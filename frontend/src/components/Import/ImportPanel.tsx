import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { isJobActive, type MigrationJobStatus } from "../../api/migration";
import {
  getImportOverview,
  startImportRun,
  getImportRun,
  cancelImportRun,
  deleteImportRun,
  listImportRuns,
  deleteImportSession,
  type ImportOverview,
  type ImportRunDetail,
} from "../../api/import";
import ImportSetupCard from "./ImportSetupCard";
import ImportRunProgress from "./ImportRunProgress";
import { Button, Card, CardContent } from "../ui";

const POLL_INTERVAL_MS = 2000;

const AI_CLEANUP_PROMPT = `I have raw mail account data that I need to turn into ONE CSV file for a bulk email import tool. Please clean and convert my data into exactly this format:

CSV columns in this order:
email,username,password,zipFileName
- email: the account's email address, lowercase
- username: the IMAP login of the account (often identical to the email)
- password: the account's password, exactly as given
- zipFileName: the name of that account's archive zip file, ending in ".zip"

STRICT RULES:
1. Lowercase and trim all email addresses. Keep usernames and passwords unchanged apart from trimming surrounding whitespace.
2. Use a comma as the separator. Wrap a value in double quotes if it contains a comma, quote, or semicolon.
3. The first line must be the header row exactly as shown above.
4. No duplicate email addresses. No empty usernames, passwords, or zip file names.
5. Put rows that are incomplete, ambiguous, or missing credentials into a separate "problems" list instead of the CSV.

Output the CSV as a single code block, followed by the list of problems.

Here is my raw data:
[paste your raw data here]`;

function finishedToast(status: MigrationJobStatus, detail: ImportRunDetail) {
  const { completedAccounts, failedAccounts } = detail.run;
  const summary = `${completedAccounts} account(s) processed, ${failedAccounts} failed`;
  switch (status) {
    case "completed":
      toast.success(`Import completed: ${summary}.`);
      break;
    case "completed_with_errors":
      toast.warning(`Import completed with errors: ${summary}. Check the account list for details.`);
      break;
    case "cancelled":
      toast.info(`Import cancelled: ${summary}. A new run will skip everything already imported.`);
      break;
    default:
      toast.error(`Import ${status}: ${detail.run.error || summary}`);
  }
}

export default function ImportPanel() {
  const [overview, setOverview] = useState<ImportOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [runDetail, setRunDetail] = useState<ImportRunDetail | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isDeletingRun, setIsDeletingRun] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(AI_CLEANUP_PROMPT);
      toast.success("Prompt copied to clipboard");
    } catch {
      // Clipboard access denied (e.g. non-HTTPS) — show the text to copy manually
      setShowPrompt(true);
      toast.error("Could not access the clipboard — copy the prompt manually");
    }
  };

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await getImportOverview());
    } catch (error) {
      toast.error(`Failed to load imported accounts: ${error}`);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const [overviewData, runs] = await Promise.all([
          getImportOverview(),
          listImportRuns(1),
        ]);
        setOverview(overviewData);

        // Show the latest run of the project (also after reload/restart);
        // reattach the live poll only if it is still running
        const latest = runs[0];
        if (latest) {
          if (isJobActive(latest.status)) {
            setActiveRunId(latest.id);
          } else {
            setRunDetail(await getImportRun(latest.id));
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
        const detail = await getImportRun(activeRunId);
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

  const handleStart = async () => {
    try {
      setIsStarting(true);
      setRunDetail(null);
      const { runId } = await startImportRun();
      setActiveRunId(runId);
      toast.info("Import started — accounts are imported one after another.");
    } catch (error) {
      toast.error(`Failed to start import: ${error}`);
    } finally {
      setIsStarting(false);
    }
  };

  const handleCancel = async () => {
    if (activeRunId == null) return;
    try {
      setIsCancelling(true);
      await cancelImportRun(activeRunId);
    } catch (error) {
      setIsCancelling(false);
      toast.error(`Failed to cancel import: ${error}`);
    }
  };

  const handleDeleteRun = async () => {
    if (!runDetail) return;
    const confirmed = window.confirm(
      "Delete this import run?\n\nOnly the run's records are removed — the target mailboxes and the uploaded zips are not touched."
    );
    if (!confirmed) return;
    try {
      setIsDeletingRun(true);
      await deleteImportRun(runDetail.run.id);
      setRunDetail(null);
      toast.success("Import run deleted");
    } catch (error) {
      toast.error(`Failed to delete run: ${error}`);
    } finally {
      setIsDeletingRun(false);
    }
  };

  const handleDeleteProject = async () => {
    const confirmed = window.confirm(
      "Delete this import project?\n\nThe imported accounts, the run history, and ALL uploaded zips on the server are removed. The target mailboxes are not touched."
    );
    if (!confirmed) return;
    try {
      await deleteImportSession();
      setRunDetail(null);
      setActiveRunId(null);
      await loadOverview();
      toast.success("Import project deleted");
    } catch (error) {
      toast.error(`Failed to delete project: ${error}`);
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
  const accounts = overview?.accounts ?? [];
  const tested = overview?.tested ?? false;
  const hasImports = accounts.length > 0;
  const allZipsUploaded = hasImports && accounts.every((account) => account.zipUploaded);
  const canStart = hasImports && allZipsUploaded && tested;
  const requirements: [boolean, string][] = [
    [hasImports, "accounts imported"],
    [allZipsUploaded, "all zips uploaded"],
    [tested, "connection tested"],
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="py-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-neutral-700">
              <span className="font-medium">Messy account data?</span>{" "}
              Let an AI clean it up first — the prompt produces the CSV file in the right format.
            </div>
            <div className="flex gap-2 shrink-0">
              <Button variant="secondary" size="sm" onClick={handleCopyPrompt}>
                Copy prompt
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowPrompt((prev) => !prev)}
              >
                {showPrompt ? "Hide" : "Show"}
              </Button>
            </div>
          </div>
          {showPrompt && (
            <pre className="text-xs text-neutral-600 bg-neutral-50 border border-neutral-200 rounded-lg p-3 whitespace-pre-wrap max-h-72 overflow-y-auto">
              {AI_CLEANUP_PROMPT}
            </pre>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-neutral-500">
        Import restores archive zips created on the Archive tab: folders are recreated on the
        target account (Sent, Trash etc. are mapped to the target's own special folders) and every
        message is uploaded with its original flags and date. Messages that already exist on the
        target are skipped, so runs can safely be repeated. Only zips with the archive manifest
        can be imported.
      </p>

      <ImportSetupCard
        accounts={accounts}
        tested={tested}
        disabled={isRunning}
        onChanged={loadOverview}
      />

      {hasImports && !isRunning && (
        <ul className="text-xs text-neutral-500 space-y-0.5">
          {requirements.map(([ok, label]) => (
            <li key={label} className={ok ? "text-green-700" : ""}>
              {ok ? "✓" : "○"} {label}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <Button
          onClick={handleStart}
          loading={isStarting}
          disabled={isRunning || isStarting || !canStart}
        >
          Start Import ({accounts.length} account{accounts.length === 1 ? "" : "s"})
        </Button>
        {hasImports && (
          <Button
            variant="secondary"
            onClick={handleDeleteProject}
            disabled={isRunning}
            className="ml-auto"
          >
            Delete project
          </Button>
        )}
      </div>

      {runDetail && (
        <ImportRunProgress
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
