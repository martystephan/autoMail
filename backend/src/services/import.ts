import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import StreamZip from 'node-stream-zip';
import prisma from '../utils/prisma';
import {
  ImportAccount,
  ImportFolder,
  ImportJob,
  ImportLog,
  ImportRun,
  MigrationJobStatus,
} from '../types/db';
import { encryptPassword, decryptPassword } from '../utils/crypto';
import { withImapClient, buildImapClient, safeCloseImapClient, ImapCredentials } from '../utils/imapClient';
import {
  FolderInfo,
  detectSourceHeadRoles,
  detectTargetLayout,
  mapSourceFolderToTarget,
  messageDedupeKey,
} from './migration';
import {
  ARCHIVE_MANIFEST_FORMAT,
  ARCHIVE_MANIFEST_NAME,
  ArchiveManifest,
  ArchiveManifestFolder,
  ArchiveMessageMeta,
  FOLDER_MESSAGES_NAME,
} from '../types/archiveFormat';

// Where uploaded archive zips live. Uploads stay until the user deletes them
// (or the whole import project) — runs read them in place, nothing is extracted.
export const IMPORT_DIR = process.env.IMPORT_DIR || path.join(__dirname, '../../data/imports');
export const IMPORT_UPLOAD_DIR = path.join(IMPORT_DIR, 'uploads');

// Number of messages appended between progress checkpoints (DB update + cancel check)
const BATCH_SIZE = Math.max(
  1,
  parseInt(process.env.IMPORT_BATCH_SIZE || process.env.MIGRATION_BATCH_SIZE || '20', 10)
);

// Abort the whole job when this many folders fail in a row (points to a
// systemic problem like broken credentials rather than a bad folder)
const MAX_CONSECUTIVE_FOLDER_FAILURES = 3;

export const ACTIVE_RUN_STATUSES: MigrationJobStatus[] = ['pending', 'running'];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Import account rows as returned to the client — never includes the password
export interface ImportAccountView {
  id: number;
  email: string;
  username: string;
  imapHost: string;
  imapPort: number;
  zipFileName: string;
  createdAt: Date;
  updatedAt: Date;
  // Whether a matching zip has been uploaded (and its size)
  zipUploaded: boolean;
  zipSize?: number;
}

export interface UploadedZipInfo {
  fileName: string;
  size: number;
  uploadedAt: Date;
}

export interface ImportOverview {
  accounts: ImportAccountView[];
  // All uploaded zips, including ones no account references
  zips: UploadedZipInfo[];
  // Whether the connection test succeeded for the current import
  tested: boolean;
}

export interface ImportRowInput {
  email: string;
  username: string;
  password: string;
  zipFileName: string;
}

export interface ImportRowsResult {
  accounts: ImportAccountView[];
  warnings: string[];
}

export interface ImportJobDetail {
  job: ImportJob;
  folders: ImportFolder[];
  logs: ImportLog[];
}

export interface ImportRunDetail {
  run: ImportRun;
  jobs: ImportJob[];
  currentJobDetail: ImportJobDetail | null;
}

class ImportJobCancelledError extends Error {
  constructor() {
    super('Import cancelled by user');
  }
}

class ImportRunCancelledError extends Error {
  constructor() {
    super('Import run cancelled by user');
  }
}

// Cancellation flags for runs/jobs running in this process
const runCancelRequests = new Set<number>();
const jobCancelRequests = new Set<number>();

// Successful connection test for the current import. Reset whenever the
// import changes (and on restart) — starting a run requires a passed test.
let connectionTested = false;

// ---------------------------------------------------------------------------
// Uploaded zip files
// ---------------------------------------------------------------------------

// Same character cleanup the archive export applies to the account email when
// it names the zip — applied to CSV values and uploaded file names alike so
// they match deterministically.
export function sanitizeZipFileName(name: string): string {
  const base = path.basename(name).replace(/\.zip$/i, '');
  const cleaned = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 100);
  return `${cleaned || '_'}.zip`;
}

// Resolve an uploaded zip name to its absolute path, refusing anything that
// escapes the upload directory
function uploadedZipPath(fileName: string): string {
  const abs = path.resolve(IMPORT_UPLOAD_DIR, fileName);
  if (!abs.startsWith(path.resolve(IMPORT_UPLOAD_DIR) + path.sep)) {
    throw new Error('Invalid zip file name');
  }
  return abs;
}

export async function listUploadedZips(): Promise<UploadedZipInfo[]> {
  let names: string[];
  try {
    names = await fsp.readdir(IMPORT_UPLOAD_DIR);
  } catch {
    return [];
  }

  const zips: UploadedZipInfo[] = [];
  for (const name of names) {
    if (!/\.zip$/i.test(name)) continue;
    const stat = await fsp.stat(path.join(IMPORT_UPLOAD_DIR, name)).catch(() => null);
    if (stat?.isFile()) {
      zips.push({ fileName: name, size: stat.size, uploadedAt: stat.mtime });
    }
  }
  zips.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return zips;
}

export async function deleteUploadedZip(fileName: string): Promise<boolean> {
  const abs = uploadedZipPath(fileName);
  if (!fs.existsSync(abs)) return false;
  await fsp.rm(abs, { force: true });
  return true;
}

export async function deleteAllUploadedZips(): Promise<number> {
  const zips = await listUploadedZips();
  for (const zip of zips) {
    await fsp.rm(path.join(IMPORT_UPLOAD_DIR, zip.fileName), { force: true });
  }
  return zips.length;
}

// ---------------------------------------------------------------------------
// Account import / overview
// ---------------------------------------------------------------------------

const VIEW_SELECT = {
  id: true,
  email: true,
  username: true,
  imapHost: true,
  imapPort: true,
  zipFileName: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function listImportAccountViews(): Promise<ImportAccountView[]> {
  const rows = await prisma.importAccount.findMany({ select: VIEW_SELECT, orderBy: { email: 'asc' } });
  const zipsByName = new Map((await listUploadedZips()).map((zip) => [zip.fileName, zip]));
  return rows.map((row) => {
    const zip = zipsByName.get(row.zipFileName);
    return { ...row, zipUploaded: Boolean(zip), zipSize: zip?.size };
  });
}

// Replace the imported accounts: upsert by email, rows missing from the new
// import are removed. The CSV stays the source of truth — this table is just
// the working copy the runs connect with.
export async function replaceImportAccounts(
  imapHost: string,
  imapPort: number,
  rows: ImportRowInput[]
): Promise<ImportRowsResult> {
  const warnings: string[] = [];
  const byEmail = new Map<string, { username: string; password: string; zipFileName: string }>();

  for (const [index, row] of rows.entries()) {
    const email = String(row.email ?? '').trim().toLowerCase();
    const username = String(row.username ?? '').trim();
    const password = String(row.password ?? '');
    const rawZipName = String(row.zipFileName ?? '').trim();

    if (!EMAIL_REGEX.test(email)) {
      throw new Error(`Row ${index + 1}: "${email || '(empty)'}" is not a valid email address`);
    }
    if (!username) {
      throw new Error(`Row ${index + 1} (${email}): username is empty`);
    }
    if (!password) {
      throw new Error(`Row ${index + 1} (${email}): password is empty`);
    }
    if (!rawZipName || !/\.zip$/i.test(rawZipName)) {
      throw new Error(`Row ${index + 1} (${email}): zip file name is missing or does not end in .zip`);
    }
    if (byEmail.has(email)) {
      warnings.push(`Duplicate email ${email} — the last occurrence was used`);
    }
    byEmail.set(email, { username, password, zipFileName: sanitizeZipFileName(rawZipName) });
  }

  if (byEmail.size === 0) {
    throw new Error('The import contains no rows');
  }

  await prisma.$transaction(
    async (tx) => {
      for (const [email, row] of byEmail) {
        const password = encryptPassword(row.password);
        await tx.importAccount.upsert({
          where: { email },
          update: { username: row.username, password, imapHost, imapPort, zipFileName: row.zipFileName },
          create: { email, username: row.username, password, imapHost, imapPort, zipFileName: row.zipFileName },
        });
      }
      await tx.importAccount.deleteMany({ where: { email: { notIn: [...byEmail.keys()] } } });
    },
    { timeout: 30000 }
  );

  connectionTested = false;
  return { accounts: await listImportAccountViews(), warnings };
}

export async function deleteImportAccounts(): Promise<number> {
  connectionTested = false;
  return (await prisma.importAccount.deleteMany({})).count;
}

export async function getImportOverview(): Promise<ImportOverview> {
  return {
    accounts: await listImportAccountViews(),
    zips: await listUploadedZips(),
    tested: connectionTested,
  };
}

// Quick credential check against one imported row (all rows share host/port,
// so one successful login validates the server settings)
export async function testImportConnection(email?: string): Promise<{ ok: boolean; error?: string }> {
  const row = email
    ? await prisma.importAccount.findUnique({ where: { email: email.trim().toLowerCase() } })
    : await prisma.importAccount.findFirst({ orderBy: { email: 'asc' } });

  if (!row) {
    return { ok: false, error: email ? `No imported account with email ${email}` : 'No accounts imported' };
  }

  try {
    await withImapClient(
      {
        host: row.imapHost,
        port: row.imapPort,
        user: row.username,
        password: decryptPassword(row.password),
      },
      async () => {}
    );
    connectionTested = true;
    return { ok: true };
  } catch (err) {
    connectionTested = false;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Accounts whose zip has not been uploaded yet — a run cannot start while any
// exist
export async function findAccountsMissingZips(): Promise<{ email: string; zipFileName: string }[]> {
  const accounts = await prisma.importAccount.findMany({
    select: { email: true, zipFileName: true },
    orderBy: { email: 'asc' },
  });
  const uploaded = new Set((await listUploadedZips()).map((zip) => zip.fileName));
  return accounts.filter((account) => !uploaded.has(account.zipFileName));
}

// ---------------------------------------------------------------------------
// Run / job persistence
// ---------------------------------------------------------------------------

export async function getImportRun(runId: number): Promise<ImportRun | undefined> {
  return (await prisma.importRun.findUnique({ where: { id: runId } })) ?? undefined;
}

export async function listImportRuns(limit = 20): Promise<ImportRun[]> {
  return prisma.importRun.findMany({ orderBy: { id: 'desc' }, take: limit });
}

export async function findActiveImportRun(): Promise<ImportRun | undefined> {
  return (
    (await prisma.importRun.findFirst({
      where: { status: { in: ACTIVE_RUN_STATUSES } },
      orderBy: { id: 'desc' },
    })) ?? undefined
  );
}

export async function getImportJob(jobId: number): Promise<ImportJob | undefined> {
  return (await prisma.importJob.findUnique({ where: { id: jobId } })) ?? undefined;
}

export async function getImportJobDetail(jobId: number): Promise<ImportJobDetail | undefined> {
  const job = await getImportJob(jobId);
  if (!job) return undefined;

  const folders = await prisma.importFolder.findMany({ where: { jobId }, orderBy: { path: 'asc' } });
  const logs = await prisma.importLog.findMany({
    where: { jobId, level: { in: ['warn', 'error'] } },
    orderBy: { id: 'desc' },
    take: 200,
  });

  return { job, folders, logs };
}

export async function listImportJobsByRun(runId: number): Promise<ImportJob[]> {
  return prisma.importJob.findMany({ where: { runId }, orderBy: { id: 'asc' } });
}

export async function getImportRunDetail(runId: number): Promise<ImportRunDetail | undefined> {
  const run = await getImportRun(runId);
  if (!run) return undefined;

  const jobs = await listImportJobsByRun(runId);
  const currentJobDetail = run.currentJobId ? (await getImportJobDetail(run.currentJobId)) ?? null : null;

  return { run, jobs, currentJobDetail };
}

export async function createImportRun(totalAccounts: number): Promise<ImportRun> {
  return prisma.importRun.create({ data: { totalAccounts } });
}

export async function cancelImportRun(runId: number): Promise<ImportRun | undefined> {
  const run = await getImportRun(runId);
  if (!run) return undefined;

  if (ACTIVE_RUN_STATUSES.includes(run.status as MigrationJobStatus)) {
    runCancelRequests.add(runId);
    if (run.currentJobId) {
      const currentJob = await getImportJob(run.currentJobId);
      if (currentJob && ACTIVE_RUN_STATUSES.includes(currentJob.status as MigrationJobStatus)) {
        jobCancelRequests.add(run.currentJobId);
        await logJob(run.currentJobId, 'info', 'Cancellation requested — job will stop at the next checkpoint');
      }
    }
  }
  return getImportRun(runId);
}

// Delete a finished run — records only, the uploaded zips are managed separately
export async function deleteImportRun(runId: number): Promise<boolean> {
  const run = await getImportRun(runId);
  if (!run) return false;
  if (ACTIVE_RUN_STATUSES.includes(run.status as MigrationJobStatus)) {
    throw new Error('This import run is still active — cancel it before deleting');
  }

  await prisma.importRun.delete({ where: { id: runId } });
  return true;
}

// The whole import project disappears: accounts, runs, job history and zips
export async function deleteImportSession(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.importRun.deleteMany({});
    await tx.importAccount.deleteMany({});
  });
  await deleteAllUploadedZips();
  connectionTested = false;
}

// Called once on server startup: jobs and runs still marked active belong to
// a previous process and are no longer running. Re-running an interrupted
// account is safe — the dedupe skips everything that already landed.
export async function recoverInterruptedImportJobs(): Promise<void> {
  const result = await prisma.importJob.updateMany({
    where: { status: { in: ACTIVE_RUN_STATUSES } },
    data: {
      status: 'interrupted',
      error: 'Server restarted while the account was being imported. Start a new run — already imported messages will be skipped.',
      completedAt: new Date(),
      currentFolder: null,
    },
  });
  if (result.count > 0) {
    console.warn(`Marked ${result.count} import job(s) as interrupted after restart`);
  }

  const runResult = await prisma.importRun.updateMany({
    where: { status: { in: ACTIVE_RUN_STATUSES } },
    data: {
      status: 'interrupted',
      error: 'Server restarted while the import run was running. Start a new run — already imported messages will be skipped.',
      completedAt: new Date(),
      currentJobId: null,
      currentEmail: null,
    },
  });
  if (runResult.count > 0) {
    console.warn(`Marked ${runResult.count} import run(s) as interrupted after restart`);
  }
}

// ---------------------------------------------------------------------------
// Zip reading
// ---------------------------------------------------------------------------

// One folder from the zip, ready to import: the manifest record plus the
// .eml entries found under its directory and their per-message metadata.
export interface ZipFolderPlan {
  manifest: ArchiveManifestFolder;
  // Full zip entry names of the folder's .eml files, sorted (UID order)
  entryNames: string[];
  // Metadata by .eml basename, from the folder's .automail-messages.jsonl
  metaByFile: Map<string, ArchiveMessageMeta>;
}

export interface ZipPlan {
  manifest: ArchiveManifest;
  folders: ZipFolderPlan[];
  // .eml entries found in the zip
  totalMessages: number;
  warnings: string[];
}

// An entry name is only trusted when it cannot escape or restructure the
// folder tree — nothing is extracted to disk, but these names decide which
// target folders get created.
function splitEntryDir(entryName: string): { dir: string; base: string } | null {
  const segments = entryName.split('/');
  const base = segments.pop() ?? '';
  if (entryName.startsWith('/') || segments.some((segment) => !segment || segment === '..' || segment === '.')) {
    return null;
  }
  return { dir: segments.join('/'), base };
}

// Read the manifest and group the zip's .eml entries by folder. Throws when
// the zip has no valid autoMail manifest — only archives produced by the
// Archive tab can be imported.
export async function readZipPlan(zip: InstanceType<typeof StreamZip.async>): Promise<ZipPlan> {
  const entries = await zip.entries();
  const warnings: string[] = [];

  const manifestEntry = entries[ARCHIVE_MANIFEST_NAME];
  if (!manifestEntry) {
    throw new Error(
      `The zip contains no ${ARCHIVE_MANIFEST_NAME} — only archives created by this tool's Archive tab can be imported`
    );
  }
  let manifest: ArchiveManifest;
  try {
    manifest = JSON.parse((await zip.entryData(ARCHIVE_MANIFEST_NAME)).toString('utf8'));
  } catch (err) {
    throw new Error(`Could not parse ${ARCHIVE_MANIFEST_NAME}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (manifest?.format !== ARCHIVE_MANIFEST_FORMAT || !Array.isArray(manifest.folders)) {
    throw new Error(`${ARCHIVE_MANIFEST_NAME} is not a valid autoMail archive manifest`);
  }

  // Group .eml entries by their directory path inside the zip
  const emlByDir = new Map<string, string[]>();
  for (const entry of Object.values(entries)) {
    if (entry.isDirectory) continue;
    const split = splitEntryDir(entry.name);
    if (!split) {
      warnings.push(`Skipped zip entry with unsafe path: ${entry.name}`);
      continue;
    }
    if (split.base === ARCHIVE_MANIFEST_NAME || split.base === FOLDER_MESSAGES_NAME) continue;
    if (!/\.eml$/i.test(split.base)) {
      warnings.push(`Skipped non-message zip entry: ${entry.name}`);
      continue;
    }
    const list = emlByDir.get(split.dir) ?? [];
    list.push(entry.name);
    emlByDir.set(split.dir, list);
  }

  // The manifest is the folder list; message metadata comes from the folder's
  // JSONL sidecar.
  const folders: ZipFolderPlan[] = [];
  let totalMessages = 0;
  const knownDirs = new Set<string>();
  for (const manifestFolder of manifest.folders) {
    if (!manifestFolder?.zipPath || !manifestFolder.originalPath) {
      warnings.push('Skipped a manifest folder record without zipPath/originalPath');
      continue;
    }
    knownDirs.add(manifestFolder.zipPath);
    const entryNames = (emlByDir.get(manifestFolder.zipPath) ?? []).sort();

    const metaByFile = new Map<string, ArchiveMessageMeta>();
    const metaEntryName = `${manifestFolder.zipPath}/${FOLDER_MESSAGES_NAME}`;
    if (entries[metaEntryName]) {
      const lines = (await zip.entryData(metaEntryName)).toString('utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const meta = JSON.parse(line) as ArchiveMessageMeta;
          if (meta?.file) metaByFile.set(meta.file, meta);
        } catch {
          warnings.push(`Skipped an unreadable metadata line in ${metaEntryName}`);
        }
      }
    }

    totalMessages += entryNames.length;
    folders.push({ manifest: manifestFolder, entryNames, metaByFile });
  }

  for (const dir of emlByDir.keys()) {
    if (!knownDirs.has(dir)) {
      warnings.push(`Skipped ${emlByDir.get(dir)!.length} message(s) in zip folder "${dir}" — not listed in the manifest`);
    }
  }

  return { manifest, folders, totalMessages, warnings };
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

async function logJob(
  jobId: number,
  level: 'info' | 'warn' | 'error',
  message: string,
  folderPath?: string,
  entryName?: string
): Promise<void> {
  await prisma.importLog.create({
    data: { jobId, level, folderPath: folderPath ?? null, entryName: entryName ?? null, message },
  });
  const prefix = `[import:${jobId}]${folderPath ? ` [${folderPath}]` : ''}`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

function checkCancelled(jobId: number): void {
  if (jobCancelRequests.has(jobId)) {
    throw new ImportJobCancelledError();
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // imapflow attaches the server's raw response text, which is usually the
    // most useful part of the error
    const responseText = (err as any).responseText;
    return responseText ? `${err.message} (${responseText})` : err.message;
  }
  return String(err);
}

async function bumpJobCounters(
  jobId: number,
  imported: number,
  skipped: number,
  failed: number,
  processed: number
): Promise<void> {
  await prisma.importJob.update({
    where: { id: jobId },
    data: {
      importedMessages: { increment: imported },
      skippedMessages: { increment: skipped },
      failedMessages: { increment: failed },
      processedMessages: { increment: processed },
    },
  });
}

// Dedupe identity of an archived message, matching what messageDedupeKey
// produces for the live messages on the target
function metaDedupeKey(meta: ArchiveMessageMeta | undefined): string | null {
  if (!meta) return null;
  return messageDedupeKey({
    envelope: { messageId: meta.messageId, subject: meta.subject },
    internalDate: meta.internalDate,
  });
}

// Import one folder in batches. The connection is opened fresh for the
// folder; every message is read from the zip and appended individually so at
// most one message is held in memory at a time.
//
// Idempotency comes from comparing with what actually exists on the target:
// before importing, the Message-IDs of all target messages are collected and
// every archived message that is already present is skipped.
async function importFolder(
  jobId: number,
  folder: ImportFolder,
  plan: ZipFolderPlan,
  zip: InstanceType<typeof StreamZip.async>,
  credentials: ImapCredentials
): Promise<void> {
  const target = buildImapClient(credentials);

  const updateFolderCounts = (imported: number, skipped: number, failed: number) =>
    prisma.importFolder.update({
      where: { id: folder.id },
      data: { importedCount: imported, skippedCount: skipped, failedCount: failed },
    });

  try {
    await target.connect();

    // What already exists on the target?
    const targetKeys = new Set<string>();
    const targetMailbox = await target.mailboxOpen(folder.targetPath, { readOnly: true });
    if (targetMailbox.exists > 0) {
      for await (const message of target.fetch('1:*', { envelope: true, internalDate: true })) {
        const key = messageDedupeKey(message);
        if (key) targetKeys.add(key);
      }
    }

    let imported = 0;
    let skipped = 0;
    let failed = 0;

    await logJob(jobId, 'info', `Importing ${plan.entryNames.length} messages in batches of ${BATCH_SIZE}`, folder.path);

    for (let offset = 0; offset < plan.entryNames.length; offset += BATCH_SIZE) {
      checkCancelled(jobId);
      const batch = plan.entryNames.slice(offset, offset + BATCH_SIZE);
      let batchImported = 0;
      let batchSkipped = 0;
      let batchFailed = 0;

      for (const entryName of batch) {
        const fileName = entryName.split('/').pop()!;
        const meta = plan.metaByFile.get(fileName);
        try {
          // A message appended earlier in this run can make later duplicates
          // (same Message-ID within the folder) redundant
          const key = metaDedupeKey(meta);
          if (key && targetKeys.has(key)) {
            batchSkipped++;
            continue;
          }

          if (!meta) {
            await logJob(jobId, 'warn', `No archive metadata for ${fileName} — imported without flags/date`, folder.path, entryName);
          }

          const source = await zip.entryData(entryName);
          const internalDate = meta?.internalDate ? new Date(meta.internalDate) : undefined;
          await target.append(
            folder.targetPath,
            source,
            meta?.flags ?? [],
            internalDate && !isNaN(internalDate.getTime()) ? internalDate : undefined
          );
          if (key) targetKeys.add(key);
          batchImported++;
        } catch (err) {
          batchFailed++;
          await logJob(jobId, 'error', `Failed to import ${fileName}: ${errorMessage(err)}`, folder.path, entryName);
        }
      }

      imported += batchImported;
      skipped += batchSkipped;
      failed += batchFailed;

      // Checkpoint: persist progress after every batch
      await updateFolderCounts(imported, skipped, failed);
      await bumpJobCounters(jobId, batchImported, batchSkipped, batchFailed, batchImported + batchSkipped + batchFailed);

      // If the very first batch failed completely, the folder itself is broken
      // (missing on target, no append permission, ...) — abort instead of
      // producing one error per message
      if (offset === 0 && batchImported === 0 && batchFailed === batch.length && batch.length > 1) {
        throw new Error(`All ${batch.length} messages in the first batch failed — aborting this folder`);
      }
    }

    const status = failed > 0 ? 'completed_with_errors' : 'completed';
    await prisma.importFolder.update({
      where: { id: folder.id },
      data: { status, completedAt: new Date() },
    });
    await logJob(
      jobId,
      failed > 0 ? 'warn' : 'info',
      `Folder done: ${imported} imported, ${skipped} skipped, ${failed} failed`,
      folder.path
    );
  } finally {
    await safeCloseImapClient(target);
  }
}

// Import one account from its zip. Never rejects for per-folder or
// per-message problems — those are logged and counted; only cancellation or a
// systemic failure ends the job early.
async function runImportJob(jobId: number): Promise<void> {
  const job = await getImportJob(jobId);
  if (!job) return;

  let zip: InstanceType<typeof StreamZip.async> | undefined;

  try {
    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: 'running', startedAt: new Date() },
    });

    const account = job.importAccountId
      ? await prisma.importAccount.findUnique({ where: { id: job.importAccountId } })
      : null;
    if (!account) {
      throw new Error('Account no longer exists');
    }
    const credentials: ImapCredentials = {
      host: account.imapHost,
      port: account.imapPort,
      user: account.username,
      password: decryptPassword(account.password),
    };

    const zipAbsPath = uploadedZipPath(job.zipFileName);
    if (!fs.existsSync(zipAbsPath)) {
      throw new Error(`Uploaded zip ${job.zipFileName} was not found — upload it and start a new run`);
    }

    await logJob(jobId, 'info', `Starting import of ${job.zipFileName} into ${job.email}`);

    // Step 1: read the zip's manifest and group its messages by folder
    zip = new StreamZip.async({ file: zipAbsPath });
    const plan = await readZipPlan(zip);
    for (const warning of plan.warnings) {
      await logJob(jobId, 'warn', warning);
    }
    await logJob(
      jobId,
      'info',
      `Archive of ${plan.manifest.email} (exported ${plan.manifest.exportedAt}): ${plan.folders.length} folders with ${plan.totalMessages} messages`
    );

    // Step 2: map every archived folder to a target folder by role (the
    // manifest carries the original paths and special-use flags, so this is
    // the same role mapping a live migration uses) and create missing folders
    const folderInfos: FolderInfo[] = plan.folders.map((folder) => ({
      path: folder.manifest.originalPath,
      name: folder.manifest.name || folder.manifest.originalPath.split(folder.manifest.delimiter || '/').pop()!,
      delimiter: folder.manifest.delimiter || '/',
      specialUse: folder.manifest.specialUse,
      flaggedSpecialUse: folder.manifest.flaggedSpecialUse,
      messageCount: folder.entryNames.length,
    }));
    const headRoles = detectSourceHeadRoles(folderInfos);
    const planByZipPath = new Map(plan.folders.map((folder) => [folder.manifest.zipPath, folder]));

    checkCancelled(jobId);
    await withImapClient(credentials, async (client) => {
      const existing = await client.list();
      const layout = detectTargetLayout(existing);
      const existingPaths = new Set(existing.map((m) => m.path));

      const mapped = plan.folders.map((folder, index) => {
        const segments = mapSourceFolderToTarget(folderInfos[index], headRoles, layout);
        return { folder, segments, targetPath: segments.join(layout.delimiter) };
      });
      // Parents sort before their children, so nested folders are created in order
      mapped.sort((a, b) => a.targetPath.localeCompare(b.targetPath));

      for (const { folder, segments, targetPath } of mapped) {
        let error: string | null = null;

        if (targetPath !== folder.manifest.originalPath) {
          await logJob(jobId, 'info', `Mapped to target folder: ${targetPath}`, folder.manifest.zipPath);
        }

        if (!existingPaths.has(targetPath)) {
          try {
            await client.mailboxCreate(segments);
            existingPaths.add(targetPath);
            await logJob(jobId, 'info', `Created folder on target: ${targetPath}`, folder.manifest.zipPath);
          } catch (err) {
            error = `Could not create folder on target: ${errorMessage(err)}`;
            await logJob(jobId, 'error', error, folder.manifest.zipPath);
          }
        }

        await prisma.importFolder.create({
          data: {
            jobId,
            path: folder.manifest.zipPath,
            targetPath,
            status: error ? 'failed' : 'pending',
            messageCount: folder.entryNames.length,
            error,
          },
        });
      }
    });

    await prisma.importJob.update({
      where: { id: jobId },
      data: { totalFolders: plan.folders.length, totalMessages: plan.totalMessages },
    });

    // Step 3: import folder by folder, batch by batch
    const folderRows = await prisma.importFolder.findMany({
      where: { jobId, status: 'pending' },
      orderBy: { path: 'asc' },
    });

    let consecutiveFailures = 0;
    for (const folderRow of folderRows) {
      checkCancelled(jobId);
      const folderPlan = planByZipPath.get(folderRow.path);
      if (!folderPlan) continue;

      await prisma.importFolder.update({
        where: { id: folderRow.id },
        data: { status: 'running', startedAt: new Date() },
      });
      await prisma.importJob.update({ where: { id: jobId }, data: { currentFolder: folderRow.targetPath } });

      try {
        await importFolder(jobId, folderRow, folderPlan, zip, credentials);
        consecutiveFailures = 0;
      } catch (err) {
        if (err instanceof ImportJobCancelledError) throw err;

        const message = errorMessage(err);
        await prisma.importFolder.update({
          where: { id: folderRow.id },
          data: { status: 'failed', error: message, completedAt: new Date() },
        });
        await logJob(jobId, 'error', `Folder failed: ${message}`, folderRow.path);

        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FOLDER_FAILURES) {
          throw new Error(
            `${MAX_CONSECUTIVE_FOLDER_FAILURES} folders failed in a row (last: ${folderRow.path}) — aborting this account. Fix the connection/credentials and start a new run; imported messages will be skipped.`
          );
        }
      }
    }

    // Step 4: final status from what actually happened
    const finalJob = (await getImportJob(jobId))!;
    const failedFolders = await prisma.importFolder.count({ where: { jobId, status: 'failed' } });
    const hasErrors = finalJob.failedMessages > 0 || failedFolders > 0;
    const finalStatus: MigrationJobStatus = hasErrors ? 'completed_with_errors' : 'completed';

    await prisma.importJob.update({
      where: { id: jobId },
      data: { status: finalStatus, currentFolder: null, completedAt: new Date() },
    });
    await logJob(
      jobId,
      hasErrors ? 'warn' : 'info',
      `Import finished: ${finalJob.importedMessages} imported, ${finalJob.skippedMessages} skipped, ${finalJob.failedMessages} failed` +
        (failedFolders > 0 ? `, ${failedFolders} folder(s) failed` : '')
    );
  } catch (err) {
    if (err instanceof ImportJobCancelledError) {
      await prisma.importJob.update({
        where: { id: jobId },
        data: { status: 'cancelled', currentFolder: null, completedAt: new Date() },
      });
      await prisma.importFolder.updateMany({
        where: { jobId, status: 'running' },
        data: { status: 'pending', completedAt: null },
      });
      await logJob(jobId, 'warn', 'Import cancelled — a new run will skip everything already imported.');
    } else {
      const message = errorMessage(err);
      await prisma.importJob.update({
        where: { id: jobId },
        data: { status: 'failed', error: message, currentFolder: null, completedAt: new Date() },
      });
      await logJob(jobId, 'error', `Import failed: ${message}`);
    }
  } finally {
    jobCancelRequests.delete(jobId);
    await zip?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Run execution
// ---------------------------------------------------------------------------

function logRun(runId: number, level: 'info' | 'warn' | 'error', message: string): void {
  const prefix = `[import-run:${runId}]`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// Import all imported accounts sequentially. A failed account is recorded
// and the run continues with the next one; only cancellation stops early.
export async function runImportRun(runId: number): Promise<void> {
  const run = await getImportRun(runId);
  if (!run) return;

  try {
    await prisma.importRun.update({
      where: { id: runId },
      data: { status: 'running', startedAt: new Date() },
    });

    const accounts = await prisma.importAccount.findMany({ orderBy: { email: 'asc' } });
    await prisma.importRun.update({ where: { id: runId }, data: { totalAccounts: accounts.length } });
    logRun(runId, 'info', `Starting import run with ${accounts.length} account(s)`);

    let completedAccounts = 0;
    let failedAccounts = 0;
    let accountsWithErrors = 0;

    for (const account of accounts) {
      if (runCancelRequests.has(runId)) {
        throw new ImportRunCancelledError();
      }

      const job = await prisma.importJob.create({
        data: {
          runId,
          importAccountId: account.id,
          email: account.email,
          zipFileName: account.zipFileName,
        },
      });
      await prisma.importRun.update({
        where: { id: runId },
        data: { currentJobId: job.id, currentEmail: account.email },
      });
      logRun(runId, 'info', `Account ${completedAccounts + 1}/${accounts.length}: importing ${account.email} (job #${job.id})`);

      // Never rejects — per-account problems end up as the job's status
      await runImportJob(job.id);

      const finished = await getImportJob(job.id);
      completedAccounts++;
      if (finished?.status === 'failed') {
        failedAccounts++;
      } else if (finished?.status === 'completed_with_errors') {
        accountsWithErrors++;
      } else if (finished?.status === 'cancelled') {
        // The account was cancelled via the run — surface it as a run cancellation
        await prisma.importRun.update({
          where: { id: runId },
          data: { completedAccounts, failedAccounts },
        });
        throw new ImportRunCancelledError();
      }

      await prisma.importRun.update({
        where: { id: runId },
        data: { completedAccounts, failedAccounts },
      });
    }

    const finalStatus: MigrationJobStatus =
      failedAccounts > 0 || accountsWithErrors > 0 ? 'completed_with_errors' : 'completed';
    await prisma.importRun.update({
      where: { id: runId },
      data: { status: finalStatus, currentJobId: null, currentEmail: null, completedAt: new Date() },
    });
    logRun(
      runId,
      finalStatus === 'completed' ? 'info' : 'warn',
      `Import run finished: ${completedAccounts} account(s) processed, ${failedAccounts} failed`
    );
  } catch (err) {
    if (err instanceof ImportRunCancelledError) {
      await prisma.importRun.update({
        where: { id: runId },
        data: { status: 'cancelled', currentJobId: null, currentEmail: null, completedAt: new Date() },
      });
      logRun(runId, 'warn', 'Import run cancelled. A new run will skip everything already imported.');
    } else {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.importRun.update({
        where: { id: runId },
        data: { status: 'failed', error: message, currentJobId: null, currentEmail: null, completedAt: new Date() },
      });
      logRun(runId, 'error', `Import run failed: ${message}`);
    }
  } finally {
    runCancelRequests.delete(runId);
  }
}
