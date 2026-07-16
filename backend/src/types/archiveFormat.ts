// On-disk format of the archive zips (format v1). The export writes these
// files alongside the .eml messages so an archive can later be imported with
// full fidelity; the import feature refuses zips without a manifest.

// Root of the zip: describes every archived folder
export const ARCHIVE_MANIFEST_NAME = 'automail-archive.json';
// Inside each folder directory: one JSON line per saved message
export const FOLDER_MESSAGES_NAME = '.automail-messages.jsonl';

export const ARCHIVE_MANIFEST_FORMAT = 'automail-archive';
export const ARCHIVE_MANIFEST_VERSION = 1;

export interface ArchiveManifestFolder {
  // '/'-joined sanitized directory path inside the zip
  zipPath: string;
  // Exact path on the source server (unsanitized, original delimiter)
  originalPath: string;
  name: string;
  delimiter: string;
  specialUse?: string;
  // Only set when the source server actually advertised the special-use flag
  flaggedSpecialUse?: string;
  messageCount: number;
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_MANIFEST_FORMAT;
  version: number;
  email: string;
  exportedAt: string;
  folders: ArchiveManifestFolder[];
}

export interface ArchiveMessageMeta {
  // .eml file name within the folder directory
  file: string;
  uid: number;
  // IMAP flags at export time, \Recent already stripped
  flags: string[];
  // ISO timestamp; missing when the server returned no INTERNALDATE
  internalDate?: string;
  messageId?: string;
  // MIME-decoded subject — needed for the dedupe fingerprint fallback when a
  // message has no Message-ID
  subject?: string;
}
