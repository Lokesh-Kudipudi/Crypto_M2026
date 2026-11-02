import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { chainError, connectWallet, personalSign, readRegistry } from "../chain";
import {
  DEFAULT_ETH_USD, DEFAULT_GAS_PRICE_GWEI, GAS, breakEvenCertificates, compareIssuing, estimateRevokeCertificate, gasToEth, gasToUsd,
} from "../cost.mjs";
import {
  Alert, Badge, Card, CopyButton, Field, Hash, PageHeader, Stat, Table,
  downloadCsv, formatDate, formatEth, formatNumber, formatUsd, useLoad,
} from "../ui";

export function WalletCard() {
  const { user, setUser, config } = useAuth();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const link = async () => {
    setBusy(true);
    setError("");
    try {
      const { account } = await connectWallet(config);
      const { message } = await api.post("/wallet/challenge");
      const signature = await personalSign(account, message);
      const { user: next } = await api.post("/wallet/link", { address: account, signature });
      setUser(next);
    } catch (e) {
      setError(e.status ? e.message : chainError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Wallet" description="Proves which key signs for you. Linking only needs a signature, which sends no transaction and costs nothing.">
      <Alert tone="error" id="wallet-error">{error}</Alert>
      {user.wallet ? <p>Linked: <code id="linked-wallet" className="break">{user.wallet}</code></p> : <p className="muted">No wallet linked yet.</p>}
      <button type="button" id="link-wallet" className="button primary" disabled={busy} onClick={link}>
        {busy ? "Check MetaMask…" : user.wallet ? "Link a different wallet" : "Link MetaMask wallet"}
      </button>
    </Card>
  );
}

export function IssuerPending() {
  const { user, refresh } = useAuth();
  return (
    <>
      <PageHeader title="Waiting for approval" description={`${user.organization} can issue certificates once an admin approves it.`} />
      <Card title="What happens next">
        <ol className="steps">
          <li className={user.wallet ? "done" : ""}>Link the wallet your university will sign with.</li>
          <li>An admin approves that wallet on-chain.</li>
          <li>You can then issue certificates.</li>
        </ol>
        <button type="button" id="check-approval" className="button" onClick={refresh}>Check status</button>
      </Card>
      <WalletCard />
    </>
  );
}

export function IssuerOverview() {
  const { data, error } = useLoad(() => api.get("/issuer/summary"));
  const certificates = data?.certificates;
  const batches = data?.batches;
  const saved = batches && batches.baselineGas ? batches.baselineGas - batches.gasUsed : 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Your university's certificates at a glance."
        actions={<Link id="new-batch-link" className="button primary" to="/issuer/new">New batch</Link>}
      />
      <Alert tone="error">{error}</Alert>
      <div className="stats" id="issuer-stats">
        <Stat label="Certificates issued" value={formatNumber(certificates?.total ?? 0)} note={`${formatNumber(batches?.total ?? 0)} batch(es)`} />
        <Stat label="Claimed by students" value={formatNumber(certificates?.claimed ?? 0)} />
        <Stat label="Revoked" value={formatNumber(certificates?.revoked ?? 0)} />
        <Stat label="Gas used" value={formatNumber(batches?.gasUsed ?? 0)} note={saved > 0 ? `${formatNumber(saved)} less than the paper's contract (est.)` : undefined} />
      </div>
      <WalletCard />
    </>
  );
}

const CERTIFICATE_COLUMNS = [
  { key: "certificate_id", label: "Certificate ID" },
  { key: "uid", label: "UID" },
  { key: "candidate_name", label: "Candidate name" },
  { key: "course_name", label: "Course name" },
  { key: "cgpa", label: "CGPA" },
  { key: "completion_year", label: "Completion year" },
  { key: "status", label: "Status" },
  { key: "revoked_reason", label: "Revocation reason" },
  { key: "claimedText", label: "Claimed" },
  { key: "published", label: "Published" },
  { key: "batch_root", label: "Batch root" },
  { key: "cert_root", label: "Certificate root" },
];

export function IssuerCertificates() {
  const { config } = useAuth();
  const { data, error, reload } = useLoad(async () => (await api.get("/issuer/certificates")).certificates);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [revoking, setRevoking] = useState(null);
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState("");
  const [newCode, setNewCode] = useState(null);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data ?? []).filter((c) =>
      (status === "all" || c.status === status)
      && (!term || [c.certificate_id, c.candidate_name, c.course_name, c.uid].some((v) => v.toLowerCase().includes(term))));
  }, [data, search, status]);

  const exportRows = () =>
    downloadCsv(
      "certificates.csv",
      rows.map((c) => ({ ...c, claimedText: c.claimed ? "Yes" : "No", published: formatDate(c.published_at) })),
      CERTIFICATE_COLUMNS
    );

  const revoke = async (e) => {
    e.preventDefault();
    if (!reason.trim()) return setActionError("Enter a reason. It's public and permanent.");
    setBusy(true);
    setActionError("");
    try {
      const { account, registry } = await connectWallet(config);
      try {
        await registry.methods
          .revokeCertificate(revoking.batch_root, revoking.cert_root, revoking.batch_proof, reason.trim())
          .send({ from: account });
      } catch (err) {
        // Already revoked on-chain means only the record here is behind, so carry on and sync it
        if (chainError(err) !== "Already revoked") throw err;
      }
      await api.post(`/issuer/certificates/${revoking.id}/revoked`);
      setRevoking(null);
      setReason("");
      reload();
    } catch (err) {
      setActionError(err.status ? err.message : chainError(err));
    } finally {
      setBusy(false);
    }
  };

  const resetCode = async (certificate) => {
    setActionError("");
    setNewCode(null);
    try {
      const { claimCode } = await api.post(`/issuer/certificates/${certificate.id}/claim-code`);
      setNewCode({ id: certificate.certificate_id, code: claimCode });
    } catch (err) {
      setActionError(err.message);
    }
  };

  return (
    <>
      <PageHeader
        title="Certificates"
        description="Search, revoke and export. The details here stay off-chain, in this app's database."
        actions={<button type="button" id="export-certificates" className="button" disabled={!rows.length} onClick={exportRows}>Export CSV</button>}
      />
      <Alert tone="error" id="certificate-error">{error || actionError}</Alert>
      {newCode && (
        <div className="alert success" id="new-code">
          <p>New claim code for {newCode.id}. The old code no longer works, and this one isn't shown again.</p>
          <div className="row wrap"><code className="claim-code">{newCode.code}</code><CopyButton text={newCode.code} /></div>
        </div>
      )}
      {revoking && (
        <Card title={`Revoke ${revoking.certificate_id}`} description="This is permanent and sends a transaction. The reason is stored publicly on-chain, so don't include personal details.">
          <form id="revoke-form" onSubmit={revoke}>
            <Field label="Reason">
              <input id="revoke-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Issued in error" />
            </Field>
            <div className="row">
              <button type="submit" className="button danger" disabled={busy}>{busy ? "Check MetaMask…" : "Revoke certificate"}</button>
              <button type="button" className="button" onClick={() => setRevoking(null)}>Cancel</button>
            </div>
          </form>
        </Card>
      )}
      <Card>
        <div className="row wrap toolbar">
          <input id="certificate-search" type="search" aria-label="Search certificates" placeholder="Search by ID, name, course or UID" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select id="certificate-status" aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="revoked">Revoked</option>
          </select>
        </div>
        <Table
          rows={rows}
          empty={data?.length ? "No certificates match." : "You haven't issued any certificates yet."}
          columns={[
            { label: "Certificate ID", render: (c) => c.certificate_id },
            { label: "Candidate", render: (c) => c.candidate_name },
            { label: "Course", render: (c) => c.course_name },
            { label: "Status", render: (c) => <Badge value={c.status} /> },
            { label: "Claimed", render: (c) => <Badge value={c.claimed ? "claimed" : "unclaimed"} label={c.claimed ? "Claimed" : "Unclaimed"} /> },
            {
              label: "Actions",
              render: (c) => (
                <div className="row">
                  {c.status === "active" && <button type="button" className="button small danger" onClick={() => { setRevoking(c); setActionError(""); }}>Revoke</button>}
                  {!c.claimed && c.status === "active" && <button type="button" className="button small" onClick={() => resetCode(c)}>New code</button>}
                </div>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}

export function IssuerBatches() {
  const { config } = useAuth();
  const { data, error, reload } = useLoad(async () => (await api.get("/issuer/batches")).batches);
  const [actionError, setActionError] = useState("");
  const [revoking, setRevoking] = useState(null);
  const [reason, setReason] = useState("");
  const rows = data ?? [];

  const checkChain = async (batch) => {
    setActionError("");
    try {
      await api.post(`/issuer/batches/${batch.root}/confirm`);
      reload();
    } catch (e) {
      setActionError(e.message);
    }
  };

  const removeDraft = async (batch) => {
    setActionError("");
    try {
      await api.del(`/issuer/batches/${batch.root}`);
      reload();
    } catch (e) {
      setActionError(e.message);
    }
  };

  const revoke = async (e) => {
    e.preventDefault();
    if (!reason.trim()) return setActionError("Enter a reason. It's public and permanent.");
    setActionError("");
    try {
      const { account, registry } = await connectWallet(config);
      await registry.methods.revokeBatch(revoking.root, reason.trim()).send({ from: account });
      await api.post(`/batches/${revoking.root}/revoked`);
      setRevoking(null);
      setReason("");
      reload();
    } catch (err) {
      setActionError(err.status ? err.message : chainError(err));
    }
  };

  const exportRows = () =>
    downloadCsv(
      "batches.csv",
      rows.map((b) => ({ ...b, published: formatDate(b.published_at) })),
      [
        { key: "root", label: "Batch root" },
        { key: "status", label: "Status" },
        { key: "count", label: "Certificates" },
        { key: "gas_used", label: "Gas used" },
        { key: "baseline_gas", label: "Paper's contract (estimated gas)" },
        { key: "stored_bytes", label: "Stored on IPFS (bytes)" },
        { key: "published", label: "Published" },
        { key: "tx_hash", label: "Transaction" },
      ]
    );

  return (
    <>
      <PageHeader
        title="Batches"
        description="Each batch is one transaction. Gas used comes from the chain's receipt."
        actions={<button type="button" id="export-batches" className="button" disabled={!rows.length} onClick={exportRows}>Export CSV</button>}
      />
      <Alert tone="error" id="batches-error">{error || actionError}</Alert>
      {revoking && (
        <Card title="Revoke this whole batch" description={`This permanently revokes all ${revoking.count} certificate(s). The reason is public and stored on-chain.`}>
          <form id="revoke-batch-form" onSubmit={revoke}>
            <Field label="Reason">
              <input id="revoke-batch-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="row">
              <button type="submit" className="button danger">Revoke batch</button>
              <button type="button" className="button" onClick={() => setRevoking(null)}>Cancel</button>
            </div>
          </form>
        </Card>
      )}
      <Card>
        <Table
          rows={rows}
          empty="No batches yet."
          columns={[
            { label: "Batch root", render: (b) => <Hash value={b.root} /> },
            { label: "Status", render: (b) => <Badge value={b.status} /> },
            { label: "Certificates", numeric: true, render: (b) => formatNumber(b.count) },
            { label: "Gas used", numeric: true, render: (b) => formatNumber(b.gas_used) },
            { label: "Published", render: (b) => formatDate(b.published_at) },
            {
              label: "Actions",
              render: (b) => (
                <div className="row">
                  {b.status === "draft" && (
                    <>
                      <button type="button" className="button small" onClick={() => checkChain(b)}>Check chain</button>
                      <button type="button" className="button small" onClick={() => removeDraft(b)}>Delete draft</button>
                    </>
                  )}
                  {b.status === "published" && <button type="button" className="button small danger" onClick={() => setRevoking(b)}>Revoke</button>}
                </div>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}

export function IssuerCosts() {
  const { config } = useAuth();
  const [certificates, setCertificates] = useState(500);
  const [batchSize, setBatchSize] = useState(100);
  const [gasPrice, setGasPrice] = useState(DEFAULT_GAS_PRICE_GWEI);
  const [ethUsd, setEthUsd] = useState(DEFAULT_ETH_USD);
  const { data: batches } = useLoad(async () => (await api.get("/issuer/batches")).batches);
  const { data: localGasPrice } = useLoad(async () => {
    const { web3 } = readRegistry(config);
    return Number(await web3.eth.getGasPrice()) / 1e9;
  }, [config]);

  const count = Math.max(0, Math.floor(Number(certificates) || 0));
  const size = Math.max(1, Math.floor(Number(batchSize) || 1));
  const price = Math.max(0, Number(gasPrice) || 0);
  const usd = Math.max(0, Number(ethUsd) || 0);
  const result = compareIssuing({ certificates: count, batchSize: size });
  const breakEven = breakEvenCertificates({ batchSize: size });
  const money = (gas) => `${formatEth(gasToEth(gas, price))} · ${formatUsd(gasToUsd(gas, price, usd))}`;

  const published = (batches ?? []).filter((b) => b.gas_used);
  const table = [
    { id: "issue", action: `Issue ${formatNumber(count)} certificate(s) in ${formatNumber(result.batches)} batch(es)`, gas: result.registryGas },
    { id: "paper", action: "Same, using the paper's contract", gas: result.baselineGas },
    { id: "revoke", action: `Revoke one certificate (batch of ${formatNumber(size)})`, gas: estimateRevokeCertificate(size) },
    { id: "revoke-batch", action: "Revoke a whole batch", gas: GAS.revokeBatch },
    { id: "approve", action: "Approve an issuer", gas: GAS.addIssuer },
    { id: "verify", action: "Verify a certificate", gas: 0 },
  ];

  return (
    <>
      <PageHeader title="Cost estimates" description="Compare issuing costs before you publish. Your local chain uses free test ETH, so this shows what a public network could cost." />
      <Card title="Your assumptions" description={`Prices are examples, not live rates.${localGasPrice !== null && localGasPrice !== undefined ? ` Your local chain's gas price is ${localGasPrice} gwei.` : ""}`}>
        <div className="form-grid four">
          <Field label="Certificates"><input id="cost-certificates" type="number" min="0" value={certificates} onChange={(e) => setCertificates(e.target.value)} /></Field>
          <Field label="Certificates per batch"><input id="cost-batch-size" type="number" min="1" value={batchSize} onChange={(e) => setBatchSize(e.target.value)} /></Field>
          <Field label="Gas price (gwei)"><input id="cost-gas-price" type="number" min="0" step="any" value={gasPrice} onChange={(e) => setGasPrice(e.target.value)} /></Field>
          <Field label="ETH price (USD)"><input id="cost-eth-price" type="number" min="0" step="any" value={ethUsd} onChange={(e) => setEthUsd(e.target.value)} /></Field>
        </div>
      </Card>
      <div className="stats" id="cost-summary">
        <Stat label="Registry" value={`${formatNumber(result.registryGas)} gas`} note={money(result.registryGas)} />
        <Stat label="Paper's contract" value={`${formatNumber(result.baselineGas)} gas`} note={money(result.baselineGas)} />
        <Stat label="Saved" value={`${result.savedPercent.toFixed(1)}%`} note={money(Math.max(0, result.savedGas))} />
        <Stat
          label="Pays back deployment after"
          value={breakEven === null ? "Never" : `${formatNumber(breakEven)} certificates`}
          note={`Costs ${formatNumber(GAS.registryDeploy - GAS.baselineDeploy)} more gas to deploy`}
        />
      </div>
      <Card title="What each action costs">
        <Table
          rows={table}
          columns={[
            { label: "Action", render: (r) => r.action },
            { label: "Gas", numeric: true, render: (r) => formatNumber(r.gas) },
            { label: "Estimated cost", numeric: true, render: (r) => (r.gas ? money(r.gas) : "Free") },
          ]}
        />
        <p className="muted small">
          The university pays for each transaction. These figures cover gas only, so they leave out hosting, IPFS pinning and staff time.
          The saving also isn't like for like: the registry stores less on-chain and adds signatures and revocation.
        </p>
      </Card>
      <Card title="Your published batches" description="Actual gas from the chain, against an estimate for the paper's contract made when each batch was issued.">
        <Table
          rows={published}
          empty="Publish a batch to see actual costs."
          columns={[
            { label: "Batch root", render: (b) => <Hash value={b.root} /> },
            { label: "Certificates", numeric: true, render: (b) => formatNumber(b.count) },
            { label: "Actual gas", numeric: true, render: (b) => formatNumber(b.gas_used) },
            { label: "Paper's contract (est.)", numeric: true, render: (b) => formatNumber(b.baseline_gas) },
            { label: "Estimated cost", numeric: true, render: (b) => money(b.gas_used) },
          ]}
        />
      </Card>
    </>
  );
}
