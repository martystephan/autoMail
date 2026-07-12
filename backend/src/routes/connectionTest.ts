import { Router, Request, Response } from 'express';
import {
  createConnectionTestRun,
  runConnectionTestRun,
  getConnectionTestRunDetail,
  listConnectionTestRuns,
  cancelConnectionTestRun,
  deleteConnectionTestRun,
  findActiveConnectionTestRun,
} from '../services/connectionTest';
import { HTTP_STATUS, ERROR_MESSAGES } from '../constants';

const router = Router();

// POST /api/connection-test/execute - Upload credentials and start testing
// them in the background. Passwords are only kept in memory for the run.
router.post('/execute', (req: Request, res: Response) => {
  try {
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

    const activeRun = findActiveConnectionTestRun();
    if (activeRun) {
      res.status(HTTP_STATUS.CONFLICT).json({
        error: `A connection test (#${activeRun.id}) is currently running`,
      });
      return;
    }

    const run = createConnectionTestRun(imapHost.trim(), port, accounts);

    // Fire and forget — progress is tracked in the DB and polled by the client
    runConnectionTestRun(run.id).catch((err) => {
      console.error(`Unexpected error in connection test run ${run.id}:`, err);
    });

    res.status(HTTP_STATUS.ACCEPTED).json({ runId: run.id, status: run.status });
  } catch (error: any) {
    // Validation errors from the service (bad email, empty password, ...)
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: error.message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
});

// GET /api/connection-test/runs - List recent connection test runs
router.get('/runs', (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
  res.json(listConnectionTestRuns(limit));
});

// GET /api/connection-test/runs/:id - Run status with all per-row results
router.get('/runs/:id', (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.id), 10);
  const detail = Number.isFinite(runId) ? getConnectionTestRunDetail(runId) : undefined;

  if (!detail) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Connection test run not found' });
    return;
  }

  res.json(detail);
});

// POST /api/connection-test/runs/:id/cancel - Request cancellation of a running test
router.post('/runs/:id/cancel', (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.id), 10);
  const run = Number.isFinite(runId) ? cancelConnectionTestRun(runId) : undefined;

  if (!run) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Connection test run not found' });
    return;
  }

  res.json(run);
});

// DELETE /api/connection-test/runs/:id - Delete a finished run and its results
router.delete('/runs/:id', (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.id), 10);
    const deleted = Number.isFinite(runId) ? deleteConnectionTestRun(runId) : false;

    if (!deleted) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Connection test run not found' });
      return;
    }

    res.json({ ok: true });
  } catch (error: any) {
    // The run is still active
    res.status(HTTP_STATUS.CONFLICT).json({ error: error.message });
  }
});

export default router;
