import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { isJobActive, type MigrationJobStatus } from "../../api/migration";
import {
  getArchiveOverview,
  startArchiveRun,
  getArchiveRun,
  cancelArchiveRun,
  deleteArchiveRun,
  listArchiveRuns,
  deleteArchiveSession,
  type ArchiveOverview,
  type ArchiveRunDetail,
} from "../../api/archive";
import ArchiveImportCard from "./ArchiveImportCard";
import ArchiveRunProgress from "./ArchiveRunProgress";
import { Button, Card, CardContent } from "../ui";

const POLL_INTERVAL_MS = 2000;

const AI_CLEANUP_PROMPT = `I have raw mail account data that I need to turn into ONE CSV file for a bulk email archiving tool. Please clean and convert my data into exactly this format:

CSV columns in this order:
email,username,password
- email: the account's email address, lowercase
- username: the IMAP login of the account (often identical to the email)
- password: the account's password, exactly as given

STRICT RULES:
1. Lowercase and trim all email addresses. Keep usernames and passwords unchanged apart from trimming surrounding whitespace.
2. Use a comma as the separator. Wrap a value in double quotes if it contains a comma, quote, or semicolon.
3. The first line must be the header row exactly as shown above.
4. No duplicate email addresses. No empty usernames or passwords.
5. Put rows that are incomplete, ambiguous, or missing credentials into a separate "problems" list instead of the CSV.

Output the CSV as a single code block, followed by the list of problems.

Here is my raw data:
[paste your raw data here]`;

function finishedToast(status: MigrationJobStatus, detail: ArchiveRunDetail) {
  const { completedAccounts, failedAccounts } = detail.run;
  const summary = `${completedAccounts} account(s) processed, ${failedAccounts} failed`;
  switch (status) {
    case "completed":
      toast.success(`Archiving completed: ${summary}. The zips are ready to download.`);
      break;
    case "completed_with_errors":
      toast.warning(
        `Archiving completed with errors: ${summary}. Check the account list — finished zips are still downloadable.`
      );
      break;
    case "cancelled":
      toast.info(`Archiving cancelled: ${summary}. Zips of finished accounts are still downloadable.`);
      break;
    default:
      toast.error(`Archiving ${status}: ${detail.run.error || summary}`);
  }
}

export default function ArchivePanel() {
  const [overview, setOverview] = useState<ArchiveOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [runDetail, setRunDetail] = useState<ArchiveRunDetail | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isDeletingRun, setIsDeletingRun] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [excludeJunk, setExcludeJunk] = useState(false);
  const [excludeTrash, setExcludeTrash] = useState(false);

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
      setOverview(await getArchiveOverview());
    } catch (error) {
      toast.error(`Failed to load imported accounts: ${error}`);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const [overviewData, runs] = await Promise.all([
          getArchiveOverview(),
          listArchiveRuns(1),
        ]);
        setOverview(overviewData);

        // Show the latest run of the project (also after reload/restart);
        // reattach the live poll only if it is still running
        const latest = runs[0];
        if (latest) {
          if (isJobActive(latest.status)) {
            setActiveRunId(latest.id);
          } else {
            setRunDetail(await getArchiveRun(latest.id));
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
        const detail = await getArchiveRun(activeRunId);
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
      const { runId } = await startArchiveRun({ excludeJunk, excludeTrash });
      setActiveRunId(runId);
      toast.info("Archiving started — accounts are archived one after another.");
    } catch (error) {
      toast.error(`Failed to start archiving: ${error}`);
    } finally {
      setIsStarting(false);
    }
  };

  const handleCancel = async () => {
    if (activeRunId == null) return;
    try {
      setIsCancelling(true);
      await cancelArchiveRun(activeRunId);
    } catch (error) {
      setIsCancelling(false);
      toast.error(`Failed to cancel archiving: ${error}`);
    }
  };

  const handleDeleteRun = async () => {
    if (!runDetail) return;
    const confirmed = window.confirm(
      "Delete this archive run?\n\nThe zip files of this run are removed from the server. Download everything you still need first — the mailboxes themselves are not touched."
    );
    if (!confirmed) return;
    try {
      setIsDeletingRun(true);
      await deleteArchiveRun(runDetail.run.id);
      setRunDetail(null);
      toast.success("Archive run deleted");
    } catch (error) {
      toast.error(`Failed to delete run: ${error}`);
    } finally {
      setIsDeletingRun(false);
    }
  };

  const handleDeleteProject = async () => {
    const confirmed = window.confirm(
      "Delete this archive project?\n\nThe imported accounts, the run history, and ALL zip files on the server are removed. Download everything you still need first — the mailboxes themselves are not touched."
    );
    if (!confirmed) return;
    try {
      await deleteArchiveSession();
      setRunDetail(null);
      setActiveRunId(null);
      await loadOverview();
      toast.success("Archive project deleted");
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
  const canStart = hasImports && tested;
  const requirements: [boolean, string][] = [
    [hasImports, "accounts imported"],
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
        Archiving is read-only: every folder of every account is downloaded as .eml files and packed
        into one zip per account — the mailboxes themselves are never changed. The zips stay on the
        server until you delete the run, so download them when the run is done.
      </p>

      <ArchiveImportCard
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
          Start Archiving ({accounts.length} account{accounts.length === 1 ? "" : "s"})
        </Button>
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={excludeJunk}
            onChange={(e) => setExcludeJunk(e.target.checked)}
            disabled={isRunning}
            className="rounded border-neutral-300"
          />
          Skip junk/spam folders
        </label>
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            checked={excludeTrash}
            onChange={(e) => setExcludeTrash(e.target.checked)}
            disabled={isRunning}
            className="rounded border-neutral-300"
          />
          Skip trash folders
        </label>
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
        <ArchiveRunProgress
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
