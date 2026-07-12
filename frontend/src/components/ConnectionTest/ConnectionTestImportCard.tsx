import { useRef, useState } from "react";
import Papa from "papaparse";
import { toast } from "sonner";
import type { ConnectionTestRow } from "../../api/connectionTest";
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
  rows: ConnectionTestRow[];
  problems: string[];
  detectedColumns: 3 | 4;
}

// Accepts both credential CSV formats used elsewhere in the app and picks the
// right one automatically:
//   3 columns (migration target / archive): email, username, password
//   4 columns (migration source): email, targetEmail, username, password
// The targetEmail column is irrelevant for a login test and is ignored.
function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<string[]>(text.replace(/^﻿/, ""), {
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

  const rows: ConnectionTestRow[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  lines.forEach((line, index) => {
    const rowNumber = index + 1;

    // A row that disagrees with the detected format would have its columns
    // misread — flag it instead of testing garbage credentials
    const hasFourthCell = (line[3] ?? "").trim() !== "";
    if (detectedColumns === 3 && hasFourthCell) {
      problems.push(
        `Row ${rowNumber}: has a 4th column although the file looks like the 3-column format — row skipped`
      );
      return;
    }
    if (detectedColumns === 4 && !hasFourthCell) {
      problems.push(
        `Row ${rowNumber}: missing the 4th column although the file looks like the 4-column format — row skipped`
      );
      return;
    }

    const email = (line[0] ?? "").trim().toLowerCase();
    const username = (line[detectedColumns === 4 ? 2 : 1] ?? "").trim();
    const password = line[detectedColumns === 4 ? 3 : 2] ?? "";

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
    rows.push({ email, username, password });
  });

  return { rows, problems, detectedColumns };
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
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setFileName(file.name);
      setParsed(parseCsv(String(reader.result ?? "")));
    };
    reader.readAsText(file);
  };

  const handleStart = () => {
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
    onStart(imapHost.trim(), port, parsed.rows);
  };

  const validRows = parsed?.rows.length ?? 0;

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
          <Label htmlFor="connection-test-csv-file">CSV File</Label>
          <input
            id="connection-test-csv-file"
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
              {parsed.problems.length > 0 && `, ${parsed.problems.length} problem(s)`} — detected{" "}
              {parsed.detectedColumns === 4
                ? "4-column source format (target column ignored)"
                : "3-column format"}
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

        <Button
          onClick={handleStart}
          loading={isStarting}
          disabled={disabled || isStarting || !parsed || validRows === 0}
        >
          Test{validRows > 0 ? ` ${validRows}` : ""} connection{validRows === 1 ? "" : "s"}
        </Button>
      </CardContent>
    </Card>
  );
}
