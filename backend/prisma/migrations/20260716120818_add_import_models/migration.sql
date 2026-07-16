-- CreateTable
CREATE TABLE "import_accounts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL,
    "zipFileName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "import_runs" (
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
CREATE TABLE "import_jobs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "importAccountId" INTEGER,
    "email" TEXT NOT NULL,
    "zipFileName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalFolders" INTEGER NOT NULL DEFAULT 0,
    "totalMessages" INTEGER NOT NULL DEFAULT 0,
    "processedMessages" INTEGER NOT NULL DEFAULT 0,
    "importedMessages" INTEGER NOT NULL DEFAULT 0,
    "skippedMessages" INTEGER NOT NULL DEFAULT 0,
    "failedMessages" INTEGER NOT NULL DEFAULT 0,
    "currentFolder" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "import_jobs_runId_fkey" FOREIGN KEY ("runId") REFERENCES "import_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "import_jobs_importAccountId_fkey" FOREIGN KEY ("importAccountId") REFERENCES "import_accounts" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "import_folders" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobId" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "targetPath" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "importedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "import_folders_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "import_jobs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "import_logs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobId" INTEGER NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "folderPath" TEXT,
    "entryName" TEXT,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "import_logs_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "import_jobs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "import_accounts_email_key" ON "import_accounts"("email");

-- CreateIndex
CREATE INDEX "idx_import_jobs_run" ON "import_jobs"("runId");

-- CreateIndex
CREATE INDEX "idx_import_folders_job" ON "import_folders"("jobId");

-- CreateIndex
CREATE INDEX "idx_import_logs_job" ON "import_logs"("jobId");
