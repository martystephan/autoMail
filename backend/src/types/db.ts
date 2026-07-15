import type { Prisma } from '@prisma/client';

// Model types come from the Prisma client; the old interface names from
// utils/db are preserved so importers only change the import path.
export type {
  MailAccount,
  AutomationFlow,
  AutomationExecution,
  BulkAccount,
  BulkRun,
  MigrationJob,
  MigrationFolder,
  MigrationLog,
  ArchiveAccount,
  ArchiveRun,
  ArchiveJob,
  ArchiveFolder,
  ArchiveLog,
  ConnectionTestRun,
  ConnectionTestResult,
} from '@prisma/client';

// Status unions — SQLite has no Prisma enums, so the columns are plain
// strings and these unions document/constrain the values the app writes.
export type MigrationJobStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type MigrationMode = 'single' | 'bulk';

export type MigrationFolderStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'completed_with_errors'
  | 'failed';

export type BulkRole = 'source' | 'target';

export type ConnectionTestResultStatus =
  | 'pending'
  | 'running'
  | 'ok'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

// Flow with joined accounts
export type FlowWithAccounts = Prisma.AutomationFlowGetPayload<{
  include: { sourceMailAccount: true; targetMailAccount: true };
}>;
