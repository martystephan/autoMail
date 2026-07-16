import { apiRequest, apiUpload } from './client';
import type { MigrationJobStatus } from './migration';

export interface ImportAccountView {
  id: number;
  email: string;
  username: string;
  imapHost: string;
  imapPort: number;
  zipFileName: string;
  createdAt: string;
  updatedAt: string;
  zipUploaded: boolean;
  zipSize?: number;
}

export interface UploadedZipInfo {
  fileName: string;
  size: number;
  uploadedAt: string;
}

export interface ImportOverview {
  accounts: ImportAccountView[];
  zips: UploadedZipInfo[];
  tested: boolean;
}

export interface ImportAccountRow {
  email: string;
  username: string;
  password: string;
  zipFileName: string;
}

export interface ImportAccountsRequest {
  imapHost: string;
  imapPort: number;
  accounts: ImportAccountRow[];
}

export interface ImportAccountsResult {
  accounts: ImportAccountView[];
  warnings: string[];
}

export interface ImportRun {
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

export interface ImportJob {
  id: number;
  runId: number;
  importAccountId: number | null;
  email: string;
  zipFileName: string;
  status: MigrationJobStatus;
  totalFolders: number;
  totalMessages: number;
  processedMessages: number;
  importedMessages: number;
  skippedMessages: number;
  failedMessages: number;
  currentFolder: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type ImportFolderStatus = 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed';

export interface ImportFolder {
  id: number;
  jobId: number;
  path: string;
  targetPath: string;
  status: ImportFolderStatus;
  messageCount: number;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ImportLog {
  id: number;
  jobId: number;
  level: string;
  folderPath: string | null;
  entryName: string | null;
  message: string;
  createdAt: string;
}

export interface ImportJobDetail {
  job: ImportJob;
  folders: ImportFolder[];
  logs: ImportLog[];
}

export interface ImportRunDetail {
  run: ImportRun;
  jobs: ImportJob[];
  currentJobDetail: ImportJobDetail | null;
}

export async function importImportAccounts(data: ImportAccountsRequest): Promise<ImportAccountsResult> {
  return apiRequest('/import/accounts', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function getImportOverview(): Promise<ImportOverview> {
  return apiRequest('/import/accounts');
}

export async function clearImportAccounts(): Promise<{ deleted: number }> {
  return apiRequest('/import/accounts', { method: 'DELETE' });
}

export async function deleteImportSession(): Promise<{ ok: boolean }> {
  return apiRequest('/import/session', { method: 'DELETE' });
}

export async function testImportConnection(email?: string): Promise<{ ok: boolean; error?: string }> {
  return apiRequest('/import/accounts/test', {
    method: 'POST',
    body: JSON.stringify(email ? { email } : {}),
  });
}

export async function uploadImportZip(file: File): Promise<{ fileName: string; size: number }> {
  const formData = new FormData();
  formData.append('zip', file);
  return apiUpload('/import/zips', formData);
}

export async function listImportZips(): Promise<UploadedZipInfo[]> {
  return apiRequest('/import/zips');
}

export async function deleteImportZip(fileName: string): Promise<{ ok: boolean }> {
  return apiRequest(`/import/zips/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
}

export async function deleteAllImportZips(): Promise<{ deleted: number }> {
  return apiRequest('/import/zips', { method: 'DELETE' });
}

export async function startImportRun(): Promise<{ runId: number; status: MigrationJobStatus }> {
  return apiRequest('/import/execute', { method: 'POST', body: JSON.stringify({}) });
}

export async function listImportRuns(limit = 20): Promise<ImportRun[]> {
  return apiRequest(`/import/runs?limit=${limit}`);
}

export async function getImportRun(runId: number): Promise<ImportRunDetail> {
  return apiRequest(`/import/runs/${runId}`);
}

export async function cancelImportRun(runId: number): Promise<ImportRun> {
  return apiRequest(`/import/runs/${runId}/cancel`, { method: 'POST' });
}

export async function deleteImportRun(runId: number): Promise<{ ok: boolean }> {
  return apiRequest(`/import/runs/${runId}`, { method: 'DELETE' });
}
