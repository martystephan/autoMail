import { apiRequest } from './client';
import type { MigrationJobStatus } from './migration';

export interface ConnectionTestRow {
  email: string;
  username: string;
  password: string;
}

export type ConnectionTestResultStatus =
  | 'pending'
  | 'running'
  | 'ok'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface ConnectionTestResult {
  id: number;
  runId: number;
  email: string;
  username: string;
  status: ConnectionTestResultStatus;
  error: string | null;
  testedAt: string | null;
}

export interface ConnectionTestRun {
  id: number;
  status: MigrationJobStatus;
  imapHost: string;
  imapPort: number;
  totalAccounts: number;
  processedAccounts: number;
  okAccounts: number;
  failedAccounts: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ConnectionTestRunDetail {
  run: ConnectionTestRun;
  results: ConnectionTestResult[];
}

export interface ConnectionTestStartRequest {
  imapHost: string;
  imapPort: number;
  accounts: ConnectionTestRow[];
}

export async function startConnectionTestRun(
  data: ConnectionTestStartRequest
): Promise<{ runId: number; status: MigrationJobStatus }> {
  return apiRequest('/connection-test/execute', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function listConnectionTestRuns(limit = 20): Promise<ConnectionTestRun[]> {
  return apiRequest(`/connection-test/runs?limit=${limit}`);
}

export async function getConnectionTestRun(runId: number): Promise<ConnectionTestRunDetail> {
  return apiRequest(`/connection-test/runs/${runId}`);
}

export async function cancelConnectionTestRun(runId: number): Promise<ConnectionTestRun> {
  return apiRequest(`/connection-test/runs/${runId}/cancel`, { method: 'POST' });
}

export async function deleteConnectionTestRun(runId: number): Promise<{ ok: boolean }> {
  return apiRequest(`/connection-test/runs/${runId}`, { method: 'DELETE' });
}
