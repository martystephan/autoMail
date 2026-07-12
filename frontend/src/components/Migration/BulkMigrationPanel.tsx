import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { isJobActive, type MigrationJobStatus } from "../../api/migration";
import {
  getBulkOverview,
  startBulkMigration,
  getBulkRun,
  cancelBulkRun,
  listBulkRuns,
  deleteBulkSession,
  type BulkOverview,
  type BulkRunDetail,
} from "../../api/bulkMigration";
import BulkImportCard from "./BulkImportCard";
import BulkRunProgress from "./BulkRunProgress";
import { Alert, Button, Card, CardContent } from "../ui";

const POLL_INTERVAL_MS = 2000;

const AI_CLEANUP_PROMPT = `I have raw mail account data that I need to turn into two CSV files for a bulk email migration tool (old accounts -> new accounts). Please clean and convert my data into exactly this format:

FILE 1 — source accounts (accounts to migrate FROM), CSV columns in this order:
email,target,username,password
- email: the source account's email address, lowercase
- target: the email address of the matching target account from file 2. Leave it empty ONLY when the target account has exactly the same email address as the source account.
- username: the IMAP login of the source account (often identical to the email)
- password: the source account's password, exactly as given

FILE 2 — target accounts (accounts to migrate TO), CSV columns in this order:
email,username,password
- email: the target account's email address, lowercase
- username: the IMAP login of the target account
- password: the target account's password, exactly as given

STRICT RULES:
1. Every entry in both files must have a match: each source row must correspond to exactly one target row (via its target column, or via its own email when the target column is empty), and each target row must be referenced by exactly one source row. Never output an unmatched row — put rows you cannot confidently match into a separate "problems" list instead.
2. Lowercase and trim all email addresses. Keep usernames and passwords unchanged apart from trimming surrounding whitespace.
3. Use a comma as the separator. Wrap a value in double quotes if it contains a comma, quote, or semicolon.
4. The first line of each file must be the header row exactly as shown above.
5. No duplicate email addresses within a file. No empty usernames or passwords.

Output file 1 and file 2 as two separate code blocks, followed by the list of problems (rows that were incomplete, ambiguous, or had no match).

Here is my raw data:
[paste your raw data here]`;

function finishedToast(status: MigrationJobStatus, detail: BulkRunDetail) {
  const { completedPairs, failedPairs } = detail.run;
  const summary = `${completedPairs} account(s) processed, ${failedPairs} failed`;
  switch (status) {
    case "completed":
      toast.success(`Bulk migration completed: ${summary}`);
      break;
    case "completed_with_errors":
      toast.warning(
        `Bulk migration completed with errors: ${summary}. Run it again to retry — messages already on the target are skipped.`
      );
      break;
    case "cancelled":
      toast.info(
        `Bulk migration cancelled: ${summary}. Run it again to resume — messages already on the target are skipped.`
      );
      break;
    default:
      toast.error(`Bulk migration ${status}: ${detail.run.error || summary}`);
  }
}

export default function BulkMigrationPanel() {
  const [overview, setOverview] = useState<BulkOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  const [runDetail, setRunDetail] = useState<BulkRunDetail | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [excludeJunk, setExcludeJunk] = useState(true);
  const [excludeTrash, setExcludeTrash] = useState(true);

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
      setOverview(await getBulkOverview());
    } catch (error) {
      toast.error(`Failed to load imported accounts: ${error}`);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const [overviewData, runs] = await Promise.all([
          getBulkOverview(),
          listBulkRuns(1),
        ]);
        setOverview(overviewData);

        // Show the latest run of the project (also after reload/restart);
        // reattach the live poll only if it is still running
        const latest = runs[0];
        if (latest) {
          if (isJobActive(latest.status)) {
            setActiveRunId(latest.id);
          } else {
            setRunDetail(await getBulkRun(latest.id));
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
        const detail = await getBulkRun(activeRunId);
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
      const { runId } = await startBulkMigration({ excludeJunk, excludeTrash });
      setActiveRunId(runId);
      toast.info("Bulk migration started — accounts are migrated one after another.");
    } catch (error) {
      toast.error(`Failed to start bulk migration: ${error}`);
    } finally {
      setIsStarting(false);
    }
  };

  const handleCancel = async () => {
    if (activeRunId == null) return;
    try {
      setIsCancelling(true);
      await cancelBulkRun(activeRunId);
    } catch (error) {
      setIsCancelling(false);
      toast.error(`Failed to cancel bulk migration: ${error}`);
    }
  };

  const handleDeleteProject = async () => {
    const confirmed = window.confirm(
      "Delete this migration project?\n\nThe imported accounts and the run history are removed. Your mailboxes are not touched — you can import the CSVs again at any time."
    );
    if (!confirmed) return;
    try {
      await deleteBulkSession();
      setRunDetail(null);
      setActiveRunId(null);
      await loadOverview();
      toast.success("Migration project deleted");
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
  const pairs = overview?.pairs ?? [];
  const unmatchedSource = overview?.unmatchedSource ?? [];
  const unmatchedTarget = overview?.unmatchedTarget ?? [];
  const matchedSourceIds = new Set(pairs.map((pair) => pair.sourceId));
  const matchedTargetIds = new Set(pairs.map((pair) => pair.targetId));
  const hasImports = (overview?.source.length ?? 0) > 0 || (overview?.target.length ?? 0) > 0;

  // Starting requires: at least one pair, no unmatched accounts on either
  // side, and both connection tests passed for the current imports
  const allMatched = unmatchedSource.length === 0 && unmatchedTarget.length === 0;
  const sourceTested = overview?.tested.source ?? false;
  const targetTested = overview?.tested.target ?? false;
  const canStart = pairs.length > 0 && allMatched && sourceTested && targetTested;
  const requirements: [boolean, string][] = [
    [pairs.length > 0 && allMatched, "all imported accounts are matched"],
    [sourceTested, "source connection tested"],
    [targetTested, "target connection tested"],
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="py-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-neutral-700">
              <span className="font-medium">Messy account data?</span>{" "}
              Let an AI clean it up first — the prompt produces both CSV files in the
              right format, with every entry matched between the two files.
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
        The CSVs are the source of truth. This migration project (imported accounts + run history)
        is kept so you can follow the process, but it is never used to resume from a point — every
        run compares source and target and skips what already exists, so after any failure you can
        simply run it again. Delete the project when you are done.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <BulkImportCard
          role="source"
          title="Source Accounts"
          description="CSV columns: email, target, username, password. The target column names the target account's email — leave it empty to match by the account's own email. All accounts must be on the same IMAP server."
          accounts={overview?.source ?? []}
          matchedIds={matchedSourceIds}
          tested={sourceTested}
          disabled={isRunning}
          onChanged={loadOverview}
        />
        <BulkImportCard
          role="target"
          title="Target Accounts"
          description="CSV columns: email, username, password. Matched against the source accounts' target column (or their email)."
          accounts={overview?.target ?? []}
          matchedIds={matchedTargetIds}
          tested={targetTested}
          disabled={isRunning}
          onChanged={loadOverview}
        />
      </div>

      {hasImports && (
        <Alert variant={pairs.length > 0 && allMatched ? "info" : "warning"}>
          {pairs.length} matched pair(s)
          {unmatchedSource.length > 0 && `, ${unmatchedSource.length} source-only`}
          {unmatchedTarget.length > 0 && `, ${unmatchedTarget.length} target-only`}
          {" — "}
          {pairs.length > 0 && allMatched
            ? "every account is matched."
            : "every imported account must be matched before the migration can start. Fix the CSVs and re-import."}
        </Alert>
      )}

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
          Start Bulk Migration ({pairs.length} account{pairs.length === 1 ? "" : "s"})
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
        <BulkRunProgress
          detail={runDetail}
          onCancel={handleCancel}
          isCancelling={isCancelling}
        />
      )}
    </div>
  );
}
