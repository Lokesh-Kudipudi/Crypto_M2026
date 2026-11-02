import { useMemo } from "react";
import { api } from "../api";
import { STATUS } from "../certcrypto.mjs";
import { Alert, Badge, Card, PageHeader, Stat, Table, downloadCsv, formatDateTime, formatNumber, useLoad } from "../ui";
import { VerifyPanel } from "./PublicVerify";

const HISTORY_COLUMNS = [
  { key: "date", label: "Checked" },
  { key: "status", label: "Result" },
  { key: "certificate_ref", label: "Certificate ID" },
  { key: "issuer_name", label: "Issuer" },
  { key: "batch_root", label: "Batch root" },
  { key: "message", label: "Details" },
];

const useHistory = () => useLoad(async () => (await api.get("/verifications")).verifications);

export function VerifierHome() {
  const { data, reload } = useHistory();
  const rows = useMemo(() => data ?? [], [data]);
  const valid = rows.filter((r) => r.status === STATUS.VALID).length;
  return (
    <>
      <PageHeader title="Verify" description="Upload a presentation file from a student, or open a link they sent you." />
      <div className="stats">
        <Stat label="Checks made" value={formatNumber(rows.length)} />
        <Stat label="Valid" value={formatNumber(valid)} />
        <Stat label="Failed" value={formatNumber(rows.length - valid)} />
      </div>
      <VerifyPanel onVerified={reload} />
    </>
  );
}

export function VerifierHistory() {
  const { data, error } = useHistory();
  const rows = data ?? [];
  const exportHistory = () =>
    downloadCsv(
      "verification-history.csv",
      rows.map((r) => ({ ...r, date: formatDateTime(r.created_at) })),
      HISTORY_COLUMNS
    );
  return (
    <>
      <PageHeader
        title="History"
        description="Your own checks. This list is a convenience, so re-verify to get a current result."
        actions={<button type="button" id="export-history" className="button" disabled={!rows.length} onClick={exportHistory}>Export CSV</button>}
      />
      <Alert tone="error">{error}</Alert>
      <Card>
        <Table
          rows={rows}
          empty="You haven't checked any certificates yet."
          columns={[
            { label: "Checked", render: (r) => formatDateTime(r.created_at) },
            { label: "Result", render: (r) => <Badge value={r.status} label={r.status.replace("_", " ")} /> },
            { label: "Certificate ID", render: (r) => r.certificate_ref || "Not shared" },
            { label: "Issuer", render: (r) => r.issuer_name || "—" },
            { label: "Details", render: (r) => r.message },
          ]}
        />
      </Card>
    </>
  );
}
