import { useMemo, useState } from "react";
import Papa from "papaparse";
import { toast } from "sonner";
import type { ConnectionTestRow } from "../../api/connectionTest";
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

// Accepts both credential CSV formats used elsewhere in the app and picks the
// right one automatically:
//   3 columns (migration target / archive): email, username, password
//   4 columns (migration source): email, targetEmail, username, password
// The targetEmail column is irrelevant for a login test, so either format
// collapses to the same 3-field CsvRow shape the table below edits.
function parseCredentialsFile(text: string): CsvRow[] {
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), {
    skipEmptyLines: "greedy",
  });

  let lines = result.data;
  let headerCells: string[] | null = null;
  if (lines.length > 0 && /e-?mail/i.test(lines[0][0] ?? "")) {
    headerCells = lines[0];
    lines = lines.slice(1);
  }

  // A "target" header names the 4-column source format outright; otherwise
  // go by the majority of rows having a non-empty 4th cell, so a stray
  // trailing comma on one line doesn't flip the format.
  let detectedColumns: 3 | 4;
  if (headerCells?.some((cell) => /target/i.test(cell ?? ""))) {
    detectedColumns = 4;
  } else {
    const rowsWithFourthCell = lines.filter((line) => (line[3] ?? "").trim() !== "").length;
    detectedColumns = rowsWithFourthCell >= Math.ceil(lines.length / 2) && lines.length > 0 ? 4 : 3;
  }

  return lines.map((line) => ({
    email: (line[0] ?? "").trim(),
    username: (line[detectedColumns === 4 ? 2 : 1] ?? "").trim(),
    password: line[detectedColumns === 4 ? 3 : 2] ?? "",
  }));
}

interface Validated {
  rows: ConnectionTestRow[];
  problems: string[];
}

function validateRows(rows: CsvRow[]): Validated {
  const validRows: ConnectionTestRow[] = [];
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
    // Duplicates are only a note — every physical row still gets its own test
    if (seen.has(email)) {
      problems.push(`Row ${rowNumber}: duplicate email ${email} — it will be tested again`);
    }
    seen.add(email);
    validRows.push({ email, username, password });
  });

  return { rows: validRows, problems };
}

interface ConnectionTestImportCardProps {
  disabled: boolean;
  isStarting: boolean;
  onStart: (imapHost: string, imapPort: number, rows: ConnectionTestRow[]) => void;
}

export default function ConnectionTestImportCard({
  disabled,
  isStarting,
  onStart,
}: ConnectionTestImportCardProps) {
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [rows, setRows] = useState<CsvRow[]>([]);

  const validated = useMemo(() => validateRows(rows), [rows]);

  const handleStart = () => {
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
    onStart(imapHost.trim(), port, validated.rows);
  };

  const validRows = validated.rows.length;

  return (
    <Card>
      <CardHeader className="border-b border-neutral-200">
        <CardTitle>Credentials to Test</CardTitle>
        <CardDescription>
          Accepts both CSV formats: email, username, password (target/archive) and email, target,
          username, password (migration source) — the format is detected automatically. All
          accounts must be on the same IMAP server.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <Label htmlFor="connection-test-imap-host">IMAP Host</Label>
            <Input
              id="connection-test-imap-host"
              placeholder="imap.example.com"
              value={imapHost}
              onChange={(e) => setImapHost(e.target.value)}
              disabled={disabled}
            />
          </div>
          <div>
            <Label htmlFor="connection-test-imap-port">Port</Label>
            <Input
              id="connection-test-imap-port"
              type="number"
              value={imapPort}
              onChange={(e) => setImapPort(e.target.value)}
              disabled={disabled}
            />
          </div>
        </div>

        <div>
          <Label>CSV File</Label>
          <CsvEditor
            columns={COLUMNS}
            rows={rows}
            onChange={setRows}
            disabled={disabled}
            parseFile={parseCredentialsFile}
            downloadFileName="connection-test-credentials.csv"
            showRequiredAlert={false}
          />
        </div>

        {rows.length > 0 && (
          <Alert variant={validated.problems.length > 0 ? "warning" : "info"}>
            {validRows} of {rows.length} row(s) ready to test
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

        <Button
          onClick={handleStart}
          loading={isStarting}
          disabled={disabled || isStarting || validRows === 0}
        >
          Test{validRows > 0 ? ` ${validRows}` : ""} connection{validRows === 1 ? "" : "s"}
        </Button>
      </CardContent>
    </Card>
  );
}
