import ImportPanel from "../components/Import/ImportPanel";
import { PageHeader } from "../components/ui/PageHeader";

export default function ImportPage() {
  return (
    <div>
      <PageHeader
        title="Import"
        description="Restore archive zips into mail accounts — folders, messages, flags and dates."
      />
      <ImportPanel />
    </div>
  );
}
