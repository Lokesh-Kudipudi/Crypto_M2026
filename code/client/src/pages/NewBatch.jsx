import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import {
  batchTypedData, buildBatch, buildCertificate, buildCredentials, encryptPdf, sha256Hex,
} from "../certcrypto.mjs";
import { chainError, connectWallet, readBaseline, signTypedData } from "../chain";
import { DEFAULT_ETH_USD, DEFAULT_GAS_PRICE_GWEI, GAS, compareIssuing, gasToEth, gasToUsd } from "../cost.mjs";
import { parseCsv, toCsv } from "../csv.mjs";
import { uploadToIpfs } from "../ipfs.mjs";
import {
  Alert, Badge, Card, Field, PageHeader, Stat, Table,
  downloadBlob, downloadCsv, downloadJson, formatEth, formatNumber, formatUsd,
} from "../ui";

const FIELDS = [
  { key: "certificateId", label: "Certificate ID" },
  { key: "uid", label: "UID" },
  { key: "candidateName", label: "Candidate name" },
  { key: "courseName", label: "Course name" },
  { key: "cgpa", label: "CGPA" },
  { key: "completionYear", label: "Completion year" },
];
const EMPTY = Object.fromEntries(FIELDS.map(({ key }) => [key, ""]));
const CSV_COLUMNS = [...FIELDS.map((f) => f.key), "pdfFile"];
const ESTIMATE_SAMPLE = 20;
// Same length as a real CID, so the estimate reflects real calldata and storage
const SAMPLE_CID = "Qm" + "x".repeat(44);

function downloadTemplate() {
  const example = {
    certificateId: "CERT-2026-0001", uid: "22CS1001", candidateName: "Asha Rao", courseName: "B.Tech Computer Science",
    cgpa: "8.50", completionYear: "2026", pdfFile: "asha-rao.pdf",
  };
  const text = toCsv([example], CSV_COLUMNS.map((c) => ({ key: c, label: c })));
  downloadBlob("certificates-template.csv", new Blob([text], { type: "text/csv" }));
}

function rowProblems(row, rows, index) {
  const problems = [];
  for (const { key, label } of FIELDS) if (!row.values[key]) problems.push(`${label} is missing`);
  const year = Number(row.values.completionYear);
  if (row.values.completionYear && (!Number.isInteger(year) || year < 1900 || year > 2100)) problems.push("Year isn't valid");
  if (rows.findIndex((r) => r.values.certificateId === row.values.certificateId) !== index) problems.push("Duplicate ID in this batch");
  if (!row.pdf) problems.push(row.pdfName ? `PDF "${row.pdfName}" not selected` : "PDF is missing");
  return problems;
}

/** Live estimate of the paper's generateCertificate, sampled from the real rows. */
function useBaselineEstimate(config, organization, rows) {
  const [perCertificate, setPerCertificate] = useState(GAS.baselinePerCertificate);
  const sample = useMemo(() => rows.slice(0, ESTIMATE_SAMPLE).map((r) => r.values), [rows]);

  useEffect(() => {
    let current = true;
    const contract = readBaseline(config);
    if (!contract || !sample.length) return undefined;
    Promise.all(
      sample.map((v) =>
        contract.methods
          .generateCertificate(v.certificateId, v.uid, v.candidateName, v.courseName, organization, SAMPLE_CID, v.cgpa, Number(v.completionYear) || 0)
          .estimateGas()
      )
    )
      .then((gas) => { if (current) setPerCertificate(Math.round(gas.reduce((a, b) => a + b, 0) / gas.length)); })
      .catch(() => { if (current) setPerCertificate(GAS.baselinePerCertificate); });
    return () => { current = false; };
  }, [config, organization, sample]);

  return perCertificate;
}

function CostCard({ rows, baselinePerCertificate, gasPrice, setGasPrice, ethUsd, setEthUsd }) {
  const totalBytes = rows.reduce((sum, r) => sum + (r.pdf?.size ?? 0), 0);
  const { registryGas, baselineGas, savedPercent } = compareIssuing({ certificates: rows.length, batchSize: rows.length, baselinePerCertificate });
  const price = Number(gasPrice) || 0;
  const usd = Number(ethUsd) || 0;
  return (
    <Card title="Cost estimate" description="Gas is measured from the contract. The prices below are examples, not live rates, so change them to match the network you're comparing with.">
      <div className="row wrap">
        <Field label="Gas price (gwei)">
          <input id="gas-price" type="number" min="0" step="any" value={gasPrice} onChange={(e) => setGasPrice(e.target.value)} />
        </Field>
        <Field label="ETH price (USD)">
          <input id="eth-price" type="number" min="0" step="any" value={ethUsd} onChange={(e) => setEthUsd(e.target.value)} />
        </Field>
      </div>
      <div className="stats" id="cost-stats">
        <Stat label="This batch" value={`${formatNumber(registryGas)} gas`} note={`${formatEth(gasToEth(registryGas, price))} · ${formatUsd(gasToUsd(registryGas, price, usd))}`} />
        <Stat label="Paper's contract" value={`${formatNumber(baselineGas)} gas`} note={`${formatEth(gasToEth(baselineGas, price))} · ${formatUsd(gasToUsd(baselineGas, price, usd))}`} />
        <Stat label="Gas saved" value={`${savedPercent.toFixed(1)}%`} note={`${rows.length} certificate(s) in 1 transaction`} />
        <Stat label="Stored on IPFS" value={`${(totalBytes / 1024).toFixed(1)} KB`} note="Encrypted, plus a small overhead" />
      </div>
      <p className="muted small">On your local Ganache chain this uses free test ETH. Verifying is free on any network, as it sends no transaction.</p>
    </Card>
  );
}

export default function NewBatch() {
  const { user, config } = useAuth();
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [formPdf, setFormPdf] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [gasPrice, setGasPrice] = useState(DEFAULT_GAS_PRICE_GWEI);
  const [ethUsd, setEthUsd] = useState(DEFAULT_ETH_USD);
  const formPdfInput = useRef(null);

  const baselinePerCertificate = useBaselineEstimate(config, user.organization, rows);
  const checked = rows.map((row, i) => ({ ...row, problems: rowProblems(row, rows, i) }));
  const problemCount = checked.filter((r) => r.problems.length).length;

  const addManual = (e) => {
    e.preventDefault();
    const values = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim()]));
    setRows((prev) => [...prev, { values, pdf: formPdf, pdfName: formPdf?.name ?? "" }]);
    setForm(EMPTY);
    setFormPdf(null);
    if (formPdfInput.current) formPdfInput.current.value = "";
    setError("");
  };

  const importCsv = async (file) => {
    setError("");
    setNotice("");
    if (!file) return;
    try {
      const parsed = parseCsv(await file.text());
      if (!parsed.length) throw new Error("This CSV has no rows.");
      const missing = FIELDS.map((f) => f.key).filter((k) => !(k in parsed[0]));
      if (missing.length) throw new Error(`This CSV is missing columns: ${missing.join(", ")}.`);
      setRows((prev) => [
        ...prev,
        ...parsed.map((r) => ({
          values: Object.fromEntries(FIELDS.map(({ key }) => [key, r[key] ?? ""])),
          pdf: null,
          pdfName: r.pdfFile ?? "",
        })),
      ]);
      setNotice(`Imported ${parsed.length} row(s). Now select their PDFs.`);
    } catch (e) {
      setError(e.message);
    }
  };

  const matchPdfs = (files) => {
    const byName = new Map([...files].map((f) => [f.name, f]));
    const next = rows.map((row) => (byName.has(row.pdfName) ? { ...row, pdf: byName.get(row.pdfName) } : row));
    setRows(next);
    setNotice(`${next.filter((r) => r.pdf).length} of ${next.length} row(s) now have a PDF.`);
  };

  const setRowPdf = (index, pdf) => setRows((prev) => prev.map((r, i) => (i === index ? { ...r, pdf, pdfName: pdf?.name ?? r.pdfName } : r)));
  const removeRow = (index) => setRows((prev) => prev.filter((_, i) => i !== index));

  const issue = async () => {
    if (busy) return;
    if (problemCount) return setError(`Fix the ${problemCount} row(s) with problems first.`);
    setBusy(true);
    setError("");
    setNotice("");
    let draftRoot = null;
    let published = false;
    try {
      setProgress("Connecting to MetaMask…");
      const { web3, account, registry } = await connectWallet(config);
      if (account.toLowerCase() !== user.wallet?.toLowerCase()) {
        throw new Error(`MetaMask is using ${account}, but your account is linked to ${user.wallet}. Switch accounts in MetaMask.`);
      }

      const certs = [];
      let storedBytes = 0;
      for (const [i, { values, pdf }] of rows.entries()) {
        setProgress(`Encrypting and uploading PDF ${i + 1} of ${rows.length}…`);
        const bytes = new Uint8Array(await pdf.arrayBuffer());
        const { ciphertext, key } = await encryptPdf(bytes);
        storedBytes += ciphertext.length;
        const pdfCid = await uploadToIpfs(new File([ciphertext], "certificate.enc"));
        const cert = buildCertificate({
          ...values,
          organizationName: user.organization,
          pdfSha256: await sha256Hex(bytes),
          pdfCid,
        });
        certs.push({ ...cert, pdfKey: key });
      }

      const chainId = Number(await web3.eth.getChainId());
      const { batchRoot, count } = buildBatch(certs.map((c) => c.certRoot));

      setProgress("Sign the batch in MetaMask. This costs nothing.");
      const signature = await signTypedData(account, batchTypedData(chainId, config.registry, batchRoot, count));
      const credentials = buildCredentials(certs, { chainId, registry: config.registry, signature });

      setProgress("Saving the batch…");
      const { codes } = await api.post("/issuer/batches", {
        root: batchRoot,
        certificates: credentials.map((credential) => ({ credential })),
        baselineGas: baselinePerCertificate * count,
        storedBytes,
      });
      draftRoot = batchRoot;

      setProgress("Confirm the transaction in MetaMask…");
      const receipt = await registry.methods.publishBatch(batchRoot, count, signature).send({ from: account });
      published = true;

      setProgress("Recording the result…");
      await api.post(`/issuer/batches/${batchRoot}/confirm`, { txHash: receipt.transactionHash });

      setDone({ batchRoot, txHash: receipt.transactionHash, gasUsed: Number(receipt.gasUsed), codes, credentials });
      setRows([]);
    } catch (e) {
      console.error("Error issuing batch:", e);
      if (draftRoot && !published) {
        await api.del(`/issuer/batches/${draftRoot}`).catch(() => {});
        setError(`${chainError(e)} Nothing was published.`);
      } else if (published) {
        setError(`The batch is on-chain, but saving the result failed: ${e.message} Open Batches and choose "Check chain".`);
      } else {
        setError(e.status ? e.message : chainError(e));
      }
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  if (done) {
    const exportCodes = () =>
      downloadCsv("claim-codes.csv", done.codes, [
        { key: "certificateId", label: "Certificate ID" },
        { key: "candidateName", label: "Candidate name" },
        { key: "claimCode", label: "Claim code" },
      ]);
    return (
      <>
        <PageHeader title="Batch published" description="Give each student their claim code." />
        <Alert tone="success" id="issue-success">
          Published {done.codes.length} certificate(s) for {formatNumber(done.gasUsed)} gas.
        </Alert>
        <Card
          title="Claim codes"
          description="These are only shown now. You can make a new code from Certificates if one gets lost."
          actions={(
            <>
              <button type="button" id="export-codes" className="button primary" onClick={exportCodes}>Export codes (CSV)</button>
              <button type="button" id="export-credentials" className="button" onClick={() => downloadJson("credentials.json", done.credentials)}>Export credentials</button>
            </>
          )}
        >
          <Table
            rows={done.codes}
            rowKey="certificateId"
            columns={[
              { label: "Certificate ID", render: (c) => c.certificateId },
              { label: "Candidate", render: (c) => c.candidateName },
              { label: "Claim code", render: (c) => <code className="claim-code">{c.claimCode}</code> },
            ]}
          />
          <p className="muted small">The credentials file holds every student's private values and PDF key, so keep it safe.</p>
        </Card>
        <button type="button" className="button" onClick={() => setDone(null)}>Start another batch</button>
      </>
    );
  }

  return (
    <>
      <PageHeader title="New batch" description={`Issuing as ${user.organization}. All certificates in a batch are published in one transaction.`} />
      <Alert tone="error" id="batch-error">{error}</Alert>
      <Alert tone="info" id="batch-notice">{notice}</Alert>

      <div className="two-column">
        <Card
          title="Import from CSV"
          description="One row per certificate, with the PDF's file name in the pdfFile column."
          actions={<button type="button" id="download-template" className="button small" onClick={downloadTemplate}>Get template</button>}
        >
          <Field label="CSV file">
            <input id="csv-input" type="file" accept=".csv,text/csv" onChange={(e) => { importCsv(e.target.files[0]); e.target.value = ""; }} />
          </Field>
          <Field label="PDF files" hint="Select them all at once. They're matched to rows by file name.">
            <input id="pdfs-input" type="file" accept="application/pdf" multiple onChange={(e) => matchPdfs(e.target.files)} />
          </Field>
        </Card>
        <Card title="Add one certificate">
          <form id="gen-form" onSubmit={addManual}>
            <div className="form-grid">
              {FIELDS.map(({ key, label }) => (
                <Field key={key} label={label}>
                  <input name={key} value={form[key]} onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))} />
                </Field>
              ))}
            </div>
            <Field label="Certificate PDF">
              <input ref={formPdfInput} id="pdf-input" type="file" accept="application/pdf" onChange={(e) => setFormPdf(e.target.files[0] || null)} />
            </Field>
            <button type="submit" id="add-button" className="button">Add to batch</button>
          </form>
        </Card>
      </div>

      {rows.length > 0 && (
        <>
          <Card title={`Batch (${rows.length})`} description={problemCount ? `${problemCount} row(s) need attention.` : "All rows are ready."} id="batch-table">
            <Table
              rows={checked.map((r, i) => ({ ...r, index: i }))}
              rowKey="index"
              columns={[
                { label: "Certificate ID", render: (r) => r.values.certificateId || "—" },
                { label: "Candidate", render: (r) => r.values.candidateName || "—" },
                { label: "Course", render: (r) => r.values.courseName || "—" },
                {
                  label: "PDF",
                  render: (r) => (r.pdf ? r.pdf.name : (
                    <input type="file" className="compact-file" accept="application/pdf" aria-label={`PDF for row ${r.index + 1}`} onChange={(e) => setRowPdf(r.index, e.target.files[0] || null)} />
                  )),
                },
                {
                  label: "Status",
                  render: (r) => (r.problems.length
                    ? <span className="small bad-text">{r.problems.join(". ")}.</span>
                    : <Badge value="active" label="Ready" />),
                },
                { label: "Remove", render: (r) => <button type="button" className="link-button" onClick={() => removeRow(r.index)}>Remove</button> },
              ]}
            />
          </Card>
          <CostCard rows={rows} baselinePerCertificate={baselinePerCertificate} gasPrice={gasPrice} setGasPrice={setGasPrice} ethUsd={ethUsd} setEthUsd={setEthUsd} />
          <div className="row align-center">
            <button type="button" id="issue-button" className="button primary" disabled={busy || problemCount > 0} onClick={issue}>
              {busy ? "Working…" : `Issue ${rows.length} certificate(s)`}
            </button>
            {progress && <span id="issue-progress" className="muted">{progress}</span>}
          </div>
        </>
      )}
    </>
  );
}
