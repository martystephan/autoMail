import { Router, Request, Response } from 'express';
import fs from 'fs';
import multer from 'multer';
import {
  IMPORT_UPLOAD_DIR,
  sanitizeZipFileName,
  listUploadedZips,
  deleteUploadedZip,
  deleteAllUploadedZips,
  replaceImportAccounts,
  deleteImportAccounts,
  getImportOverview,
  testImportConnection,
  findAccountsMissingZips,
  createImportRun,
  runImportRun,
  getImportRunDetail,
  listImportRuns,
  cancelImportRun,
  deleteImportRun,
  deleteImportSession,
  findActiveImportRun,
} from '../services/import';
import { HTTP_STATUS, ERROR_MESSAGES } from '../constants';

const router = Router();

// Imports, uploads and deletes are blocked while a run is active so
// credentials and zips don't change under it
async function activeImportError(): Promise<string | undefined> {
  const activeRun = await findActiveImportRun();
  if (activeRun) return `An import run (#${activeRun.id}) is currently running`;
  return undefined;
}

// Zips are streamed to disk under their sanitized original name — uploading
// the same name again replaces the previous file.
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        fs.mkdirSync(IMPORT_UPLOAD_DIR, { recursive: true });
        cb(null, IMPORT_UPLOAD_DIR);
      } catch (err) {
        cb(err as Error, IMPORT_UPLOAD_DIR);
      }
    },
    filename: (_req, file, cb) => cb(null, sanitizeZipFileName(file.originalname)),
  }),
  limits: { fileSize: parseInt(process.env.IMPORT_MAX_ZIP_SIZE || String(10 * 1024 ** 3), 10) },
  fileFilter: (_req, file, cb) => cb(null, /\.zip$/i.test(file.originalname)),
});

// PUT /api/import/accounts - Replace the imported accounts
router.put('/accounts', async (req: Request, res: Response) => {
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

    const conflict = await activeImportError();
    if (conflict) {
      res.status(HTTP_STATUS.CONFLICT).json({ error: conflict });
      return;
    }

    const result = await replaceImportAccounts(imapHost.trim(), port, accounts);
    res.json(result);
  } catch (error: any) {
    // Validation errors from the service (bad email, missing zip name, ...)
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: error.message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
});

// GET /api/import/accounts - The current import, uploaded zips and test state
router.get('/accounts', async (_req: Request, res: Response) => {
  res.json(await getImportOverview());
});

// DELETE /api/import/accounts - Clear the imported accounts
router.delete('/accounts', async (_req: Request, res: Response) => {
  const conflict = await activeImportError();
  if (conflict) {
    res.status(HTTP_STATUS.CONFLICT).json({ error: conflict });
    return;
  }

  res.json({ deleted: await deleteImportAccounts() });
});

// DELETE /api/import/session - Remove the whole import project
// (imported accounts, runs, uploaded zips, and job history)
router.delete('/session', async (_req: Request, res: Response) => {
  const conflict = await activeImportError();
  if (conflict) {
    res.status(HTTP_STATUS.CONFLICT).json({ error: conflict });
    return;
  }

  await deleteImportSession();
  res.json({ ok: true });
});

// POST /api/import/accounts/test - Try an IMAP login with one imported row
router.post('/accounts/test', async (req: Request, res: Response) => {
  res.json(await testImportConnection(req.body?.email));
});

// POST /api/import/zips - Upload one archive zip (multipart field "zip")
router.post('/zips', async (req: Request, res: Response) => {
  const conflict = await activeImportError();
  if (conflict) {
    res.status(HTTP_STATUS.CONFLICT).json({ error: conflict });
    return;
  }

  upload.single('zip')(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: `Upload failed: ${message}` });
      return;
    }
    if (!req.file) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({ error: 'No zip file uploaded (multipart field "zip", .zip only)' });
      return;
    }
    res.json({ fileName: req.file.filename, size: req.file.size });
  });
});

// GET /api/import/zips - List uploaded zips
router.get('/zips', async (_req: Request, res: Response) => {
  res.json(await listUploadedZips());
});

// DELETE /api/import/zips - Remove all uploaded zips
router.delete('/zips', async (_req: Request, res: Response) => {
  const conflict = await activeImportError();
  if (conflict) {
    res.status(HTTP_STATUS.CONFLICT).json({ error: conflict });
    return;
  }

  res.json({ deleted: await deleteAllUploadedZips() });
});

// DELETE /api/import/zips/:fileName - Remove one uploaded zip
router.delete('/zips/:fileName', async (req: Request, res: Response) => {
  const conflict = await activeImportError();
  if (conflict) {
    res.status(HTTP_STATUS.CONFLICT).json({ error: conflict });
    return;
  }

  try {
    const deleted = await deleteUploadedZip(String(req.params.fileName));
    if (!deleted) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Zip not found' });
      return;
    }
    res.json({ ok: true });
  } catch (error: any) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({ error: error.message });
  }
});

// POST /api/import/execute - Start an import run (runs in the background)
router.post('/execute', async (_req: Request, res: Response) => {
  try {
    const conflict = await activeImportError();
    if (conflict) {
      res.status(HTTP_STATUS.CONFLICT).json({ error: conflict });
      return;
    }

    const overview = await getImportOverview();
    if (overview.accounts.length === 0) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'No accounts imported — import a CSV first',
      });
      return;
    }

    const missing = await findAccountsMissingZips();
    if (missing.length > 0) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error:
          'Some accounts have no uploaded zip: ' +
          missing.map((account) => `${account.email} (${account.zipFileName})`).join(', '),
      });
      return;
    }

    if (!overview.tested) {
      res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'Test the connection successfully before starting',
      });
      return;
    }

    const run = await createImportRun(overview.accounts.length);

    // Fire and forget — progress is tracked in the DB and polled by the client
    runImportRun(run.id).catch((err) => {
      console.error(`Unexpected error in import run ${run.id}:`, err);
    });

    res.status(HTTP_STATUS.ACCEPTED).json({ runId: run.id, status: run.status });
  } catch (error: any) {
    console.error('Error starting import run:', error);
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      error: error.message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
    });
  }
});

// GET /api/import/runs - List recent import runs
router.get('/runs', async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
  res.json(await listImportRuns(limit));
});

// GET /api/import/runs/:id - Run status with per-account jobs and current job detail
router.get('/runs/:id', async (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.id), 10);
  const detail = Number.isFinite(runId) ? await getImportRunDetail(runId) : undefined;

  if (!detail) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Import run not found' });
    return;
  }

  res.json(detail);
});

// POST /api/import/runs/:id/cancel - Request cancellation of a running import run
router.post('/runs/:id/cancel', async (req: Request, res: Response) => {
  const runId = parseInt(String(req.params.id), 10);
  const run = Number.isFinite(runId) ? await cancelImportRun(runId) : undefined;

  if (!run) {
    res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Import run not found' });
    return;
  }

  res.json(run);
});

// DELETE /api/import/runs/:id - Delete a finished run's records
router.delete('/runs/:id', async (req: Request, res: Response) => {
  try {
    const runId = parseInt(String(req.params.id), 10);
    const deleted = Number.isFinite(runId) ? await deleteImportRun(runId) : false;

    if (!deleted) {
      res.status(HTTP_STATUS.NOT_FOUND).json({ error: 'Import run not found' });
      return;
    }

    res.json({ ok: true });
  } catch (error: any) {
    // The run is still active
    res.status(HTTP_STATUS.CONFLICT).json({ error: error.message });
  }
});

export default router;
