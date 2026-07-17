import Papa from "papaparse";

interface CsvColumn {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
}

type CsvRow = Record<string, string>;

function emptyRow(columns: CsvColumn[]): CsvRow {
  return Object.fromEntries(columns.map((column) => [column.key, ""]));
}

// A leading row is treated as a header (and dropped) when its first cell
// looks like an email column header ("email", "E-Mail", ...) — every CSV
// format in this app starts with an email column, so this single sniff
// covers them all regardless of how many columns follow.
function isHeaderRow(line: string[]): boolean {
  return /e-?mail/i.test(line[0] ?? "");
}

function parseCsvText(text: string, columns: CsvColumn[]): CsvRow[] {
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), {
    skipEmptyLines: "greedy",
  });
  let lines = result.data;
  if (lines.length > 0 && isHeaderRow(lines[0])) {
    lines = lines.slice(1);
  }
  return lines.map((line) =>
    Object.fromEntries(columns.map((column, index) => [column.key, (line[index] ?? "").trim()]))
  );
}

function rowsToCsvText(rows: CsvRow[], columns: CsvColumn[]): string {
  return Papa.unparse({
    fields: columns.map((column) => column.label),
    data: rows.map((row) => columns.map((column) => row[column.key] ?? "")),
  });
}

function missingRequiredFields(row: CsvRow, columns: CsvColumn[]): string[] {
  return columns.filter((column) => column.required && !row[column.key]?.trim()).map((c) => c.label);
}

export { emptyRow, isHeaderRow, parseCsvText, rowsToCsvText, missingRequiredFields, type CsvColumn, type CsvRow };
