import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { STATUS, verifyPresentation } from "../certcrypto.mjs";
import { readReader } from "../chain";
import { catBytes } from "../ipfs.mjs";
import { Alert, Card, Field, formatDate } from "../ui";

export const FIELD_LABELS = {
  certificateId: "Certificate ID",
  uid: "UID",
  candidateName: "Candidate name",
  courseName: "Course name",
  organizationName: "Organization",
  cgpa: "CGPA",
  completionYear: "Completion year",
  pdfSha256: "PDF SHA-256",
  pdfCid: "Encrypted PDF CID",
};

const RESULT = {
  [STATUS.VALID]: { title: "Valid certificate", tone: "good" },
  [STATUS.TAMPERED]: { title: "Tampered", tone: "bad" },
  [STATUS.REVOKED]: { title: "Revoked", tone: "bad" },
  [STATUS.UNKNOWN_ISSUER]: { title: "Unknown issuer", tone: "bad" },
  [STATUS.NOT_ANCHORED]: { title: "Not on this registry", tone: "bad" },
};

export function VerifyResult({ result }) {
  const { title, tone } = RESULT[result.status];
  return (
    <div id="verify-result" className={`result ${tone}`}>
      <div className="result-title">{title}</div>
      <p>{result.message}</p>
      {result.publishedAt > 0 && <p className="small">Published on-chain on {formatDate(result.publishedAt)}.</p>}
      {Object.keys(result.disclosed).length > 0 && (
        <dl className="details-list">
          {Object.entries(result.disclosed).map(([key, value]) => (
            <div key={key}>
              <dt>{FIELD_LABELS[key]}</dt>
              <dd className="break">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function VerifyPanel({ token, onVerified }) {
  const { config, user } = useAuth();
  const [presentation, setPresentation] = useState(null);
  const [pdf, setPdf] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const loadedToken = useRef(null);

  const run = useCallback(async (toCheck, pdfFile) => {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const next = await verifyPresentation(toCheck, readReader(config), {
        chainId: config.chainId,
        address: config.registry,
        pdfBytes: pdfFile ? new Uint8Array(await pdfFile.arrayBuffer()) : undefined,
        fetchCiphertext: catBytes,
      });
      setResult(next);
      if (user) {
        await api.post("/verifications", {
          status: next.status,
          certificateRef: next.disclosed.certificateId,
          issuerName: next.issuer,
          batchRoot: toCheck.batchRoot,
          message: next.message,
        }).catch(() => {});
        if (onVerified) onVerified();
      }
    } catch (e) {
      console.error("Error verifying certificate:", e);
      setError(`Couldn't finish checking: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [config, user, onVerified]);

  useEffect(() => {
    // React's dev mode runs effects twice, which would count each view twice
    if (!token || loadedToken.current === token) return;
    loadedToken.current = token;
    api.get(`/share/${encodeURIComponent(token)}`)
      .then(({ presentation: shared }) => {
        setPresentation(shared);
        return run(shared);
      })
      .catch((e) => setError(e.message));
    // Only runs when the link changes, not on every new callback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const chooseFile = async (file) => {
    setPresentation(null);
    setResult(null);
    setError("");
    if (!file) return;
    try {
      setPresentation(JSON.parse(await file.text()));
    } catch (e) {
      setError("This file isn't a valid presentation.");
    }
  };

  return (
    <Card title="Verify a certificate" description="Checks the issuer's signature, the Merkle proofs, the on-chain record and revocation. Free, with no wallet needed.">
      <Alert tone="error" id="verify-error">{error}</Alert>
      {!token && (
        <Field label="Presentation file">
          <input id="presentation-input" type="file" accept="application/json,.json" onChange={(e) => chooseFile(e.target.files[0])} />
        </Field>
      )}
      <Field label="PDF to check (optional)" hint="Compared with the hash the issuer signed. The student must have shared that hash.">
        <input id="verify-pdf" type="file" accept="application/pdf" onChange={(e) => setPdf(e.target.files[0] || null)} />
      </Field>
      <button type="button" id="verify-button" className="button primary" disabled={!presentation || busy} onClick={() => run(presentation, pdf)}>
        {busy ? "Checking…" : "Verify"}
      </button>
      {result && <VerifyResult result={result} />}
    </Card>
  );
}

export default function PublicVerify() {
  const { token } = useParams();
  const { user } = useAuth();
  return (
    <div className="public-page">
      <header className="landing-header">
        <Link to="/" className="brand dark">CertChain</Link>
        {!user && <Link className="button" to="/login">Log in</Link>}
      </header>
      <div className="narrow">
        <VerifyPanel token={token} />
      </div>
    </div>
  );
}
