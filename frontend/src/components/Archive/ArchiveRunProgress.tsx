import { useState } from "react";
import { toast } from "sonner";
import { Download, FolderDown } from "lucide-react";
import type { MigrationJobStatus } from "../../api/migration";
import { isJobActive } from "../../api/migration";
import { downloadArchiveZip, fetchArchiveZipBlob, type ArchiveRunDetail } from "../../api/archive";
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "../ui";

const RUN_STATUS_LABELS: Record<MigrationJobStatus, string> = {
  pending: "Starting...",
  running: "Running",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

const RUN_STATUS_STYLES: Record<MigrationJobStatus, string> = {
  pending: "bg-blue-100 text-blue-700",
  running: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  completed_with_errors: "bg-amber-100 text-amber-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-neutral-100 text-neutral-600",
  interrupted: "bg-amber-100 text-amber-700",
};

const JOB_STATUS_STYLES: Record<MigrationJobStatus, string> = {
  pending: "text-neutral-400",
  running: "text-blue-600",
  completed: "text-green-600",
  completed_with_errors: "text-amber-600",
  failed: "text-red-600",
  cancelled: "text-neutral-500",
  interrupted: "text-amber-600",
};

// File System Access API (Chromium): lets the user pick a folder once and
// saves every zip into it. Not in the TS DOM lib yet.
declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
  }
}

const FOLDER_STATUS_STYLES: Record<string, string> = {
  pending: "text-neutral-400",
  running: "text-blue-600",
  completed: "text-green-600",
  completed_with_errors: "text-amber-600",
  failed: "text-red-600",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
}

interface ArchiveRunProgressProps {
  detail: ArchiveRunDetail;
  onCancel: () => void;
  isCancelling: boolean;
  onDeleteRun: () => void;
  isDeleting: boolean;
}

export default function ArchiveRunProgress({
  detail,
  onCancel,
  isCancelling,
  onDeleteRun,
  isDeleting,
}: ArchiveRunProgressProps) {
  const { run, jobs, currentJobDetail } = detail;
  const [downloadingJobId, setDownloadingJobId] = useState<number | null>(null);
  const [isDownloadingAll, setIsDownloadingAll] = useState(false);
  const [folderSaveProgress, setFolderSaveProgress] = useState<string | null>(null);

  const active = isJobActive(run.status);
  const percent =
    run.totalAccounts > 0
      ? Math.min(100, Math.round((run.completedAccounts / run.totalAccounts) * 100))
      : active
        ? 0
        : 100;

  const downloadableJobs = jobs.filter((job) => job.zipPath != null);

  const handleDownload = async (jobId: number, email: string) => {
    try {
      setDownloadingJobId(jobId);
      await downloadArchiveZip(jobId, `${email}.zip`);
    } catch (error) {
      toast.error(`Download failed: ${error}`);
    } finally {
      setDownloadingJobId(null);
    }
  };

  // Pick a folder once, then write every zip straight into it — no per-file
  // save dialogs. Only available in Chromium-based browsers.
  const handleSaveAllToFolder = async () => {
    if (!window.showDirectoryPicker) return;

    let dir: FileSystemDirectoryHandle;
    try {
      dir = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch {
      // User closed the picker (or the browser denied access) — nothing to do
      return;
    }

    let saved = 0;
    const failures: string[] = [];
    try {
      for (const [index, job] of downloadableJobs.entries()) {
        setFolderSaveProgress(`${index + 1} / ${downloadableJobs.length}`);
        try {
          const blob = await fetchArchiveZipBlob(job.id);
          const fileHandle = await dir.getFileHandle(`${job.email}.zip`, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(blob);
          await writable.close();
          saved++;
        } catch (error) {
          failures.push(`${job.email}: ${error}`);
        }
      }
    } finally {
      setFolderSaveProgress(null);
    }

    if (failures.length === 0) {
      toast.success(`Saved ${saved} zip(s) to "${dir.name}"`);
    } else {
      failures.forEach((failure) => toast.error(`Failed to save ${failure}`));
      toast.warning(`Saved ${saved} of ${downloadableJobs.length} zip(s) to "${dir.name}"`);
    }
  };

  const handleDownloadAll = async () => {
    try {
      setIsDownloadingAll(true);
      for (const job of downloadableJobs) {
        await downloadArchiveZip(job.id, `${job.email}.zip`);
        // Give the browser a moment between saves so none are dropped
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      toast.success(`Downloaded ${downloadableJobs.length} zip(s)`);
    } catch (error) {
      toast.error(`Download failed: ${error}`);
    } finally {
      setIsDownloadingAll(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="border-b border-neutral-200">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                Archive Run #{run.id}
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${RUN_STATUS_STYLES[run.status]}`}
                >
                  {RUN_STATUS_LABELS[run.status]}
                </span>
              </CardTitle>
              <CardDescription>
                {active && run.currentEmail
                  ? `Currently archiving account ${Math.min(run.completedAccounts + 1, run.totalAccounts)} of ${run.totalAccounts}: ${run.currentEmail}`
                  : run.error ||
                    "Accounts are archived one after another; each account becomes one zip of .eml files."}
              </CardDescription>
            </div>
            <div className="flex gap-2 shrink-0">
              {active ? (
                <Button
                  variant="secondary"
                  onClick={onCancel}
                  loading={isCancelling}
                  disabled={isCancelling}
                >
                  {isCancelling ? "Cancelling..." : "Cancel"}
                </Button>
              ) : (
                <>
                  {downloadableJobs.length > 1 && (
                    <Button
                      variant="secondary"
                      onClick={handleDownloadAll}
                      loading={isDownloadingAll}
                      disabled={isDownloadingAll || downloadingJobId != null || folderSaveProgress != null}
                    >
                      Download all ({downloadableJobs.length})
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    onClick={onDeleteRun}
                    loading={isDeleting}
                    disabled={isDeleting}
                  >
                    Delete run &amp; zips
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-neutral-700 font-medium">
                {run.completedAccounts} / {run.totalAccounts} accounts
                {run.failedAccounts > 0 && (
                  <span className="text-red-600"> ({run.failedAccounts} failed)</span>
                )}
              </span>
              <span className="text-neutral-500">{percent}%</span>
            </div>
            <div className="w-full bg-neutral-200 rounded-full h-2 overflow-hidden">
              <div
                className={`h-2 rounded-full transition-all duration-500 ${
                  run.status === "failed" ? "bg-red-500" : "bg-blue-600"
                }`}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>

          {jobs.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-neutral-700 mb-2">Accounts</h3>
              <ul className="divide-y divide-neutral-200 border border-neutral-200 rounded-lg max-h-72 overflow-y-auto">
                {jobs.map((job) => (
                  <li key={job.id} className="px-4 py-2 flex justify-between items-center gap-4">
                    <div className="min-w-0">
                      <div className="text-sm text-neutral-900 truncate">{job.email}</div>
                      {job.error && (
                        <div className="text-xs text-red-600 truncate" title={job.error}>
                          {job.error}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0 text-sm">
                      <span className="text-neutral-500">
                        {job.savedMessages} / {job.totalMessages} saved
                        {job.failedMessages > 0 && (
                          <span className="text-red-600">, {job.failedMessages} failed</span>
                        )}
                      </span>
                      <span className={`text-xs font-medium ${JOB_STATUS_STYLES[job.status]}`}>
                        {RUN_STATUS_LABELS[job.status]}
                      </span>
                      {job.zipPath != null && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleDownload(job.id, job.email)}
                          loading={downloadingJobId === job.id}
                          disabled={downloadingJobId != null || isDownloadingAll || folderSaveProgress != null}
                        >
                          <Download className="size-3.5" />
                          {job.zipSize != null ? formatBytes(job.zipSize) : "Download"}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {downloadableJobs.length > 0 && !!window.showDirectoryPicker && (
            <div className="flex justify-end">
              <Button
                onClick={handleSaveAllToFolder}
                loading={folderSaveProgress != null}
                disabled={folderSaveProgress != null || downloadingJobId != null || isDownloadingAll}
              >
                <FolderDown className="size-4" />
                {folderSaveProgress
                  ? `Saving ${folderSaveProgress}...`
                  : `Save all ${downloadableJobs.length} zip(s) to a folder`}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {currentJobDetail && isJobActive(currentJobDetail.job.status) && (
        <Card>
          <CardHeader className="border-b border-neutral-200">
            <CardTitle className="text-base">
              Archiving {currentJobDetail.job.email}
            </CardTitle>
            <CardDescription>
              {currentJobDetail.job.currentFolder
                ? `Current folder: ${currentJobDetail.job.currentFolder}`
                : "Listing folders..."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {currentJobDetail.folders.length > 0 && (
              <ul className="divide-y divide-neutral-200 border border-neutral-200 rounded-lg max-h-56 overflow-y-auto">
                {currentJobDetail.folders.map((folder) => (
                  <li key={folder.id} className="px-4 py-1.5 flex justify-between items-center gap-4 text-sm">
                    <span className="text-neutral-900 truncate">{folder.path}</span>
                    <span className="shrink-0 text-neutral-500">
                      {folder.savedCount} / {folder.messageCount}
                      {folder.failedCount > 0 && (
                        <span className="text-red-600"> ({folder.failedCount} failed)</span>
                      )}{" "}
                      <span className={`text-xs font-medium ${FOLDER_STATUS_STYLES[folder.status] ?? ""}`}>
                        {RUN_STATUS_LABELS[folder.status as MigrationJobStatus] ?? folder.status}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {currentJobDetail.logs.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-neutral-700 mb-2">Warnings &amp; errors</h3>
                <ul className="text-xs space-y-0.5 max-h-32 overflow-y-auto">
                  {currentJobDetail.logs.map((log) => (
                    <li
                      key={log.id}
                      className={log.level === "error" ? "text-red-600" : "text-amber-700"}
                    >
                      {log.folderPath ? `[${log.folderPath}] ` : ""}
                      {log.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
