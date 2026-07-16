import prisma from '../utils/prisma';
import {
  MailAccount,
  BulkAccount,
  MigrationJob,
  MigrationFolder,
  MigrationLog,
  MigrationJobStatus,
} from '../types/db';
import { withImapClient, buildImapClient, safeCloseImapClient, ImapCredentials } from '../utils/imapClient';
import { decryptPassword } from '../utils/crypto';
import { getValidAccessToken } from './tokenManager';

// Default folders to exclude from migration, grouped so bulk mode can toggle
// each group. Entries are matched by special-use flag, path, and folder name.
export const TRASH_FOLDERS = ['\\Trash', 'Trash', 'Deleted Items', 'Deleted Messages', 'Bin'];
export const JUNK_FOLDERS = ['\\Junk', 'Junk', 'Junk E-mail', 'Junk Email', 'Spam'];
export const DEFAULT_EXCLUDED_FOLDERS = [...TRASH_FOLDERS, ...JUNK_FOLDERS];

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
  // imapflow's specialUse may be a name-based GUESS; flaggedSpecialUse is only
  // set when the server actually advertises the special-use flag
  specialUse?: string;
  flaggedSpecialUse?: string;
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

// A migration side, independent of where the credentials come from
// (mail_accounts for single mode, bulk_accounts for bulk mode).
export interface MigrationEndpoint {
  email: string;
  getCredentials(): Promise<ImapCredentials>;
}

export function endpointFromMailAccount(account: MailAccount): MigrationEndpoint {
  return {
    email: account.email,
    getCredentials: () => getImapCredentials(account),
  };
}

export function endpointFromBulkAccount(account: BulkAccount): MigrationEndpoint {
  return {
    email: account.email,
    getCredentials: async () => ({
      host: account.imapHost,
      port: account.imapPort,
      user: account.username,
      password: decryptPassword(account.password),
    }),
  };
}

// Load the source/target endpoints for a job, branching on its mode
async function resolveEndpoints(job: MigrationJob): Promise<{ source: MigrationEndpoint; target: MigrationEndpoint }> {
  if (job.mode === 'bulk') {
    const sourceRow = job.sourceBulkAccountId
      ? await prisma.bulkAccount.findUnique({ where: { id: job.sourceBulkAccountId } })
      : null;
    const targetRow = job.targetBulkAccountId
      ? await prisma.bulkAccount.findUnique({ where: { id: job.targetBulkAccountId } })
      : null;
    if (!sourceRow || !targetRow) {
      throw new Error('Source or target account no longer exists');
    }
    return { source: endpointFromBulkAccount(sourceRow), target: endpointFromBulkAccount(targetRow) };
  }

  const sourceAccount = job.sourceAccountId
    ? await prisma.mailAccount.findUnique({ where: { id: job.sourceAccountId } })
    : null;
  const targetAccount = job.targetAccountId
    ? await prisma.mailAccount.findUnique({ where: { id: job.targetAccountId } })
    : null;
  if (!sourceAccount || !targetAccount) {
    throw new Error('Source or target account no longer exists');
  }
  return { source: endpointFromMailAccount(sourceAccount), target: endpointFromMailAccount(targetAccount) };
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
  const segments = folder.path.split(folder.delimiter || '/');

  for (const excluded of excludedFolders) {
    // Match by special use (e.g., \Trash, \Junk)
    if (excluded.startsWith('\\') && folder.specialUse === excluded) {
      return true;
    }
    // Match by path (case-insensitive)
    if (folder.path.toLowerCase() === excluded.toLowerCase()) {
      return true;
    }
    // Match by folder name at any depth, so "INBOX/Deleted Messages" and the
    // subfolders of an excluded folder ("Trash/2019") are caught as well
    if (matchByName && segments.some((segment) => segment.toLowerCase() === excluded.toLowerCase())) {
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
          flaggedSpecialUse:
            mailbox.specialUse && mailbox.flags?.has(mailbox.specialUse) ? mailbox.specialUse : undefined,
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

// ---------------------------------------------------------------------------
// Folder mapping: source folders are mapped to target folders by ROLE, not by
// path. A leading INBOX segment counts as the root (some servers/clients nest
// everything inside INBOX), and special-use folders are matched to the
// target's equivalents even when their names differ. Children follow their
// mapped parent: "INBOX/Sent Messages/2023" -> "<target sent folder>/2023".
// ---------------------------------------------------------------------------

export type FolderRole = 'sent' | 'drafts' | 'trash' | 'junk' | 'archive';

const SPECIAL_USE_ROLES: Record<string, FolderRole> = {
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'archive',
};

// Well-known folder names for servers/clients that do not set special-use
// flags (e.g. Apple Mail's "Sent Messages" / "Deleted Messages")
const ROLE_NAMES: Record<FolderRole, string[]> = {
  sent: ['sent', 'sent messages', 'sent items', 'sent mail', 'gesendet', 'gesendete elemente', 'gesendete objekte'],
  drafts: ['drafts', 'draft', 'entwürfe'],
  trash: ['trash', 'deleted messages', 'deleted items', 'bin', 'papierkorb', 'gelöschte elemente', 'gelöschte objekte'],
  junk: ['junk', 'junk e-mail', 'junk email', 'spam'],
  archive: ['archive', 'archives', 'archiv', 'all mail'],
};

// Folder created on the target when it has no folder for a role yet
const ROLE_DEFAULT_NAME: Record<FolderRole, string> = {
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
  junk: 'Junk',
  archive: 'Archive',
};

function roleFromSpecialUse(specialUse?: string): FolderRole | undefined {
  return specialUse ? SPECIAL_USE_ROLES[specialUse] : undefined;
}

function roleFromFolderName(name: string): FolderRole | undefined {
  const lower = name.trim().toLowerCase();
  for (const [role, names] of Object.entries(ROLE_NAMES) as [FolderRole, string[]][]) {
    if (names.includes(lower)) return role;
  }
  return undefined;
}

// Split a path into segments, treating a leading INBOX as the root
// ("INBOX/test" is the same folder level as "test")
function canonicalSegments(path: string, delimiter: string): string[] {
  const segments = path.split(delimiter || '/');
  if (segments.length > 1 && segments[0].toUpperCase() === 'INBOX') {
    segments.shift();
  }
  return segments;
}

export interface TargetLayout {
  delimiter: string;
  // ['INBOX'] when the target roots all folders inside INBOX, otherwise []
  rootPrefix: string[];
  // role -> path segments of the target's folder for that role
  roleFolders: Map<FolderRole, string[]>;
}

export function detectTargetLayout(
  mailboxes: { path: string; delimiter?: string; specialUse?: string; flags?: Set<string> }[]
): TargetLayout {
  const delimiter = mailboxes.find((m) => m.delimiter)?.delimiter || '/';

  const nonInbox = mailboxes.filter((m) => m.path.toUpperCase() !== 'INBOX');
  const rootPrefix =
    nonInbox.length > 0 &&
    nonInbox.every((m) => m.path.toUpperCase().startsWith(`INBOX${delimiter}`.toUpperCase()))
      ? ['INBOX']
      : [];

  const roleFolders = new Map<FolderRole, string[]>();
  // Only special-use flags the server actually advertises are authoritative
  // (imapflow also guesses specialUse from names — that tier is handled by
  // the prioritized name fallback below)
  for (const mailbox of mailboxes) {
    const advertised =
      mailbox.specialUse && mailbox.flags?.has(mailbox.specialUse) ? mailbox.specialUse : undefined;
    const role = roleFromSpecialUse(advertised);
    if (role && !roleFolders.has(role)) {
      roleFolders.set(role, mailbox.path.split(delimiter));
    }
  }
  // Name fallback only for roles no flagged folder claims, best candidate
  // first (a leading INBOX counts as root)
  const rootNameToPath = new Map<string, string[]>();
  for (const mailbox of mailboxes) {
    const segments = canonicalSegments(mailbox.path, delimiter);
    if (segments.length !== 1) continue;
    const key = segments[0].toLowerCase();
    if (!rootNameToPath.has(key)) rootNameToPath.set(key, mailbox.path.split(delimiter));
  }
  for (const [role, names] of Object.entries(ROLE_NAMES) as [FolderRole, string[]][]) {
    if (roleFolders.has(role)) continue;
    const candidate = names.find((name) => rootNameToPath.has(name));
    if (candidate) roleFolders.set(role, rootNameToPath.get(candidate)!);
  }

  return { delimiter, rootPrefix, roleFolders };
}

// Which root-level source folders carry a role (their subtree follows them).
// `flagged` records whether the role comes from a special-use flag the server
// actually advertises; a name is only accepted for a role that no flagged
// folder claims — a folder merely NAMED like a special folder (e.g.
// "Deleted Messages" next to a real \Trash) stays an ordinary folder.
export interface HeadRole {
  role: FolderRole;
  flagged: boolean;
}

export function detectSourceHeadRoles(folders: FolderInfo[]): Map<string, HeadRole> {
  const headRoles = new Map<string, HeadRole>();
  const claimed = new Set<FolderRole>();

  for (const folder of folders) {
    const segments = canonicalSegments(folder.path, folder.delimiter);
    if (segments.length !== 1) continue;
    const role = roleFromSpecialUse(folder.flaggedSpecialUse);
    if (role && !claimed.has(role)) {
      headRoles.set(segments[0].toLowerCase(), { role, flagged: true });
      claimed.add(role);
    }
  }

  const headNames = new Set<string>();
  for (const folder of folders) {
    headNames.add(canonicalSegments(folder.path, folder.delimiter)[0].toLowerCase());
  }
  for (const [role, names] of Object.entries(ROLE_NAMES) as [FolderRole, string[]][]) {
    if (claimed.has(role)) continue;
    const candidate = names.find((name) => headNames.has(name));
    if (candidate) headRoles.set(candidate, { role, flagged: false });
  }
  return headRoles;
}

// Skip-trash/skip-junk excludes ONLY folders the server flags with the
// special-use attribute (and their subtrees) — never folders that merely have
// a matching name. Name recognition is used for mapping alone.
export function applyRoleExclusions(
  folders: FolderInfo[],
  headRoles: Map<string, HeadRole>,
  options: { excludeTrash: boolean; excludeJunk: boolean }
): FolderInfo[] {
  const excludedRoles = new Set<FolderRole>();
  if (options.excludeTrash) excludedRoles.add('trash');
  if (options.excludeJunk) excludedRoles.add('junk');
  if (excludedRoles.size === 0) return folders;

  return folders.filter((folder) => {
    const ownRole = roleFromSpecialUse(folder.flaggedSpecialUse);
    if (ownRole && excludedRoles.has(ownRole)) return false;

    const head = headRoles.get(canonicalSegments(folder.path, folder.delimiter)[0].toLowerCase());
    return !(head && head.flagged && excludedRoles.has(head.role));
  });
}

export function mapSourceFolderToTarget(
  folder: FolderInfo,
  headRoles: Map<string, HeadRole>,
  layout: TargetLayout
): string[] {
  if (folder.path.toUpperCase() === 'INBOX') return ['INBOX'];

  const segments = canonicalSegments(folder.path, folder.delimiter);
  const head = headRoles.get(segments[0].toLowerCase());
  if (head) {
    const roleFolder = layout.roleFolders.get(head.role) ?? [...layout.rootPrefix, ROLE_DEFAULT_NAME[head.role]];
    return [...roleFolder, ...segments.slice(1)];
  }
  return [...layout.rootPrefix, ...segments];
}

// Get migration preview (dry run)
export async function getMigrationPreview(
  sourceAccount: MailAccount,
  excludedFolders?: string[]
): Promise<MigrationPreview> {
  const credentials = await getImapCredentials(sourceAccount);

  let folders: FolderInfo[];
  if (excludedFolders == null) {
    // Defaults: exclude by role (real trash/junk), not by name
    const all = await getFolders(credentials, [], false);
    folders = applyRoleExclusions(all, detectSourceHeadRoles(all), { excludeTrash: true, excludeJunk: true });
  } else {
    // User-picked exclusions are exact paths
    folders = await getFolders(credentials, excludedFolders, false);
  }

  const totalMessages = folders.reduce((sum, folder) => sum + folder.messageCount, 0);

  return {
    folders,
    totalMessages,
    excludedFolders: excludedFolders ?? DEFAULT_EXCLUDED_FOLDERS,
  };
}

// ---------------------------------------------------------------------------
// Job persistence helpers
// ---------------------------------------------------------------------------

async function logJob(
  jobId: number,
  level: 'info' | 'warn' | 'error',
  message: string,
  folderPath?: string,
  uid?: number
): Promise<void> {
  await prisma.migrationLog.create({
    data: { jobId, level, folderPath: folderPath ?? null, uid: uid ?? null, message },
  });
  const prefix = `[migration:${jobId}]${folderPath ? ` [${folderPath}]` : ''}`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export async function getMigrationJob(jobId: number): Promise<MigrationJob | undefined> {
  return (await prisma.migrationJob.findUnique({ where: { id: jobId } })) ?? undefined;
}

export async function getMigrationJobDetail(jobId: number): Promise<MigrationJobDetail | undefined> {
  const job = await getMigrationJob(jobId);
  if (!job) return undefined;

  const folders = await prisma.migrationFolder.findMany({ where: { jobId }, orderBy: { path: 'asc' } });
  const logs = await prisma.migrationLog.findMany({
    where: { jobId, level: { in: ['warn', 'error'] } },
    orderBy: { id: 'desc' },
    take: 200,
  });

  return { job, folders, logs };
}

export async function listMigrationJobs(limit = 20): Promise<MigrationJob[]> {
  return prisma.migrationJob.findMany({ orderBy: { id: 'desc' }, take: limit });
}

export async function listMigrationJobsByBulkRun(runId: number): Promise<MigrationJob[]> {
  return prisma.migrationJob.findMany({ where: { bulkRunId: runId }, orderBy: { id: 'asc' } });
}

export async function findActiveMigrationJob(): Promise<MigrationJob | undefined> {
  return (
    (await prisma.migrationJob.findFirst({
      where: { status: { in: ACTIVE_JOB_STATUSES } },
      orderBy: { id: 'desc' },
    })) ?? undefined
  );
}

export async function createMigrationJob(
  sourceAccountId: number,
  targetAccountId: number,
  excludedFolders?: string[]
): Promise<MigrationJob> {
  return prisma.migrationJob.create({
    data: {
      sourceAccountId,
      targetAccountId,
      excludedFolders: JSON.stringify(excludedFolders ?? null),
    },
  });
}

// Bulk pair exclusions are built-in folder groups (trash/junk), so they are
// matched by name like the defaults — unlike user-picked paths in single mode
export async function createBulkPairJob(
  runId: number,
  sourceRow: BulkAccount,
  targetRow: BulkAccount,
  excludedFolders: string[]
): Promise<MigrationJob> {
  const bulkEmail =
    sourceRow.email === targetRow.email ? sourceRow.email : `${sourceRow.email} → ${targetRow.email}`;
  return prisma.migrationJob.create({
    data: {
      mode: 'bulk',
      bulkRunId: runId,
      sourceBulkAccountId: sourceRow.id,
      targetBulkAccountId: targetRow.id,
      bulkEmail,
      excludedFolders: JSON.stringify(excludedFolders),
    },
  });
}

// Request cancellation of a job. Running jobs stop at the next batch checkpoint.
export async function cancelMigrationJob(jobId: number): Promise<MigrationJob | undefined> {
  const job = await getMigrationJob(jobId);
  if (!job) return undefined;

  if (ACTIVE_JOB_STATUSES.includes(job.status as MigrationJobStatus)) {
    cancelRequests.add(jobId);
    await logJob(jobId, 'info', 'Cancellation requested — job will stop at the next checkpoint');
  }
  return getMigrationJob(jobId);
}

// Called once on server startup: jobs and runs still marked active belong to
// a previous process and are no longer running. The stored records are pure
// history — re-running is always safe because messages that already exist on
// the target are skipped.
export async function recoverInterruptedJobs(): Promise<void> {
  const result = await prisma.migrationJob.updateMany({
    where: { status: { in: ACTIVE_JOB_STATUSES } },
    data: {
      status: 'interrupted',
      error:
        'Server restarted while the migration was running. Start it again — messages that already exist on the target will be skipped.',
      completedAt: new Date(),
      currentFolder: null,
    },
  });
  if (result.count > 0) {
    console.warn(`Marked ${result.count} migration job(s) as interrupted after restart`);
  }

  const bulkResult = await prisma.bulkRun.updateMany({
    where: { status: { in: ACTIVE_JOB_STATUSES } },
    data: {
      status: 'interrupted',
      error:
        'Server restarted while the bulk migration was running. Start it again — messages that already exist on the target will be skipped.',
      completedAt: new Date(),
      currentJobId: null,
      currentEmail: null,
    },
  });
  if (bulkResult.count > 0) {
    console.warn(`Marked ${bulkResult.count} bulk migration run(s) as interrupted after restart`);
  }
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

async function bumpJobCounters(
  jobId: number,
  copied: number,
  skipped: number,
  failed: number,
  processed: number
): Promise<void> {
  await prisma.migrationJob.update({
    where: { id: jobId },
    data: {
      copiedMessages: { increment: copied },
      skippedMessages: { increment: skipped },
      failedMessages: { increment: failed },
      processedMessages: { increment: processed },
    },
  });
}

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

// Identity of a message for source/target comparison: the Message-ID header
// when it has one, otherwise a fingerprint of internal date + subject.
// Returns null when neither is available — such messages are always copied.
export function messageDedupeKey(message: {
  envelope?: { messageId?: string; subject?: string };
  internalDate?: Date | string;
}): string | null {
  const messageId = message.envelope?.messageId?.trim();
  if (messageId) return messageId;

  const date = message.internalDate ? new Date(message.internalDate).getTime() : null;
  const subject = message.envelope?.subject?.trim();
  if (date == null && !subject) return null;
  return `fp:${date ?? ''}|${subject ?? ''}`;
}

// Copy one folder in batches. Both connections are opened fresh for the
// folder; every message is fetched and appended individually so at most one
// message is held in memory at a time. Progress is persisted after every batch.
//
// Idempotency comes from comparing with what actually exists on the target:
// before copying, the Message-IDs of all target messages are collected and
// every source message that is already present is skipped. This needs no
// local bookkeeping, so reruns are safe no matter how the target got its mail.
async function migrateFolder(
  jobId: number,
  folder: MigrationFolder,
  sourceEndpoint: MigrationEndpoint,
  targetEndpoint: MigrationEndpoint
): Promise<void> {
  const sourceCredentials = await sourceEndpoint.getCredentials();
  const targetCredentials = await targetEndpoint.getCredentials();
  const source = buildImapClient(sourceCredentials);
  const target = buildImapClient(targetCredentials);

  const updateFolderCounts = (messageCount: number, copied: number, skipped: number, failed: number) =>
    prisma.migrationFolder.update({
      where: { id: folder.id },
      data: { messageCount, copiedCount: copied, skippedCount: skipped, failedCount: failed },
    });

  try {
    await source.connect();
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

    const mailbox = await source.mailboxOpen(folder.path, { readOnly: true });
    const uids: number[] = (await source.search({ all: true }, { uid: true })) || [];

    const sourceKeyByUid = new Map<number, string | null>();
    if (mailbox.exists > 0) {
      for await (const message of source.fetch('1:*', { uid: true, envelope: true, internalDate: true })) {
        sourceKeyByUid.set(message.uid, messageDedupeKey(message));
      }
    }

    const pendingUids = uids.filter((uid) => {
      const key = sourceKeyByUid.get(uid);
      return !(key && targetKeys.has(key));
    });

    let skipped = uids.length - pendingUids.length;
    let copied = 0;
    let failed = 0;

    await updateFolderCounts(uids.length, copied, skipped, failed);
    if (skipped > 0) {
      await bumpJobCounters(jobId, 0, skipped, 0, skipped);
      await logJob(jobId, 'info', `${skipped} of ${uids.length} messages already exist on the target — skipping them`, folder.path);
    }
    await logJob(jobId, 'info', `Copying ${pendingUids.length} messages in batches of ${BATCH_SIZE}`, folder.path);

    for (let offset = 0; offset < pendingUids.length; offset += BATCH_SIZE) {
      checkCancelled(jobId);
      const batch = pendingUids.slice(offset, offset + BATCH_SIZE);
      let batchCopied = 0;
      let batchSkipped = 0;
      let batchFailed = 0;

      for (const uid of batch) {
        // A message copied earlier in this run can make later duplicates
        // (same Message-ID within the source folder) redundant
        const key = sourceKeyByUid.get(uid);
        if (key && targetKeys.has(key)) {
          batchSkipped++;
          continue;
        }

        try {
          const message = await source.fetchOne(
            String(uid),
            { uid: true, flags: true, internalDate: true, source: true },
            { uid: true }
          );

          if (!message || !message.source) {
            batchFailed++;
            await logJob(jobId, 'error', `Message UID ${uid} could not be fetched (no content returned)`, folder.path, uid);
            continue;
          }

          const flags = message.flags
            ? Array.from(message.flags).filter((flag) => flag !== '\\Recent')
            : [];
          await target.append(folder.targetPath, message.source, flags, message.internalDate ?? undefined);
          if (key) targetKeys.add(key);
          batchCopied++;
        } catch (err) {
          batchFailed++;
          await logJob(jobId, 'error', `Failed to copy message UID ${uid}: ${errorMessage(err)}`, folder.path, uid);
        }
      }

      copied += batchCopied;
      skipped += batchSkipped;
      failed += batchFailed;

      // Checkpoint: persist progress after every batch
      await updateFolderCounts(uids.length, copied, skipped, failed);
      await bumpJobCounters(jobId, batchCopied, batchSkipped, batchFailed, batchCopied + batchSkipped + batchFailed);

      // If the very first batch failed completely, the folder itself is broken
      // (missing on target, no append permission, ...) — abort instead of
      // producing one error per message
      if (offset === 0 && batchCopied === 0 && batchFailed === batch.length && batch.length > 1) {
        throw new Error(`All ${batch.length} messages in the first batch failed — aborting this folder`);
      }
    }

    const status = failed > 0 ? 'completed_with_errors' : 'completed';
    await prisma.migrationFolder.update({
      where: { id: folder.id },
      data: { status, completedAt: new Date() },
    });
    await logJob(jobId, failed > 0 ? 'warn' : 'info', `Folder done: ${copied} copied, ${skipped} skipped, ${failed} failed`, folder.path);
  } finally {
    await safeCloseImapClient(source);
    await safeCloseImapClient(target);
  }
}

// Run a migration job to completion. Never rejects for per-folder or
// per-message problems — those are logged and counted; only cancellation or a
// systemic failure ends the job early.
export async function runMigrationJob(jobId: number): Promise<void> {
  const job = await getMigrationJob(jobId);
  if (!job) return;

  try {
    await prisma.migrationJob.update({
      where: { id: jobId },
      data: { status: 'running', startedAt: new Date() },
    });

    const { source: sourceEndpoint, target: targetEndpoint } = await resolveEndpoints(job);

    await logJob(jobId, 'info', `Starting migration: ${sourceEndpoint.email} -> ${targetEndpoint.email}`);

    // Step 1: list source folders
    const parsedExclusions = JSON.parse(job.excludedFolders) as string[] | null;
    const useDefaults = parsedExclusions == null;
    const sourceCredentials = await sourceEndpoint.getCredentials();

    let folders: FolderInfo[];
    let headRoles: Map<string, HeadRole>;
    if (useDefaults || job.mode === 'bulk') {
      // Default/bulk exclusions work by ROLE: the flag entries in the stored
      // list signal which groups to skip. A real \Trash is skipped; an
      // ordinary folder that is merely named like one is migrated normally.
      const excludedList = parsedExclusions ?? DEFAULT_EXCLUDED_FOLDERS;
      const all = await getFolders(sourceCredentials, [], false);
      headRoles = detectSourceHeadRoles(all);
      folders = applyRoleExclusions(all, headRoles, {
        excludeTrash: excludedList.includes('\\Trash'),
        excludeJunk: excludedList.includes('\\Junk'),
      });
    } else {
      // Single mode with a user-picked folder selection: exact paths
      folders = await getFolders(sourceCredentials, parsedExclusions, false);
      headRoles = detectSourceHeadRoles(folders);
    }
    // Parents sort before their children, so nested folders are created in order
    folders.sort((a, b) => a.path.localeCompare(b.path));

    const totalMessages = folders.reduce((sum, folder) => sum + folder.messageCount, 0);
    await logJob(jobId, 'info', `Found ${folders.length} folders with ${totalMessages} messages to migrate`);

    // Step 2: create missing folders on the target (delimiter-translated)
    const targetCredentials = await targetEndpoint.getCredentials();

    checkCancelled(jobId);
    await withImapClient(targetCredentials, async (client) => {
      const existing = await client.list();
      const layout = detectTargetLayout(existing);
      const existingPaths = new Set(existing.map((m) => m.path));

      // Map every source folder to its target path by role, then create
      // parents before children (sorted by target path)
      const mapped = folders.map((folder) => {
        const segments = mapSourceFolderToTarget(folder, headRoles, layout);
        return { folder, segments, targetPath: segments.join(layout.delimiter) };
      });
      mapped.sort((a, b) => a.targetPath.localeCompare(b.targetPath));

      for (const { folder, segments, targetPath } of mapped) {
        let error: string | null = null;

        if (targetPath !== folder.path) {
          await logJob(jobId, 'info', `Mapped to target folder: ${targetPath}`, folder.path);
        }

        if (!existingPaths.has(targetPath)) {
          try {
            await client.mailboxCreate(segments);
            existingPaths.add(targetPath);
            await logJob(jobId, 'info', `Created folder on target: ${targetPath}`, folder.path);
          } catch (err) {
            error = `Could not create folder on target: ${errorMessage(err)}`;
            await logJob(jobId, 'error', error, folder.path);
          }
        }

        await prisma.migrationFolder.create({
          data: {
            jobId,
            path: folder.path,
            targetPath,
            status: error ? 'failed' : 'pending',
            messageCount: folder.messageCount,
            error,
          },
        });
      }
    });

    await prisma.migrationJob.update({
      where: { id: jobId },
      data: { totalFolders: folders.length, totalMessages },
    });

    // Step 3: copy folder by folder, batch by batch
    const folderRows = await prisma.migrationFolder.findMany({
      where: { jobId, status: 'pending' },
      orderBy: { path: 'asc' },
    });

    let consecutiveFailures = 0;
    for (const folderRow of folderRows) {
      checkCancelled(jobId);
      await prisma.migrationFolder.update({
        where: { id: folderRow.id },
        data: { status: 'running', startedAt: new Date() },
      });
      await prisma.migrationJob.update({ where: { id: jobId }, data: { currentFolder: folderRow.path } });

      try {
        await migrateFolder(jobId, folderRow, sourceEndpoint, targetEndpoint);
        consecutiveFailures = 0;
      } catch (err) {
        if (err instanceof MigrationCancelledError) throw err;

        const message = errorMessage(err);
        await prisma.migrationFolder.update({
          where: { id: folderRow.id },
          data: { status: 'failed', error: message, completedAt: new Date() },
        });
        await logJob(jobId, 'error', `Folder failed: ${message}`, folderRow.path);

        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FOLDER_FAILURES) {
          throw new Error(
            `${MAX_CONSECUTIVE_FOLDER_FAILURES} folders failed in a row (last: ${folderRow.path}) — aborting job. Fix the connection/credentials and start the migration again; completed work will be skipped.`
          );
        }
      }
    }

    // Step 4: final status from what actually happened
    const finalJob = (await getMigrationJob(jobId))!;
    const failedFolders = await prisma.migrationFolder.count({ where: { jobId, status: 'failed' } });
    const hasErrors = finalJob.failedMessages > 0 || failedFolders > 0;
    const finalStatus: MigrationJobStatus = hasErrors ? 'completed_with_errors' : 'completed';

    await prisma.migrationJob.update({
      where: { id: jobId },
      data: { status: finalStatus, currentFolder: null, completedAt: new Date() },
    });
    await logJob(
      jobId,
      hasErrors ? 'warn' : 'info',
      `Migration finished: ${finalJob.copiedMessages} copied, ${finalJob.skippedMessages} skipped, ${finalJob.failedMessages} failed` +
        (failedFolders > 0 ? `, ${failedFolders} folder(s) failed` : '')
    );
  } catch (err) {
    if (err instanceof MigrationCancelledError) {
      await prisma.migrationJob.update({
        where: { id: jobId },
        data: { status: 'cancelled', currentFolder: null, completedAt: new Date() },
      });
      await prisma.migrationFolder.updateMany({
        where: { jobId, status: 'running' },
        data: { status: 'pending', completedAt: null },
      });
      await logJob(jobId, 'warn', 'Migration cancelled. Start it again to resume — messages that already exist on the target will be skipped.');
    } else {
      const message = errorMessage(err);
      await prisma.migrationJob.update({
        where: { id: jobId },
        data: { status: 'failed', error: message, currentFolder: null, completedAt: new Date() },
      });
      await logJob(jobId, 'error', `Migration failed: ${message}`);
    }
  } finally {
    cancelRequests.delete(jobId);
  }
}
