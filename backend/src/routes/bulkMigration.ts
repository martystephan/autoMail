import { Router, Request, Response } from 'express';
import { BulkRole } from '../types/db';
import { findActiveMigrationJob } from '../services/migration';
import {
  deleteBulkSession,
  replaceBulkAccounts,
  deleteBulkAccounts,
  getBulkOverview,
  testBulkConnection,
  createBulkRun,
  runBulkMigration,
  getBulkRunDetail,
  listBulkRuns,
  cancelBulkRun,
  findActiveBulkRun,
} from '../services/bulkMigration';
import { HTTP_STATUS, ERROR_MESSAGES } from '../constants';

const router = Router();

function parseRole(value: string): BulkRole | undefined {
  return value === 'source' || value === 'target' ? value : undefined;
}

// Imports and deletes are blocked while anything is migrating so credentials
// don't change under a running job
async function activeMigrationError(): Promise<string | undefined> {
  const activeJob = await findActiveMigrationJob();
  if (activeJob) return `A migration (job #${activeJob.id}) is currently running`;
  const activeRun = await findActiveBulkRun();
  if (activeRun) return `A bulk migration (run #${activeRun.id}) is currently running`;
  return undefined;
}

// PUT /api/migration/bulk/accounts/:role - Replace the imported accounts of one role
router.put('/accounts/:role', async (req: Request, res: Response) => {
  try {
    const role = parseRole(String(req.params.role));
    if (!role) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: "Role must be 'source' or 'target'" });
      return;
    }

    const { imapHost, imapPort, accounts } = req.body;
    const port = parseInt(String(imapPort), 10);
    if (!imapHost || typeof imapHost !== 'string' || !imapHost.trim()) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'imapHost is required' });
      return;
    }
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'imapPort must be a valid port number' });
      return;
    }
    if (!Array.isArray(accounts) || accounts.length === 0) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'accounts must be a non-empty array' });
      return;
    }

    const conflict = await activeMigrationError();
    if (conflict) {
      res.status(HTTP_STATUS.CONFLICT).json({ error: conflict });
      return;
    }

    const result = await replaceBulkAccounts(role, imapHost.trim(), port, accounts);
    res.json(result);
  } catch (error: any) {
    // Validation errors from the service (bad email, empty password, ...)
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: error.message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
});

// GET /api/migration/bulk/accounts - Both imports plus the email matching
router.get('/accounts', async (_req: Request, res: Response) => {
  res.json(await getBulkOverview());
});

// DELETE /api/migration/bulk/accounts/:role - Clear one imported table
router.delete('/accounts/:role', async (req: Request, res: Response) => {
  const role = parseRole(String(req.params.role));
  if (!role) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: "Role must be 'source' or 'target'" });
    return;
  }

  const conflict = await activeMigrationError();
  if (conflict) {
    res.status(HTTP_STATUS.CONFLICT).json({ error: conflict });
    return;
  }

  res.json({ deleted: await deleteBulkAccounts(role) });
});

// DELETE /api/migration/bulk/session - Remove the whole migration project
// (imported accounts, runs, and job history)
router.delete('/session', async (_req: Request, res: Response) => {
  const conflict = await activeMigrationError();
  if (conflict) {
    res.status(HTTP_STATUS.CONFLICT).json({ error: conflict });
    return;
  }

  await deleteBulkSession();
  res.json({ ok: true });
});

// POST /api/migration/bulk/accounts/:role/test - Try an IMAP login with one imported row
router.post('/accounts/:role/test', async (req: Request, res: Response) => {
  const role = parseRole(String(req.params.role));
  if (!role) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: "Role must be 'source' or 'target'" });
    return;
  }

  res.json(await testBulkConnection(role, req.body?.email));
});

// POST /api/migration/bulk/execute - Start a bulk run (runs in the background)
router.post('/execute', async (req: Request, res: Response) => {
  try {
    const conflict = await activeMigrationError();
    if (conflict) {
      res.status(HTTP_STATUS.CONFLICT).json({ error: conflict });
      return;
    }

    const overview = await getBulkOverview();
    if (overview.pairs.length === 0) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'No matched account pairs — import source and target accounts with matching email addresses first',
      });
      return;
    }

    // Every imported account must belong to a pair — unmatched rows point to
    // a mistake in the CSVs, so migration cannot start until they are fixed
    const unmatched = overview.unmatchedSource.length + overview.unmatchedTarget.length;
    if (unmatched > 0) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: `${unmatched} imported account(s) have no counterpart — all accounts must be matched before starting`,
      });
      return;
    }

    if (!overview.tested.source || !overview.tested.target) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'Test the source and target connections successfully before starting',
      });
      return;
    }

    const run = await createBulkRun(overview.pairs.length);

    // Fire and forget — progress is tracked in the DB and polled by the client
    runBulkMigration(run.id, {
      excludeTrash: req.body?.excludeTrash !== false,
      excludeJunk: req.body?.excludeJunk !== false,
    }).catch((err) => {
      console.error(`Unexpected error in bulk migration run ${run.id}:`, err);
    });

    res.status(HTTP_STATUS.ACCEPTED).json({ runId: run.id, status: run.status });
  } catch (error: any) {
    console.error('Error starting bulk migration:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      error: error.message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
});

// GET /api/migration/bulk/runs - List recent bulk runs
router.get('/runs', async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
  res.json(await listBulkRuns(limit));
});

// GET /api/migration/bulk/runs/:id - Run status with per-pair jobs and current job detail
router.get('/runs/:id', async (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.id), 10);
  const detail = Number.isFinite(runId) ? await getBulkRunDetail(runId) : undefined;

  if (!detail) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Bulk migration run not found' });
    return;
  }

  res.json(detail);
});

// POST /api/migration/bulk/runs/:id/cancel - Request cancellation of a running bulk run
router.post('/runs/:id/cancel', async (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.id), 10);
  const run = Number.isFinite(runId) ? await cancelBulkRun(runId) : undefined;

  if (!run) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Bulk migration run not found' });
    return;
  }

  res.json(run);
});

export default router;
