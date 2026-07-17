import { useState } from "react";
import { Download, Plus, Trash2 } from "lucide-react";
import { FilePicker } from "./FilePicker";
import { Button } from "./Button";
import { Input } from "./Input";
import { Alert } from "./Alert";
import { Table, TableHead, TableBody, TableRow, TableHeader, TableCell } from "./Table";
import { emptyRow, missingRequiredFields, parseCsvText, rowsToCsvText, type CsvColumn, type CsvRow } from "./csvEditorUtils";

interface CsvEditorProps {
  columns: CsvColumn[];
  rows: CsvRow[];
  onChange: (rows: CsvRow[]) => void;
  disabled?: boolean;
  pickerTitle?: string;
  downloadFileName?: string;
  className?: string;
  // Overrides the default index-mapped CSV parsing for uploaded files —
  // e.g. to auto-detect between multiple accepted column layouts. The
  // "Edit as text" round-trip always uses the default column-order parsing.
  parseFile?: (text: string) => CsvRow[];
  // Set to false when the caller already surfaces its own required-field
  // messaging (e.g. as part of richer domain validation), to avoid showing
  // the same "row is missing X" complaint twice.
  showRequiredAlert?: boolean;
}

function CsvEditor({
  columns,
  rows,
  onChange,
  disabled = false,
  pickerTitle = "Choose a CSV file",
  downloadFileName = "data.csv",
  className = "",
  parseFile,
  showRequiredAlert = true,
}: CsvEditorProps) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [mode, setMode] = useState<"table" | "text">("table");
  const [text, setText] = useState(() => rowsToCsvText(rows, columns));

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setFileName(file.name);
      const raw = String(reader.result ?? "");
      const parsed = parseFile ? parseFile(raw) : parseCsvText(raw, columns);
      onChange(parsed);
      setText(rowsToCsvText(parsed, columns));
    };
    reader.readAsText(file);
  };

  const updateCell = (rowIndex: number, key: string, value: string) => {
    onChange(rows.map((row, index) => (index === rowIndex ? { ...row, [key]: value } : row)));
  };

  const removeRow = (rowIndex: number) => {
    onChange(rows.filter((_, index) => index !== rowIndex));
  };

  const addRow = () => {
    onChange([...rows, emptyRow(columns)]);
  };

  const clearAll = () => {
    setFileName(null);
    onChange([]);
    setText(rowsToCsvText([], columns));
  };

  const switchToText = () => {
    setText(rowsToCsvText(rows, columns));
    setMode("text");
  };

  const applyText = () => {
    onChange(parseCsvText(text, columns));
    setMode("table");
  };

  const handleDownload = () => {
    const blob = new Blob([rowsToCsvText(rows, columns)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = downloadFileName;
    link.click();
    URL.revokeObjectURL(url);
  };

  const problemRows = rows
    .map((row, index) => ({ index, missing: missingRequiredFields(row, columns) }))
    .filter((entry) => entry.missing.length > 0);

  return (
    <div className={`space-y-3 ${className}`}>
      <FilePicker
        accept=".csv,text/csv,text/plain"
        disabled={disabled}
        title={pickerTitle}
        selection={fileName}
        onFiles={(files) => handleFile(files[0])}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={addRow} disabled={disabled}>
          <Plus className="size-4" />
          Add row
        </Button>
        {mode === "table" ? (
          <Button variant="secondary" size="sm" onClick={switchToText} disabled={disabled}>
            Edit as text
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={applyText} disabled={disabled}>
            Apply changes
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={handleDownload}
          disabled={disabled || rows.length === 0}
        >
          <Download className="size-4" />
          Download CSV
        </Button>
        {rows.length > 0 && (
          <Button variant="ghost" size="sm" onClick={clearAll} disabled={disabled} className="ml-auto">
            Clear all
          </Button>
        )}
      </div>

      {showRequiredAlert && problemRows.length > 0 && (
        <Alert variant="warning">
          {problemRows.length} row(s) are missing required fields:{" "}
          {problemRows.map((entry) => `Row ${entry.index + 1} (${entry.missing.join(", ")})`).join("; ")}
        </Alert>
      )}

      {mode === "text" ? (
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={disabled}
          rows={Math.max(6, rows.length + 2)}
          className="block w-full px-3 py-2 rounded-md border border-neutral-300 text-sm text-neutral-900
            font-mono focus:border-blue-500 disabled:bg-neutral-50 disabled:text-neutral-500"
          placeholder={columns.map((column) => column.label).join(",")}
        />
      ) : rows.length === 0 ? (
        <div className="text-center py-8 border border-dashed border-neutral-300 rounded-lg text-sm text-neutral-500">
          No entries yet — upload a CSV or add a row manually.
        </div>
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              {columns.map((column) => (
                <TableHeader key={column.key}>
                  {column.label}
                  {column.required && <span className="text-red-500"> *</span>}
                </TableHeader>
              ))}
              <TableHeader className="w-10">
                <span className="sr-only">Actions</span>
              </TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row, rowIndex) => (
              <TableRow key={rowIndex}>
                {columns.map((column) => (
                  <TableCell key={column.key} className="py-1.5">
                    <Input
                      value={row[column.key] ?? ""}
                      placeholder={column.placeholder}
                      disabled={disabled}
                      error={Boolean(column.required && !row[column.key]?.trim())}
                      onChange={(event) => updateCell(rowIndex, column.key, event.target.value)}
                      className="py-1"
                    />
                  </TableCell>
                ))}
                <TableCell className="py-1.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={disabled}
                    onClick={() => removeRow(rowIndex)}
                    aria-label={`Remove row ${rowIndex + 1}`}
                  >
                    <Trash2 className="size-4 text-neutral-400" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export { CsvEditor, type CsvEditorProps };
export { type CsvColumn, type CsvRow } from "./csvEditorUtils";
