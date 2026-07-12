import { apiRequest } from './client';

export interface FolderInfo {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: string;
  messageCount: number;
}

export interface MigrationPreview {
  folders: FolderInfo[];
  totalMessages: number;
  excludedFolders: string[];
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
  bulkEmail: string | null;
  status: MigrationJobStatus;
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
  path: string;
  targetPath: string;
  status: MigrationFolderStatus;
  messageCount: number;
  copiedCount: number;
  skippedCount: number;
  failedCount: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface MigrationLogEntry {
  id: number;
  jobId: number;
  level: string;
  folderPath: string | null;
  uid: number | null;
  message: string;
  createdAt: string;
}

export interface MigrationJobDetail {
  job: MigrationJob;
  folders: MigrationFolder[];
  logs: MigrationLogEntry[];
}

export interface MigrationRequest {
  sourceAccountId: number;
  targetAccountId?: number;
  excludedFolders?: string[];
}

export const TERMINAL_JOB_STATUSES: MigrationJobStatus[] = [
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
  'interrupted',
];

export function isJobActive(status: MigrationJobStatus): boolean {
  return !TERMINAL_JOB_STATUSES.includes(status);
}

export async function getMigrationPreview(data: MigrationRequest): Promise<MigrationPreview> {
  return apiRequest('/migration/preview', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function startMigration(data: MigrationRequest): Promise<{ jobId: number; status: MigrationJobStatus }> {
  return apiRequest('/migration/execute', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function listMigrationJobs(limit = 20): Promise<MigrationJob[]> {
  return apiRequest(`/migration/jobs?limit=${limit}`);
}

export async function getMigrationJob(jobId: number): Promise<MigrationJobDetail> {
  return apiRequest(`/migration/jobs/${jobId}`);
}

export async function cancelMigrationJob(jobId: number): Promise<MigrationJob> {
  return apiRequest(`/migration/jobs/${jobId}/cancel`, { method: 'POST' });
}
