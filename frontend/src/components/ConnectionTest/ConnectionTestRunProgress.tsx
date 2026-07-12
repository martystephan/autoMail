import type { MigrationJobStatus } from "../../api/migration";
import { isJobActive } from "../../api/migration";
import type {
  ConnectionTestResultStatus,
  ConnectionTestRunDetail,
} from "../../api/connectionTest";
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeader,
  TableCell,
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

const RESULT_STATUS_LABELS: Record<ConnectionTestResultStatus, string> = {
  pending: "Pending",
  running: "Testing...",
  ok: "OK",
  failed: "FAILED",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

const RESULT_STATUS_STYLES: Record<ConnectionTestResultStatus, string> = {
  pending: "bg-neutral-100 text-neutral-500",
  running: "bg-blue-100 text-blue-700",
  ok: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-neutral-100 text-neutral-600",
  interrupted: "bg-amber-100 text-amber-700",
};

interface ConnectionTestRunProgressProps {
  detail: ConnectionTestRunDetail;
  onCancel: () => void;
  isCancelling: boolean;
  onDeleteRun: () => void;
  isDeleting: boolean;
}

export default function ConnectionTestRunProgress({
  detail,
  onCancel,
  isCancelling,
  onDeleteRun,
  isDeleting,
}: ConnectionTestRunProgressProps) {
  const { run, results } = detail;

  const active = isJobActive(run.status);
  const percent =
    run.totalAccounts > 0
      ? Math.min(100, Math.round((run.processedAccounts / run.totalAccounts) * 100))
      : active
        ? 0
        : 100;
  const pendingAccounts = Math.max(0, run.totalAccounts - run.processedAccounts);

  return (
    <Card>
      <CardHeader className="border-b border-neutral-200">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              Connection Test #{run.id}
              <span
                className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${RUN_STATUS_STYLES[run.status]}`}
              >
                {RUN_STATUS_LABELS[run.status]}
              </span>
            </CardTitle>
            <CardDescription>
              {run.error ||
                `IMAP logins against ${run.imapHost}:${run.imapPort} — nothing is read or changed in the mailboxes.`}
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
              <Button
                variant="secondary"
                onClick={onDeleteRun}
                loading={isDeleting}
                disabled={isDeleting}
              >
                Delete run
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="flex justify-between text-sm mb-1">
            <span className="text-neutral-700 font-medium">
              <span className="text-green-700">{run.okAccounts} ok</span>
              {" · "}
              <span className={run.failedAccounts > 0 ? "text-red-600" : "text-neutral-500"}>
                {run.failedAccounts} failed
              </span>
              {pendingAccounts > 0 && (
                <span className="text-neutral-500"> · {pendingAccounts} pending</span>
              )}
            </span>
            <span className="text-neutral-500">
              {run.processedAccounts} / {run.totalAccounts} ({percent}%)
            </span>
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

        {results.length > 0 && (
          <div className="border border-neutral-200 rounded-lg max-h-96 overflow-y-auto">
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeader>Email</TableHeader>
                  <TableHeader>Username</TableHeader>
                  <TableHeader>Status</TableHeader>
                  <TableHeader>Error</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {results.map((result) => (
                  <TableRow key={result.id}>
                    <TableCell className="truncate max-w-52" title={result.email}>
                      {result.email}
                    </TableCell>
                    <TableCell className="truncate max-w-52" title={result.username}>
                      {result.username}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${RESULT_STATUS_STYLES[result.status]}`}
                      >
                        {RESULT_STATUS_LABELS[result.status]}
                      </span>
                    </TableCell>
                    <TableCell
                      className="text-xs text-red-600 truncate max-w-80"
                      title={result.error ?? undefined}
                    >
                      {result.error ?? ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
