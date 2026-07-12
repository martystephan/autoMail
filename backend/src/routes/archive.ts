import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import {
  ARCHIVE_DIR,
  replaceArchiveAccounts,
  deleteArchiveAccounts,
  getArchiveOverview,
  testArchiveConnection,
  createArchiveRun,
  runArchiveRun,
  getArchiveRunDetail,
  listArchiveRuns,
  cancelArchiveRun,
  deleteArchiveRun,
  deleteArchiveSession,
  findActiveArchiveRun,
  getArchiveJob,
} from '../services/archive';
import { HTTP_STATUS, ERROR_MESSAGES } from '../constants';

const router = Router();

// Imports and deletes are blocked while a run is active so credentials and
// zips don't change under it
function activeArchiveError(): string | undefined {
  const activeRun = findActiveArchiveRun();
  if (activeRun) return `An archive run (#${activeRun.id}) is currently running`;
  return undefined;
}

// PUT /api/archive/accounts - Replace the imported accounts
router.put('/accounts', (req: Request, res: Response) => {
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

    const conflict = activeArchiveError();
    if (conflict) {
      res.status(HTTP_STATUS.CONFLICT).json({ error: conflict });
      return;
    }

    const result = replaceArchiveAccounts(imapHost.trim(), port, accounts);
    res.json(result);
  } catch (error: any) {
    // Validation errors from the service (bad email, empty password, ...)
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: error.message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
});

// GET /api/archive/accounts - The current import plus its test state
router.get('/accounts', (_req: Request, res: Response) => {
  res.json(getArchiveOverview());
});

// DELETE /api/archive/accounts - Clear the imported accounts
router.delete('/accounts', (_req: Request, res: Response) => {
  const conflict = activeArchiveError();
  if (conflict) {
    res.status(HTTP_STATUS.CONFLICT).json({ error: conflict });
    return;
  }

  res.json({ deleted: deleteArchiveAccounts() });
});

// DELETE /api/archive/session - Remove the whole archive project
// (imported accounts, runs, zips, and job history)
router.delete('/session', (_req: Request, res: Response) => {
  const conflict = activeArchiveError();
  if (conflict) {
    res.status(HTTP_STATUS.CONFLICT).json({ error: conflict });
    return;
  }

  deleteArchiveSession();
  res.json({ ok: true });
});

// POST /api/archive/accounts/test - Try an IMAP login with one imported row
router.post('/accounts/test', async (req: Request, res: Response) => {
  res.json(await testArchiveConnection(req.body?.email));
});

// POST /api/archive/execute - Start an archive run (runs in the background)
router.post('/execute', (req: Request, res: Response) => {
  try {
    const conflict = activeArchiveError();
    if (conflict) {
      res.status(HTTP_STATUS.CONFLICT).json({ error: conflict });
      return;
    }

    const overview = getArchiveOverview();
    if (overview.accounts.length === 0) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'No accounts imported — import a CSV first',
      });
      return;
    }

    if (!overview.tested) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'Test the connection successfully before starting',
      });
      return;
    }

    const run = createArchiveRun(overview.accounts.length);

    // Fire and forget — progress is tracked in the DB and polled by the client
    runArchiveRun(run.id, {
      excludeTrash: req.body?.excludeTrash === true,
      excludeJunk: req.body?.excludeJunk === true,
    }).catch((err) => {
      console.error(`Unexpected error in archive run ${run.id}:`, err);
    });

    res.status(HTTP_STATUS.ACCEPTED).json({ runId: run.id, status: run.status });
  } catch (error: any) {
    console.error('Error starting archive run:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      error: error.message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
});

// GET /api/archive/runs - List recent archive runs
router.get('/runs', (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
  res.json(listArchiveRuns(limit));
});

// GET /api/archive/runs/:id - Run status with per-account jobs and current job detail
router.get('/runs/:id', (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.id), 10);
  const detail = Number.isFinite(runId) ? getArchiveRunDetail(runId) : undefined;

  if (!detail) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Archive run not found' });
    return;
  }

  res.json(detail);
});

// POST /api/archive/runs/:id/cancel - Request cancellation of a running archive run
router.post('/runs/:id/cancel', (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.id), 10);
  const run = Number.isFinite(runId) ? cancelArchiveRun(runId) : undefined;

  if (!run) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Archive run not found' });
    return;
  }

  res.json(run);
});

// DELETE /api/archive/runs/:id - Delete a finished run's zips and records
router.delete('/runs/:id', (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.id), 10);
    const deleted = Number.isFinite(runId) ? deleteArchiveRun(runId) : false;

    if (!deleted) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Archive run not found' });
      return;
    }

    res.json({ ok: true });
  } catch (error: any) {
    // The run is still active
    res.status(HTTP_STATUS.CONFLICT).json({ error: error.message });
  }
});

// GET /api/archive/jobs/:id/download - Stream one account's zip
router.get('/jobs/:id/download', (req: Request, res: Response) => {
  const jobId = parseInt(String(req.params.id), 10);
  const job = Number.isFinite(jobId) ? getArchiveJob(jobId) : undefined;

  if (!job || !job.zipPath) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'No zip exists for this job' });
    return;
  }

  // zipPath comes from our own DB, but keep the resolved file pinned inside
  // ARCHIVE_DIR anyway
  const absPath = path.resolve(ARCHIVE_DIR, job.zipPath);
  if (!absPath.startsWith(path.resolve(ARCHIVE_DIR) + path.sep) || !fs.existsSync(absPath)) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'The zip file no longer exists on the server' });
    return;
  }

  res.download(absPath, `${job.email}.zip`);
});

export default router;
