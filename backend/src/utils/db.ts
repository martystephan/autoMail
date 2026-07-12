import Database from 'better-sqlite3';
import path from 'path';

// Database types
export interface User {
  id: number;
  username: string;
  passwordHash: string;
  createdAt: string;
}

export interface MailAccount {
  id: number;
  name: string;
  type: string;
  email: string;
  imapHost: string | null;
  imapPort: number | null;
  password: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiry: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationFlow {
  id: number;
  name: string;
  sourceMailAccountId: number;
  sourceMailbox: string;
  targetMailAccountId: number;
  targetMailbox: string;
  enabled: number; // SQLite uses 0/1 for boolean
  intervalMinutes: number;
  lastRun: string | null;
  nextRun: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationExecution {
  id: number;
  flowId: number;
  status: string;
  movedCount: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

// Flow with joined accounts
export interface FlowWithAccounts extends AutomationFlow {
  sourceMailAccount: MailAccount;
  targetMailAccount: MailAccount;
}

export type MigrationJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type MigrationMode = 'single' | 'bulk';

export interface MigrationJob {
  id: number;
  sourceAccountId: number | null;
  targetAccountId: number | null;
  mode: MigrationMode;
  bulkRunId: number | null;
  sourceBulkAccountId: number | null;
  targetBulkAccountId: number | null;
  bulkEmail: string | null;
  status: MigrationJobStatus;
  excludedFolders: string; // JSON array or "null" (= use defaults)
  totalFolders: number;
  totalMessages: number;
  processedMessages: number;
  copiedMessages: number;
  skippedMessages: number;
  failedMessages: number;
  currentFolder: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type MigrationFolderStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed';

export interface MigrationFolder {
  id: number;
  jobId: number;
  path: string; // path on the source account
  targetPath: string; // path on the target account (delimiter-translated)
  status: MigrationFolderStatus;
  messageCount: number;
  copiedCount: number;
  skippedCount: number;
  failedCount: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface MigrationLog {
  id: number;
  jobId: number;
  level: string; // info | warn | error
  folderPath: string | null;
  uid: number | null;
  message: string;
  createdAt: string;
}

export type BulkRole = 'source' | 'target';

export interface BulkAccount {
  id: number;
  role: BulkRole;
  email: string;
  targetEmail: string | null; // source rows only: match this target email instead of the own one
  username: string; // IMAP login
  password: string; // AES-encrypted at rest
  imapHost: string;
  imapPort: number;
  createdAt: string;
  updatedAt: string;
}

export interface BulkRun {
  id: number;
  status: MigrationJobStatus;
  totalPairs: number;
  completedPairs: number;
  failedPairs: number;
  currentJobId: number | null;
  currentEmail: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ArchiveAccount {
  id: number;
  email: string;
  username: string; // IMAP login
  password: string; // AES-encrypted at rest
  imapHost: string;
  imapPort: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArchiveRun {
  id: number;
  status: MigrationJobStatus;
  totalAccounts: number;
  completedAccounts: number;
  failedAccounts: number;
  currentJobId: number | null;
  currentEmail: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ArchiveJob {
  id: number;
  runId: number;
  archiveAccountId: number | null;
  email: string;
  status: MigrationJobStatus;
  excludedFolders: string; // JSON array of special-use flags ('\Trash', '\Junk')
  totalFolders: number;
  totalMessages: number;
  processedMessages: number;
  savedMessages: number;
  failedMessages: number;
  currentFolder: string | null;
  zipPath: string | null; // relative to ARCHIVE_DIR, set once the zip exists
  zipSize: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ArchiveFolder {
  id: number;
  jobId: number;
  path: string;
  status: MigrationFolderStatus;
  messageCount: number;
  savedCount: number;
  failedCount: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ArchiveLog {
  id: number;
  jobId: number;
  level: string; // info | warn | error
  folderPath: string | null;
  uid: number | null;
  message: string;
  createdAt: string;
}

// Initialize database
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../data/automail.db');

// Ensure data directory exists
import fs from 'fs';
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Tables from older versions of the migration feature that no longer exist:
// the copied-messages ledger (replaced by Message-ID comparison with the
// target at run time) and the JSON session blob (replaced by the structured
// tables below).
db.exec(`
  DROP TABLE IF EXISTS migration_copied_messages;
  DROP TABLE IF EXISTS bulk_session;
`);

// A bulk_accounts table from before the username/targetEmail columns can
// simply be recreated — imports are replaceable
const bulkAccountsColumns = db.pragma('table_info(bulk_accounts)') as { name: string }[];
if (bulkAccountsColumns.length > 0 && !bulkAccountsColumns.some((column) => column.name === 'username')) {
  db.exec('DROP TABLE bulk_accounts');
  console.log('Dropped outdated bulk_accounts table — re-import the CSVs');
}

// Create tables if they don't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    passwordHash TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS mail_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    email TEXT NOT NULL,
    imapHost TEXT,
    imapPort INTEGER,
    password TEXT,
    accessToken TEXT,
    refreshToken TEXT,
    tokenExpiry TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS automation_flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    sourceMailAccountId INTEGER NOT NULL,
    sourceMailbox TEXT NOT NULL,
    targetMailAccountId INTEGER NOT NULL,
    targetMailbox TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    intervalMinutes INTEGER NOT NULL DEFAULT 60,
    lastRun TEXT,
    nextRun TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (sourceMailAccountId) REFERENCES mail_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (targetMailAccountId) REFERENCES mail_accounts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS automation_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flowId INTEGER NOT NULL,
    status TEXT NOT NULL,
    movedCount INTEGER NOT NULL DEFAULT 0,
    errorMessage TEXT,
    startedAt TEXT NOT NULL DEFAULT (datetime('now')),
    completedAt TEXT,
    FOREIGN KEY (flowId) REFERENCES automation_flows(id) ON DELETE CASCADE
  );

  -- The bulk migration project: imported CSV accounts and run history. Pure
  -- follow-along data — it is never used to resume a run from a point (every
  -- run compares source and target and skips what already exists). It lives
  -- until the user deletes the project.
  CREATE TABLE IF NOT EXISTS bulk_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('source', 'target')),
    email TEXT NOT NULL,
    targetEmail TEXT,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    imapHost TEXT NOT NULL,
    imapPort INTEGER NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (role, email)
  );

  -- One bulk run = a sequential batch of per-pair migration jobs
  CREATE TABLE IF NOT EXISTS bulk_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'pending',
    totalPairs INTEGER NOT NULL DEFAULT 0,
    completedPairs INTEGER NOT NULL DEFAULT 0,
    failedPairs INTEGER NOT NULL DEFAULT 0,
    currentJobId INTEGER,
    currentEmail TEXT,
    error TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    startedAt TEXT,
    completedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS migration_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceAccountId INTEGER,
    targetAccountId INTEGER,
    mode TEXT NOT NULL DEFAULT 'single',
    bulkRunId INTEGER,
    sourceBulkAccountId INTEGER,
    targetBulkAccountId INTEGER,
    bulkEmail TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    excludedFolders TEXT NOT NULL DEFAULT 'null',
    totalFolders INTEGER NOT NULL DEFAULT 0,
    totalMessages INTEGER NOT NULL DEFAULT 0,
    processedMessages INTEGER NOT NULL DEFAULT 0,
    copiedMessages INTEGER NOT NULL DEFAULT 0,
    skippedMessages INTEGER NOT NULL DEFAULT 0,
    failedMessages INTEGER NOT NULL DEFAULT 0,
    currentFolder TEXT,
    error TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    startedAt TEXT,
    completedAt TEXT,
    FOREIGN KEY (sourceAccountId) REFERENCES mail_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (targetAccountId) REFERENCES mail_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (bulkRunId) REFERENCES bulk_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (sourceBulkAccountId) REFERENCES bulk_accounts(id) ON DELETE SET NULL,
    FOREIGN KEY (targetBulkAccountId) REFERENCES bulk_accounts(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS migration_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jobId INTEGER NOT NULL,
    path TEXT NOT NULL,
    targetPath TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    messageCount INTEGER NOT NULL DEFAULT 0,
    copiedCount INTEGER NOT NULL DEFAULT 0,
    skippedCount INTEGER NOT NULL DEFAULT 0,
    failedCount INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    startedAt TEXT,
    completedAt TEXT,
    FOREIGN KEY (jobId) REFERENCES migration_jobs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_migration_folders_job ON migration_folders(jobId);

  CREATE TABLE IF NOT EXISTS migration_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jobId INTEGER NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    folderPath TEXT,
    uid INTEGER,
    message TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (jobId) REFERENCES migration_jobs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_migration_logs_job ON migration_logs(jobId);

  -- The archive project: imported CSV accounts and run history. Read-only
  -- exports — each run writes one zip of .eml files per account; the zips
  -- stay on disk until the user deletes the run or the project.
  CREATE TABLE IF NOT EXISTS archive_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    imapHost TEXT NOT NULL,
    imapPort INTEGER NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One archive run = a sequential batch of per-account archive jobs
  CREATE TABLE IF NOT EXISTS archive_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'pending',
    totalAccounts INTEGER NOT NULL DEFAULT 0,
    completedAccounts INTEGER NOT NULL DEFAULT 0,
    failedAccounts INTEGER NOT NULL DEFAULT 0,
    currentJobId INTEGER,
    currentEmail TEXT,
    error TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    startedAt TEXT,
    completedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS archive_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    runId INTEGER NOT NULL,
    archiveAccountId INTEGER,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    excludedFolders TEXT NOT NULL DEFAULT '[]',
    totalFolders INTEGER NOT NULL DEFAULT 0,
    totalMessages INTEGER NOT NULL DEFAULT 0,
    processedMessages INTEGER NOT NULL DEFAULT 0,
    savedMessages INTEGER NOT NULL DEFAULT 0,
    failedMessages INTEGER NOT NULL DEFAULT 0,
    currentFolder TEXT,
    zipPath TEXT,
    zipSize INTEGER,
    error TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    startedAt TEXT,
    completedAt TEXT,
    FOREIGN KEY (runId) REFERENCES archive_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (archiveAccountId) REFERENCES archive_accounts(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_archive_jobs_run ON archive_jobs(runId);

  CREATE TABLE IF NOT EXISTS archive_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jobId INTEGER NOT NULL,
    path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    messageCount INTEGER NOT NULL DEFAULT 0,
    savedCount INTEGER NOT NULL DEFAULT 0,
    failedCount INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    startedAt TEXT,
    completedAt TEXT,
    FOREIGN KEY (jobId) REFERENCES archive_jobs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_archive_folders_job ON archive_folders(jobId);

  CREATE TABLE IF NOT EXISTS archive_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jobId INTEGER NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    folderPath TEXT,
    uid INTEGER,
    message TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (jobId) REFERENCES archive_jobs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_archive_logs_job ON archive_logs(jobId);
`);

// One-time rebuild of migration_jobs for databases created before bulk mode:
// the account columns must become nullable and the bulk columns added, and
// SQLite cannot do either via ALTER TABLE. Foreign keys are switched OFF so
// that DROP/RENAME neither cascade-deletes migration_folders/migration_logs
// nor rewrites their FK references to the temporary table name.
const migrationJobsColumns = db.pragma('table_info(migration_jobs)') as { name: string }[];
if (!migrationJobsColumns.some((column) => column.name === 'bulkRunId')) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE migration_jobs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceAccountId INTEGER,
        targetAccountId INTEGER,
        mode TEXT NOT NULL DEFAULT 'single',
        bulkRunId INTEGER,
        sourceBulkAccountId INTEGER,
        targetBulkAccountId INTEGER,
        bulkEmail TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        excludedFolders TEXT NOT NULL DEFAULT 'null',
        totalFolders INTEGER NOT NULL DEFAULT 0,
        totalMessages INTEGER NOT NULL DEFAULT 0,
        processedMessages INTEGER NOT NULL DEFAULT 0,
        copiedMessages INTEGER NOT NULL DEFAULT 0,
        skippedMessages INTEGER NOT NULL DEFAULT 0,
        failedMessages INTEGER NOT NULL DEFAULT 0,
        currentFolder TEXT,
        error TEXT,
        createdAt TEXT NOT NULL DEFAULT (datetime('now')),
        startedAt TEXT,
        completedAt TEXT,
        FOREIGN KEY (sourceAccountId) REFERENCES mail_accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (targetAccountId) REFERENCES mail_accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (bulkRunId) REFERENCES bulk_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (sourceBulkAccountId) REFERENCES bulk_accounts(id) ON DELETE SET NULL,
        FOREIGN KEY (targetBulkAccountId) REFERENCES bulk_accounts(id) ON DELETE SET NULL
      );

      INSERT INTO migration_jobs_new (
        id, sourceAccountId, targetAccountId, status, excludedFolders,
        totalFolders, totalMessages, processedMessages, copiedMessages,
        skippedMessages, failedMessages, currentFolder, error,
        createdAt, startedAt, completedAt
      )
      SELECT
        id, sourceAccountId, targetAccountId, status, excludedFolders,
        totalFolders, totalMessages, processedMessages, copiedMessages,
        skippedMessages, failedMessages, currentFolder, error,
        createdAt, startedAt, completedAt
      FROM migration_jobs;

      DROP TABLE migration_jobs;
      ALTER TABLE migration_jobs_new RENAME TO migration_jobs;
    `);
  })();
  db.pragma('foreign_keys = ON');
  console.log('Rebuilt migration_jobs table with bulk migration columns');
}

export default db;
