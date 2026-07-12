import { apiRequest, apiDownload, apiFetchBlob } from './client';
import type { MigrationJobStatus } from './migration';

export interface ArchiveAccountView {
  id: number;
  email: string;
  username: string;
  imapHost: string;
  imapPort: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArchiveOverview {
  accounts: ArchiveAccountView[];
  tested: boolean;
}

export interface ArchiveImportRow {
  email: string;
  username: string;
  password: string;
}

export interface ArchiveImportRequest {
  imapHost: string;
  imapPort: number;
  accounts: ArchiveImportRow[];
}

export interface ArchiveImportResult {
  accounts: ArchiveAccountView[];
  warnings: string[];
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
  excludedFolders: string;
  totalFolders: number;
  totalMessages: number;
  processedMessages: number;
  savedMessages: number;
  failedMessages: number;
  currentFolder: string | null;
  zipPath: string | null;
  zipSize: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type ArchiveFolderStatus = 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed';

export interface ArchiveFolder {
  id: number;
  jobId: number;
  path: string;
  status: ArchiveFolderStatus;
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
  level: string;
  folderPath: string | null;
  uid: number | null;
  message: string;
  createdAt: string;
}

export interface ArchiveJobDetail {
  job: ArchiveJob;
  folders: ArchiveFolder[];
  logs: ArchiveLog[];
}

export interface ArchiveRunDetail {
  run: ArchiveRun;
  jobs: ArchiveJob[];
  currentJobDetail: ArchiveJobDetail | null;
}

export interface ArchiveRunOptions {
  excludeTrash: boolean;
  excludeJunk: boolean;
}

export async function importArchiveAccounts(data: ArchiveImportRequest): Promise<ArchiveImportResult> {
  return apiRequest('/archive/accounts', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function getArchiveOverview(): Promise<ArchiveOverview> {
  return apiRequest('/archive/accounts');
}

export async function clearArchiveAccounts(): Promise<{ deleted: number }> {
  return apiRequest('/archive/accounts', { method: 'DELETE' });
}

export async function deleteArchiveSession(): Promise<{ ok: boolean }> {
  return apiRequest('/archive/session', { method: 'DELETE' });
}

export async function testArchiveConnection(email?: string): Promise<{ ok: boolean; error?: string }> {
  return apiRequest('/archive/accounts/test', {
    method: 'POST',
    body: JSON.stringify(email ? { email } : {}),
  });
}

export async function startArchiveRun(
  options: ArchiveRunOptions
): Promise<{ runId: number; status: MigrationJobStatus }> {
  return apiRequest('/archive/execute', { method: 'POST', body: JSON.stringify(options) });
}

export async function listArchiveRuns(limit = 20): Promise<ArchiveRun[]> {
  return apiRequest(`/archive/runs?limit=${limit}`);
}

export async function getArchiveRun(runId: number): Promise<ArchiveRunDetail> {
  return apiRequest(`/archive/runs/${runId}`);
}

export async function cancelArchiveRun(runId: number): Promise<ArchiveRun> {
  return apiRequest(`/archive/runs/${runId}/cancel`, { method: 'POST' });
}

export async function deleteArchiveRun(runId: number): Promise<{ ok: boolean }> {
  return apiRequest(`/archive/runs/${runId}`, { method: 'DELETE' });
}

export async function downloadArchiveZip(jobId: number, filename: string): Promise<void> {
  return apiDownload(`/archive/jobs/${jobId}/download`, filename);
}

export async function fetchArchiveZipBlob(jobId: number): Promise<Blob> {
  return apiFetchBlob(`/archive/jobs/${jobId}/download`);
}
