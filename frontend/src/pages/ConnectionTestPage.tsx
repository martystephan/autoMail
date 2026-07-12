import ConnectionTestPanel from "../components/ConnectionTest/ConnectionTestPanel";
import { PageHeader } from "../components/ui/PageHeader";

export default function ConnectionTestPage() {
  return (
    <div>
      <PageHeader
        title="Connection Test"
        description="Upload a credentials CSV and verify every IMAP login. Nothing is read or changed in the mailboxes."
      />
      <ConnectionTestPanel />
    </div>
  );
}
