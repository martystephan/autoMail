import { apiRequest } from './client';
import type { MigrationJob, MigrationJobDetail, MigrationJobStatus } from './migration';

export type BulkRole = 'source' | 'target';

export interface BulkAccountView {
  id: number;
  role: BulkRole;
  email: string;
  targetEmail: string | null;
  username: string;
  imapHost: string;
  imapPort: number;
  createdAt: string;
  updatedAt: string;
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
  tested: Record<BulkRole, boolean>;
}

export interface BulkImportRow {
  email: string;
  username: string;
  password: string;
  targetEmail?: string; // source rows only
}

export interface BulkImportRequest {
  imapHost: string;
  imapPort: number;
  accounts: BulkImportRow[];
}

export interface BulkImportResult {
  accounts: BulkAccountView[];
  warnings: string[];
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

export interface BulkRunDetail {
  run: BulkRun;
  jobs: MigrationJob[];
  currentJobDetail: MigrationJobDetail | null;
}

export async function importBulkAccounts(role: BulkRole, data: BulkImportRequest): Promise<BulkImportResult> {
  return apiRequest(`/migration/bulk/accounts/${role}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function getBulkOverview(): Promise<BulkOverview> {
  return apiRequest('/migration/bulk/accounts');
}

export async function clearBulkAccounts(role: BulkRole): Promise<{ deleted: number }> {
  return apiRequest(`/migration/bulk/accounts/${role}`, { method: 'DELETE' });
}

export async function deleteBulkSession(): Promise<{ ok: boolean }> {
  return apiRequest('/migration/bulk/session', { method: 'DELETE' });
}

export async function testBulkConnection(role: BulkRole, email?: string): Promise<{ ok: boolean; error?: string }> {
  return apiRequest(`/migration/bulk/accounts/${role}/test`, {
    method: 'POST',
    body: JSON.stringify(email ? { email } : {}),
  });
}

export interface BulkRunOptions {
  excludeTrash: boolean;
  excludeJunk: boolean;
}

export async function startBulkMigration(
  options: BulkRunOptions
): Promise<{ runId: number; status: MigrationJobStatus }> {
  return apiRequest('/migration/bulk/execute', { method: 'POST', body: JSON.stringify(options) });
}

export async function listBulkRuns(limit = 20): Promise<BulkRun[]> {
  return apiRequest(`/migration/bulk/runs?limit=${limit}`);
}

export async function getBulkRun(runId: number): Promise<BulkRunDetail> {
  return apiRequest(`/migration/bulk/runs/${runId}`);
}

export async function cancelBulkRun(runId: number): Promise<BulkRun> {
  return apiRequest(`/migration/bulk/runs/${runId}/cancel`, { method: 'POST' });
}
