import db, { MailAccount, MigrationJob, MigrationFolder, MigrationLog, MigrationJobStatus } from '../utils/db';
import { withImapClient, buildImapClient, safeCloseImapClient, ImapCredentials } from '../utils/imapClient';
import { decryptPassword } from '../utils/crypto';
import { getValidAccessToken } from './tokenManager';

// Default folders to exclude from migration
export const DEFAULT_EXCLUDED_FOLDERS = ['\\Trash', '\\Junk', 'Junk', 'Trash', 'Deleted Items', 'Junk E-mail', 'Spam'];

// Number of messages copied between progress checkpoints (DB update + cancel check)
const BATCH_SIZE = Math.max(1, parseInt(process.env.MIGRATION_BATCH_SIZE || '20', 10));

// Abort the whole job when this many folders fail in a row (points to a
// systemic problem like broken credentials rather than a bad folder)
const MAX_CONSECUTIVE_FOLDER_FAILURES = 3;

export const ACTIVE_JOB_STATUSES: MigrationJobStatus[] = ['pending', 'running'];

export interface FolderInfo {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: string;
  messageCount: number;
}

export interface MigrationPreview {
  folders: FolderInfo[];
  totalMessages: number;
  excludedFolders: string[];
}

export interface MigrationJobDetail {
  job: MigrationJob;
  folders: MigrationFolder[];
  logs: MigrationLog[];
}

class MigrationCancelledError extends Error {
  constructor() {
    super('Migration cancelled by user');
  }
}

// Cancellation flags for jobs running in this process
const cancelRequests = new Set<number>();

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

// Fetched fresh per folder so long migrations survive OAuth token expiry
async function getImapCredentials(account: MailAccount): Promise<ImapCredentials> {
  const credentials: ImapCredentials = {
    host: account.imapHost!,
    port: account.imapPort!,
    user: account.email,
  };

  if (account.type === 'imap') {
    credentials.password = decryptPassword(account.password!);
  } else if (account.type === 'microsoft') {
    credentials.accessToken = await getValidAccessToken(account.id);
  }

  return credentials;
}

// ---------------------------------------------------------------------------
// Folder listing / preview
// ---------------------------------------------------------------------------

// Check if a folder should be excluded. Name (last path segment) matching is
// only used for the built-in default list, so nested trash/junk folders are
// caught. User-supplied exclusions are full paths and must match exactly.
function shouldExcludeFolder(
  folder: { path: string; specialUse?: string; delimiter?: string },
  excludedFolders: string[],
  matchByName: boolean
): boolean {
  const folderName = folder.path.split(folder.delimiter || '/').pop() || folder.path;

  for (const excluded of excludedFolders) {
    // Match by special use (e.g., \Trash, \Junk)
    if (excluded.startsWith('\\') && folder.specialUse === excluded) {
      return true;
    }
    // Match by path (case-insensitive)
    if (folder.path.toLowerCase() === excluded.toLowerCase()) {
      return true;
    }
    // Match by folder name (last path segment)
    if (matchByName && folderName.toLowerCase() === excluded.toLowerCase()) {
      return true;
    }
  }
  return false;
}

// Get all folders from an account with message counts
export async function getFolders(
  credentials: ImapCredentials,
  excludedFolders: string[],
  matchExclusionsByName: boolean
): Promise<FolderInfo[]> {
  return await withImapClient(credentials, async (client) => {
    const mailboxes = await client.list();
    const folders: FolderInfo[] = [];

    for (const mailbox of mailboxes) {
      // Skip excluded folders
      if (
        shouldExcludeFolder(
          { path: mailbox.path, specialUse: mailbox.specialUse, delimiter: mailbox.delimiter },
          excludedFolders,
          matchExclusionsByName
        )
      ) {
        continue;
      }

      // Skip non-selectable folders (like namespace roots)
      if (mailbox.flags?.has('\\Noselect') || mailbox.flags?.has('\\NonExistent')) {
        continue;
      }

      try {
        const status = await client.status(mailbox.path, { messages: true });
        folders.push({
          path: mailbox.path,
          name: mailbox.name,
          delimiter: mailbox.delimiter || '/',
          specialUse: mailbox.specialUse,
          messageCount: status.messages || 0,
        });
      } catch (err) {
        // Skip folders we can't access
        console.warn(`Could not get status for mailbox ${mailbox.path}:`, err);
      }
    }

    return folders;
  });
}

// Get migration preview (dry run)
export async function getMigrationPreview(
  sourceAccount: MailAccount,
  excludedFolders?: string[]
): Promise<MigrationPreview> {
  const useDefaults = excludedFolders == null;
  const excluded = excludedFolders ?? DEFAULT_EXCLUDED_FOLDERS;
  const credentials = await getImapCredentials(sourceAccount);
  const folders = await getFolders(credentials, excluded, useDefaults);
  const totalMessages = folders.reduce((sum, folder) => sum + folder.messageCount, 0);

  return {
    folders,
    totalMessages,
    excludedFolders: excluded,
  };
}

// ---------------------------------------------------------------------------
// Job persistence helpers
// ---------------------------------------------------------------------------

function logJob(
  jobId: number,
  level: 'info' | 'warn' | 'error',
  message: string,
  folderPath?: string,
  uid?: number
): void {
  db.prepare('INSERT INTO migration_logs (jobId, level, folderPath, uid, message) VALUES (?, ?, ?, ?, ?)').run(
    jobId,
    level,
    folderPath ?? null,
    uid ?? null,
    message
  );
  const prefix = `[migration:${jobId}]${folderPath ? ` [${folderPath}]` : ''}`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export function getMigrationJob(jobId: number): MigrationJob | undefined {
  return db.prepare('SELECT * FROM migration_jobs WHERE id = ?').get(jobId) as MigrationJob | undefined;
}

export function getMigrationJobDetail(jobId: number): MigrationJobDetail | undefined {
  const job = getMigrationJob(jobId);
  if (!job) return undefined;

  const folders = db
    .prepare('SELECT * FROM migration_folders WHERE jobId = ? ORDER BY path')
    .all(jobId) as MigrationFolder[];
  const logs = db
    .prepare("SELECT * FROM migration_logs WHERE jobId = ? AND level IN ('warn', 'error') ORDER BY id DESC LIMIT 200")
    .all(jobId) as MigrationLog[];

  return { job, folders, logs };
}

export function listMigrationJobs(limit = 20): MigrationJob[] {
  return db.prepare('SELECT * FROM migration_jobs ORDER BY id DESC LIMIT ?').all(limit) as MigrationJob[];
}

export function findActiveMigrationJob(): MigrationJob | undefined {
  return db
    .prepare("SELECT * FROM migration_jobs WHERE status IN ('pending', 'running') ORDER BY id DESC LIMIT 1")
    .get() as MigrationJob | undefined;
}

export function createMigrationJob(
  sourceAccountId: number,
  targetAccountId: number,
  excludedFolders?: string[]
): MigrationJob {
  const info = db
    .prepare('INSERT INTO migration_jobs (sourceAccountId, targetAccountId, excludedFolders) VALUES (?, ?, ?)')
    .run(sourceAccountId, targetAccountId, JSON.stringify(excludedFolders ?? null));
  return getMigrationJob(Number(info.lastInsertRowid))!;
}

// Request cancellation of a job. Running jobs stop at the next batch
// checkpoint; jobs that are not actually running in this process (e.g. left
// over after a crash) are cancelled directly.
export function cancelMigrationJob(jobId: number): MigrationJob | undefined {
  const job = getMigrationJob(jobId);
  if (!job) return undefined;

  if (ACTIVE_JOB_STATUSES.includes(job.status)) {
    cancelRequests.add(jobId);
    logJob(jobId, 'info', 'Cancellation requested — job will stop at the next checkpoint');
  }
  return getMigrationJob(jobId);
}

// Called once on server startup: jobs that were still marked active belong to
// a previous process and are no longer running. The copied-messages ledger
// makes re-running them safe (already-copied messages are skipped).
export function recoverInterruptedJobs(): void {
  const result = db
    .prepare(
      `UPDATE migration_jobs
       SET status = 'interrupted',
           error = 'Server restarted while the migration was running. Start it again — already copied messages will be skipped.',
           completedAt = datetime('now'),
           currentFolder = NULL
       WHERE status IN ('pending', 'running')`
    )
    .run();
  if (result.changes > 0) {
    console.warn(`Marked ${result.changes} migration job(s) as interrupted after restart`);
  }
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

const stmtBumpJobCounters = () =>
  db.prepare(
    `UPDATE migration_jobs
     SET copiedMessages = copiedMessages + ?,
         skippedMessages = skippedMessages + ?,
         failedMessages = failedMessages + ?,
         processedMessages = processedMessages + ?
     WHERE id = ?`
  );

function checkCancelled(jobId: number): void {
  if (cancelRequests.has(jobId)) {
    throw new MigrationCancelledError();
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

// Copy one folder in batches. Both connections are opened fresh for the
// folder; every message is fetched and appended individually so at most one
// message is held in memory at a time. Progress is persisted after every batch.
async function migrateFolder(
  jobId: number,
  folder: MigrationFolder,
  sourceAccount: MailAccount,
  targetAccount: MailAccount
): Promise<void> {
  const sourceCredentials = await getImapCredentials(sourceAccount);
  const targetCredentials = await getImapCredentials(targetAccount);
  const source = buildImapClient(sourceCredentials);
  const target = buildImapClient(targetCredentials);

  const updateFolderCounts = db.prepare(
    'UPDATE migration_folders SET messageCount = ?, copiedCount = ?, skippedCount = ?, failedCount = ? WHERE id = ?'
  );
  const insertLedger = db.prepare(
    `INSERT OR IGNORE INTO migration_copied_messages
     (sourceAccountId, targetAccountId, folderPath, uidValidity, uid) VALUES (?, ?, ?, ?, ?)`
  );
  const bumpJob = stmtBumpJobCounters();

  try {
    await source.connect();
    await target.connect();

    const mailbox = await source.mailboxOpen(folder.path, { readOnly: true });
    const uidValidity = String((mailbox as any).uidValidity ?? '0');
    const uids: number[] = (await source.search({ all: true }, { uid: true })) || [];

    // Idempotency: skip everything the ledger says was already copied
    const copiedRows = db
      .prepare(
        `SELECT uid FROM migration_copied_messages
         WHERE sourceAccountId = ? AND targetAccountId = ? AND folderPath = ? AND uidValidity = ?`
      )
      .all(sourceAccount.id, targetAccount.id, folder.path, uidValidity) as { uid: number }[];
    const alreadyCopied = new Set(copiedRows.map((row) => row.uid));
    const pendingUids = uids.filter((uid) => !alreadyCopied.has(uid));

    const skipped = uids.length - pendingUids.length;
    let copied = 0;
    let failed = 0;

    updateFolderCounts.run(uids.length, copied, skipped, failed, folder.id);
    if (skipped > 0) {
      bumpJob.run(0, skipped, 0, skipped, jobId);
      logJob(jobId, 'info', `${skipped} of ${uids.length} messages were already migrated — skipping them`, folder.path);
    }
    logJob(jobId, 'info', `Copying ${pendingUids.length} messages in batches of ${BATCH_SIZE}`, folder.path);

    for (let offset = 0; offset < pendingUids.length; offset += BATCH_SIZE) {
      checkCancelled(jobId);
      const batch = pendingUids.slice(offset, offset + BATCH_SIZE);
      let batchCopied = 0;
      let batchFailed = 0;

      for (const uid of batch) {
        try {
          const message = await source.fetchOne(
            String(uid),
            { uid: true, flags: true, internalDate: true, source: true },
            { uid: true }
          );

          if (!message || !message.source) {
            batchFailed++;
            logJob(jobId, 'error', `Message UID ${uid} could not be fetched (no content returned)`, folder.path, uid);
            continue;
          }

          const flags = message.flags
            ? Array.from(message.flags).filter((flag) => flag !== '\\Recent')
            : [];
          await target.append(folder.targetPath, message.source, flags, message.internalDate ?? undefined);
          insertLedger.run(sourceAccount.id, targetAccount.id, folder.path, uidValidity, uid);
          batchCopied++;
        } catch (err) {
          batchFailed++;
          logJob(jobId, 'error', `Failed to copy message UID ${uid}: ${errorMessage(err)}`, folder.path, uid);
        }
      }

      copied += batchCopied;
      failed += batchFailed;

      // Checkpoint: persist progress after every batch
      updateFolderCounts.run(uids.length, copied, skipped, failed, folder.id);
      bumpJob.run(batchCopied, 0, batchFailed, batchCopied + batchFailed, jobId);

      // If the very first batch failed completely, the folder itself is broken
      // (missing on target, no append permission, ...) — abort instead of
      // producing one error per message
      if (offset === 0 && batchCopied === 0 && batchFailed === batch.length && batch.length > 1) {
        throw new Error(`All ${batch.length} messages in the first batch failed — aborting this folder`);
      }
    }

    const status = failed > 0 ? 'completed_with_errors' : 'completed';
    db.prepare("UPDATE migration_folders SET status = ?, completedAt = datetime('now') WHERE id = ?").run(
      status,
      folder.id
    );
    logJob(jobId, failed > 0 ? 'warn' : 'info', `Folder done: ${copied} copied, ${skipped} skipped, ${failed} failed`, folder.path);
  } finally {
    await safeCloseImapClient(source);
    await safeCloseImapClient(target);
  }
}

// Run a migration job to completion. Never rejects for per-folder or
// per-message problems — those are logged and counted; only cancellation or a
// systemic failure ends the job early.
export async function runMigrationJob(jobId: number): Promise<void> {
  const job = getMigrationJob(jobId);
  if (!job) return;

  try {
    db.prepare("UPDATE migration_jobs SET status = 'running', startedAt = datetime('now') WHERE id = ?").run(jobId);

    const sourceAccount = db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(job.sourceAccountId) as
      | MailAccount
      | undefined;
    const targetAccount = db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(job.targetAccountId) as
      | MailAccount
      | undefined;
    if (!sourceAccount || !targetAccount) {
      throw new Error('Source or target account no longer exists');
    }

    logJob(jobId, 'info', `Starting migration: ${sourceAccount.email} -> ${targetAccount.email}`);

    // Step 1: list source folders
    const parsedExclusions = JSON.parse(job.excludedFolders) as string[] | null;
    const useDefaults = parsedExclusions == null;
    const excluded = parsedExclusions ?? DEFAULT_EXCLUDED_FOLDERS;

    const sourceCredentials = await getImapCredentials(sourceAccount);
    const folders = await getFolders(sourceCredentials, excluded, useDefaults);
    // Parents sort before their children, so nested folders are created in order
    folders.sort((a, b) => a.path.localeCompare(b.path));

    const totalMessages = folders.reduce((sum, folder) => sum + folder.messageCount, 0);
    logJob(jobId, 'info', `Found ${folders.length} folders with ${totalMessages} messages to migrate`);

    // Step 2: create missing folders on the target (delimiter-translated)
    const targetCredentials = await getImapCredentials(targetAccount);
    const insertFolder = db.prepare(
      'INSERT INTO migration_folders (jobId, path, targetPath, status, messageCount, error) VALUES (?, ?, ?, ?, ?, ?)'
    );

    checkCancelled(jobId);
    await withImapClient(targetCredentials, async (client) => {
      const existing = await client.list();
      const targetDelimiter = existing.find((m) => m.delimiter)?.delimiter || '/';
      const existingPaths = new Set(existing.map((m) => m.path));

      for (const folder of folders) {
        const segments = folder.path.split(folder.delimiter);
        const targetPath = segments.join(targetDelimiter);
        let error: string | null = null;

        if (!existingPaths.has(targetPath)) {
          try {
            await client.mailboxCreate(segments);
            existingPaths.add(targetPath);
            logJob(jobId, 'info', `Created folder on target: ${targetPath}`, folder.path);
          } catch (err) {
            error = `Could not create folder on target: ${errorMessage(err)}`;
            logJob(jobId, 'error', error, folder.path);
          }
        }

        insertFolder.run(jobId, folder.path, targetPath, error ? 'failed' : 'pending', folder.messageCount, error);
      }
    });

    db.prepare('UPDATE migration_jobs SET totalFolders = ?, totalMessages = ? WHERE id = ?').run(
      folders.length,
      totalMessages,
      jobId
    );

    // Step 3: copy folder by folder, batch by batch
    const folderRows = db
      .prepare("SELECT * FROM migration_folders WHERE jobId = ? AND status = 'pending' ORDER BY path")
      .all(jobId) as MigrationFolder[];

    let consecutiveFailures = 0;
    for (const folderRow of folderRows) {
      checkCancelled(jobId);
      db.prepare("UPDATE migration_folders SET status = 'running', startedAt = datetime('now') WHERE id = ?").run(
        folderRow.id
      );
      db.prepare('UPDATE migration_jobs SET currentFolder = ? WHERE id = ?').run(folderRow.path, jobId);

      try {
        await migrateFolder(jobId, folderRow, sourceAccount, targetAccount);
        consecutiveFailures = 0;
      } catch (err) {
        if (err instanceof MigrationCancelledError) throw err;

        const message = errorMessage(err);
        db.prepare(
          "UPDATE migration_folders SET status = 'failed', error = ?, completedAt = datetime('now') WHERE id = ?"
        ).run(message, folderRow.id);
        logJob(jobId, 'error', `Folder failed: ${message}`, folderRow.path);

        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FOLDER_FAILURES) {
          throw new Error(
            `${MAX_CONSECUTIVE_FOLDER_FAILURES} folders failed in a row (last: ${folderRow.path}) — aborting job. Fix the connection/credentials and start the migration again; completed work will be skipped.`
          );
        }
      }
    }

    // Step 4: final status from what actually happened
    const finalJob = getMigrationJob(jobId)!;
    const failedFolders = db
      .prepare("SELECT COUNT(*) AS count FROM migration_folders WHERE jobId = ? AND status = 'failed'")
      .get(jobId) as { count: number };
    const hasErrors = finalJob.failedMessages > 0 || failedFolders.count > 0;
    const finalStatus: MigrationJobStatus = hasErrors ? 'completed_with_errors' : 'completed';

    db.prepare(
      "UPDATE migration_jobs SET status = ?, currentFolder = NULL, completedAt = datetime('now') WHERE id = ?"
    ).run(finalStatus, jobId);
    logJob(
      jobId,
      hasErrors ? 'warn' : 'info',
      `Migration finished: ${finalJob.copiedMessages} copied, ${finalJob.skippedMessages} skipped, ${finalJob.failedMessages} failed` +
        (failedFolders.count > 0 ? `, ${failedFolders.count} folder(s) failed` : '')
    );
  } catch (err) {
    if (err instanceof MigrationCancelledError) {
      db.prepare(
        "UPDATE migration_jobs SET status = 'cancelled', currentFolder = NULL, completedAt = datetime('now') WHERE id = ?"
      ).run(jobId);
      db.prepare(
        "UPDATE migration_folders SET status = 'pending', completedAt = NULL WHERE jobId = ? AND status = 'running'"
      ).run(jobId);
      logJob(jobId, 'warn', 'Migration cancelled. Start it again to resume — already copied messages will be skipped.');
    } else {
      const message = errorMessage(err);
      db.prepare(
        "UPDATE migration_jobs SET status = 'failed', error = ?, currentFolder = NULL, completedAt = datetime('now') WHERE id = ?"
      ).run(message, jobId);
      logJob(jobId, 'error', `Migration failed: ${message}`);
    }
  } finally {
    cancelRequests.delete(jobId);
  }
}
