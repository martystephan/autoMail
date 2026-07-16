import dotenv from "dotenv";
// Load environment variables BEFORE any other imports that might use them
dotenv.config();

import express from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./src/lib/auth";
import prisma from "./src/utils/prisma";
import mailAccountsRouter from "./src/routes/mailAccounts";
import automationFlowsRouter from "./src/routes/automationFlows";
import oauthRouter, { oauthPublicRouter } from "./src/routes/oauth";
import migrationRouter from "./src/routes/migration";
import bulkMigrationRouter from "./src/routes/bulkMigration";
import archiveRouter from "./src/routes/archive";
import importRouter from "./src/routes/import";
import connectionTestRouter from "./src/routes/connectionTest";
import { requireAuth } from "./src/middleware/auth";
import { startScheduler } from "./src/services/automation";
import { recoverInterruptedJobs } from "./src/services/migration";
import { recoverInterruptedArchiveJobs, cleanupArchiveTempDir } from "./src/services/archive";
import { recoverInterruptedImportJobs } from "./src/services/import";
import { recoverInterruptedConnectionTestRuns } from "./src/services/connectionTest";

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL ?? "http://localhost:5173", credentials: true }));

const PORT = process.env.PORT || 4000;

// First-run setup check. Registered BEFORE the better-auth catch-all so the
// frontend keeps its /api/auth/setup-status URL.
app.get("/api/auth/setup-status", async (_req, res) => {
  try {
    res.json({ needsSetup: (await prisma.user.count()) === 0 });
  } catch (error) {
    res.status(500).json({ error: "Failed to check setup status" });
  }
});

// better-auth handles all remaining /api/auth/* routes. It needs the raw
// request body, so express.json() MUST come after this handler.
app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(express.json());

// Public routes (no auth required)
app.use("/api/oauth", oauthPublicRouter); // OAuth callback (called by provider)

// Protected routes (auth required)
app.use("/api/mail-accounts", requireAuth, mailAccountsRouter);
app.use("/api/automation-flows", requireAuth, automationFlowsRouter);
app.use("/api/oauth", requireAuth, oauthRouter);
app.use("/api/migration/bulk", requireAuth, bulkMigrationRouter);
app.use("/api/migration", requireAuth, migrationRouter);
app.use("/api/archive", requireAuth, archiveRouter);
app.use("/api/import", requireAuth, importRouter);
app.use("/api/connection-test", requireAuth, connectionTestRouter);

// Start server
app.listen(PORT, async () => {
  console.log(`Backend running on http://localhost:${PORT}`);

  try {
    // Jobs/runs still marked active belong to a previous process — relabel them
    // as interrupted. This is display-only: a new run never reads old run data.
    await recoverInterruptedJobs();
    await recoverInterruptedArchiveJobs();
    await recoverInterruptedImportJobs();
    await recoverInterruptedConnectionTestRuns();
  } catch (error) {
    console.error("Failed to recover interrupted jobs:", error);
  }

  // Temp .eml files only exist while a run is active — leftovers are crash debris
  cleanupArchiveTempDir();

  // Start automation scheduler
  startScheduler();
});
