import { useState, useEffect } from "react";
import type { MailAccount, Mailbox } from "../../api/mailAccounts";
import { getMailboxes } from "../../api/mailAccounts";
import {
  Button,
  Select,
  Label,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "../ui";

interface MigrationFormProps {
  accounts: MailAccount[];
  onPreview: (sourceAccountId: number, excludedFolders: string[]) => void;
  onExecute: (
    sourceAccountId: number,
    targetAccountId: number,
    excludedFolders: string[]
  ) => void;
  onReset: () => void;
  isExecuting: boolean;
  hasPreview: boolean;
}

export default function MigrationForm({
  accounts,
  onPreview,
  onExecute,
  onReset,
  isExecuting,
  hasPreview,
}: MigrationFormProps) {
  const [sourceAccountId, setSourceAccountId] = useState<number | "">("");
  const [targetAccountId, setTargetAccountId] = useState<number | "">("");
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [selectedMailboxes, setSelectedMailboxes] = useState<Set<string>>(
    new Set()
  );
  const [isLoadingMailboxes, setIsLoadingMailboxes] = useState(false);
  const [mailboxError, setMailboxError] = useState<string | null>(null);

  const fetchMailboxes = async () => {
    if (sourceAccountId === "") return;
    setIsLoadingMailboxes(true);
    setMailboxError(null);
    try {
      const boxes = await getMailboxes(sourceAccountId);
      setMailboxes(boxes);
      // Select all mailboxes by default
      setSelectedMailboxes(new Set(boxes.map((box) => box.path)));
    } catch (error) {
      setMailboxError("Failed to fetch mailboxes");
      console.error("Error fetching mailboxes:", error);
    } finally {
      setIsLoadingMailboxes(false);
    }
  };

  // Fetch mailboxes when source account changes
  useEffect(() => {
    if (sourceAccountId === "") {
      setMailboxes([]);
      setSelectedMailboxes(new Set());
      setMailboxError(null);
      return;
    }
    fetchMailboxes();
  }, [sourceAccountId]);

  const getExcludedFolders = (): string[] => {
    return mailboxes
      .filter((box) => !selectedMailboxes.has(box.path))
      .map((box) => box.path);
  };

  const toggleMailbox = (path: string) => {
    setSelectedMailboxes((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedMailboxes(new Set(mailboxes.map((box) => box.path)));
  };

  const deselectAll = () => {
    setSelectedMailboxes(new Set());
  };

  const handlePreview = async () => {
    if (sourceAccountId === "") return;
    setIsPreviewing(true);
    try {
      await onPreview(sourceAccountId, getExcludedFolders());
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleExecute = () => {
    if (sourceAccountId === "" || targetAccountId === "") return;
    onExecute(sourceAccountId, targetAccountId, getExcludedFolders());
  };

  const handleReset = () => {
    setSourceAccountId("");
    setTargetAccountId("");
    setMailboxes([]);
    setSelectedMailboxes(new Set());
    onReset();
  };

  const canPreview = sourceAccountId !== "";
  const canExecute =
    sourceAccountId !== "" &&
    targetAccountId !== "" &&
    sourceAccountId !== targetAccountId &&
    hasPreview;

  return (
    <Card>
      <CardHeader className="border-b border-neutral-200">
        <CardTitle>Migration Settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label htmlFor="sourceAccount">Source Account</Label>
            <Select
              id="sourceAccount"
              value={sourceAccountId}
              onChange={(e) => {
                setSourceAccountId(
                  e.target.value ? Number(e.target.value) : ""
                );
                onReset();
              }}
              className="mt-1"
              disabled={isExecuting}
            >
              <option value="">Select source account</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} ({account.email})
                </option>
              ))}
            </Select>
            <p className="mt-1 text-xs text-neutral-500">
              The account to copy messages from
            </p>
          </div>

          <div>
            <Label htmlFor="targetAccount">Target Account</Label>
            <Select
              id="targetAccount"
              value={targetAccountId}
              onChange={(e) =>
                setTargetAccountId(e.target.value ? Number(e.target.value) : "")
              }
              className="mt-1"
              disabled={isExecuting}
            >
              <option value="">Select target account</option>
              {accounts
                .filter((a) => a.id !== sourceAccountId)
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} ({account.email})
                  </option>
                ))}
            </Select>
            <p className="mt-1 text-xs text-neutral-500">
              The account to copy messages to
            </p>
          </div>
        </div>

        {sourceAccountId !== "" && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Label>Folders to Migrate</Label>
                <button
                  type="button"
                  onClick={fetchMailboxes}
                  className="text-neutral-400 hover:text-neutral-600 disabled:opacity-50"
                  disabled={isExecuting || isLoadingMailboxes}
                  title="Reload mailboxes"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className={`h-4 w-4 ${isLoadingMailboxes ? "animate-spin" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                </button>
              </div>
              {mailboxes.length > 0 && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={selectAll}
                    className="text-xs text-blue-600 hover:text-blue-800"
                    disabled={isExecuting}
                  >
                    Select all
                  </button>
                  <span className="text-neutral-300">|</span>
                  <button
                    type="button"
                    onClick={deselectAll}
                    className="text-xs text-blue-600 hover:text-blue-800"
                    disabled={isExecuting}
                  >
                    Deselect all
                  </button>
                </div>
              )}
            </div>

            {isLoadingMailboxes ? (
              <div className="text-sm text-neutral-500 py-4">
                Loading mailboxes...
              </div>
            ) : mailboxError ? (
              <div className="text-sm text-red-600 py-4">{mailboxError}</div>
            ) : mailboxes.length === 0 ? (
              <div className="text-sm text-neutral-500 py-4">
                No mailboxes found
              </div>
            ) : (
              <div className="border border-neutral-200 rounded-lg p-3 max-h-64 overflow-y-auto space-y-1">
                {[...mailboxes]
                  .sort((a, b) => a.path.localeCompare(b.path))
                  .map((mailbox) => {
                    const depth = (mailbox.path.match(/\//g) || []).length;
                    const displayName =
                      mailbox.name ||
                      mailbox.path.split("/").pop() ||
                      mailbox.path;

                    return (
                      <label
                        key={mailbox.path}
                        className="flex items-center gap-2 cursor-pointer hover:bg-neutral-50 py-1 px-1 rounded"
                        style={{ paddingLeft: `${depth * 16 + 4}px` }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedMailboxes.has(mailbox.path)}
                          onChange={() => toggleMailbox(mailbox.path)}
                          disabled={isExecuting}
                          className="rounded border-neutral-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-sm text-neutral-700">
                          {displayName}
                        </span>
                        {mailbox.specialUse && (
                          <span className="text-xs text-neutral-400">
                            {mailbox.specialUse}
                          </span>
                        )}
                      </label>
                    );
                  })}
              </div>
            )}
            <p className="mt-1 text-xs text-neutral-500">
              Uncheck folders you want to exclude from the migration
            </p>
          </div>
        )}

        <div className="flex justify-end space-x-3 pt-4">
          <Button
            variant="secondary"
            onClick={handleReset}
            disabled={isExecuting}
          >
            Reset
          </Button>
          <Button
            variant="primary"
            onClick={handlePreview}
            loading={isPreviewing}
            disabled={!canPreview || isPreviewing || isExecuting}
          >
            {isPreviewing ? "Loading Preview..." : "Preview (Dry Run)"}
          </Button>
          <Button
            variant="success"
            onClick={handleExecute}
            loading={isExecuting}
            disabled={!canExecute || isExecuting}
          >
            {isExecuting ? "Migration Running..." : "Start Migration"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
