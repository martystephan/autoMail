import dotenv from "dotenv";
// Load environment variables BEFORE any other imports that might use them
dotenv.config();

import express from "express";
import cors from "cors";
import mailAccountsRouter from "./src/routes/mailAccounts";
import automationFlowsRouter from "./src/routes/automationFlows";
import oauthRouter, { oauthPublicRouter } from "./src/routes/oauth";
import migrationRouter from "./src/routes/migration";
import bulkMigrationRouter from "./src/routes/bulkMigration";
import archiveRouter from "./src/routes/archive";
import authRouter from "./src/routes/auth";
import { requireAuth } from "./src/middleware/auth";
import { startScheduler } from "./src/services/automation";
import { recoverInterruptedJobs } from "./src/services/migration";
import { recoverInterruptedArchiveJobs, cleanupArchiveTempDir } from "./src/services/archive";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// Public routes (no auth required)
app.use("/api/auth", authRouter);
app.use("/api/oauth", oauthPublicRouter); // OAuth callback (called by provider)

// Protected routes (auth required)
app.use("/api/mail-accounts", requireAuth, mailAccountsRouter);
app.use("/api/automation-flows", requireAuth, automationFlowsRouter);
app.use("/api/oauth", requireAuth, oauthRouter);
app.use("/api/migration/bulk", requireAuth, bulkMigrationRouter);
app.use("/api/migration", requireAuth, migrationRouter);
app.use("/api/archive", requireAuth, archiveRouter);

// Start server
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);

  // Jobs/runs still marked active belong to a previous process — relabel them
  // as interrupted. This is display-only: a new run never reads old run data.
  recoverInterruptedJobs();
  recoverInterruptedArchiveJobs();

  // Temp .eml files only exist while a run is active — leftovers are crash debris
  cleanupArchiveTempDir();

  // Start automation scheduler
  startScheduler();
});
