import { useRef, useState } from "react";
import Papa from "papaparse";
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
  Input,
  Label,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "../ui";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ParsedCsv {
  rows: ArchiveImportRow[];
  problems: string[];
}

// Fixed column order: email, username, password. A first row whose first cell
// looks like a header ("email", "E-Mail", ...) is dropped.
function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<string[]>(text.replace(/^﻿/, ""), {
    skipEmptyLines: "greedy",
  });

  let lines = result.data;
  if (lines.length > 0 && /e-?mail/i.test(lines[0][0] ?? "")) {
    lines = lines.slice(1);
  }

  const rows: ArchiveImportRow[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    const email = (line[0] ?? "").trim().toLowerCase();
    const username = (line[1] ?? "").trim();
    const password = line[2] ?? "";
    const rowNumber = index + 1;

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
    rows.push({ email, username, password });
  });

  return { rows, problems };
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
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setFileName(file.name);
      setParsed(parseCsv(String(reader.result ?? "")));
    };
    reader.readAsText(file);
  };

  const resetFileSelection = () => {
    setParsed(null);
    setFileName(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleImport = async () => {
    if (!parsed || parsed.rows.length === 0) return;
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
        accounts: parsed.rows,
      });
      result.warnings.forEach((warning) => toast.warning(warning));
      toast.success(`Imported ${result.accounts.length} account(s)`);
      resetFileSelection();
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

  const validRows = parsed?.rows.length ?? 0;

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
          <Label htmlFor="archive-csv-file">CSV File (email, username, password)</Label>
          <input
            id="archive-csv-file"
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            disabled={disabled}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
            className="block w-full text-sm text-neutral-600 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-neutral-100 file:text-sm file:font-medium file:text-neutral-700 hover:file:bg-neutral-200 disabled:cursor-not-allowed"
          />
        </div>

        {parsed && (
          <div className="space-y-2">
            <Alert variant={parsed.problems.length > 0 ? "warning" : "info"}>
              {fileName}: {validRows} valid row(s)
              {parsed.problems.length > 0 && `, ${parsed.problems.length} problem(s)`}
            </Alert>
            {parsed.problems.length > 0 && (
              <ul className="text-xs text-amber-700 space-y-0.5 max-h-24 overflow-y-auto">
                {parsed.problems.map((problem, index) => (
                  <li key={index}>{problem}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleImport}
            loading={isImporting}
            disabled={disabled || isImporting || !parsed || validRows === 0}
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
