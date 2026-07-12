import { Router, Request, Response } from 'express';
import db, { MailAccount } from '../utils/db';
import {
  getMigrationPreview,
  createMigrationJob,
  runMigrationJob,
  getMigrationJobDetail,
  listMigrationJobs,
  cancelMigrationJob,
  findActiveMigrationJob,
  DEFAULT_EXCLUDED_FOLDERS,
} from '../services/migration';
import { findActiveBulkRun } from '../services/bulkMigration';
import { HTTP_STATUS, ERROR_MESSAGES } from '../constants';

const router = Router();

// POST /api/migration/preview - Get migration preview (dry run)
router.post('/preview', async (req: Request, res: Response) => {
  try {
    const { sourceAccountId, excludedFolders } = req.body;

    if (!sourceAccountId) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'sourceAccountId is required',
      });
      return;
    }

    const sourceAccount = db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(sourceAccountId) as MailAccount | undefined;

    if (!sourceAccount) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        error: 'Source account not found',
      });
      return;
    }

    const preview = await getMigrationPreview(sourceAccount, excludedFolders ?? undefined);

    res.json(preview);
  } catch (error: any) {
    console.error('Error getting migration preview:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      error: error.message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
});

// POST /api/migration/execute - Start a migration job (runs in the background)
router.post('/execute', (req: Request, res: Response) => {
  try {
    const { sourceAccountId, targetAccountId, excludedFolders } = req.body;

    if (!sourceAccountId || !targetAccountId) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'sourceAccountId and targetAccountId are required',
      });
      return;
    }

    if (sourceAccountId === targetAccountId) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'Source and target accounts must be different',
      });
      return;
    }

    const sourceAccount = db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(sourceAccountId) as MailAccount | undefined;
    const targetAccount = db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(targetAccountId) as MailAccount | undefined;

    if (!sourceAccount) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        error: 'Source account not found',
      });
      return;
    }

    if (!targetAccount) {
      res.status(HTTP_STATUS.NOT_FOUND).json({
        error: 'Target account not found',
      });
      return;
    }

    // Only one migration at a time keeps the load on the mail servers sane
    // and the progress unambiguous
    const activeJob = findActiveMigrationJob();
    if (activeJob) {
      res.status(HTTP_STATUS.CONFLICT).json({
        error: `Another migration (job #${activeJob.id}) is already running`,
        jobId: activeJob.id,
      });
      return;
    }

    // A bulk run also counts, even between two of its pair jobs
    const activeRun = findActiveBulkRun();
    if (activeRun) {
      res.status(HTTP_STATUS.CONFLICT).json({
        error: `A bulk migration (run #${activeRun.id}) is already running`,
      });
      return;
    }

    const job = createMigrationJob(sourceAccountId, targetAccountId, excludedFolders ?? undefined);

    // Fire and forget — progress is tracked in the DB and polled by the client
    runMigrationJob(job.id).catch((err) => {
      console.error(`Unexpected error in migration job ${job.id}:`, err);
    });

    res.status(HTTP_STATUS.ACCEPTED).json({ jobId: job.id, status: job.status });
  } catch (error: any) {
    console.error('Error starting migration:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      error: error.message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
});

// GET /api/migration/jobs - List recent migration jobs
router.get('/jobs', (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
  res.json(listMigrationJobs(limit));
});

// GET /api/migration/jobs/:id - Job status with per-folder progress and error log
router.get('/jobs/:id', (req: Request, res: Response) => {
  const jobId = parseInt(String(req.params.id), 10);
  const detail = Number.isFinite(jobId) ? getMigrationJobDetail(jobId) : undefined;

  if (!detail) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Migration job not found' });
    return;
  }

  res.json(detail);
});

// POST /api/migration/jobs/:id/cancel - Request cancellation of a running job
router.post('/jobs/:id/cancel', (req: Request, res: Response) => {
  const jobId = parseInt(String(req.params.id), 10);
  const job = Number.isFinite(jobId) ? cancelMigrationJob(jobId) : undefined;

  if (!job) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Migration job not found' });
    return;
  }

  res.json(job);
});

// GET /api/migration/default-excluded-folders - Get default excluded folders
router.get('/default-excluded-folders', (_req: Request, res: Response) => {
  res.json({ excludedFolders: DEFAULT_EXCLUDED_FOLDERS });
});

export default router;
