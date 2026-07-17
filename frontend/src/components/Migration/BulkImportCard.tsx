import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  importBulkAccounts,
  clearBulkAccounts,
  testBulkConnection,
  type BulkAccountView,
  type BulkImportRow,
  type BulkRole,
} from "../../api/bulkMigration";
import {
  Alert,
  Button,
  CsvEditor,
  Input,
  Label,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  type CsvColumn,
  type CsvRow,
} from "../ui";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SOURCE_COLUMNS: CsvColumn[] = [
  { key: "email", label: "Email", required: true },
  { key: "targetEmail", label: "Target Email", placeholder: "same as email if empty" },
  { key: "username", label: "Username", required: true },
  { key: "password", label: "Password", required: true },
];

const TARGET_COLUMNS: CsvColumn[] = [
  { key: "email", label: "Email", required: true },
  { key: "username", label: "Username", required: true },
  { key: "password", label: "Password", required: true },
];

interface Validated {
  rows: BulkImportRow[];
  problems: string[];
}

// Domain validation on top of CsvEditor's own required-field check: email
// format, and (source only) matching a target's format when given.
function validateRows(rows: CsvRow[], role: BulkRole): Validated {
  const validRows: BulkImportRow[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  rows.forEach((row, index) => {
    const email = (row.email ?? "").trim().toLowerCase();
    const targetEmail = role === "source" ? (row.targetEmail ?? "").trim().toLowerCase() : "";
    const username = (row.username ?? "").trim();
    const password = row.password ?? "";
    const rowNumber = index + 1;

    if (!email && !username && !password && !targetEmail) return; // blank manual row
    if (!EMAIL_REGEX.test(email)) {
      problems.push(`Row ${rowNumber}: "${email || "(empty)"}" is not a valid email address`);
      return;
    }
    if (targetEmail && !EMAIL_REGEX.test(targetEmail)) {
      problems.push(`Row ${rowNumber} (${email}): target "${targetEmail}" is not a valid email address`);
      return;
    }
    if (!username) {
      problems.push(`Row ${rowNumber} (${email}): username is empty`);
      return;
    }
    if (!password) {
      problems.push(`Row ${rowNumber} (${email}): password is empty`);
      return;
    }
    if (seen.has(email)) {
      problems.push(`Row ${rowNumber}: duplicate email ${email} — the last occurrence will be used`);
    }
    seen.add(email);
    validRows.push({ email, username, password, ...(targetEmail ? { targetEmail } : {}) });
  });

  return { rows: validRows, problems };
}

interface BulkImportCardProps {
  role: BulkRole;
  title: string;
  description: string;
  accounts: BulkAccountView[];
  matchedIds: Set<number>;
  tested: boolean;
  disabled: boolean;
  onChanged: () => void;
}

export default function BulkImportCard({
  role,
  title,
  description,
  accounts,
  matchedIds,
  tested,
  disabled,
  onChanged,
}: BulkImportCardProps) {
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  const columns = role === "source" ? SOURCE_COLUMNS : TARGET_COLUMNS;
  const validated = useMemo(() => validateRows(rows, role), [rows, role]);

  const handleImport = async () => {
    if (validated.rows.length === 0) return;
    const port = parseInt(imapPort, 10);
    if (!imapHost.trim()) {
      toast.error("Enter the IMAP host first");
      return;
    }
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      toast.error("Enter a valid IMAP port");
      return;
    }

    try {
      setIsImporting(true);
      const result = await importBulkAccounts(role, {
        imapHost: imapHost.trim(),
        imapPort: port,
        accounts: validated.rows,
      });
      result.warnings.forEach((warning) => toast.warning(warning));
      toast.success(`Imported ${result.accounts.length} ${role} account(s)`);
      setRows([]);
      onChanged();
    } catch (error) {
      toast.error(`Import failed: ${error}`);
    } finally {
      setIsImporting(false);
    }
  };

  const handleClear = async () => {
    const confirmed = window.confirm(`Remove all imported ${role} accounts?`);
    if (!confirmed) return;

    try {
      setIsClearing(true);
      await clearBulkAccounts(role);
      toast.success(`Cleared ${role} accounts`);
      onChanged();
    } catch (error) {
      toast.error(`Failed to clear accounts: ${error}`);
    } finally {
      setIsClearing(false);
    }
  };

  const handleTest = async () => {
    try {
      setIsTesting(true);
      const result = await testBulkConnection(role);
      if (result.ok) {
        toast.success(`${title}: connection successful`);
      } else {
        toast.error(`${title}: connection failed — ${result.error}`);
      }
      // The test result gates the Start button — refresh the shared overview
      onChanged();
    } catch (error) {
      toast.error(`Connection test failed: ${error}`);
    } finally {
      setIsTesting(false);
    }
  };

  const validRows = validated.rows.length;

  return (
    <Card>
      <CardHeader className="border-b border-neutral-200">
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Label htmlFor={`${role}-imap-host`}>IMAP Host</Label>
            <Input
              id={`${role}-imap-host`}
              placeholder="imap.example.com"
              value={imapHost}
              onChange={(e) => setImapHost(e.target.value)}
              disabled={disabled}
            />
          </div>
          <div>
            <Label htmlFor={`${role}-imap-port`}>Port</Label>
            <Input
              id={`${role}-imap-port`}
              type="number"
              value={imapPort}
              onChange={(e) => setImapPort(e.target.value)}
              disabled={disabled}
            />
          </div>
        </div>

        <div>
          <Label>
            {role === "source"
              ? "CSV File (email, target, username, password)"
              : "CSV File (email, username, password)"}
          </Label>
          <CsvEditor
            columns={columns}
            rows={rows}
            onChange={setRows}
            disabled={disabled}
            downloadFileName={`${role}-accounts.csv`}
            showRequiredAlert={false}
          />
        </div>

        {rows.length > 0 && (
          <Alert variant={validated.problems.length > 0 ? "warning" : "info"}>
            {validRows} of {rows.length} row(s) ready to import
            {validated.problems.length > 0 && `, ${validated.problems.length} problem(s)`}
            {validated.problems.length > 0 && (
              <ul className="mt-1 text-xs space-y-0.5 max-h-24 overflow-y-auto">
                {validated.problems.map((problem, index) => (
                  <li key={index}>{problem}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleImport}
            loading={isImporting}
            disabled={disabled || isImporting || validRows === 0}
          >
            Import{validRows > 0 ? ` ${validRows} accounts` : ""}
          </Button>
          {accounts.length > 0 && (
            <>
              <Button
                variant="secondary"
                onClick={handleTest}
                loading={isTesting}
                disabled={isTesting}
              >
                {tested ? "Test connection ✓" : "Test connection"}
              </Button>
              <Button
                variant="secondary"
                onClick={handleClear}
                loading={isClearing}
                disabled={disabled || isClearing}
              >
                Clear
              </Button>
            </>
          )}
        </div>

        {accounts.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-neutral-700 mb-2">
              Imported accounts ({accounts.length})
            </h3>
            <ul className="divide-y divide-neutral-200 border border-neutral-200 rounded-lg max-h-64 overflow-y-auto">
              {accounts.map((account) => (
                <li
                  key={account.id}
                  className="px-4 py-2 flex justify-between items-center gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-neutral-900 truncate">
                      {account.email}
                      {account.targetEmail && account.targetEmail !== account.email && (
                        <span className="text-neutral-500"> → {account.targetEmail}</span>
                      )}
                    </div>
                    <div className="text-xs text-neutral-500 truncate">
                      {account.username} @ {account.imapHost}:{account.imapPort}
                    </div>
                  </div>
                  {matchedIds.has(account.id) ? (
                    <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
                      Matched
                    </span>
                  ) : (
                    <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700">
                      No counterpart
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
