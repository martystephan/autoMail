import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { ZipArchive } from 'archiver';
import db, {
  ArchiveAccount,
  ArchiveFolder,
  ArchiveJob,
  ArchiveLog,
  ArchiveRun,
  MigrationJobStatus,
} from '../utils/db';
import { encryptPassword, decryptPassword } from '../utils/crypto';
import { withImapClient, buildImapClient, safeCloseImapClient, ImapCredentials } from '../utils/imapClient';
import { getFolders, detectSourceHeadRoles, applyRoleExclusions } from './migration';

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
  createdAt: string;
  updatedAt: string;
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

const VIEW_COLUMNS = 'id, email, username, imapHost, imapPort, createdAt, updatedAt';

function listArchiveAccountViews(): ArchiveAccountView[] {
  return db.prepare(`SELECT ${VIEW_COLUMNS} FROM archive_accounts ORDER BY email`).all() as ArchiveAccountView[];
}

// Replace the imported accounts: upsert by email, rows missing from the new
// import are removed. The CSV stays the source of truth — this table is just
// the working copy the runs connect with.
export function replaceArchiveAccounts(
  imapHost: string,
  imapPort: number,
  rows: ArchiveImportRow[]
): ArchiveImportResult {
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

  const upsert = db.prepare(
    `INSERT INTO archive_accounts (email, username, password, imapHost, imapPort)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       username = excluded.username,
       password = excluded.password,
       imapHost = excluded.imapHost,
       imapPort = excluded.imapPort,
       updatedAt = datetime('now')`
  );

  db.transaction(() => {
    for (const [email, row] of byEmail) {
      upsert.run(email, row.username, encryptPassword(row.password), imapHost, imapPort);
    }
    const placeholders = Array.from(byEmail.keys(), () => '?').join(', ');
    db.prepare(`DELETE FROM archive_accounts WHERE email NOT IN (${placeholders})`).run(...byEmail.keys());
  })();

  connectionTested = false;
  return { accounts: listArchiveAccountViews(), warnings };
}

export function deleteArchiveAccounts(): number {
  connectionTested = false;
  return db.prepare('DELETE FROM archive_accounts').run().changes;
}

export function getArchiveOverview(): ArchiveOverview {
  return { accounts: listArchiveAccountViews(), tested: connectionTested };
}

// Quick credential check against one imported row (all rows share host/port,
// so one successful login validates the server settings)
export async function testArchiveConnection(email?: string): Promise<{ ok: boolean; error?: string }> {
  const row = (
    email
      ? db.prepare('SELECT * FROM archive_accounts WHERE email = ?').get(email.trim().toLowerCase())
      : db.prepare('SELECT * FROM archive_accounts ORDER BY email LIMIT 1').get()
  ) as ArchiveAccount | undefined;

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

export function getArchiveRun(runId: number): ArchiveRun | undefined {
  return db.prepare('SELECT * FROM archive_runs WHERE id = ?').get(runId) as ArchiveRun | undefined;
}

export function listArchiveRuns(limit = 20): ArchiveRun[] {
  return db.prepare('SELECT * FROM archive_runs ORDER BY id DESC LIMIT ?').all(limit) as ArchiveRun[];
}

export function findActiveArchiveRun(): ArchiveRun | undefined {
  return db
    .prepare("SELECT * FROM archive_runs WHERE status IN ('pending', 'running') ORDER BY id DESC LIMIT 1")
    .get() as ArchiveRun | undefined;
}

export function getArchiveJob(jobId: number): ArchiveJob | undefined {
  return db.prepare('SELECT * FROM archive_jobs WHERE id = ?').get(jobId) as ArchiveJob | undefined;
}

export function getArchiveJobDetail(jobId: number): ArchiveJobDetail | undefined {
  const job = getArchiveJob(jobId);
  if (!job) return undefined;

  const folders = db.prepare('SELECT * FROM archive_folders WHERE jobId = ? ORDER BY path').all(jobId) as ArchiveFolder[];
  const logs = db
    .prepare("SELECT * FROM archive_logs WHERE jobId = ? AND level IN ('warn', 'error') ORDER BY id DESC LIMIT 200")
    .all(jobId) as ArchiveLog[];

  return { job, folders, logs };
}

export function listArchiveJobsByRun(runId: number): ArchiveJob[] {
  return db.prepare('SELECT * FROM archive_jobs WHERE runId = ? ORDER BY id').all(runId) as ArchiveJob[];
}

export function getArchiveRunDetail(runId: number): ArchiveRunDetail | undefined {
  const run = getArchiveRun(runId);
  if (!run) return undefined;

  const jobs = listArchiveJobsByRun(runId);
  const currentJobDetail = run.currentJobId ? getArchiveJobDetail(run.currentJobId) ?? null : null;

  return { run, jobs, currentJobDetail };
}

export function createArchiveRun(totalAccounts: number): ArchiveRun {
  const info = db.prepare('INSERT INTO archive_runs (totalAccounts) VALUES (?)').run(totalAccounts);
  return getArchiveRun(Number(info.lastInsertRowid))!;
}

function createArchiveJob(runId: number, account: ArchiveAccount, excludedFolders: string[]): ArchiveJob {
  const info = db
    .prepare('INSERT INTO archive_jobs (runId, archiveAccountId, email, excludedFolders) VALUES (?, ?, ?, ?)')
    .run(runId, account.id, account.email, JSON.stringify(excludedFolders));
  return getArchiveJob(Number(info.lastInsertRowid))!;
}

export function cancelArchiveRun(runId: number): ArchiveRun | undefined {
  const run = getArchiveRun(runId);
  if (!run) return undefined;

  if (ACTIVE_RUN_STATUSES.includes(run.status)) {
    runCancelRequests.add(runId);
    if (run.currentJobId) {
      const currentJob = getArchiveJob(run.currentJobId);
      if (currentJob && ACTIVE_RUN_STATUSES.includes(currentJob.status)) {
        jobCancelRequests.add(run.currentJobId);
        logJob(run.currentJobId, 'info', 'Cancellation requested — job will stop at the next checkpoint');
      }
    }
  }
  return getArchiveRun(runId);
}

// Delete a finished run: its zips on disk plus all records (jobs, folders and
// logs go via ON DELETE CASCADE)
export function deleteArchiveRun(runId: number): boolean {
  const run = getArchiveRun(runId);
  if (!run) return false;
  if (ACTIVE_RUN_STATUSES.includes(run.status)) {
    throw new Error('This archive run is still active — cancel it before deleting');
  }

  fs.rmSync(path.join(ARCHIVE_DIR, `run-${runId}`), { recursive: true, force: true });
  db.prepare('DELETE FROM archive_runs WHERE id = ?').run(runId);
  return true;
}

// The whole archive project disappears: imports, runs, zips and job history
export function deleteArchiveSession(): void {
  const runs = db.prepare('SELECT id FROM archive_runs').all() as { id: number }[];
  for (const run of runs) {
    fs.rmSync(path.join(ARCHIVE_DIR, `run-${run.id}`), { recursive: true, force: true });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM archive_runs').run();
    db.prepare('DELETE FROM archive_accounts').run();
  })();
  connectionTested = false;
}

// Called once on server startup: jobs and runs still marked active belong to
// a previous process and are no longer running. Zips of accounts that
// finished before the crash are kept; the interrupted account has no zip.
export function recoverInterruptedArchiveJobs(): void {
  const result = db
    .prepare(
      `UPDATE archive_jobs
       SET status = 'interrupted',
           error = 'Server restarted while the account was being archived. Start a new run for this account.',
           completedAt = datetime('now'),
           currentFolder = NULL
       WHERE status IN ('pending', 'running')`
    )
    .run();
  if (result.changes > 0) {
    console.warn(`Marked ${result.changes} archive job(s) as interrupted after restart`);
  }

  const runResult = db
    .prepare(
      `UPDATE archive_runs
       SET status = 'interrupted',
           error = 'Server restarted while the archive run was running. Zips created before the restart are still available.',
           completedAt = datetime('now'),
           currentJobId = NULL,
           currentEmail = NULL
       WHERE status IN ('pending', 'running')`
    )
    .run();
  if (runResult.changes > 0) {
    console.warn(`Marked ${runResult.changes} archive run(s) as interrupted after restart`);
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

function logJob(
  jobId: number,
  level: 'info' | 'warn' | 'error',
  message: string,
  folderPath?: string,
  uid?: number
): void {
  db.prepare('INSERT INTO archive_logs (jobId, level, folderPath, uid, message) VALUES (?, ?, ?, ?, ?)').run(
    jobId,
    level,
    folderPath ?? null,
    uid ?? null,
    message
  );
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

const stmtBumpJobCounters = () =>
  db.prepare(
    `UPDATE archive_jobs
     SET savedMessages = savedMessages + ?,
         failedMessages = failedMessages + ?,
         processedMessages = processedMessages + ?
     WHERE id = ?`
  );

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

  const updateFolderCounts = db.prepare(
    'UPDATE archive_folders SET messageCount = ?, savedCount = ?, failedCount = ? WHERE id = ?'
  );
  const bumpJob = stmtBumpJobCounters();

  await fsp.mkdir(folderDir, { recursive: true });

  try {
    await source.connect();
    await source.mailboxOpen(folder.path, { readOnly: true });
    const uids: number[] = (await source.search({ all: true }, { uid: true })) || [];

    let saved = 0;
    let failed = 0;

    updateFolderCounts.run(uids.length, saved, failed, folder.id);
    logJob(jobId, 'info', `Saving ${uids.length} messages in batches of ${BATCH_SIZE}`, folder.path);

    for (let offset = 0; offset < uids.length; offset += BATCH_SIZE) {
      checkCancelled(jobId);
      const batch = uids.slice(offset, offset + BATCH_SIZE);
      let batchSaved = 0;
      let batchFailed = 0;

      for (const uid of batch) {
        try {
          const message = await source.fetchOne(
            String(uid),
            { uid: true, envelope: true, source: true },
            { uid: true }
          );

          if (!message || !message.source) {
            batchFailed++;
            logJob(jobId, 'error', `Message UID ${uid} could not be fetched (no content returned)`, folder.path, uid);
            continue;
          }

          await fsp.writeFile(emlFilePath(folderDir, uid, message.envelope?.subject), message.source);
          batchSaved++;
        } catch (err) {
          batchFailed++;
          logJob(jobId, 'error', `Failed to save message UID ${uid}: ${errorMessage(err)}`, folder.path, uid);
        }
      }

      saved += batchSaved;
      failed += batchFailed;

      // Checkpoint: persist progress after every batch
      updateFolderCounts.run(uids.length, saved, failed, folder.id);
      bumpJob.run(batchSaved, batchFailed, batchSaved + batchFailed, jobId);

      // If the very first batch failed completely, the folder itself is broken
      // (disk full, no read permission, ...) — abort instead of producing one
      // error per message
      if (offset === 0 && batchSaved === 0 && batchFailed === batch.length && batch.length > 1) {
        throw new Error(`All ${batch.length} messages in the first batch failed — aborting this folder`);
      }
    }

    const status = failed > 0 ? 'completed_with_errors' : 'completed';
    db.prepare("UPDATE archive_folders SET status = ?, completedAt = datetime('now') WHERE id = ?").run(
      status,
      folder.id
    );
    logJob(jobId, failed > 0 ? 'warn' : 'info', `Folder done: ${saved} saved, ${failed} failed`, folder.path);
  } finally {
    await safeCloseImapClient(source);
  }
}

// Archive one account to a zip. Never rejects for per-folder or per-message
// problems — those are logged and counted; only cancellation or a systemic
// failure ends the job early.
async function runArchiveJob(jobId: number): Promise<void> {
  const job = getArchiveJob(jobId);
  if (!job) return;

  const accountSegment = sanitizeSegment(job.email);
  const tmpDir = path.join(ARCHIVE_DIR, 'tmp', `run-${job.runId}`, accountSegment);
  const zipRelPath = path.join(`run-${job.runId}`, `${accountSegment}.zip`);
  const zipAbsPath = path.join(ARCHIVE_DIR, zipRelPath);
  let zipRecorded = false;

  try {
    db.prepare("UPDATE archive_jobs SET status = 'running', startedAt = datetime('now') WHERE id = ?").run(jobId);

    const account = db.prepare('SELECT * FROM archive_accounts WHERE id = ?').get(job.archiveAccountId) as
      | ArchiveAccount
      | undefined;
    if (!account) {
      throw new Error('Account no longer exists');
    }
    const credentials: ImapCredentials = {
      host: account.imapHost,
      port: account.imapPort,
      user: account.username,
      password: decryptPassword(account.password),
    };

    logJob(jobId, 'info', `Starting archive of ${job.email}`);

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
    logJob(jobId, 'info', `Found ${folders.length} folders with ${totalMessages} messages to archive`);

    const insertFolder = db.prepare(
      'INSERT INTO archive_folders (jobId, path, messageCount) VALUES (?, ?, ?)'
    );
    const dirByPath = new Map<string, string>();
    for (const folder of folders) {
      insertFolder.run(jobId, folder.path, folder.messageCount);
      const segments = folder.path.split(folder.delimiter || '/').map(sanitizeSegment);
      dirByPath.set(folder.path, path.join(tmpDir, ...segments));
    }
    db.prepare('UPDATE archive_jobs SET totalFolders = ?, totalMessages = ? WHERE id = ?').run(
      folders.length,
      totalMessages,
      jobId
    );

    // Fresh temp directory for this account
    await fsp.rm(tmpDir, { recursive: true, force: true });
    await fsp.mkdir(tmpDir, { recursive: true });

    // Step 2: save folder by folder, batch by batch
    const folderRows = db
      .prepare("SELECT * FROM archive_folders WHERE jobId = ? AND status = 'pending' ORDER BY path")
      .all(jobId) as ArchiveFolder[];

    let consecutiveFailures = 0;
    for (const folderRow of folderRows) {
      checkCancelled(jobId);
      db.prepare("UPDATE archive_folders SET status = 'running', startedAt = datetime('now') WHERE id = ?").run(
        folderRow.id
      );
      db.prepare('UPDATE archive_jobs SET currentFolder = ? WHERE id = ?').run(folderRow.path, jobId);

      try {
        await archiveFolder(jobId, folderRow, dirByPath.get(folderRow.path)!, credentials);
        consecutiveFailures = 0;
      } catch (err) {
        if (err instanceof ArchiveJobCancelledError) throw err;

        const message = errorMessage(err);
        db.prepare(
          "UPDATE archive_folders SET status = 'failed', error = ?, completedAt = datetime('now') WHERE id = ?"
        ).run(message, folderRow.id);
        logJob(jobId, 'error', `Folder failed: ${message}`, folderRow.path);

        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FOLDER_FAILURES) {
          throw new Error(
            `${MAX_CONSECUTIVE_FOLDER_FAILURES} folders failed in a row (last: ${folderRow.path}) — aborting this account. Fix the connection/credentials and start a new run.`
          );
        }
      }
    }

    // Step 3: zip the account and drop the temp files
    checkCancelled(jobId);
    db.prepare('UPDATE archive_jobs SET currentFolder = ? WHERE id = ?').run('(creating zip)', jobId);
    logJob(jobId, 'info', `Creating zip ${zipRelPath}`);
    await fsp.mkdir(path.dirname(zipAbsPath), { recursive: true });
    const zipSize = await zipDirectory(tmpDir, zipAbsPath);
    db.prepare('UPDATE archive_jobs SET zipPath = ?, zipSize = ? WHERE id = ?').run(zipRelPath, zipSize, jobId);
    zipRecorded = true;

    // Step 4: final status from what actually happened
    const finalJob = getArchiveJob(jobId)!;
    const failedFolders = db
      .prepare("SELECT COUNT(*) AS count FROM archive_folders WHERE jobId = ? AND status = 'failed'")
      .get(jobId) as { count: number };
    const hasErrors = finalJob.failedMessages > 0 || failedFolders.count > 0;
    const finalStatus: MigrationJobStatus = hasErrors ? 'completed_with_errors' : 'completed';

    db.prepare(
      "UPDATE archive_jobs SET status = ?, currentFolder = NULL, completedAt = datetime('now') WHERE id = ?"
    ).run(finalStatus, jobId);
    logJob(
      jobId,
      hasErrors ? 'warn' : 'info',
      `Archive finished: ${finalJob.savedMessages} saved, ${finalJob.failedMessages} failed` +
        (failedFolders.count > 0 ? `, ${failedFolders.count} folder(s) failed` : '') +
        ` — zip is ${zipSize} bytes`
    );
  } catch (err) {
    if (err instanceof ArchiveJobCancelledError) {
      db.prepare(
        "UPDATE archive_jobs SET status = 'cancelled', currentFolder = NULL, completedAt = datetime('now') WHERE id = ?"
      ).run(jobId);
      db.prepare(
        "UPDATE archive_folders SET status = 'pending', completedAt = NULL WHERE jobId = ? AND status = 'running'"
      ).run(jobId);
      logJob(jobId, 'warn', 'Archiving cancelled — no zip was created for this account.');
    } else {
      const message = errorMessage(err);
      db.prepare(
        "UPDATE archive_jobs SET status = 'failed', error = ?, currentFolder = NULL, completedAt = datetime('now') WHERE id = ?"
      ).run(message, jobId);
      logJob(jobId, 'error', `Archiving failed: ${message}`);
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
  const run = getArchiveRun(runId);
  if (!run) return;

  const excludedFolders = [
    ...(options.excludeTrash ? ['\\Trash'] : []),
    ...(options.excludeJunk ? ['\\Junk'] : []),
  ];

  try {
    db.prepare("UPDATE archive_runs SET status = 'running', startedAt = datetime('now') WHERE id = ?").run(runId);

    const accounts = db.prepare('SELECT * FROM archive_accounts ORDER BY email').all() as ArchiveAccount[];
    db.prepare('UPDATE archive_runs SET totalAccounts = ? WHERE id = ?').run(accounts.length, runId);
    logRun(runId, 'info', `Starting archive run with ${accounts.length} account(s)`);

    let completedAccounts = 0;
    let failedAccounts = 0;
    let accountsWithErrors = 0;

    for (const account of accounts) {
      if (runCancelRequests.has(runId)) {
        throw new ArchiveRunCancelledError();
      }

      const job = createArchiveJob(runId, account, excludedFolders);
      db.prepare('UPDATE archive_runs SET currentJobId = ?, currentEmail = ? WHERE id = ?').run(
        job.id,
        account.email,
        runId
      );
      logRun(runId, 'info', `Account ${completedAccounts + 1}/${accounts.length}: archiving ${account.email} (job #${job.id})`);

      // Never rejects — per-account problems end up as the job's status
      await runArchiveJob(job.id);

      const finished = getArchiveJob(job.id);
      completedAccounts++;
      if (finished?.status === 'failed') {
        failedAccounts++;
      } else if (finished?.status === 'completed_with_errors') {
        accountsWithErrors++;
      } else if (finished?.status === 'cancelled') {
        // The account was cancelled via the run — surface it as a run cancellation
        db.prepare('UPDATE archive_runs SET completedAccounts = ?, failedAccounts = ? WHERE id = ?').run(
          completedAccounts,
          failedAccounts,
          runId
        );
        throw new ArchiveRunCancelledError();
      }

      db.prepare('UPDATE archive_runs SET completedAccounts = ?, failedAccounts = ? WHERE id = ?').run(
        completedAccounts,
        failedAccounts,
        runId
      );
    }

    const finalStatus: MigrationJobStatus =
      failedAccounts > 0 || accountsWithErrors > 0 ? 'completed_with_errors' : 'completed';
    db.prepare(
      "UPDATE archive_runs SET status = ?, currentJobId = NULL, currentEmail = NULL, completedAt = datetime('now') WHERE id = ?"
    ).run(finalStatus, runId);
    logRun(
      runId,
      finalStatus === 'completed' ? 'info' : 'warn',
      `Archive run finished: ${completedAccounts} account(s) processed, ${failedAccounts} failed`
    );
  } catch (err) {
    if (err instanceof ArchiveRunCancelledError) {
      db.prepare(
        "UPDATE archive_runs SET status = 'cancelled', currentJobId = NULL, currentEmail = NULL, completedAt = datetime('now') WHERE id = ?"
      ).run(runId);
      logRun(runId, 'warn', 'Archive run cancelled. Zips of accounts that finished before the cancellation are still available.');
    } else {
      const message = err instanceof Error ? err.message : String(err);
      db.prepare(
        "UPDATE archive_runs SET status = 'failed', error = ?, currentJobId = NULL, currentEmail = NULL, completedAt = datetime('now') WHERE id = ?"
      ).run(message, runId);
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
