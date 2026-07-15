import prisma from '../utils/prisma';
import { ConnectionTestResult, ConnectionTestRun, MigrationJobStatus } from '../types/db';
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

export async function getConnectionTestRun(runId: number): Promise<ConnectionTestRun | undefined> {
  return (await prisma.connectionTestRun.findUnique({ where: { id: runId } })) ?? undefined;
}

export async function listConnectionTestRuns(limit = 20): Promise<ConnectionTestRun[]> {
  return prisma.connectionTestRun.findMany({ orderBy: { id: 'desc' }, take: limit });
}

export async function findActiveConnectionTestRun(): Promise<ConnectionTestRun | undefined> {
  return (
    (await prisma.connectionTestRun.findFirst({
      where: { status: { in: ACTIVE_RUN_STATUSES } },
      orderBy: { id: 'desc' },
    })) ?? undefined
  );
}

export async function getConnectionTestRunDetail(
  runId: number
): Promise<ConnectionTestRunDetail | undefined> {
  const run = await getConnectionTestRun(runId);
  if (!run) return undefined;

  const results = await prisma.connectionTestResult.findMany({
    where: { runId },
    orderBy: { id: 'asc' },
  });

  return { run, results };
}

export async function cancelConnectionTestRun(runId: number): Promise<ConnectionTestRun | undefined> {
  const run = await getConnectionTestRun(runId);
  if (!run) return undefined;

  if (ACTIVE_RUN_STATUSES.includes(run.status as MigrationJobStatus)) {
    runCancelRequests.add(runId);
  }
  return getConnectionTestRun(runId);
}

// Results go via ON DELETE CASCADE
export async function deleteConnectionTestRun(runId: number): Promise<boolean> {
  const run = await getConnectionTestRun(runId);
  if (!run) return false;
  if (ACTIVE_RUN_STATUSES.includes(run.status as MigrationJobStatus)) {
    throw new Error('This connection test is still running — cancel it before deleting');
  }

  await prisma.connectionTestRun.delete({ where: { id: runId } });
  return true;
}

// Validate the uploaded rows and create the run with one result row per
// credential. Duplicates are NOT collapsed — every physical CSV row gets its
// own test. The passwords stay in memory only.
export async function createConnectionTestRun(
  imapHost: string,
  imapPort: number,
  rows: ConnectionTestRow[]
): Promise<ConnectionTestRun> {
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

  const passwords = new Map<number, string>();
  const runId = await prisma.$transaction(
    async (tx) => {
      const run = await tx.connectionTestRun.create({
        data: { imapHost, imapPort, totalAccounts: validated.length },
      });
      for (const row of validated) {
        const result = await tx.connectionTestResult.create({
          data: { runId: run.id, email: row.email, username: row.username },
        });
        passwords.set(result.id, row.password);
      }
      return run.id;
    },
    { timeout: 30000 }
  );

  runPasswords.set(runId, passwords);
  return (await getConnectionTestRun(runId))!;
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
  await prisma.connectionTestResult.update({
    where: { id: result.id },
    data: { status: 'running' },
  });

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

  await prisma.connectionTestResult.update({
    where: { id: result.id },
    data: { status: ok ? 'ok' : 'failed', error, testedAt: new Date() },
  });
  await prisma.connectionTestRun.update({
    where: { id: run.id },
    data: {
      processedAccounts: { increment: 1 },
      okAccounts: { increment: ok ? 1 : 0 },
      failedAccounts: { increment: ok ? 0 : 1 },
    },
  });
  return ok;
}

// Test all rows of a run in small parallel batches. Fire and forget — the
// client polls the run in the DB.
export async function runConnectionTestRun(runId: number): Promise<void> {
  const run = await getConnectionTestRun(runId);
  if (!run) return;

  try {
    await prisma.connectionTestRun.update({
      where: { id: runId },
      data: { status: 'running', startedAt: new Date() },
    });

    const passwords = runPasswords.get(runId);
    if (!passwords) {
      throw new Error('The credentials for this run are no longer in memory — upload the CSV again');
    }

    const results = await prisma.connectionTestResult.findMany({
      where: { runId, status: 'pending' },
      orderBy: { id: 'asc' },
    });
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

    const finished = (await getConnectionTestRun(runId))!;
    const finalStatus: MigrationJobStatus = finished.failedAccounts > 0 ? 'completed_with_errors' : 'completed';
    await prisma.connectionTestRun.update({
      where: { id: runId },
      data: { status: finalStatus, completedAt: new Date() },
    });
    logRun(
      runId,
      finalStatus === 'completed' ? 'info' : 'warn',
      `Connection test finished: ${finished.okAccounts} ok, ${finished.failedAccounts} failed`
    );
  } catch (err) {
    if (err instanceof ConnectionTestRunCancelledError) {
      await prisma.connectionTestResult.updateMany({
        where: { runId, status: { in: ['pending', 'running'] } },
        data: { status: 'cancelled' },
      });
      await prisma.connectionTestRun.update({
        where: { id: runId },
        data: { status: 'cancelled', completedAt: new Date() },
      });
      logRun(runId, 'warn', 'Connection test cancelled — rows tested before the cancellation keep their result.');
    } else {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.connectionTestRun.update({
        where: { id: runId },
        data: { status: 'failed', error: message, completedAt: new Date() },
      });
      logRun(runId, 'error', `Connection test failed: ${message}`);
    }
  } finally {
    runCancelRequests.delete(runId);
    runPasswords.delete(runId);
  }
}

// Called once on server startup: runs still marked active belong to a
// previous process, and their passwords died with it — they cannot resume.
export async function recoverInterruptedConnectionTestRuns(): Promise<void> {
  const resultChanges = await prisma.connectionTestResult.updateMany({
    where: { status: { in: ['pending', 'running'] } },
    data: { status: 'interrupted' },
  });
  const runChanges = await prisma.connectionTestRun.updateMany({
    where: { status: { in: ['pending', 'running'] } },
    data: {
      status: 'interrupted',
      error:
        'Server restarted while the connection test was running. Upload the CSV again to test the remaining rows.',
      completedAt: new Date(),
    },
  });
  if (runChanges.count > 0) {
    console.warn(
      `Marked ${runChanges.count} connection test run(s) (${resultChanges.count} row(s)) as interrupted after restart`
    );
  }
}
