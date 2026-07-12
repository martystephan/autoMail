import { useState, useEffect } from "react";
import { toast } from "sonner";
import { getMailAccounts, type MailAccount } from "../api/mailAccounts";
import {
  getMigrationPreview,
  startMigration,
  getMigrationJob,
  cancelMigrationJob,
  listMigrationJobs,
  isJobActive,
  type MigrationPreview,
  type MigrationJobDetail,
  type MigrationJobStatus,
} from "../api/migration";
import { listBulkRuns } from "../api/bulkMigration";
import MigrationForm from "../components/Migration/MigrationForm";
import MigrationProgress from "../components/Migration/MigrationProgress";
import BulkMigrationPanel from "../components/Migration/BulkMigrationPanel";
import {
  Alert,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "../components/ui";
import { PageHeader } from "../components/ui/PageHeader";

const POLL_INTERVAL_MS = 2000;

function finishedToast(status: MigrationJobStatus, detail: MigrationJobDetail) {
  const { copiedMessages, skippedMessages, failedMessages } = detail.job;
  const summary = `${copiedMessages} copied, ${skippedMessages} skipped, ${failedMessages} failed`;
  switch (status) {
    case "completed":
      toast.success(`Migration completed: ${summary}`);
      break;
    case "completed_with_errors":
      toast.warning(
        `Migration completed with errors: ${summary}. Run it again to retry the failed messages.`
      );
      break;
    case "cancelled":
      toast.info(
        `Migration cancelled: ${summary}. Run it again to resume — messages already on the target are skipped.`
      );
      break;
    default:
      toast.error(`Migration ${status}: ${detail.job.error || summary}`);
  }
}

type MigrationMode = "single" | "bulk";

export default function MigrationPage() {
  const [mode, setMode] = useState<MigrationMode>("single");
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [activeJobId, setActiveJobId] = useState<number | null>(null);
  const [jobDetail, setJobDetail] = useState<MigrationJobDetail | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [accountsData, jobs, bulkRuns] = await Promise.all([
        getMailAccounts(),
        listMigrationJobs(1),
        listBulkRuns(1),
      ]);
      setAccounts(accountsData);

      // Reattach to a migration that is still running (e.g. after a page
      // reload). Bulk pair jobs are handled by the bulk panel, not here.
      const latest = jobs[0];
      if (latest && latest.mode === "single" && isJobActive(latest.status)) {
        setActiveJobId(latest.id);
      }

      // An active bulk run opens the bulk tab, which reattaches on its own
      const latestRun = bulkRuns[0];
      if (latestRun && isJobActive(latestRun.status)) {
        setMode("bulk");
      }
    } catch (error) {
      toast.error(`Failed to load data: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  // Poll the active job until it reaches a terminal state
  useEffect(() => {
    if (activeJobId == null) return;

    let stopped = false;

    const tick = async () => {
      try {
        const detail = await getMigrationJob(activeJobId);
        if (stopped) return;
        setJobDetail(detail);
        if (!isJobActive(detail.job.status)) {
          finishedToast(detail.job.status, detail);
          setActiveJobId(null);
          setIsCancelling(false);
        }
      } catch {
        // Transient polling error (e.g. brief network hiccup) — keep trying
      }
    };

    tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [activeJobId]);

  const handlePreview = async (
    sourceAccountId: number,
    excludedFolders: string[]
  ) => {
    try {
      setPreview(null);
      setJobDetail(null);
      const previewData = await getMigrationPreview({
        sourceAccountId,
        excludedFolders,
      });
      setPreview(previewData);
    } catch (error) {
      toast.error(`Failed to get preview: ${error}`);
    }
  };

  const handleExecute = async (
    sourceAccountId: number,
    targetAccountId: number,
    excludedFolders: string[]
  ) => {
    try {
      setJobDetail(null);
      const { jobId } = await startMigration({
        sourceAccountId,
        targetAccountId,
        excludedFolders,
      });
      setActiveJobId(jobId);
      toast.info("Migration started — it runs in the background in small batches.");
    } catch (error) {
      toast.error(`Failed to start migration: ${error}`);
    }
  };

  const handleCancel = async () => {
    if (activeJobId == null) return;
    try {
      setIsCancelling(true);
      await cancelMigrationJob(activeJobId);
    } catch (error) {
      setIsCancelling(false);
      toast.error(`Failed to cancel migration: ${error}`);
    }
  };

  const handleReset = () => {
    setPreview(null);
    if (activeJobId == null) {
      setJobDetail(null);
    }
  };

  const isExecuting = activeJobId != null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Migration"
        description="Copy folders and messages from one account to another. Migrations run in batches, every step is logged, and messages that already exist on the target are skipped — so re-running is always safe."
      />

      <div className="inline-flex rounded-lg border border-neutral-300 p-0.5 bg-neutral-100">
        {(
          [
            ["single", "Single Account"],
            ["bulk", "Bulk (CSV)"],
          ] as [MigrationMode, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setMode(value)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
              mode === value
                ? "bg-white text-neutral-900 shadow-sm"
                : "text-neutral-500 hover:text-neutral-800"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "bulk" ? (
        <BulkMigrationPanel />
      ) : (
        <>
          {accounts.length < 2 && (
            <Alert variant="warning">
              You need at least two mail accounts to perform a migration.
            </Alert>
          )}

          {loading ? (
            <div className="text-center py-12">
              <p className="text-neutral-500">Loading...</p>
            </div>
          ) : (
            <>
          <MigrationForm
            accounts={accounts}
            onPreview={handlePreview}
            onExecute={handleExecute}
            onReset={handleReset}
            isExecuting={isExecuting}
            hasPreview={preview !== null}
          />

          {preview && !jobDetail && (
            <Card>
              <CardHeader className="border-b border-neutral-200">
                <CardTitle>Migration Preview</CardTitle>
                <CardDescription>
                  The following folders and messages will be copied
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-neutral-700">
                    Total Messages:
                  </span>
                  <span className="text-sm text-neutral-900">
                    {preview.totalMessages}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-neutral-700">
                    Excluded Folders:
                  </span>
                  <span className="text-sm text-neutral-500">
                    {preview.excludedFolders.join(", ") || "None"}
                  </span>
                </div>
                <div>
                  <h3 className="text-sm font-medium text-neutral-700 mb-2">
                    Folders to Copy:
                  </h3>
                  {preview.folders.length === 0 ? (
                    <p className="text-sm text-neutral-500">
                      No folders to copy
                    </p>
                  ) : (
                    <ul className="divide-y divide-neutral-200 border border-neutral-200 rounded-lg">
                      {preview.folders.map((folder) => (
                        <li
                          key={folder.path}
                          className="px-4 py-3 flex justify-between items-center"
                        >
                          <div>
                            <span className="text-sm text-neutral-900">
                              {folder.path}
                            </span>
                            {folder.specialUse && (
                              <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-neutral-100 text-neutral-600">
                                {folder.specialUse}
                              </span>
                            )}
                          </div>
                          <span className="text-sm text-neutral-500">
                            {folder.messageCount} messages
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

              {jobDetail && (
                <MigrationProgress
                  detail={jobDetail}
                  onCancel={handleCancel}
                  isCancelling={isCancelling}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
