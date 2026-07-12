import db, { ConnectionTestResult, ConnectionTestRun, MigrationJobStatus } from '../utils/db';
import { withImapClient } from '../utils/imapClient';

// How many IMAP logins are attempted at the same time
const CONNECTION_TEST_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.CONNECTION_TEST_CONCURRENCY || '5', 10)
);

// Tight timeouts so one dead host doesn't stall a batch for imapflow's
// 90-second default
const CONNECT_TIMEOUT_MS = 15000;
const GREETING_TIMEOUT_MS = 10000;

export const ACTIVE_RUN_STATUSES: MigrationJobStatus[] = ['pending', 'running'];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ConnectionTestRow {
  email: string;
  username: string;
  password: string;
}

export interface ConnectionTestRunDetail {
  run: ConnectionTestRun;
  results: ConnectionTestResult[];
}

class ConnectionTestRunCancelledError extends Error {
  constructor() {
    super('Connection test cancelled by user');
  }
}

// Cancellation flags for runs in this process
const runCancelRequests = new Set<number>();

// Passwords are never written to the database — they live here only while
// their run is active (runId -> resultId -> plaintext password)
const runPasswords = new Map<number, Map<number, string>>();

// ---------------------------------------------------------------------------
// Run persistence
// ---------------------------------------------------------------------------

export function getConnectionTestRun(runId: number): ConnectionTestRun | undefined {
  return db.prepare('SELECT * FROM connection_test_runs WHERE id = ?').get(runId) as
    | ConnectionTestRun
    | undefined;
}

export function listConnectionTestRuns(limit = 20): ConnectionTestRun[] {
  return db
    .prepare('SELECT * FROM connection_test_runs ORDER BY id DESC LIMIT ?')
    .all(limit) as ConnectionTestRun[];
}

export function findActiveConnectionTestRun(): ConnectionTestRun | undefined {
  return db
    .prepare("SELECT * FROM connection_test_runs WHERE status IN ('pending', 'running') ORDER BY id DESC LIMIT 1")
    .get() as ConnectionTestRun | undefined;
}

export function getConnectionTestRunDetail(runId: number): ConnectionTestRunDetail | undefined {
  const run = getConnectionTestRun(runId);
  if (!run) return undefined;

  const results = db
    .prepare('SELECT * FROM connection_test_results WHERE runId = ? ORDER BY id')
    .all(runId) as ConnectionTestResult[];

  return { run, results };
}

export function cancelConnectionTestRun(runId: number): ConnectionTestRun | undefined {
  const run = getConnectionTestRun(runId);
  if (!run) return undefined;

  if (ACTIVE_RUN_STATUSES.includes(run.status)) {
    runCancelRequests.add(runId);
  }
  return getConnectionTestRun(runId);
}

// Results go via ON DELETE CASCADE
export function deleteConnectionTestRun(runId: number): boolean {
  const run = getConnectionTestRun(runId);
  if (!run) return false;
  if (ACTIVE_RUN_STATUSES.includes(run.status)) {
    throw new Error('This connection test is still running — cancel it before deleting');
  }

  db.prepare('DELETE FROM connection_test_runs WHERE id = ?').run(runId);
  return true;
}

// Validate the uploaded rows and create the run with one result row per
// credential. Duplicates are NOT collapsed — every physical CSV row gets its
// own test. The passwords stay in memory only.
export function createConnectionTestRun(
  imapHost: string,
  imapPort: number,
  rows: ConnectionTestRow[]
): ConnectionTestRun {
  const validated: ConnectionTestRow[] = [];

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
    validated.push({ email, username, password });
  }

  if (validated.length === 0) {
    throw new Error('The upload contains no rows');
  }

  const insertResult = db.prepare(
    'INSERT INTO connection_test_results (runId, email, username) VALUES (?, ?, ?)'
  );

  const passwords = new Map<number, string>();
  const runId = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO connection_test_runs (imapHost, imapPort, totalAccounts) VALUES (?, ?, ?)')
      .run(imapHost, imapPort, validated.length);
    const id = Number(info.lastInsertRowid);
    for (const row of validated) {
      const resultInfo = insertResult.run(id, row.email, row.username);
      passwords.set(Number(resultInfo.lastInsertRowid), row.password);
    }
    return id;
  })();

  runPasswords.set(runId, passwords);
  return getConnectionTestRun(runId)!;
}

// ---------------------------------------------------------------------------
// Run execution
// ---------------------------------------------------------------------------

function logRun(runId: number, level: 'info' | 'warn' | 'error', message: string): void {
  const prefix = `[connection-test:${runId}]`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// Classify the failure so the row shows "wrong password" vs "server
// unreachable" at a glance
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // imapflow attaches the server's raw response text, which is usually the
    // most useful part of the error
    const responseText = (err as any).responseText;
    const detail = responseText ? `${err.message} (${responseText})` : err.message;

    if ((err as any).authenticationFailed) {
      return `Authentication failed: ${detail}`;
    }
    const code = (err as any).code;
    if (typeof code === 'string' && code) {
      return `Connection failed (${code}): ${detail}`;
    }
    return detail;
  }
  return String(err);
}

// Try one IMAP login and record the verdict. Never rejects — failures become
// the row's status.
async function testOneResult(
  run: ConnectionTestRun,
  result: ConnectionTestResult,
  password: string
): Promise<boolean> {
  db.prepare("UPDATE connection_test_results SET status = 'running' WHERE id = ?").run(result.id);

  let ok = false;
  let error: string | null = null;
  try {
    await withImapClient(
      {
        host: run.imapHost,
        port: run.imapPort,
        user: result.username,
        password,
        connectionTimeout: CONNECT_TIMEOUT_MS,
        greetingTimeout: GREETING_TIMEOUT_MS,
      },
      async () => {}
    );
    ok = true;
  } catch (err) {
    error = errorMessage(err);
    logRun(run.id, 'warn', `${result.email}: ${error}`);
  }

  db.prepare(
    "UPDATE connection_test_results SET status = ?, error = ?, testedAt = datetime('now') WHERE id = ?"
  ).run(ok ? 'ok' : 'failed', error, result.id);
  db.prepare(
    `UPDATE connection_test_runs
     SET processedAccounts = processedAccounts + 1,
         okAccounts = okAccounts + ?,
         failedAccounts = failedAccounts + ?
     WHERE id = ?`
  ).run(ok ? 1 : 0, ok ? 0 : 1, run.id);
  return ok;
}

// Test all rows of a run in small parallel batches. Fire and forget — the
// client polls the run in the DB.
export async function runConnectionTestRun(runId: number): Promise<void> {
  const run = getConnectionTestRun(runId);
  if (!run) return;

  try {
    db.prepare("UPDATE connection_test_runs SET status = 'running', startedAt = datetime('now') WHERE id = ?").run(
      runId
    );

    const passwords = runPasswords.get(runId);
    if (!passwords) {
      throw new Error('The credentials for this run are no longer in memory — upload the CSV again');
    }

    const results = db
      .prepare("SELECT * FROM connection_test_results WHERE runId = ? AND status = 'pending' ORDER BY id")
      .all(runId) as ConnectionTestResult[];
    logRun(
      runId,
      'info',
      `Testing ${results.length} connection(s) against ${run.imapHost}:${run.imapPort}, ${CONNECTION_TEST_CONCURRENCY} at a time`
    );

    for (let offset = 0; offset < results.length; offset += CONNECTION_TEST_CONCURRENCY) {
      if (runCancelRequests.has(runId)) {
        throw new ConnectionTestRunCancelledError();
      }

      const batch = results.slice(offset, offset + CONNECTION_TEST_CONCURRENCY);
      await Promise.all(batch.map((result) => testOneResult(run, result, passwords.get(result.id) ?? '')));
    }

    const finished = getConnectionTestRun(runId)!;
    const finalStatus: MigrationJobStatus = finished.failedAccounts > 0 ? 'completed_with_errors' : 'completed';
    db.prepare(
      "UPDATE connection_test_runs SET status = ?, completedAt = datetime('now') WHERE id = ?"
    ).run(finalStatus, runId);
    logRun(
      runId,
      finalStatus === 'completed' ? 'info' : 'warn',
      `Connection test finished: ${finished.okAccounts} ok, ${finished.failedAccounts} failed`
    );
  } catch (err) {
    if (err instanceof ConnectionTestRunCancelledError) {
      db.prepare(
        "UPDATE connection_test_results SET status = 'cancelled' WHERE runId = ? AND status IN ('pending', 'running')"
      ).run(runId);
      db.prepare(
        "UPDATE connection_test_runs SET status = 'cancelled', completedAt = datetime('now') WHERE id = ?"
      ).run(runId);
      logRun(runId, 'warn', 'Connection test cancelled — rows tested before the cancellation keep their result.');
    } else {
      const message = err instanceof Error ? err.message : String(err);
      db.prepare(
        "UPDATE connection_test_runs SET status = 'failed', error = ?, completedAt = datetime('now') WHERE id = ?"
      ).run(message, runId);
      logRun(runId, 'error', `Connection test failed: ${message}`);
    }
  } finally {
    runCancelRequests.delete(runId);
    runPasswords.delete(runId);
  }
}

// Called once on server startup: runs still marked active belong to a
// previous process, and their passwords died with it — they cannot resume.
export function recoverInterruptedConnectionTestRuns(): void {
  const resultChanges = db
    .prepare(
      `UPDATE connection_test_results
       SET status = 'interrupted'
       WHERE status IN ('pending', 'running')`
    )
    .run();
  const runChanges = db
    .prepare(
      `UPDATE connection_test_runs
       SET status = 'interrupted',
           error = 'Server restarted while the connection test was running. Upload the CSV again to test the remaining rows.',
           completedAt = datetime('now')
       WHERE status IN ('pending', 'running')`
    )
    .run();
  if (runChanges.changes > 0) {
    console.warn(
      `Marked ${runChanges.changes} connection test run(s) (${resultChanges.changes} row(s)) as interrupted after restart`
    );
  }
}
