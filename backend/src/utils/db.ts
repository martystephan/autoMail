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

export interface MigrationJob {
  id: number;
  sourceAccountId: number;
  targetAccountId: number;
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

  CREATE TABLE IF NOT EXISTS migration_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceAccountId INTEGER NOT NULL,
    targetAccountId INTEGER NOT NULL,
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
    FOREIGN KEY (targetAccountId) REFERENCES mail_accounts(id) ON DELETE CASCADE
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

  -- Idempotency ledger: which source messages have already been copied to which
  -- target. Keyed by account pair + folder + UIDVALIDITY + UID, independent of
  -- the job, so a re-run (new job) skips everything that already arrived.
  CREATE TABLE IF NOT EXISTS migration_copied_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceAccountId INTEGER NOT NULL,
    targetAccountId INTEGER NOT NULL,
    folderPath TEXT NOT NULL,
    uidValidity TEXT NOT NULL,
    uid INTEGER NOT NULL,
    copiedAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(sourceAccountId, targetAccountId, folderPath, uidValidity, uid)
  );
`);

export default db;
