import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  importArchiveAccounts,
  clearArchiveAccounts,
  testArchiveConnection,
  type ArchiveAccountView,
  type ArchiveImportRow,
} from "../../api/archive";
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

const COLUMNS: CsvColumn[] = [
  { key: "email", label: "Email", required: true },
  { key: "username", label: "Username", required: true },
  { key: "password", label: "Password", required: true },
];

interface Validated {
  rows: ArchiveImportRow[];
  problems: string[];
}

function validateRows(rows: CsvRow[]): Validated {
  const validRows: ArchiveImportRow[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  rows.forEach((row, index) => {
    const email = (row.email ?? "").trim().toLowerCase();
    const username = (row.username ?? "").trim();
    const password = row.password ?? "";
    const rowNumber = index + 1;

    if (!email && !username && !password) return; // blank manual row
    if (!EMAIL_REGEX.test(email)) {
      problems.push(`Row ${rowNumber}: "${email || "(empty)"}" is not a valid email address`);
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
    validRows.push({ email, username, password });
  });

  return { rows: validRows, problems };
}

interface ArchiveImportCardProps {
  accounts: ArchiveAccountView[];
  tested: boolean;
  disabled: boolean;
  onChanged: () => void;
}

export default function ArchiveImportCard({
  accounts,
  tested,
  disabled,
  onChanged,
}: ArchiveImportCardProps) {
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  const validated = useMemo(() => validateRows(rows), [rows]);

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
      const result = await importArchiveAccounts({
        imapHost: imapHost.trim(),
        imapPort: port,
        accounts: validated.rows,
      });
      result.warnings.forEach((warning) => toast.warning(warning));
      toast.success(`Imported ${result.accounts.length} account(s)`);
      setRows([]);
      onChanged();
    } catch (error) {
      toast.error(`Import failed: ${error}`);
    } finally {
      setIsImporting(false);
    }
  };

  const handleClear = async () => {
    const confirmed = window.confirm("Remove all imported accounts?");
    if (!confirmed) return;

    try {
      setIsClearing(true);
      await clearArchiveAccounts();
      toast.success("Cleared imported accounts");
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
      const result = await testArchiveConnection();
      if (result.ok) {
        toast.success("Connection successful");
      } else {
        toast.error(`Connection failed — ${result.error}`);
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
        <CardTitle>Accounts to Archive</CardTitle>
        <CardDescription>
          CSV columns: email, username, password — the same format as the target CSV of a bulk
          migration. All accounts must be on the same IMAP server.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Label htmlFor="archive-imap-host">IMAP Host</Label>
            <Input
              id="archive-imap-host"
              placeholder="imap.example.com"
              value={imapHost}
              onChange={(e) => setImapHost(e.target.value)}
              disabled={disabled}
            />
          </div>
          <div>
            <Label htmlFor="archive-imap-port">Port</Label>
            <Input
              id="archive-imap-port"
              type="number"
              value={imapPort}
              onChange={(e) => setImapPort(e.target.value)}
              disabled={disabled}
            />
          </div>
        </div>

        <div>
          <Label>CSV File (email, username, password)</Label>
          <CsvEditor
            columns={COLUMNS}
            rows={rows}
            onChange={setRows}
            disabled={disabled}
            downloadFileName="archive-accounts.csv"
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
                <li key={account.id} className="px-4 py-2">
                  <div className="text-sm text-neutral-900 truncate">{account.email}</div>
                  <div className="text-xs text-neutral-500 truncate">
                    {account.username} @ {account.imapHost}:{account.imapPort}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
