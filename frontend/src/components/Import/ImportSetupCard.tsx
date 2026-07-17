import { useMemo, useState } from "react";
import { X } from "lucide-react";
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
  CsvEditor,
  FilePicker,
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
  { key: "zipFileName", label: "Zip File Name", required: true, placeholder: "archive.zip" },
];

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

interface Validated {
  rows: ImportAccountRow[];
  problems: string[];
}

function validateRows(rows: CsvRow[]): Validated {
  const validRows: ImportAccountRow[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  rows.forEach((row, index) => {
    const email = (row.email ?? "").trim().toLowerCase();
    const username = (row.username ?? "").trim();
    const password = row.password ?? "";
    const zipFileName = (row.zipFileName ?? "").trim();
    const rowNumber = index + 1;

    if (!email && !username && !password && !zipFileName) return; // blank manual row
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
    validRows.push({ email, username, password, zipFileName });
  });

  return { rows: validRows, problems };
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
  const [rows, setRows] = useState<CsvRow[]>([]);
  const [zipFiles, setZipFiles] = useState<File[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const [isClearing, setIsClearing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  const validated = useMemo(() => validateRows(rows), [rows]);

  // Each file-dialog interaction only hands back the files just picked, not
  // previous ones — merge instead of replacing, so re-opening the picker to
  // add one more zip doesn't drop what was already selected. Re-picking a
  // zip with the same (sanitized) name replaces just that entry, so a bad
  // file can be swapped out by picking the corrected one again.
  const handleZipSelection = (files: File[]) => {
    const zips = files.filter((file) => /\.zip$/i.test(file.name));
    if (files.length > 0 && zips.length === 0) {
      toast.warning("The selection contains no .zip files");
      return;
    }
    if (zips.length === 0) return;
    setZipFiles((prev) => {
      const bySanitizedName = new Map(prev.map((file) => [sanitizeZipFileName(file.name), file]));
      for (const zip of zips) {
        bySanitizedName.set(sanitizeZipFileName(zip.name), zip);
      }
      return [...bySanitizedName.values()];
    });
  };

  const removeZipFile = (fileToRemove: File) => {
    setZipFiles((prev) => prev.filter((file) => file !== fileToRemove));
  };

  const resetSelection = () => {
    setRows([]);
    setZipFiles([]);
  };

  // Match every CSV row against the selected zip files by sanitized basename
  const matching = useMemo(() => {
    const filesByName = new Map(zipFiles.map((file) => [sanitizeZipFileName(file.name), file]));
    const matchRows = validated.rows.map((row) => {
      const wanted = sanitizeZipFileName(row.zipFileName);
      return { row, wanted, file: filesByName.get(wanted) ?? null };
    });
    const wantedNames = new Set(matchRows.map((entry) => entry.wanted));
    const unreferenced = zipFiles.filter((file) => !wantedNames.has(sanitizeZipFileName(file.name)));
    const missing = matchRows.filter((entry) => !entry.file);
    return { rows: matchRows, unreferenced, missing };
  }, [validated, zipFiles]);

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
      const result = await importImportAccounts({
        imapHost: imapHost.trim(),
        imapPort: port,
        accounts: validated.rows,
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

  const validRows = validated.rows.length;

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
          <Label>CSV File (email, username, password, zip file name)</Label>
          <CsvEditor
            columns={COLUMNS}
            rows={rows}
            onChange={setRows}
            disabled={disabled}
            downloadFileName="import-accounts.csv"
            showRequiredAlert={false}
          />
        </div>

        <div>
          <div className="flex items-center justify-between">
            <Label htmlFor="import-zip-files">Archive zips</Label>
            {zipFiles.length > 0 && (
              <button
                type="button"
                onClick={() => setZipFiles([])}
                disabled={disabled}
                className="text-xs text-neutral-500 underline hover:text-neutral-700 disabled:opacity-50"
              >
                Clear all
              </button>
            )}
          </div>
          <FilePicker
            id="import-zip-files"
            accept=".zip"
            allowDirectory
            disabled={disabled}
            title="Choose one or more zip files"
            selectedHint="Click or drop to add more — pick a same-named zip again to replace it"
            selection={
              zipFiles.length > 0
                ? `${zipFiles.length} zip file(s) selected (${formatBytes(
                    zipFiles.reduce((sum, file) => sum + file.size, 0)
                  )})`
                : null
            }
            onFiles={handleZipSelection}
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

        {validRows > 0 && (
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
                    <span className="shrink-0 flex items-center gap-1.5 text-xs text-green-700">
                      ✓ {formatBytes(entry.file.size)}
                      <button
                        type="button"
                        onClick={() => removeZipFile(entry.file!)}
                        disabled={disabled}
                        className="text-green-700/60 hover:text-red-600 disabled:opacity-50"
                        aria-label={`Remove ${entry.file.name}`}
                      >
                        <X className="size-3.5" />
                      </button>
                    </span>
                  ) : (
                    <span className="shrink-0 text-xs text-red-600">zip not in folder</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {matching.unreferenced.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-neutral-700 mb-2">
              {validRows > 0 ? "Unmatched zips" : "Selected zips"} ({matching.unreferenced.length})
            </h3>
            <ul className="divide-y divide-neutral-200 border border-neutral-200 rounded-lg max-h-48 overflow-y-auto">
              {matching.unreferenced.map((file) => (
                <li key={file.name} className="px-4 py-1.5 flex justify-between items-center gap-4 text-sm">
                  <span className="text-neutral-700 truncate">
                    {file.name} <span className="text-neutral-400">({formatBytes(file.size)})</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeZipFile(file)}
                    disabled={disabled}
                    className="shrink-0 text-neutral-400 hover:text-red-600 disabled:opacity-50"
                    aria-label={`Remove ${file.name}`}
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
            {validRows > 0 && (
              <p className="text-xs text-neutral-500 mt-1">
                Not referenced by any CSV row — these will not be uploaded.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleImport}
            loading={isImporting}
            disabled={disabled || isImporting || validRows === 0}
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
