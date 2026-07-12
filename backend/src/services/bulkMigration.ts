import db, { BulkAccount, BulkRole, BulkRun, MigrationJob, MigrationJobStatus } from '../utils/db';
import { encryptPassword, decryptPassword } from '../utils/crypto';
import { withImapClient } from '../utils/imapClient';
import {
  ACTIVE_JOB_STATUSES,
  MigrationJobDetail,
  TRASH_FOLDERS,
  JUNK_FOLDERS,
  createBulkPairJob,
  runMigrationJob,
  getMigrationJob,
  getMigrationJobDetail,
  listMigrationJobsByBulkRun,
  cancelMigrationJob,
} from './migration';

export interface BulkRunOptions {
  excludeTrash?: boolean; // default true
  excludeJunk?: boolean; // default true
}

export const ACTIVE_RUN_STATUSES: MigrationJobStatus[] = ['pending', 'running'];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Bulk account rows as returned to the client — never includes the password
export interface BulkAccountView {
  id: number;
  role: BulkRole;
  email: string;
  targetEmail: string | null;
  username: string;
  imapHost: string;
  imapPort: number;
  createdAt: string;
  updatedAt: string;
}

export interface BulkPair {
  sourceEmail: string;
  targetEmail: string;
  sourceId: number;
  targetId: number;
}

export interface BulkOverview {
  source: BulkAccountView[];
  target: BulkAccountView[];
  pairs: BulkPair[];
  unmatchedSource: string[];
  unmatchedTarget: string[];
  // Whether each side's connection test succeeded for the current import
  tested: Record<BulkRole, boolean>;
}

export interface BulkImportRow {
  email: string;
  username: string;
  password: string;
  targetEmail?: string; // source rows only
}

export interface BulkImportResult {
  accounts: BulkAccountView[];
  warnings: string[];
}

export interface BulkRunDetail {
  run: BulkRun;
  jobs: MigrationJob[];
  currentJobDetail: MigrationJobDetail | null;
}

class BulkRunCancelledError extends Error {
  constructor() {
    super('Bulk migration cancelled by user');
  }
}

// Cancellation flags for bulk runs running in this process
const bulkCancelRequests = new Set<number>();

// Successful connection tests per role. Reset whenever that import changes
// (and on restart) — starting a run requires both tests to have passed.
const connectionTested: Record<BulkRole, boolean> = { source: false, target: false };

// ---------------------------------------------------------------------------
// Account import / overview
// ---------------------------------------------------------------------------

const VIEW_COLUMNS = 'id, role, email, targetEmail, username, imapHost, imapPort, createdAt, updatedAt';

function listBulkAccountViews(role: BulkRole): BulkAccountView[] {
  return db
    .prepare(`SELECT ${VIEW_COLUMNS} FROM bulk_accounts WHERE role = ? ORDER BY email`)
    .all(role) as BulkAccountView[];
}

// Replace the imported accounts for one role: upsert by (role, email), rows
// missing from the new import are removed. The CSVs stay the source of truth —
// this table is just the working copy the runs connect with.
export function replaceBulkAccounts(
  role: BulkRole,
  imapHost: string,
  imapPort: number,
  rows: BulkImportRow[]
): BulkImportResult {
  const warnings: string[] = [];
  const byEmail = new Map<string, { username: string; password: string; targetEmail: string | null }>();

  for (const [index, row] of rows.entries()) {
    const email = String(row.email ?? '').trim().toLowerCase();
    const username = String(row.username ?? '').trim();
    const password = String(row.password ?? '');
    const targetEmail = String(row.targetEmail ?? '').trim().toLowerCase() || null;

    if (!EMAIL_REGEX.test(email)) {
      throw new Error(`Row ${index + 1}: "${email || '(empty)'}" is not a valid email address`);
    }
    if (!username) {
      throw new Error(`Row ${index + 1} (${email}): username is empty`);
    }
    if (!password) {
      throw new Error(`Row ${index + 1} (${email}): password is empty`);
    }
    if (targetEmail && role === 'target') {
      throw new Error(`Row ${index + 1} (${email}): target accounts cannot have a target column`);
    }
    if (targetEmail && !EMAIL_REGEX.test(targetEmail)) {
      throw new Error(`Row ${index + 1} (${email}): target "${targetEmail}" is not a valid email address`);
    }
    if (byEmail.has(email)) {
      warnings.push(`Duplicate email ${email} — the last occurrence was used`);
    }
    byEmail.set(email, { username, password, targetEmail });
  }

  if (byEmail.size === 0) {
    throw new Error('The import contains no rows');
  }

  const upsert = db.prepare(
    `INSERT INTO bulk_accounts (role, email, targetEmail, username, password, imapHost, imapPort)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(role, email) DO UPDATE SET
       targetEmail = excluded.targetEmail,
       username = excluded.username,
       password = excluded.password,
       imapHost = excluded.imapHost,
       imapPort = excluded.imapPort,
       updatedAt = datetime('now')`
  );

  db.transaction(() => {
    for (const [email, row] of byEmail) {
      upsert.run(role, email, row.targetEmail, row.username, encryptPassword(row.password), imapHost, imapPort);
    }
    const placeholders = Array.from(byEmail.keys(), () => '?').join(', ');
    db.prepare(`DELETE FROM bulk_accounts WHERE role = ? AND email NOT IN (${placeholders})`).run(
      role,
      ...byEmail.keys()
    );
  })();

  connectionTested[role] = false;
  return { accounts: listBulkAccountViews(role), warnings };
}

export function deleteBulkAccounts(role: BulkRole): number {
  connectionTested[role] = false;
  return db.prepare('DELETE FROM bulk_accounts WHERE role = ?').run(role).changes;
}

// The whole migration project disappears: imports, runs, and job history
// (pair jobs, their folders and logs go via ON DELETE CASCADE)
export function deleteBulkSession(): void {
  db.transaction(() => {
    db.prepare("DELETE FROM migration_jobs WHERE mode = 'bulk'").run();
    db.prepare('DELETE FROM bulk_runs').run();
    db.prepare('DELETE FROM bulk_accounts').run();
  })();
  connectionTested.source = false;
  connectionTested.target = false;
}

// A source row matches the target row whose email equals the source's target
// column, falling back to the source's own email when no target is given
function getMatchedPairs(): BulkPair[] {
  return db
    .prepare(
      `SELECT s.email AS sourceEmail, t.email AS targetEmail, s.id AS sourceId, t.id AS targetId
       FROM bulk_accounts s
       JOIN bulk_accounts t ON t.role = 'target' AND t.email = COALESCE(s.targetEmail, s.email)
       WHERE s.role = 'source'
       ORDER BY s.email`
    )
    .all() as BulkPair[];
}

export function getBulkOverview(): BulkOverview {
  const source = listBulkAccountViews('source');
  const target = listBulkAccountViews('target');
  const pairs = getMatchedPairs();
  const matchedSourceIds = new Set(pairs.map((pair) => pair.sourceId));
  const matchedTargetIds = new Set(pairs.map((pair) => pair.targetId));

  return {
    source,
    target,
    pairs,
    unmatchedSource: source.filter((row) => !matchedSourceIds.has(row.id)).map((row) => row.email),
    unmatchedTarget: target.filter((row) => !matchedTargetIds.has(row.id)).map((row) => row.email),
    tested: { ...connectionTested },
  };
}

// Quick credential check against one imported row (all rows of a role share
// host/port, so one successful login validates the server settings)
export async function testBulkConnection(role: BulkRole, email?: string): Promise<{ ok: boolean; error?: string }> {
  const row = (
    email
      ? db.prepare('SELECT * FROM bulk_accounts WHERE role = ? AND email = ?').get(role, email.trim().toLowerCase())
      : db.prepare('SELECT * FROM bulk_accounts WHERE role = ? ORDER BY email LIMIT 1').get(role)
  ) as BulkAccount | undefined;

  if (!row) {
    return { ok: false, error: email ? `No imported ${role} account with email ${email}` : `No ${role} accounts imported` };
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
    connectionTested[role] = true;
    return { ok: true };
  } catch (err) {
    connectionTested[role] = false;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Run persistence
// ---------------------------------------------------------------------------

export function getBulkRun(runId: number): BulkRun | undefined {
  return db.prepare('SELECT * FROM bulk_runs WHERE id = ?').get(runId) as BulkRun | undefined;
}

export function listBulkRuns(limit = 20): BulkRun[] {
  return db.prepare('SELECT * FROM bulk_runs ORDER BY id DESC LIMIT ?').all(limit) as BulkRun[];
}

export function findActiveBulkRun(): BulkRun | undefined {
  return db
    .prepare("SELECT * FROM bulk_runs WHERE status IN ('pending', 'running') ORDER BY id DESC LIMIT 1")
    .get() as BulkRun | undefined;
}

export function getBulkRunDetail(runId: number): BulkRunDetail | undefined {
  const run = getBulkRun(runId);
  if (!run) return undefined;

  const jobs = listMigrationJobsByBulkRun(runId);
  const currentJobDetail = run.currentJobId ? getMigrationJobDetail(run.currentJobId) ?? null : null;

  return { run, jobs, currentJobDetail };
}

export function createBulkRun(totalPairs: number): BulkRun {
  const info = db.prepare('INSERT INTO bulk_runs (totalPairs) VALUES (?)').run(totalPairs);
  return getBulkRun(Number(info.lastInsertRowid))!;
}

export function cancelBulkRun(runId: number): BulkRun | undefined {
  const run = getBulkRun(runId);
  if (!run) return undefined;

  if (ACTIVE_RUN_STATUSES.includes(run.status)) {
    bulkCancelRequests.add(runId);
    if (run.currentJobId) {
      const currentJob = getMigrationJob(run.currentJobId);
      if (currentJob && ACTIVE_JOB_STATUSES.includes(currentJob.status)) {
        cancelMigrationJob(run.currentJobId);
      }
    }
  }
  return getBulkRun(runId);
}

// ---------------------------------------------------------------------------
// Run execution
// ---------------------------------------------------------------------------

function logRun(runId: number, level: 'info' | 'warn' | 'error', message: string): void {
  const prefix = `[bulk-migration:${runId}]`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// Run all matched pairs sequentially. A failed pair is recorded and the run
// continues with the next one; only cancellation stops the run early. Every
// run starts fresh: nothing from previous runs is consulted — the recorded
// data is purely a status board for the user.
export async function runBulkMigration(runId: number, options: BulkRunOptions = {}): Promise<void> {
  const run = getBulkRun(runId);
  if (!run) return;

  const excludedFolders = [
    ...(options.excludeTrash === false ? [] : TRASH_FOLDERS),
    ...(options.excludeJunk === false ? [] : JUNK_FOLDERS),
  ];

  try {
    db.prepare("UPDATE bulk_runs SET status = 'running', startedAt = datetime('now') WHERE id = ?").run(runId);

    const pairs = getMatchedPairs();
    db.prepare('UPDATE bulk_runs SET totalPairs = ? WHERE id = ?').run(pairs.length, runId);
    logRun(runId, 'info', `Starting bulk migration with ${pairs.length} account pair(s)`);

    let completedPairs = 0;
    let failedPairs = 0;
    let pairsWithErrors = 0;

    for (const pair of pairs) {
      if (bulkCancelRequests.has(runId)) {
        throw new BulkRunCancelledError();
      }

      const pairLabel =
        pair.sourceEmail === pair.targetEmail ? pair.sourceEmail : `${pair.sourceEmail} → ${pair.targetEmail}`;

      const sourceRow = db.prepare('SELECT * FROM bulk_accounts WHERE id = ?').get(pair.sourceId) as
        | BulkAccount
        | undefined;
      const targetRow = db.prepare('SELECT * FROM bulk_accounts WHERE id = ?').get(pair.targetId) as
        | BulkAccount
        | undefined;
      if (!sourceRow || !targetRow) {
        failedPairs++;
        completedPairs++;
        logRun(runId, 'error', `Pair ${pairLabel}: account rows were deleted while the run was active — skipped`);
        continue;
      }

      // Same server + same login would copy an account onto itself
      if (
        sourceRow.imapHost === targetRow.imapHost &&
        sourceRow.imapPort === targetRow.imapPort &&
        sourceRow.username === targetRow.username
      ) {
        failedPairs++;
        completedPairs++;
        logRun(runId, 'warn', `Pair ${pairLabel}: source and target are the same account — skipped`);
        continue;
      }

      const job = createBulkPairJob(runId, sourceRow, targetRow, excludedFolders);
      db.prepare('UPDATE bulk_runs SET currentJobId = ?, currentEmail = ? WHERE id = ?').run(
        job.id,
        pairLabel,
        runId
      );
      logRun(runId, 'info', `Pair ${completedPairs + 1}/${pairs.length}: migrating ${pairLabel} (job #${job.id})`);

      // Never rejects — per-pair problems end up as the job's status
      await runMigrationJob(job.id);

      const finished = getMigrationJob(job.id);
      completedPairs++;
      if (finished?.status === 'failed') {
        failedPairs++;
      } else if (finished?.status === 'completed_with_errors') {
        pairsWithErrors++;
      } else if (finished?.status === 'cancelled') {
        // The pair was cancelled via the run — surface it as a run cancellation
        db.prepare('UPDATE bulk_runs SET completedPairs = ?, failedPairs = ? WHERE id = ?').run(
          completedPairs,
          failedPairs,
          runId
        );
        throw new BulkRunCancelledError();
      }

      db.prepare('UPDATE bulk_runs SET completedPairs = ?, failedPairs = ? WHERE id = ?').run(
        completedPairs,
        failedPairs,
        runId
      );
    }

    const finalStatus: MigrationJobStatus =
      failedPairs > 0 || pairsWithErrors > 0 ? 'completed_with_errors' : 'completed';
    db.prepare(
      "UPDATE bulk_runs SET status = ?, currentJobId = NULL, currentEmail = NULL, completedAt = datetime('now') WHERE id = ?"
    ).run(finalStatus, runId);
    logRun(
      runId,
      finalStatus === 'completed' ? 'info' : 'warn',
      `Bulk migration finished: ${completedPairs} pair(s) processed, ${failedPairs} failed`
    );
  } catch (err) {
    if (err instanceof BulkRunCancelledError) {
      db.prepare(
        "UPDATE bulk_runs SET status = 'cancelled', currentJobId = NULL, currentEmail = NULL, completedAt = datetime('now') WHERE id = ?"
      ).run(runId);
      logRun(runId, 'warn', 'Bulk migration cancelled. Start it again to resume — messages that already exist on the target will be skipped.');
    } else {
      const message = err instanceof Error ? err.message : String(err);
      db.prepare(
        "UPDATE bulk_runs SET status = 'failed', error = ?, currentJobId = NULL, currentEmail = NULL, completedAt = datetime('now') WHERE id = ?"
      ).run(message, runId);
      logRun(runId, 'error', `Bulk migration failed: ${message}`);
    }
  } finally {
    bulkCancelRequests.delete(runId);
  }
}
