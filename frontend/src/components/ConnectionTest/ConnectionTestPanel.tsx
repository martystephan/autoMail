import { useEffect, useState } from "react";
import { toast } from "sonner";
import { isJobActive, type MigrationJobStatus } from "../../api/migration";
import {
  startConnectionTestRun,
  getConnectionTestRun,
  cancelConnectionTestRun,
  deleteConnectionTestRun,
  listConnectionTestRuns,
  type ConnectionTestRow,
  type ConnectionTestRunDetail,
} from "../../api/connectionTest";
import ConnectionTestImportCard from "./ConnectionTestImportCard";
import ConnectionTestRunProgress from "./ConnectionTestRunProgress";

const POLL_INTERVAL_MS = 2000;

function finishedToast(status: MigrationJobStatus, detail: ConnectionTestRunDetail) {
  const { okAccounts, failedAccounts } = detail.run;
  const summary = `${okAccounts} ok, ${failedAccounts} failed`;
  switch (status) {
    case "completed":
      toast.success(`Connection test completed: ${summary}.`);
      break;
    case "completed_with_errors":
      toast.warning(`Connection test completed: ${summary}. Check the failed rows below.`);
      break;
    case "cancelled":
      toast.info(`Connection test cancelled: ${summary}.`);
      break;
    default:
      toast.error(`Connection test ${status}: ${detail.run.error || summary}`);
  }
}

export default function ConnectionTestPanel() {
  const [loading, setLoading] = useState(true);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [runDetail, setRunDetail] = useState<ConnectionTestRunDetail | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isDeletingRun, setIsDeletingRun] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const runs = await listConnectionTestRuns(1);

        // Show the latest run (also after reload/restart); reattach the live
        // poll only if it is still running
        const latest = runs[0];
        if (latest) {
          if (isJobActive(latest.status)) {
            setActiveRunId(latest.id);
          } else {
            setRunDetail(await getConnectionTestRun(latest.id));
          }
        }
      } catch (error) {
        toast.error(`Failed to load data: ${error}`);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Poll the active run until it reaches a terminal state
  useEffect(() => {
    if (activeRunId == null) return;

    let stopped = false;

    const tick = async () => {
      try {
        const detail = await getConnectionTestRun(activeRunId);
        if (stopped) return;
        setRunDetail(detail);
        if (!isJobActive(detail.run.status)) {
          finishedToast(detail.run.status, detail);
          setActiveRunId(null);
          setIsCancelling(false);
        }
      } catch {
        // Transient polling error — keep trying
      }
    };

    tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [activeRunId]);

  const handleStart = async (imapHost: string, imapPort: number, rows: ConnectionTestRow[]) => {
    try {
      setIsStarting(true);
      setRunDetail(null);
      const { runId } = await startConnectionTestRun({ imapHost, imapPort, accounts: rows });
      setActiveRunId(runId);
      toast.info("Connection test started — logins are tried a few at a time.");
    } catch (error) {
      toast.error(`Failed to start the connection test: ${error}`);
    } finally {
      setIsStarting(false);
    }
  };

  const handleCancel = async () => {
    if (activeRunId == null) return;
    try {
      setIsCancelling(true);
      await cancelConnectionTestRun(activeRunId);
    } catch (error) {
      setIsCancelling(false);
      toast.error(`Failed to cancel the connection test: ${error}`);
    }
  };

  const handleDeleteRun = async () => {
    if (!runDetail) return;
    const confirmed = window.confirm("Delete this connection test and its results?");
    if (!confirmed) return;
    try {
      setIsDeletingRun(true);
      await deleteConnectionTestRun(runDetail.run.id);
      setRunDetail(null);
      toast.success("Connection test deleted");
    } catch (error) {
      toast.error(`Failed to delete the run: ${error}`);
    } finally {
      setIsDeletingRun(false);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-12">
        <p className="text-neutral-500">Loading...</p>
      </div>
    );
  }

  const isRunning = activeRunId != null;

  return (
    <div className="space-y-4">
      <p className="text-xs text-neutral-500">
        Every row of the CSV gets one IMAP login attempt — a few at a time — and is reported as OK
        or FAILED. Passwords are only kept in memory while the test runs; the results survive a
        reload, the credentials do not.
      </p>

      <ConnectionTestImportCard
        disabled={isRunning}
        isStarting={isStarting}
        onStart={handleStart}
      />

      {runDetail && (
        <ConnectionTestRunProgress
          detail={runDetail}
          onCancel={handleCancel}
          isCancelling={isCancelling}
          onDeleteRun={handleDeleteRun}
          isDeleting={isDeletingRun}
        />
      )}
    </div>
  );
}
