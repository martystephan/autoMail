import { useMemo, useState } from "react";
import Papa from "papaparse";
import { toast } from "sonner";
import {
  importImportAccounts,
  clearImportAccounts,
  testImportConnection,
  uploadImportZip,
  type ImportAccountView,
  type ImportAccountRow,
} from "../../api/import";
import {
  Alert,
  Button,
  FilePicker,
  Input,
  Label,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "../ui";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mirror of the backend's sanitizeZipFileName so the matching table shows the
// same verdict the server will reach (the server's result stays authoritative)
function sanitizeZipFileName(name: string): string {
  const base = name.split("/").pop()!.replace(/\.zip$/i, "");
  const cleaned = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 100);
  return `${cleaned || "_"}.zip`;
}

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

interface ParsedCsv {
  rows: ImportAccountRow[];
  problems: string[];
}

// Fixed column order: email, username, password, zip file name. A first row
// whose first cell looks like a header ("email", "E-Mail", ...) is dropped.
function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<string[]>(text.replace(/^﻿/, ""), {
    skipEmptyLines: "greedy",
  });

  let lines = result.data;
  if (lines.length > 0 && /e-?mail/i.test(lines[0][0] ?? "")) {
    lines = lines.slice(1);
  }

  const rows: ImportAccountRow[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    const email = (line[0] ?? "").trim().toLowerCase();
    const username = (line[1] ?? "").trim();
    const password = line[2] ?? "";
    const zipFileName = (line[3] ?? "").trim();
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
    if (!zipFileName || !/\.zip$/i.test(zipFileName)) {
      problems.push(`Row ${rowNumber} (${email}): zip file name is missing or does not end in .zip`);
      return;
    }
    if (seen.has(email)) {
      problems.push(`Row ${rowNumber}: duplicate email ${email} — the last occurrence will be used`);
    }
    seen.add(email);
    rows.push({ email, username, password, zipFileName });
  });

  return { rows, problems };
}

interface ImportSetupCardProps {
  accounts: ImportAccountView[];
  tested: boolean;
  disabled: boolean;
  onChanged: () => void;
}

export default function ImportSetupCard({
  accounts,
  tested,
  disabled,
  onChanged,
}: ImportSetupCardProps) {
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [zipFiles, setZipFiles] = useState<File[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  const handleCsvFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setCsvFileName(file.name);
      setParsed(parseCsv(String(reader.result ?? "")));
    };
    reader.readAsText(file);
  };

  const handleFolderSelection = (files: File[]) => {
    const zips = files.filter((file) => /\.zip$/i.test(file.name));
    setZipFiles(zips);
    if (files.length > 0 && zips.length === 0) {
      toast.warning("The selected folder contains no .zip files");
    }
  };

  const resetSelection = () => {
    setParsed(null);
    setCsvFileName(null);
    setZipFiles([]);
  };

  // Match every CSV row against the selected zip files by sanitized basename
  const matching = useMemo(() => {
    const filesByName = new Map(zipFiles.map((file) => [sanitizeZipFileName(file.name), file]));
    const rows = (parsed?.rows ?? []).map((row) => {
      const wanted = sanitizeZipFileName(row.zipFileName);
      return { row, wanted, file: filesByName.get(wanted) ?? null };
    });
    const wantedNames = new Set(rows.map((entry) => entry.wanted));
    const unreferenced = zipFiles.filter((file) => !wantedNames.has(sanitizeZipFileName(file.name)));
    const missing = rows.filter((entry) => !entry.file);
    return { rows, unreferenced, missing };
  }, [parsed, zipFiles]);

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
      const result = await importImportAccounts({
        imapHost: imapHost.trim(),
        imapPort: port,
        accounts: parsed.rows,
      });
      result.warnings.forEach((warning) => toast.warning(warning));

      // Upload the matched zips one after another — a failed upload doesn't
      // block the rest, missing ones can be re-uploaded later
      const toUpload = matching.rows.filter((entry) => entry.file);
      let uploaded = 0;
      const failures: string[] = [];
      for (const [index, entry] of toUpload.entries()) {
        setUploadProgress(`${index + 1} / ${toUpload.length}: ${entry.file!.name}`);
        try {
          await uploadImportZip(entry.file!);
          uploaded++;
        } catch (error) {
          failures.push(`${entry.file!.name}: ${error}`);
        }
      }
      setUploadProgress(null);

      failures.forEach((failure) => toast.error(`Upload failed — ${failure}`));
      toast.success(
        `Imported ${result.accounts.length} account(s)` +
          (toUpload.length > 0 ? `, uploaded ${uploaded} of ${toUpload.length} zip(s)` : "")
      );
      resetSelection();
      onChanged();
    } catch (error) {
      toast.error(`Import failed: ${error}`);
    } finally {
      setUploadProgress(null);
      setIsImporting(false);
    }
  };

  const handleClear = async () => {
    const confirmed = window.confirm("Remove all imported accounts? Uploaded zips are kept.");
    if (!confirmed) return;

    try {
      setIsClearing(true);
      await clearImportAccounts();
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
      const result = await testImportConnection();
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
        <CardTitle>Accounts &amp; Archive Zips</CardTitle>
        <CardDescription>
          CSV columns: email, username, password, zip file name. Then select the folder that
          contains the archive zips — they are matched by file name and uploaded to the server.
          All accounts must be on the same IMAP server.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Label htmlFor="import-imap-host">IMAP Host</Label>
            <Input
              id="import-imap-host"
              placeholder="imap.example.com"
              value={imapHost}
              onChange={(e) => setImapHost(e.target.value)}
              disabled={disabled}
            />
          </div>
          <div>
            <Label htmlFor="import-imap-port">Port</Label>
            <Input
              id="import-imap-port"
              type="number"
              value={imapPort}
              onChange={(e) => setImapPort(e.target.value)}
              disabled={disabled}
            />
          </div>
        </div>

        <div>
          <Label htmlFor="import-csv-file">CSV File (email, username, password, zip file name)</Label>
          <FilePicker
            id="import-csv-file"
            accept=".csv,text/csv,text/plain"
            disabled={disabled}
            title="Choose a CSV file"
            selection={csvFileName}
            onFiles={(files) => handleCsvFile(files[0])}
          />
        </div>

        <div>
          <Label htmlFor="import-zip-folder">Folder with the archive zips</Label>
          <FilePicker
            id="import-zip-folder"
            directory
            disabled={disabled}
            title="Choose the folder containing the zips"
            selection={
              zipFiles.length > 0
                ? `${zipFiles.length} zip file(s) selected (${formatBytes(
                    zipFiles.reduce((sum, file) => sum + file.size, 0)
                  )})`
                : null
            }
            onFiles={handleFolderSelection}
          />
        </div>

        {parsed && (
          <div className="space-y-2">
            <Alert variant={parsed.problems.length > 0 ? "warning" : "info"}>
              {csvFileName}: {validRows} valid row(s)
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

        {parsed && validRows > 0 && (
          <div>
            <h3 className="text-sm font-medium text-neutral-700 mb-2">Zip matching</h3>
            <ul className="divide-y divide-neutral-200 border border-neutral-200 rounded-lg max-h-48 overflow-y-auto">
              {matching.rows.map((entry) => (
                <li key={entry.row.email} className="px-4 py-1.5 flex justify-between items-center gap-4 text-sm">
                  <span className="text-neutral-900 truncate">
                    {entry.row.email}
                    <span className="text-neutral-400"> → {entry.wanted}</span>
                  </span>
                  {entry.file ? (
                    <span className="shrink-0 text-xs text-green-700">
                      ✓ {formatBytes(entry.file.size)}
                    </span>
                  ) : (
                    <span className="shrink-0 text-xs text-red-600">zip not in folder</span>
                  )}
                </li>
              ))}
            </ul>
            {matching.unreferenced.length > 0 && (
              <p className="text-xs text-neutral-500 mt-1">
                {matching.unreferenced.length} zip(s) in the folder are not referenced by any CSV
                row and will not be uploaded.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleImport}
            loading={isImporting}
            disabled={disabled || isImporting || !parsed || validRows === 0}
          >
            {uploadProgress
              ? `Uploading ${uploadProgress}`
              : `Import${validRows > 0 ? ` ${validRows} accounts` : ""}` +
                (matching.rows.some((entry) => entry.file)
                  ? ` & upload ${matching.rows.filter((entry) => entry.file).length} zips`
                  : "")}
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
                <li key={account.id} className="px-4 py-2 flex justify-between items-center gap-4">
                  <div className="min-w-0">
                    <div className="text-sm text-neutral-900 truncate">{account.email}</div>
                    <div className="text-xs text-neutral-500 truncate">
                      {account.username} @ {account.imapHost}:{account.imapPort} — {account.zipFileName}
                    </div>
                  </div>
                  {account.zipUploaded ? (
                    <span className="shrink-0 text-xs text-green-700">
                      ✓ zip uploaded{account.zipSize != null ? ` (${formatBytes(account.zipSize)})` : ""}
                    </span>
                  ) : (
                    <span className="shrink-0 text-xs text-red-600">zip missing</span>
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
