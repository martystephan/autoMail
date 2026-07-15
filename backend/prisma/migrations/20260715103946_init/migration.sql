-- CreateTable
CREATE TABLE "mail_accounts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "imapHost" TEXT,
    "imapPort" INTEGER,
    "password" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "tokenExpiry" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "automation_flows" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "sourceMailAccountId" INTEGER NOT NULL,
    "sourceMailbox" TEXT NOT NULL,
    "targetMailAccountId" INTEGER NOT NULL,
    "targetMailbox" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 60,
    "lastRun" DATETIME,
    "nextRun" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "automation_flows_sourceMailAccountId_fkey" FOREIGN KEY ("sourceMailAccountId") REFERENCES "mail_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "automation_flows_targetMailAccountId_fkey" FOREIGN KEY ("targetMailAccountId") REFERENCES "mail_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "automation_executions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "flowId" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "movedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "automation_executions_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "automation_flows" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "bulk_accounts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "role" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "targetEmail" TEXT,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "bulk_runs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalPairs" INTEGER NOT NULL DEFAULT 0,
    "completedPairs" INTEGER NOT NULL DEFAULT 0,
    "failedPairs" INTEGER NOT NULL DEFAULT 0,
    "currentJobId" INTEGER,
    "currentEmail" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "migration_jobs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sourceAccountId" INTEGER,
    "targetAccountId" INTEGER,
    "mode" TEXT NOT NULL DEFAULT 'single',
    "bulkRunId" INTEGER,
    "sourceBulkAccountId" INTEGER,
    "targetBulkAccountId" INTEGER,
    "bulkEmail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "excludedFolders" TEXT NOT NULL DEFAULT 'null',
    "totalFolders" INTEGER NOT NULL DEFAULT 0,
    "totalMessages" INTEGER NOT NULL DEFAULT 0,
    "processedMessages" INTEGER NOT NULL DEFAULT 0,
    "copiedMessages" INTEGER NOT NULL DEFAULT 0,
    "skippedMessages" INTEGER NOT NULL DEFAULT 0,
    "failedMessages" INTEGER NOT NULL DEFAULT 0,
    "currentFolder" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "migration_jobs_sourceAccountId_fkey" FOREIGN KEY ("sourceAccountId") REFERENCES "mail_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "migration_jobs_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES "mail_accounts" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "migration_jobs_bulkRunId_fkey" FOREIGN KEY ("bulkRunId") REFERENCES "bulk_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "migration_jobs_sourceBulkAccountId_fkey" FOREIGN KEY ("sourceBulkAccountId") REFERENCES "bulk_accounts" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "migration_jobs_targetBulkAccountId_fkey" FOREIGN KEY ("targetBulkAccountId") REFERENCES "bulk_accounts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "migration_folders" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobId" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "targetPath" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "copiedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "migration_folders_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "migration_jobs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "migration_logs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobId" INTEGER NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "folderPath" TEXT,
    "uid" INTEGER,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "migration_logs_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "migration_jobs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "archive_accounts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "archive_runs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalAccounts" INTEGER NOT NULL DEFAULT 0,
    "completedAccounts" INTEGER NOT NULL DEFAULT 0,
    "failedAccounts" INTEGER NOT NULL DEFAULT 0,
    "currentJobId" INTEGER,
    "currentEmail" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "archive_jobs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "archiveAccountId" INTEGER,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "excludedFolders" TEXT NOT NULL DEFAULT '[]',
    "totalFolders" INTEGER NOT NULL DEFAULT 0,
    "totalMessages" INTEGER NOT NULL DEFAULT 0,
    "processedMessages" INTEGER NOT NULL DEFAULT 0,
    "savedMessages" INTEGER NOT NULL DEFAULT 0,
    "failedMessages" INTEGER NOT NULL DEFAULT 0,
    "currentFolder" TEXT,
    "zipPath" TEXT,
    "zipSize" INTEGER,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "archive_jobs_runId_fkey" FOREIGN KEY ("runId") REFERENCES "archive_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "archive_jobs_archiveAccountId_fkey" FOREIGN KEY ("archiveAccountId") REFERENCES "archive_accounts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "archive_folders" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobId" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "savedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "archive_folders_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "archive_jobs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "archive_logs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobId" INTEGER NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "folderPath" TEXT,
    "uid" INTEGER,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "archive_logs_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "archive_jobs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "connection_test_runs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL,
    "totalAccounts" INTEGER NOT NULL DEFAULT 0,
    "processedAccounts" INTEGER NOT NULL DEFAULT 0,
    "okAccounts" INTEGER NOT NULL DEFAULT 0,
    "failedAccounts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "connection_test_results" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "testedAt" DATETIME,
    CONSTRAINT "connection_test_results_runId_fkey" FOREIGN KEY ("runId") REFERENCES "connection_test_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" DATETIME NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" DATETIME,
    "refreshTokenExpiresAt" DATETIME,
    "scope" TEXT,
    "password" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "bulk_accounts_role_email_key" ON "bulk_accounts"("role", "email");

-- CreateIndex
CREATE INDEX "idx_migration_folders_job" ON "migration_folders"("jobId");

-- CreateIndex
CREATE INDEX "idx_migration_logs_job" ON "migration_logs"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "archive_accounts_email_key" ON "archive_accounts"("email");

-- CreateIndex
CREATE INDEX "idx_archive_jobs_run" ON "archive_jobs"("runId");

-- CreateIndex
CREATE INDEX "idx_archive_folders_job" ON "archive_folders"("jobId");

-- CreateIndex
CREATE INDEX "idx_archive_logs_job" ON "archive_logs"("jobId");

-- CreateIndex
CREATE INDEX "idx_connection_test_results_run" ON "connection_test_results"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");
