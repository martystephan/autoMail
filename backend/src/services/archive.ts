import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { ZipArchive } from 'archiver';
import prisma from '../utils/prisma';
import {
  ArchiveAccount,
  ArchiveFolder,
  ArchiveJob,
  ArchiveLog,
  ArchiveRun,
  MigrationJobStatus,
} from '../types/db';
import { encryptPassword, decryptPassword } from '../utils/crypto';
import { withImapClient, buildImapClient, safeCloseImapClient, ImapCredentials } from '../utils/imapClient';
import { getFolders, detectSourceHeadRoles, applyRoleExclusions } from './migration';
import {
  ARCHIVE_MANIFEST_FORMAT,
  ARCHIVE_MANIFEST_NAME,
  ARCHIVE_MANIFEST_VERSION,
  ArchiveManifest,
  ArchiveManifestFolder,
  ArchiveMessageMeta,
  FOLDER_MESSAGES_NAME,
} from '../types/archiveFormat';

// Where the produced zips live. Zips are written to run-<id>/ subfolders and
// stay until the user deletes the run; tmp/ only exists while a run is active.
export const ARCHIVE_DIR = process.env.ARCHIVE_DIR || path.join(__dirname, '../../data/archives');

// Number of messages saved between progress checkpoints (DB update + cancel check)
const BATCH_SIZE = Math.max(
  1,
  parseInt(process.env.ARCHIVE_BATCH_SIZE || process.env.MIGRATION_BATCH_SIZE || '20', 10)
);

// Abort the whole job when this many folders fail in a row (points to a
// systemic problem like broken credentials rather than a bad folder)
const MAX_CONSECUTIVE_FOLDER_FAILURES = 3;

export const ACTIVE_RUN_STATUSES: MigrationJobStatus[] = ['pending', 'running'];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ArchiveRunOptions {
  excludeTrash?: boolean; // default false — an archive should usually be complete
  excludeJunk?: boolean; // default false
}

// Archive account rows as returned to the client — never includes the password
export interface ArchiveAccountView {
  id: number;
  email: string;
  username: string;
  imapHost: string;
  imapPort: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ArchiveOverview {
  accounts: ArchiveAccountView[];
  // Whether the connection test succeeded for the current import
  tested: boolean;
}

export interface ArchiveImportRow {
  email: string;
  username: string;
  password: string;
}

export interface ArchiveImportResult {
  accounts: ArchiveAccountView[];
  warnings: string[];
}

export interface ArchiveJobDetail {
  job: ArchiveJob;
  folders: ArchiveFolder[];
  logs: ArchiveLog[];
}

export interface ArchiveRunDetail {
  run: ArchiveRun;
  jobs: ArchiveJob[];
  currentJobDetail: ArchiveJobDetail | null;
}

class ArchiveJobCancelledError extends Error {
  constructor() {
    super('Archiving cancelled by user');
  }
}

class ArchiveRunCancelledError extends Error {
  constructor() {
    super('Archive run cancelled by user');
  }
}

// Cancellation flags for runs/jobs running in this process
const runCancelRequests = new Set<number>();
const jobCancelRequests = new Set<number>();

// Successful connection test for the current import. Reset whenever the
// import changes (and on restart) — starting a run requires a passed test.
let connectionTested = false;

// ---------------------------------------------------------------------------
// Account import / overview
// ---------------------------------------------------------------------------

const VIEW_SELECT = {
  id: true,
  email: true,
  username: true,
  imapHost: true,
  imapPort: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function listArchiveAccountViews(): Promise<ArchiveAccountView[]> {
  return prisma.archiveAccount.findMany({ select: VIEW_SELECT, orderBy: { email: 'asc' } });
}

// Replace the imported accounts: upsert by email, rows missing from the new
// import are removed. The CSV stays the source of truth — this table is just
// the working copy the runs connect with.
export async function replaceArchiveAccounts(
  imapHost: string,
  imapPort: number,
  rows: ArchiveImportRow[]
): Promise<ArchiveImportResult> {
  const warnings: string[] = [];
  const byEmail = new Map<string, { username: string; password: string }>();

  for (const [index, row] of rows.entries()) {
    const email = String(row.email ?? '').trim().toLowerCase();
    const username = String(row.username ?? '').trim();
    const password = String(row.password ?? '');

    if (!EMAIL_REGEX.test(email)) {
      throw new Error(`Row ${index + 1}: "${email || '(empty)'}" is not a valid email address`);
    }
    if (!username) {
      throw new Error(`Row ${index + 1} (${email}): username is empty`);
    }
    if (!password) {
      throw new Error(`Row ${index + 1} (${email}): password is empty`);
    }
    if (byEmail.has(email)) {
      warnings.push(`Duplicate email ${email} — the last occurrence was used`);
    }
    byEmail.set(email, { username, password });
  }

  if (byEmail.size === 0) {
    throw new Error('The import contains no rows');
  }

  await prisma.$transaction(
    async (tx) => {
      for (const [email, row] of byEmail) {
        const password = encryptPassword(row.password);
        await tx.archiveAccount.upsert({
          where: { email },
          update: { username: row.username, password, imapHost, imapPort },
          create: { email, username: row.username, password, imapHost, imapPort },
        });
      }
      await tx.archiveAccount.deleteMany({ where: { email: { notIn: [...byEmail.keys()] } } });
    },
    { timeout: 30000 }
  );

  connectionTested = false;
  return { accounts: await listArchiveAccountViews(), warnings };
}

export async function deleteArchiveAccounts(): Promise<number> {
  connectionTested = false;
  return (await prisma.archiveAccount.deleteMany({})).count;
}

export async function getArchiveOverview(): Promise<ArchiveOverview> {
  return { accounts: await listArchiveAccountViews(), tested: connectionTested };
}

// Quick credential check against one imported row (all rows share host/port,
// so one successful login validates the server settings)
export async function testArchiveConnection(email?: string): Promise<{ ok: boolean; error?: string }> {
  const row = email
    ? await prisma.archiveAccount.findUnique({ where: { email: email.trim().toLowerCase() } })
    : await prisma.archiveAccount.findFirst({ orderBy: { email: 'asc' } });

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

// ---------------------------------------------------------------------------
// Run / job persistence
// ---------------------------------------------------------------------------

export async function getArchiveRun(runId: number): Promise<ArchiveRun | undefined> {
  return (await prisma.archiveRun.findUnique({ where: { id: runId } })) ?? undefined;
}

export async function listArchiveRuns(limit = 20): Promise<ArchiveRun[]> {
  return prisma.archiveRun.findMany({ orderBy: { id: 'desc' }, take: limit });
}

export async function findActiveArchiveRun(): Promise<ArchiveRun | undefined> {
  return (
    (await prisma.archiveRun.findFirst({
      where: { status: { in: ACTIVE_RUN_STATUSES } },
      orderBy: { id: 'desc' },
    })) ?? undefined
  );
}

export async function getArchiveJob(jobId: number): Promise<ArchiveJob | undefined> {
  return (await prisma.archiveJob.findUnique({ where: { id: jobId } })) ?? undefined;
}

export async function getArchiveJobDetail(jobId: number): Promise<ArchiveJobDetail | undefined> {
  const job = await getArchiveJob(jobId);
  if (!job) return undefined;

  const folders = await prisma.archiveFolder.findMany({ where: { jobId }, orderBy: { path: 'asc' } });
  const logs = await prisma.archiveLog.findMany({
    where: { jobId, level: { in: ['warn', 'error'] } },
    orderBy: { id: 'desc' },
    take: 200,
  });

  return { job, folders, logs };
}

export async function listArchiveJobsByRun(runId: number): Promise<ArchiveJob[]> {
  return prisma.archiveJob.findMany({ where: { runId }, orderBy: { id: 'asc' } });
}

export async function getArchiveRunDetail(runId: number): Promise<ArchiveRunDetail | undefined> {
  const run = await getArchiveRun(runId);
  if (!run) return undefined;

  const jobs = await listArchiveJobsByRun(runId);
  const currentJobDetail = run.currentJobId ? (await getArchiveJobDetail(run.currentJobId)) ?? null : null;

  return { run, jobs, currentJobDetail };
}

export async function createArchiveRun(totalAccounts: number): Promise<ArchiveRun> {
  return prisma.archiveRun.create({ data: { totalAccounts } });
}

async function createArchiveJob(
  runId: number,
  account: ArchiveAccount,
  excludedFolders: string[]
): Promise<ArchiveJob> {
  return prisma.archiveJob.create({
    data: {
      runId,
      archiveAccountId: account.id,
      email: account.email,
      excludedFolders: JSON.stringify(excludedFolders),
    },
  });
}

export async function cancelArchiveRun(runId: number): Promise<ArchiveRun | undefined> {
  const run = await getArchiveRun(runId);
  if (!run) return undefined;

  if (ACTIVE_RUN_STATUSES.includes(run.status as MigrationJobStatus)) {
    runCancelRequests.add(runId);
    if (run.currentJobId) {
      const currentJob = await getArchiveJob(run.currentJobId);
      if (currentJob && ACTIVE_RUN_STATUSES.includes(currentJob.status as MigrationJobStatus)) {
        jobCancelRequests.add(run.currentJobId);
        await logJob(run.currentJobId, 'info', 'Cancellation requested — job will stop at the next checkpoint');
      }
    }
  }
  return getArchiveRun(runId);
}

// Delete a finished run: its zips on disk plus all records (jobs, folders and
// logs go via ON DELETE CASCADE)
export async function deleteArchiveRun(runId: number): Promise<boolean> {
  const run = await getArchiveRun(runId);
  if (!run) return false;
  if (ACTIVE_RUN_STATUSES.includes(run.status as MigrationJobStatus)) {
    throw new Error('This archive run is still active — cancel it before deleting');
  }

  fs.rmSync(path.join(ARCHIVE_DIR, `run-${runId}`), { recursive: true, force: true });
  await prisma.archiveRun.delete({ where: { id: runId } });
  return true;
}

// The whole archive project disappears: imports, runs, zips and job history
export async function deleteArchiveSession(): Promise<void> {
  const runs = await prisma.archiveRun.findMany({ select: { id: true } });
  for (const run of runs) {
    fs.rmSync(path.join(ARCHIVE_DIR, `run-${run.id}`), { recursive: true, force: true });
  }
  await prisma.$transaction(async (tx) => {
    await tx.archiveRun.deleteMany({});
    await tx.archiveAccount.deleteMany({});
  });
  connectionTested = false;
}

// Called once on server startup: jobs and runs still marked active belong to
// a previous process and are no longer running. Zips of accounts that
// finished before the crash are kept; the interrupted account has no zip.
export async function recoverInterruptedArchiveJobs(): Promise<void> {
  const result = await prisma.archiveJob.updateMany({
    where: { status: { in: ACTIVE_RUN_STATUSES } },
    data: {
      status: 'interrupted',
      error: 'Server restarted while the account was being archived. Start a new run for this account.',
      completedAt: new Date(),
      currentFolder: null,
    },
  });
  if (result.count > 0) {
    console.warn(`Marked ${result.count} archive job(s) as interrupted after restart`);
  }

  const runResult = await prisma.archiveRun.updateMany({
    where: { status: { in: ACTIVE_RUN_STATUSES } },
    data: {
      status: 'interrupted',
      error:
        'Server restarted while the archive run was running. Zips created before the restart are still available.',
      completedAt: new Date(),
      currentJobId: null,
      currentEmail: null,
    },
  });
  if (runResult.count > 0) {
    console.warn(`Marked ${runResult.count} archive run(s) as interrupted after restart`);
  }
}

// Only active runs ever write to tmp/, so leftovers are crash debris
export function cleanupArchiveTempDir(): void {
  fs.rmSync(path.join(ARCHIVE_DIR, 'tmp'), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

// Make a mailbox/email/subject segment safe as a file or directory name on
// any platform
function sanitizeSegment(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 100);
  return cleaned || '_';
}

// UIDs are unique within a folder, so names cannot collide — the existsSync
// suffix is a pure safety net
function emlFilePath(dir: string, uid: number, subject?: string): string {
  const slug = subject?.trim() ? sanitizeSegment(subject.trim()).slice(0, 60) : 'no-subject';
  const base = `${String(uid).padStart(6, '0')}_${slug}`;
  let filePath = path.join(dir, `${base}.eml`);
  for (let attempt = 2; fs.existsSync(filePath); attempt++) {
    filePath = path.join(dir, `${base}-${attempt}.eml`);
  }
  return filePath;
}

// Zip the contents of a directory (not the directory itself) into outFile,
// resolving with the final file size
function zipDirectory(srcDir: string, outFile: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const output = fs.createWriteStream(outFile);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    output.on('close', () => resolve(archive.pointer()));
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(srcDir, false);
    archive.finalize().catch(reject);
  });
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

async function logJob(
  jobId: number,
  level: 'info' | 'warn' | 'error',
  message: string,
  folderPath?: string,
  uid?: number
): Promise<void> {
  await prisma.archiveLog.create({
    data: { jobId, level, folderPath: folderPath ?? null, uid: uid ?? null, message },
  });
  const prefix = `[archive:${jobId}]${folderPath ? ` [${folderPath}]` : ''}`;
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
    throw new ArchiveJobCancelledError();
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

async function bumpJobCounters(jobId: number, saved: number, failed: number, processed: number): Promise<void> {
  await prisma.archiveJob.update({
    where: { id: jobId },
    data: {
      savedMessages: { increment: saved },
      failedMessages: { increment: failed },
      processedMessages: { increment: processed },
    },
  });
}

// Save one folder in batches. The connection is opened fresh for the folder;
// every message is fetched and written individually so at most one message is
// held in memory at a time. Progress is persisted after every batch.
async function archiveFolder(
  jobId: number,
  folder: ArchiveFolder,
  folderDir: string,
  credentials: ImapCredentials
): Promise<void> {
  const source = buildImapClient(credentials);

  const updateFolderCounts = (messageCount: number, saved: number, failed: number) =>
    prisma.archiveFolder.update({
      where: { id: folder.id },
      data: { messageCount, savedCount: saved, failedCount: failed },
    });

  await fsp.mkdir(folderDir, { recursive: true });

  try {
    await source.connect();
    await source.mailboxOpen(folder.path, { readOnly: true });
    const uids: number[] = (await source.search({ all: true }, { uid: true })) || [];

    let saved = 0;
    let failed = 0;

    await updateFolderCounts(uids.length, saved, failed);
    await logJob(jobId, 'info', `Saving ${uids.length} messages in batches of ${BATCH_SIZE}`, folder.path);

    for (let offset = 0; offset < uids.length; offset += BATCH_SIZE) {
      checkCancelled(jobId);
      const batch = uids.slice(offset, offset + BATCH_SIZE);
      let batchSaved = 0;
      let batchFailed = 0;
      const batchMeta: ArchiveMessageMeta[] = [];

      for (const uid of batch) {
        try {
          const message = await source.fetchOne(
            String(uid),
            { uid: true, envelope: true, source: true, flags: true, internalDate: true },
            { uid: true }
          );

          if (!message || !message.source) {
            batchFailed++;
            await logJob(jobId, 'error', `Message UID ${uid} could not be fetched (no content returned)`, folder.path, uid);
            continue;
          }

          const filePath = emlFilePath(folderDir, uid, message.envelope?.subject);
          await fsp.writeFile(filePath, message.source);
          batchMeta.push({
            file: path.basename(filePath),
            uid,
            flags: message.flags ? Array.from(message.flags).filter((flag) => flag !== '\\Recent') : [],
            internalDate: message.internalDate ? new Date(message.internalDate).toISOString() : undefined,
            messageId: message.envelope?.messageId ?? undefined,
            subject: message.envelope?.subject ?? undefined,
          });
          batchSaved++;
        } catch (err) {
          batchFailed++;
          await logJob(jobId, 'error', `Failed to save message UID ${uid}: ${errorMessage(err)}`, folder.path, uid);
        }
      }

      // Restore metadata (flags, internal date, Message-ID) for the batch —
      // appended so at most one batch of records is held in memory
      if (batchMeta.length > 0) {
        await fsp.appendFile(
          path.join(folderDir, FOLDER_MESSAGES_NAME),
          batchMeta.map((meta) => JSON.stringify(meta)).join('\n') + '\n'
        );
      }

      saved += batchSaved;
      failed += batchFailed;

      // Checkpoint: persist progress after every batch
      await updateFolderCounts(uids.length, saved, failed);
      await bumpJobCounters(jobId, batchSaved, batchFailed, batchSaved + batchFailed);

      // If the very first batch failed completely, the folder itself is broken
      // (disk full, no read permission, ...) — abort instead of producing one
      // error per message
      if (offset === 0 && batchSaved === 0 && batchFailed === batch.length && batch.length > 1) {
        throw new Error(`All ${batch.length} messages in the first batch failed — aborting this folder`);
      }
    }

    const status = failed > 0 ? 'completed_with_errors' : 'completed';
    await prisma.archiveFolder.update({
      where: { id: folder.id },
      data: { status, completedAt: new Date() },
    });
    await logJob(jobId, failed > 0 ? 'warn' : 'info', `Folder done: ${saved} saved, ${failed} failed`, folder.path);
  } finally {
    await safeCloseImapClient(source);
  }
}

// Archive one account to a zip. Never rejects for per-folder or per-message
// problems — those are logged and counted; only cancellation or a systemic
// failure ends the job early.
async function runArchiveJob(jobId: number): Promise<void> {
  const job = await getArchiveJob(jobId);
  if (!job) return;

  const accountSegment = sanitizeSegment(job.email);
  const tmpDir = path.join(ARCHIVE_DIR, 'tmp', `run-${job.runId}`, accountSegment);
  const zipRelPath = path.join(`run-${job.runId}`, `${accountSegment}.zip`);
  const zipAbsPath = path.join(ARCHIVE_DIR, zipRelPath);
  let zipRecorded = false;

  try {
    await prisma.archiveJob.update({
      where: { id: jobId },
      data: { status: 'running', startedAt: new Date() },
    });

    const account = job.archiveAccountId
      ? await prisma.archiveAccount.findUnique({ where: { id: job.archiveAccountId } })
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

    await logJob(jobId, 'info', `Starting archive of ${job.email}`);

    // Step 1: list folders, applying the run's role exclusions. Like bulk
    // migration, skip-trash/skip-junk only excludes folders the server flags
    // with the special-use attribute — never folders that merely share a name.
    const excludedFlags = JSON.parse(job.excludedFolders) as string[];
    const all = await getFolders(credentials, [], false);
    const folders = applyRoleExclusions(all, detectSourceHeadRoles(all), {
      excludeTrash: excludedFlags.includes('\\Trash'),
      excludeJunk: excludedFlags.includes('\\Junk'),
    });
    folders.sort((a, b) => a.path.localeCompare(b.path));

    const totalMessages = folders.reduce((sum, folder) => sum + folder.messageCount, 0);
    await logJob(jobId, 'info', `Found ${folders.length} folders with ${totalMessages} messages to archive`);

    const dirByPath = new Map<string, string>();
    const manifestFolders: ArchiveManifestFolder[] = [];
    for (const folder of folders) {
      await prisma.archiveFolder.create({
        data: { jobId, path: folder.path, messageCount: folder.messageCount },
      });
      const segments = folder.path.split(folder.delimiter || '/').map(sanitizeSegment);
      dirByPath.set(folder.path, path.join(tmpDir, ...segments));
      manifestFolders.push({
        zipPath: segments.join('/'),
        originalPath: folder.path,
        name: folder.name,
        delimiter: folder.delimiter,
        specialUse: folder.specialUse,
        flaggedSpecialUse: folder.flaggedSpecialUse,
        messageCount: folder.messageCount,
      });
    }
    await prisma.archiveJob.update({
      where: { id: jobId },
      data: { totalFolders: folders.length, totalMessages },
    });

    // Fresh temp directory for this account
    await fsp.rm(tmpDir, { recursive: true, force: true });
    await fsp.mkdir(tmpDir, { recursive: true });

    // Step 2: save folder by folder, batch by batch
    const folderRows = await prisma.archiveFolder.findMany({
      where: { jobId, status: 'pending' },
      orderBy: { path: 'asc' },
    });

    let consecutiveFailures = 0;
    for (const folderRow of folderRows) {
      checkCancelled(jobId);
      await prisma.archiveFolder.update({
        where: { id: folderRow.id },
        data: { status: 'running', startedAt: new Date() },
      });
      await prisma.archiveJob.update({ where: { id: jobId }, data: { currentFolder: folderRow.path } });

      try {
        await archiveFolder(jobId, folderRow, dirByPath.get(folderRow.path)!, credentials);
        consecutiveFailures = 0;
      } catch (err) {
        if (err instanceof ArchiveJobCancelledError) throw err;

        const message = errorMessage(err);
        await prisma.archiveFolder.update({
          where: { id: folderRow.id },
          data: { status: 'failed', error: message, completedAt: new Date() },
        });
        await logJob(jobId, 'error', `Folder failed: ${message}`, folderRow.path);

        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FOLDER_FAILURES) {
          throw new Error(
            `${MAX_CONSECUTIVE_FOLDER_FAILURES} folders failed in a row (last: ${folderRow.path}) — aborting this account. Fix the connection/credentials and start a new run.`
          );
        }
      }
    }

    // Step 3: zip the account and drop the temp files. The manifest makes the
    // zip importable with full fidelity (original paths, roles, flags, dates).
    checkCancelled(jobId);
    const manifest: ArchiveManifest = {
      format: ARCHIVE_MANIFEST_FORMAT,
      version: ARCHIVE_MANIFEST_VERSION,
      email: job.email,
      exportedAt: new Date().toISOString(),
      folders: manifestFolders,
    };
    await fsp.writeFile(path.join(tmpDir, ARCHIVE_MANIFEST_NAME), JSON.stringify(manifest, null, 2));
    await prisma.archiveJob.update({ where: { id: jobId }, data: { currentFolder: '(creating zip)' } });
    await logJob(jobId, 'info', `Creating zip ${zipRelPath}`);
    await fsp.mkdir(path.dirname(zipAbsPath), { recursive: true });
    const zipSize = await zipDirectory(tmpDir, zipAbsPath);
    await prisma.archiveJob.update({ where: { id: jobId }, data: { zipPath: zipRelPath, zipSize } });
    zipRecorded = true;

    // Step 4: final status from what actually happened
    const finalJob = (await getArchiveJob(jobId))!;
    const failedFolders = await prisma.archiveFolder.count({ where: { jobId, status: 'failed' } });
    const hasErrors = finalJob.failedMessages > 0 || failedFolders > 0;
    const finalStatus: MigrationJobStatus = hasErrors ? 'completed_with_errors' : 'completed';

    await prisma.archiveJob.update({
      where: { id: jobId },
      data: { status: finalStatus, currentFolder: null, completedAt: new Date() },
    });
    await logJob(
      jobId,
      hasErrors ? 'warn' : 'info',
      `Archive finished: ${finalJob.savedMessages} saved, ${finalJob.failedMessages} failed` +
        (failedFolders > 0 ? `, ${failedFolders} folder(s) failed` : '') +
        ` — zip is ${zipSize} bytes`
    );
  } catch (err) {
    if (err instanceof ArchiveJobCancelledError) {
      await prisma.archiveJob.update({
        where: { id: jobId },
        data: { status: 'cancelled', currentFolder: null, completedAt: new Date() },
      });
      await prisma.archiveFolder.updateMany({
        where: { jobId, status: 'running' },
        data: { status: 'pending', completedAt: null },
      });
      await logJob(jobId, 'warn', 'Archiving cancelled — no zip was created for this account.');
    } else {
      const message = errorMessage(err);
      await prisma.archiveJob.update({
        where: { id: jobId },
        data: { status: 'failed', error: message, currentFolder: null, completedAt: new Date() },
      });
      await logJob(jobId, 'error', `Archiving failed: ${message}`);
    }
    // A partial zip from a failed/cancelled zipping step is useless
    if (!zipRecorded) {
      await fsp.rm(zipAbsPath, { force: true }).catch(() => {});
    }
  } finally {
    jobCancelRequests.delete(jobId);
    // The .eml files only exist to feed the zip — always drop them
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Run execution
// ---------------------------------------------------------------------------

function logRun(runId: number, level: 'info' | 'warn' | 'error', message: string): void {
  const prefix = `[archive-run:${runId}]`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// Archive all imported accounts sequentially. A failed account is recorded
// and the run continues with the next one; only cancellation stops early.
export async function runArchiveRun(runId: number, options: ArchiveRunOptions = {}): Promise<void> {
  const run = await getArchiveRun(runId);
  if (!run) return;

  const excludedFolders = [
    ...(options.excludeTrash ? ['\\Trash'] : []),
    ...(options.excludeJunk ? ['\\Junk'] : []),
  ];

  try {
    await prisma.archiveRun.update({
      where: { id: runId },
      data: { status: 'running', startedAt: new Date() },
    });

    const accounts = await prisma.archiveAccount.findMany({ orderBy: { email: 'asc' } });
    await prisma.archiveRun.update({ where: { id: runId }, data: { totalAccounts: accounts.length } });
    logRun(runId, 'info', `Starting archive run with ${accounts.length} account(s)`);

    let completedAccounts = 0;
    let failedAccounts = 0;
    let accountsWithErrors = 0;

    for (const account of accounts) {
      if (runCancelRequests.has(runId)) {
        throw new ArchiveRunCancelledError();
      }

      const job = await createArchiveJob(runId, account, excludedFolders);
      await prisma.archiveRun.update({
        where: { id: runId },
        data: { currentJobId: job.id, currentEmail: account.email },
      });
      logRun(runId, 'info', `Account ${completedAccounts + 1}/${accounts.length}: archiving ${account.email} (job #${job.id})`);

      // Never rejects — per-account problems end up as the job's status
      await runArchiveJob(job.id);

      const finished = await getArchiveJob(job.id);
      completedAccounts++;
      if (finished?.status === 'failed') {
        failedAccounts++;
      } else if (finished?.status === 'completed_with_errors') {
        accountsWithErrors++;
      } else if (finished?.status === 'cancelled') {
        // The account was cancelled via the run — surface it as a run cancellation
        await prisma.archiveRun.update({
          where: { id: runId },
          data: { completedAccounts, failedAccounts },
        });
        throw new ArchiveRunCancelledError();
      }

      await prisma.archiveRun.update({
        where: { id: runId },
        data: { completedAccounts, failedAccounts },
      });
    }

    const finalStatus: MigrationJobStatus =
      failedAccounts > 0 || accountsWithErrors > 0 ? 'completed_with_errors' : 'completed';
    await prisma.archiveRun.update({
      where: { id: runId },
      data: { status: finalStatus, currentJobId: null, currentEmail: null, completedAt: new Date() },
    });
    logRun(
      runId,
      finalStatus === 'completed' ? 'info' : 'warn',
      `Archive run finished: ${completedAccounts} account(s) processed, ${failedAccounts} failed`
    );
  } catch (err) {
    if (err instanceof ArchiveRunCancelledError) {
      await prisma.archiveRun.update({
        where: { id: runId },
        data: { status: 'cancelled', currentJobId: null, currentEmail: null, completedAt: new Date() },
      });
      logRun(runId, 'warn', 'Archive run cancelled. Zips of accounts that finished before the cancellation are still available.');
    } else {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.archiveRun.update({
        where: { id: runId },
        data: { status: 'failed', error: message, currentJobId: null, currentEmail: null, completedAt: new Date() },
      });
      logRun(runId, 'error', `Archive run failed: ${message}`);
    }
  } finally {
    runCancelRequests.delete(runId);
    // The run's whole tmp tree is dead weight once the run is over
    await fsp
      .rm(path.join(ARCHIVE_DIR, 'tmp', `run-${runId}`), { recursive: true, force: true })
      .catch(() => {});
  }
}
