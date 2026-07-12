import type { MigrationJobStatus } from "../../api/migration";
import { isJobActive } from "../../api/migration";
import type { BulkRunDetail } from "../../api/bulkMigration";
import MigrationProgress from "./MigrationProgress";
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

interface BulkRunProgressProps {
  detail: BulkRunDetail;
  onCancel: () => void;
  isCancelling: boolean;
}

export default function BulkRunProgress({
  detail,
  onCancel,
  isCancelling,
}: BulkRunProgressProps) {
  const { run, jobs, currentJobDetail } = detail;

  const active = isJobActive(run.status);
  const percent =
    run.totalPairs > 0
      ? Math.min(100, Math.round((run.completedPairs / run.totalPairs) * 100))
      : active
        ? 0
        : 100;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="border-b border-neutral-200">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                Bulk Migration #{run.id}
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${RUN_STATUS_STYLES[run.status]}`}
                >
                  {RUN_STATUS_LABELS[run.status]}
                </span>
              </CardTitle>
              <CardDescription>
                {active && run.currentEmail
                  ? `Currently migrating account ${Math.min(run.completedPairs + 1, run.totalPairs)} of ${run.totalPairs}: ${run.currentEmail}`
                  : run.error || "Accounts are migrated one after another; each account is a separate job."}
              </CardDescription>
            </div>
            {active && (
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
                {run.completedPairs} / {run.totalPairs} accounts
                {run.failedPairs > 0 && (
                  <span className="text-red-600"> ({run.failedPairs} failed)</span>
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
                  <li
                    key={job.id}
                    className="px-4 py-2 flex justify-between items-center gap-4"
                  >
                    <div className="min-w-0">
                      <div className="text-sm text-neutral-900 truncate">
                        {job.bulkEmail ?? `Job #${job.id}`}
                      </div>
                      {job.error && (
                        <div className="text-xs text-red-600 truncate" title={job.error}>
                          {job.error}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3 shrink-0 text-sm">
                      <span className="text-neutral-500">
                        {job.copiedMessages} copied, {job.skippedMessages} skipped
                        {job.failedMessages > 0 && (
                          <span className="text-red-600">
                            , {job.failedMessages} failed
                          </span>
                        )}
                      </span>
                      <span
                        className={`text-xs font-medium ${JOB_STATUS_STYLES[job.status]}`}
                      >
                        {RUN_STATUS_LABELS[job.status]}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {currentJobDetail && isJobActive(currentJobDetail.job.status) && (
        <MigrationProgress
          detail={currentJobDetail}
          onCancel={onCancel}
          isCancelling={isCancelling}
          hideCancel
        />
      )}
    </div>
  );
}
