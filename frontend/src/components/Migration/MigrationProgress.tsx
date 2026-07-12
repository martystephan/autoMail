import { useState } from "react";
import type {
  MigrationJobDetail,
  MigrationJobStatus,
  MigrationFolderStatus,
} from "../../api/migration";
import { isJobActive } from "../../api/migration";
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "../ui";

const JOB_STATUS_LABELS: Record<MigrationJobStatus, string> = {
  pending: "Starting...",
  running: "Running",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

const JOB_STATUS_STYLES: Record<MigrationJobStatus, string> = {
  pending: "bg-blue-100 text-blue-700",
  running: "bg-blue-100 text-blue-700",
  completed: "bg-green-100 text-green-700",
  completed_with_errors: "bg-amber-100 text-amber-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-neutral-100 text-neutral-600",
  interrupted: "bg-amber-100 text-amber-700",
};

const FOLDER_STATUS_LABELS: Record<MigrationFolderStatus, string> = {
  pending: "Waiting",
  running: "Copying...",
  completed: "Done",
  completed_with_errors: "Done (errors)",
  failed: "Failed",
};

const FOLDER_STATUS_STYLES: Record<MigrationFolderStatus, string> = {
  pending: "text-neutral-400",
  running: "text-blue-600",
  completed: "text-green-600",
  completed_with_errors: "text-amber-600",
  failed: "text-red-600",
};

interface MigrationProgressProps {
  detail: MigrationJobDetail;
  onCancel: () => void;
  isCancelling: boolean;
  // Bulk runs render this inside their own progress card and cancel the whole
  // run instead of the single pair job
  hideCancel?: boolean;
}

export default function MigrationProgress({
  detail,
  onCancel,
  isCancelling,
  hideCancel = false,
}: MigrationProgressProps) {
  const { job, folders, logs } = detail;
  const [showLogs, setShowLogs] = useState(false);

  const active = isJobActive(job.status);
  const percent =
    job.totalMessages > 0
      ? Math.min(100, Math.round((job.processedMessages / job.totalMessages) * 100))
      : active
        ? 0
        : 100;

  return (
    <Card>
      <CardHeader className="border-b border-neutral-200">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              Migration #{job.id}
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${JOB_STATUS_STYLES[job.status]}`}
              >
                {JOB_STATUS_LABELS[job.status]}
              </span>
            </CardTitle>
            <CardDescription>
              {active && job.currentFolder
                ? `Currently copying: ${job.currentFolder}`
                : job.error || "Messages are copied in small batches; progress is saved continuously."}
            </CardDescription>
          </div>
          {active && !hideCancel && (
            <Button
              variant="secondary"
              onClick={onCancel}
              loading={isCancelling}
              disabled={isCancelling}
            >
              {isCancelling ? "Cancelling..." : "Cancel"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-neutral-700 font-medium">
              {job.processedMessages} / {job.totalMessages} messages
            </span>
            <span className="text-neutral-500">{percent}%</span>
          </div>
          <div className="w-full bg-neutral-200 rounded-full h-2 overflow-hidden">
            <div
              className={`h-2 rounded-full transition-all duration-500 ${
                job.status === "failed" ? "bg-red-500" : "bg-blue-600"
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 text-center">
          <div className="rounded-lg bg-green-50 py-2">
            <div className="text-lg font-semibold text-green-700">
              {job.copiedMessages}
            </div>
            <div className="text-xs text-green-700">Copied</div>
          </div>
          <div className="rounded-lg bg-neutral-50 py-2">
            <div className="text-lg font-semibold text-neutral-700">
              {job.skippedMessages}
            </div>
            <div className="text-xs text-neutral-500">
              Skipped (already on target)
            </div>
          </div>
          <div className="rounded-lg bg-red-50 py-2">
            <div className="text-lg font-semibold text-red-700">
              {job.failedMessages}
            </div>
            <div className="text-xs text-red-700">Failed</div>
          </div>
        </div>

        {folders.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-neutral-700 mb-2">
              Folders
            </h3>
            <ul className="divide-y divide-neutral-200 border border-neutral-200 rounded-lg max-h-72 overflow-y-auto">
              {folders.map((folder) => (
                <li
                  key={folder.id}
                  className="px-4 py-2 flex justify-between items-center gap-4"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-neutral-900 truncate">
                      {folder.path}
                    </div>
                    {folder.error && (
                      <div className="text-xs text-red-600 truncate" title={folder.error}>
                        {folder.error}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-sm">
                    <span className="text-neutral-500">
                      {folder.copiedCount + folder.skippedCount + folder.failedCount}
                      /{folder.messageCount}
                      {folder.failedCount > 0 && (
                        <span className="text-red-600">
                          {" "}
                          ({folder.failedCount} failed)
                        </span>
                      )}
                    </span>
                    <span
                      className={`text-xs font-medium ${FOLDER_STATUS_STYLES[folder.status]}`}
                    >
                      {FOLDER_STATUS_LABELS[folder.status]}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {logs.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setShowLogs((prev) => !prev)}
              className="text-sm font-medium text-red-700 hover:text-red-900"
            >
              {showLogs ? "Hide" : "Show"} problems ({logs.length})
            </button>
            {showLogs && (
              <ul className="mt-2 divide-y divide-neutral-200 border border-neutral-200 rounded-lg max-h-72 overflow-y-auto text-sm">
                {logs.map((log) => (
                  <li key={log.id} className="px-4 py-2">
                    <span
                      className={
                        log.level === "error"
                          ? "text-red-600"
                          : "text-amber-600"
                      }
                    >
                      [{log.level}]
                    </span>{" "}
                    {log.folderPath && (
                      <span className="text-neutral-500">
                        {log.folderPath}
                        {log.uid != null ? ` (UID ${log.uid})` : ""}:{" "}
                      </span>
                    )}
                    <span className="text-neutral-800">{log.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
