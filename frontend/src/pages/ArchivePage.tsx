import ArchivePanel from "../components/Archive/ArchivePanel";
import { PageHeader } from "../components/ui/PageHeader";

export default function ArchivePage() {
  return (
    <div>
      <PageHeader
        title="Archive"
        description="Export whole mailboxes as .eml files, zipped per account. Read-only — the accounts are not changed."
      />
      <ArchivePanel />
    </div>
  );
}
