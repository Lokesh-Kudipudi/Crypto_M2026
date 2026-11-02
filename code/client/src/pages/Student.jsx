import { useEffect, useState } from "react";
import { api } from "../api";
import { CERT_FIELDS, PDF_FIELDS, createPresentation, decryptPdf } from "../certcrypto.mjs";
import { catBytes } from "../ipfs.mjs";
import {
  Alert, Badge, Card, CopyButton, Field, PageHeader, Stat, Table,
  downloadBlob, downloadCsv, downloadJson, formatDate, formatNumber, safeName, useLoad,
} from "../ui";
import { FIELD_LABELS } from "./PublicVerify";

const DISCLOSABLE = CERT_FIELDS.filter((name) => !PDF_FIELDS.includes(name));
const shareUrl = (token) => `${window.location.origin}/verify/${token}`;

function SharePanel({ credential, certificateRowId }) {
  const [chosen, setChosen] = useState({ certificateId: true });
  const [includePdf, setIncludePdf] = useState(false);
  const [days, setDays] = useState(30);
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const id = credential.fields.certificateId.value;
  const names = DISCLOSABLE.filter((name) => chosen[name]);

  const build = () => createPresentation(credential, names, { includePdf });

  const downloadPresentation = () => {
    setError("");
    try {
      downloadJson(`presentation-${safeName(id)}.json`, build());
    } catch (e) {
      setError(e.message);
    }
  };

  const createLink = async () => {
    setError("");
    setLink("");
    try {
      const { token } = await api.post(`/student/certificates/${certificateRowId}/shares`, {
        presentation: build(),
        expiresInDays: Number(days),
      });
      setLink(shareUrl(token));
    } catch (e) {
      setError(e.message);
    }
  };

  const openPdf = async () => {
    setBusy(true);
    setError("");
    try {
      const bytes = await decryptPdf(await catBytes(credential.fields.pdfCid.value), credential.pdfKey);
      downloadBlob(`certificate-${safeName(id)}.pdf`, new Blob([bytes], { type: "application/pdf" }));
    } catch (e) {
      setError(`Couldn't get your PDF: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="share-panel" className="share-panel">
      <Alert tone="error">{error}</Alert>
      <h3>Choose what to reveal</h3>
      <div className="check-list">
        {DISCLOSABLE.map((name) => (
          <label key={name} className="check">
            <input
              type="checkbox"
              name={name}
              checked={!!chosen[name]}
              onChange={(e) => setChosen((prev) => ({ ...prev, [name]: e.target.checked }))}
            />
            <span><span className="muted">{FIELD_LABELS[name]}:</span> {credential.fields[name].value}</span>
          </label>
        ))}
        <label className="check">
          <input type="checkbox" id="include-pdf" checked={includePdf} onChange={(e) => setIncludePdf(e.target.checked)} />
          <span>Include the PDF <span className="muted">(reveals everything printed in it)</span></span>
        </label>
      </div>
      <div className="row wrap align-end">
        {certificateRowId && (
          <>
            <Field label="Link expires after">
              <select id="share-days" value={days} onChange={(e) => setDays(e.target.value)}>
                <option value={1}>1 day</option>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
                <option value={365}>1 year</option>
              </select>
            </Field>
            <button type="button" id="create-link" className="button primary" onClick={createLink}>Create share link</button>
          </>
        )}
        <button type="button" id="download-presentation" className="button" onClick={downloadPresentation}>Download presentation</button>
        <button type="button" id="download-credential" className="button" onClick={() => downloadJson(`credential-${safeName(id)}.json`, credential)}>Export credential</button>
        <button type="button" className="button" disabled={busy} onClick={openPdf}>{busy ? "Decrypting…" : "Download my PDF"}</button>
      </div>
      {link && (
        <div id="share-link" className="alert success">
          <p><strong>Copy this link now.</strong> It won't be shown again.</p>
          <div className="row wrap"><code className="break">{link}</code><CopyButton text={link} /></div>
        </div>
      )}
      <p className="muted small">Your credential file holds your PDF key and every hidden value, so keep it private. Presentations are safe to share.</p>
    </div>
  );
}

function CertificateRow({ certificate }) {
  const [open, setOpen] = useState(false);
  const [credential, setCredential] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || credential) return;
    api.get(`/student/certificates/${certificate.id}/credential`)
      .then((r) => setCredential(r.credential))
      .catch((e) => setError(e.message));
  }, [open, credential, certificate.id]);

  return (
    <div className="list-item">
      <div className="list-item-main">
        <div>
          <div className="list-item-title">{certificate.course_name}</div>
          <div className="muted small">
            {certificate.issuer} · {certificate.certificate_id} · {certificate.completion_year}
          </div>
          {certificate.revoked_reason && <div className="small bad-text">Revoked: {certificate.revoked_reason}</div>}
        </div>
        <div className="row">
          <Badge value={certificate.status} />
          <button type="button" className="button small" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Close" : "Share"}
          </button>
        </div>
      </div>
      <Alert tone="error">{error}</Alert>
      {open && credential && <SharePanel credential={credential} certificateRowId={certificate.id} />}
    </div>
  );
}

export function StudentCertificates() {
  const { data, error, reload } = useLoad(async () => (await api.get("/student/certificates")).certificates);
  const [code, setCode] = useState("");
  const [claimError, setClaimError] = useState("");
  const [claimed, setClaimed] = useState("");
  const [imported, setImported] = useState(null);
  const [importError, setImportError] = useState("");
  const rows = data ?? [];

  const claim = async (e) => {
    e.preventDefault();
    setClaimError("");
    setClaimed("");
    try {
      const { certificateId } = await api.post("/student/claim", { code });
      setClaimed(`Added certificate ${certificateId}.`);
      setCode("");
      reload();
    } catch (err) {
      setClaimError(err.message);
    }
  };

  const importCredential = async (file) => {
    setImported(null);
    setImportError("");
    if (!file) return;
    try {
      const credential = JSON.parse(await file.text());
      if (!credential.fields || !credential.certRoot) throw new Error();
      setImported(credential);
    } catch {
      setImportError("This file isn't a valid credential.");
    }
  };

  return (
    <>
      <PageHeader title="My certificates" description="Claim certificates from your university, then share only what's needed." />
      <div className="stats">
        <Stat label="Certificates" value={formatNumber(rows.length)} />
        <Stat label="Active" value={formatNumber(rows.filter((r) => r.status === "active").length)} />
      </div>
      <Card title="Claim a certificate" description="Enter the code your university gave you.">
        <form id="claim-form" className="row wrap align-end" onSubmit={claim}>
          <Field label="Claim code">
            <input id="claim-code" value={code} required placeholder="XXXXX-XXXXX-XXXXX-XXXXX" onChange={(e) => setCode(e.target.value)} />
          </Field>
          <button type="submit" className="button primary">Claim</button>
        </form>
        <Alert tone="error" id="claim-error">{claimError}</Alert>
        <Alert tone="success" id="claim-success">{claimed}</Alert>
      </Card>
      <Card title="Your certificates">
        <Alert tone="error">{error}</Alert>
        {rows.length ? (
          <div id="student-certificates">
            {rows.map((c) => <CertificateRow key={c.id} certificate={c} />)}
          </div>
        ) : (
          <p className="empty">No certificates yet. Claim one above.</p>
        )}
      </Card>
      <Card title="Use a credential file" description="Create a presentation from a file. It stays in your browser and isn't uploaded.">
        <Field label="Credential file">
          <input id="credential-input" type="file" accept="application/json,.json" onChange={(e) => importCredential(e.target.files[0])} />
        </Field>
        <Alert tone="error">{importError}</Alert>
        {imported && <SharePanel credential={imported} />}
      </Card>
    </>
  );
}

const linkState = (s) => {
  if (s.revoked_at) return "revoked";
  return s.expires_at * 1000 < Date.now() ? "expired" : "active";
};

export function StudentLinks() {
  const { data, error, reload } = useLoad(async () => (await api.get("/student/shares")).shares);
  const [actionError, setActionError] = useState("");
  const rows = data ?? [];

  const revoke = async (id) => {
    setActionError("");
    try {
      await api.del(`/student/shares/${id}`);
      reload();
    } catch (e) {
      setActionError(e.message);
    }
  };

  const exportLinks = () =>
    downloadCsv(
      "share-links.csv",
      rows.map((s) => ({
        ...s,
        state: linkState(s),
        fieldNames: s.fields.map((f) => FIELD_LABELS[f]).join("; "),
        created: formatDate(s.created_at),
        expires: formatDate(s.expires_at),
      })),
      [
        { key: "certificate_id", label: "Certificate ID" },
        { key: "fieldNames", label: "Fields shared" },
        { key: "views", label: "Views" },
        { key: "state", label: "Status" },
        { key: "created", label: "Created" },
        { key: "expires", label: "Expires" },
      ]
    );

  return (
    <>
      <PageHeader
        title="Share links"
        description="See who can still open your certificates, and turn off a link at any time."
        actions={<button type="button" id="export-links" className="button" disabled={!rows.length} onClick={exportLinks}>Export CSV</button>}
      />
      <Alert tone="error">{error || actionError}</Alert>
      <Card>
        <Table
          rows={rows}
          empty="You haven't created any links yet."
          columns={[
            { label: "Certificate", render: (s) => s.certificate_id },
            { label: "Fields shared", render: (s) => s.fields.map((f) => FIELD_LABELS[f]).join(", ") },
            { label: "Views", numeric: true, render: (s) => formatNumber(s.views) },
            { label: "Expires", render: (s) => formatDate(s.expires_at) },
            { label: "Status", render: (s) => <Badge value={linkState(s)} /> },
            {
              label: "Action",
              render: (s) => linkState(s) === "active" && (
                <button type="button" className="button small danger" onClick={() => revoke(s.id)}>Turn off</button>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}
