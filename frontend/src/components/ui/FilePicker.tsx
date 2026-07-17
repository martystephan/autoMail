import { useRef, useState, type DragEvent } from "react";
import { FileCheck2, FolderOpen, UploadCloud } from "lucide-react";

interface FilePickerProps {
  id?: string;
  // e.g. ".csv,text/csv" — forwarded to the native input; dropped files are
  // not filtered here, callers validate what they receive
  accept?: string;
  multiple?: boolean;
  // Folder-only picker (webkitdirectory) — clicking always opens the OS
  // folder dialog. Dropped folders are walked recursively either way.
  directory?: boolean;
  // Universal mode: clicking opens the normal (multi-)file dialog, plus a
  // small secondary control opens the OS folder dialog. Drag & drop already
  // accepts loose files and folders together, so this brings click-to-browse
  // to parity. Ignored when `directory` is set.
  allowDirectory?: boolean;
  disabled?: boolean;
  // Main line while nothing is selected, e.g. "Choose a CSV file"
  title: string;
  // Secondary line while nothing is selected (defaults to a drag & drop hint)
  hint?: string;
  // Secondary line once something is selected (defaults to "Click or drop to
  // replace"). Override when picking again adds to the selection instead —
  // e.g. a multi-file picker whose caller merges new picks with the old ones.
  selectedHint?: string;
  // Summary of the current selection, e.g. "accounts.csv" or "12 zips (3.4 GB)".
  // null/undefined shows the empty state.
  selection?: string | null;
  onFiles: (files: File[]) => void;
}

// Recursively collect the files of a dropped directory tree. webkitGetAsEntry
// is non-standard but supported by every current browser; when it is missing
// the plain dataTransfer.files (no folders) are used instead.
async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry != null);

  if (entries.length === 0) {
    return Array.from(dataTransfer.files ?? []);
  }

  const files: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null))
      );
      if (file) files.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns batches (Chromium: 100 at a time) until empty
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve) =>
          reader.readEntries(resolve, () => resolve([]))
        );
        if (batch.length === 0) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  for (const entry of entries) await walk(entry);
  return files;
}

export default function FilePicker({
  id,
  accept,
  multiple = false,
  directory = false,
  allowDirectory = false,
  disabled = false,
  title,
  hint,
  selectedHint,
  selection,
  onFiles,
}: FilePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const hasSelection = selection != null && selection !== "";
  const EmptyIcon = directory ? FolderOpen : UploadCloud;
  const effectiveMultiple = multiple || directory || allowDirectory;

  const emitFiles = (files: File[]) => {
    if (files.length > 0) onFiles(effectiveMultiple ? files : files.slice(0, 1));
  };

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    setIsDragOver(false);
    if (disabled) return;
    emitFiles(await filesFromDataTransfer(event.dataTransfer));
  };

  const showFolderControl = allowDirectory && !directory;

  return (
    <div className="space-y-1">
      <button
        type="button"
        id={id}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        className={`
          w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-dashed
          text-left transition-colors
          focus:outline-none focus-visible:border-blue-500
          disabled:opacity-50 disabled:cursor-not-allowed
          ${
            isDragOver
              ? "border-blue-400 bg-blue-50"
              : hasSelection
                ? "border-green-300 bg-green-50 hover:bg-green-100"
                : "border-neutral-300 bg-neutral-50 hover:bg-neutral-100 hover:border-neutral-400"
          }
        `}
      >
        {hasSelection ? (
          <FileCheck2 className="size-5 shrink-0 text-green-600" />
        ) : (
          <EmptyIcon className={`size-5 shrink-0 ${isDragOver ? "text-blue-500" : "text-neutral-400"}`} />
        )}
        <span className="min-w-0">
          <span
            className={`block text-sm font-medium truncate ${
              hasSelection ? "text-green-800" : "text-neutral-700"
            }`}
          >
            {hasSelection ? selection : title}
          </span>
          <span className={`block text-xs ${hasSelection ? "text-green-700/70" : "text-neutral-500"}`}>
            {hasSelection
              ? (selectedHint ?? "Click or drop to replace")
              : (hint ??
                  (directory
                    ? "Click to browse or drag & drop a folder here"
                    : allowDirectory
                      ? "Click to browse files, or drag & drop files or a folder here"
                      : "Click to browse or drag & drop here"))}
          </span>
        </span>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={effectiveMultiple}
          // Non-standard folder picker attribute, missing from React's types
          {...(directory ? ({ webkitdirectory: "" } as Record<string, string>) : {})}
          className="hidden"
          tabIndex={-1}
          onChange={(event) => {
            emitFiles(Array.from(event.target.files ?? []));
            // Allow re-selecting the same file/folder to fire another change
            event.target.value = "";
          }}
        />
      </button>
      {showFolderControl && (
        <div className="text-right">
          <button
            type="button"
            disabled={disabled}
            onClick={() => dirInputRef.current?.click()}
            className="text-xs text-neutral-500 underline hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            or choose a folder instead
          </button>
          <input
            ref={dirInputRef}
            type="file"
            multiple
            accept={accept}
            // Non-standard folder picker attribute, missing from React's types
            {...({ webkitdirectory: "" } as Record<string, string>)}
            className="hidden"
            tabIndex={-1}
            onChange={(event) => {
              emitFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
        </div>
      )}
    </div>
  );
}

export { FilePicker, type FilePickerProps };
