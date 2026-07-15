import prisma from '../utils/prisma';
import { BulkRole, BulkRun, MigrationJob, MigrationJobStatus } from '../types/db';
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
  createdAt: Date;
  updatedAt: Date;
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

async function listBulkAccountViews(role: BulkRole): Promise<BulkAccountView[]> {
  return (await prisma.bulkAccount.findMany({
    where: { role },
    orderBy: { email: 'asc' },
    select: {
      id: true,
      role: true,
      email: true,
      targetEmail: true,
      username: true,
      imapHost: true,
      imapPort: true,
      createdAt: true,
      updatedAt: true,
    },
  })) as BulkAccountView[];
}

// Replace the imported accounts for one role: upsert by (role, email), rows
// missing from the new import are removed. The CSVs stay the source of truth —
// this table is just the working copy the runs connect with.
export async function replaceBulkAccounts(
  role: BulkRole,
  imapHost: string,
  imapPort: number,
  rows: BulkImportRow[]
): Promise<BulkImportResult> {
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

  await prisma.$transaction(
    async (tx) => {
      for (const [email, row] of byEmail) {
        const password = encryptPassword(row.password);
        await tx.bulkAccount.upsert({
          where: { role_email: { role, email } },
          create: {
            role,
            email,
            targetEmail: row.targetEmail,
            username: row.username,
            password,
            imapHost,
            imapPort,
          },
          update: {
            targetEmail: row.targetEmail,
            username: row.username,
            password,
            imapHost,
            imapPort,
          },
        });
      }
      await tx.bulkAccount.deleteMany({
        where: { role, email: { notIn: [...byEmail.keys()] } },
      });
    },
    { timeout: 30000 }
  );

  connectionTested[role] = false;
  return { accounts: await listBulkAccountViews(role), warnings };
}

export async function deleteBulkAccounts(role: BulkRole): Promise<number> {
  connectionTested[role] = false;
  return (await prisma.bulkAccount.deleteMany({ where: { role } })).count;
}

// The whole migration project disappears: imports, runs, and job history
// (pair jobs, their folders and logs go via ON DELETE CASCADE)
export async function deleteBulkSession(): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.migrationJob.deleteMany({ where: { mode: 'bulk' } });
      await tx.bulkRun.deleteMany();
      await tx.bulkAccount.deleteMany();
    },
    { timeout: 30000 }
  );
  connectionTested.source = false;
  connectionTested.target = false;
}

// A source row matches the target row whose email equals the source's target
// column, falling back to the source's own email when no target is given
async function getMatchedPairs(): Promise<BulkPair[]> {
  const sources = await prisma.bulkAccount.findMany({ where: { role: 'source' }, orderBy: { email: 'asc' } });
  const targets = await prisma.bulkAccount.findMany({ where: { role: 'target' } });
  const targetByEmail = new Map(targets.map((target) => [target.email, target]));

  const pairs: BulkPair[] = [];
  for (const source of sources) {
    const target = targetByEmail.get(source.targetEmail ?? source.email);
    if (!target) continue;
    pairs.push({
      sourceEmail: source.email,
      targetEmail: target.email,
      sourceId: source.id,
      targetId: target.id,
    });
  }
  return pairs;
}

export async function getBulkOverview(): Promise<BulkOverview> {
  const source = await listBulkAccountViews('source');
  const target = await listBulkAccountViews('target');
  const pairs = await getMatchedPairs();
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
  const row = email
    ? await prisma.bulkAccount.findUnique({
        where: { role_email: { role, email: email.trim().toLowerCase() } },
      })
    : await prisma.bulkAccount.findFirst({ where: { role }, orderBy: { email: 'asc' } });

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

export async function getBulkRun(runId: number): Promise<BulkRun | undefined> {
  return (await prisma.bulkRun.findUnique({ where: { id: runId } })) ?? undefined;
}

export async function listBulkRuns(limit = 20): Promise<BulkRun[]> {
  return prisma.bulkRun.findMany({ orderBy: { id: 'desc' }, take: limit });
}

export async function findActiveBulkRun(): Promise<BulkRun | undefined> {
  return (
    (await prisma.bulkRun.findFirst({
      where: { status: { in: ['pending', 'running'] } },
      orderBy: { id: 'desc' },
    })) ?? undefined
  );
}

export async function getBulkRunDetail(runId: number): Promise<BulkRunDetail | undefined> {
  const run = await getBulkRun(runId);
  if (!run) return undefined;

  const jobs = await listMigrationJobsByBulkRun(runId);
  const currentJobDetail = run.currentJobId ? (await getMigrationJobDetail(run.currentJobId)) ?? null : null;

  return { run, jobs, currentJobDetail };
}

export async function createBulkRun(totalPairs: number): Promise<BulkRun> {
  return prisma.bulkRun.create({ data: { totalPairs } });
}

export async function cancelBulkRun(runId: number): Promise<BulkRun | undefined> {
  const run = await getBulkRun(runId);
  if (!run) return undefined;

  if (ACTIVE_RUN_STATUSES.includes(run.status as MigrationJobStatus)) {
    bulkCancelRequests.add(runId);
    if (run.currentJobId) {
      const currentJob = await getMigrationJob(run.currentJobId);
      if (currentJob && ACTIVE_JOB_STATUSES.includes(currentJob.status as MigrationJobStatus)) {
        await cancelMigrationJob(run.currentJobId);
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
  const run = await getBulkRun(runId);
  if (!run) return;

  const excludedFolders = [
    ...(options.excludeTrash === false ? [] : TRASH_FOLDERS),
    ...(options.excludeJunk === false ? [] : JUNK_FOLDERS),
  ];

  try {
    await prisma.bulkRun.update({
      where: { id: runId },
      data: { status: 'running', startedAt: new Date() },
    });

    const pairs = await getMatchedPairs();
    await prisma.bulkRun.update({ where: { id: runId }, data: { totalPairs: pairs.length } });
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

      const sourceRow = await prisma.bulkAccount.findUnique({ where: { id: pair.sourceId } });
      const targetRow = await prisma.bulkAccount.findUnique({ where: { id: pair.targetId } });
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

      const job = await createBulkPairJob(runId, sourceRow, targetRow, excludedFolders);
      await prisma.bulkRun.update({
        where: { id: runId },
        data: { currentJobId: job.id, currentEmail: pairLabel },
      });
      logRun(runId, 'info', `Pair ${completedPairs + 1}/${pairs.length}: migrating ${pairLabel} (job #${job.id})`);

      // Never rejects — per-pair problems end up as the job's status
      await runMigrationJob(job.id);

      const finished = await getMigrationJob(job.id);
      completedPairs++;
      if (finished?.status === 'failed') {
        failedPairs++;
      } else if (finished?.status === 'completed_with_errors') {
        pairsWithErrors++;
      } else if (finished?.status === 'cancelled') {
        // The pair was cancelled via the run — surface it as a run cancellation
        await prisma.bulkRun.update({
          where: { id: runId },
          data: { completedPairs, failedPairs },
        });
        throw new BulkRunCancelledError();
      }

      await prisma.bulkRun.update({
        where: { id: runId },
        data: { completedPairs, failedPairs },
      });
    }

    const finalStatus: MigrationJobStatus =
      failedPairs > 0 || pairsWithErrors > 0 ? 'completed_with_errors' : 'completed';
    await prisma.bulkRun.update({
      where: { id: runId },
      data: { status: finalStatus, currentJobId: null, currentEmail: null, completedAt: new Date() },
    });
    logRun(
      runId,
      finalStatus === 'completed' ? 'info' : 'warn',
      `Bulk migration finished: ${completedPairs} pair(s) processed, ${failedPairs} failed`
    );
  } catch (err) {
    if (err instanceof BulkRunCancelledError) {
      await prisma.bulkRun.update({
        where: { id: runId },
        data: { status: 'cancelled', currentJobId: null, currentEmail: null, completedAt: new Date() },
      });
      logRun(runId, 'warn', 'Bulk migration cancelled. Start it again to resume — messages that already exist on the target will be skipped.');
    } else {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.bulkRun.update({
        where: { id: runId },
        data: { status: 'failed', error: message, currentJobId: null, currentEmail: null, completedAt: new Date() },
      });
      logRun(runId, 'error', `Bulk migration failed: ${message}`);
    }
  } finally {
    bulkCancelRequests.delete(runId);
  }
}
