import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { chainError, connectWallet, readRegistry } from "../chain";
import {
  Alert, Badge, Card, Field, Hash, PageHeader, Stat, Table,
  downloadCsv, formatDate, formatDateTime, formatNumber, useLoad,
} from "../ui";

/** Connect the wallet and make sure it's the registry's owner before sending anything. */
async function connectOwner(config) {
  const wallet = await connectWallet(config);
  const owner = await wallet.registry.methods.owner().call();
  if (owner.toLowerCase() !== wallet.account.toLowerCase()) {
    throw new Error(`Only the contract owner (${owner}) can do this. Switch accounts in MetaMask.`);
  }
  return wallet;
}

export function AdminOverview() {
  const { config } = useAuth();
  const { data, error } = useLoad(() => api.get("/admin/summary"));
  const { data: owner } = useLoad(async () => (config?.registry ? readRegistry(config).contract.methods.owner().call() : null), [config]);
  const users = data?.users ?? [];
  const totalUsers = users.reduce((sum, u) => sum + u.count, 0);
  const pending = users.filter((u) => u.status === "pending").reduce((sum, u) => sum + u.count, 0);

  return (
    <>
      <PageHeader title="Overview" description="Everyone on the platform, and what's been published." />
      <Alert tone="error">{error}</Alert>
      {!config?.registry && <Alert tone="error" id="no-contract">The contract isn't deployed on this chain, or the chain isn't running. Run truffle migrate.</Alert>}
      {pending > 0 && <Alert tone="info" id="pending-alert">{pending} issuer(s) are waiting for approval. <Link to="/admin/issuers">Review them</Link></Alert>}
      <div className="stats" id="admin-stats">
        <Stat label="Users" value={formatNumber(totalUsers)} />
        <Stat label="Pending issuers" value={formatNumber(pending)} />
        <Stat label="Certificates" value={formatNumber(data?.certificates.total ?? 0)} note={`${formatNumber(data?.certificates.revoked ?? 0)} revoked`} />
        <Stat label="Gas used" value={formatNumber(data?.batches.gasUsed ?? 0)} note={`${formatNumber(data?.batches.total ?? 0)} batch(es)`} />
      </div>
      <Card title="Blockchain">
        <dl className="details-list">
          <div><dt>Chain ID</dt><dd>{config?.chainId ?? "Not connected"}</dd></div>
          <div><dt>Registry contract</dt><dd><code className="break">{config?.registry ?? "Not deployed"}</code></dd></div>
          <div><dt>Contract owner</dt><dd><code className="break" id="owner-address">{owner ?? "—"}</code></dd></div>
        </dl>
        <p className="muted small">Approving issuers and revoking batches needs MetaMask, using the owner's account.</p>
      </Card>
    </>
  );
}

export function AdminIssuers() {
  const { config } = useAuth();
  const { data, error, reload } = useLoad(async () => (await api.get("/admin/users")).users);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState(null);
  const issuers = (data ?? []).filter((u) => u.role === "issuer");

  const act = async (user, action) => {
    setBusyId(user.id);
    setActionError("");
    setNotice("");
    try {
      await action();
      reload();
    } catch (e) {
      setActionError(e.status ? e.message : chainError(e));
    } finally {
      setBusyId(null);
    }
  };

  const approve = (user) => act(user, async () => {
    const { contract } = readRegistry(config);
    const onChain = await contract.methods.issuers(user.wallet).call();
    if (!onChain.active || onChain.name !== user.organization) {
      const { account, registry } = await connectOwner(config);
      await registry.methods.addIssuer(user.wallet, user.organization).send({ from: account });
    }
    await api.post(`/admin/users/${user.id}/approve`);
    setNotice(`Approved ${user.organization}.`);
  });

  // Removing on-chain is what really stops publishing; the account change alone wouldn't
  const remove = (user) => act(user, async () => {
    if (user.wallet) {
      const { contract } = readRegistry(config);
      const onChain = await contract.methods.issuers(user.wallet).call();
      if (onChain.active) {
        const { account, registry } = await connectOwner(config);
        await registry.methods.removeIssuer(user.wallet).send({ from: account });
      }
    }
    await api.post(`/admin/users/${user.id}/disable`);
    setNotice(`Removed ${user.organization}. Its existing certificates stay valid unless you revoke its batches.`);
  });

  const restore = (user) => act(user, async () => {
    await api.post(`/admin/users/${user.id}/enable`);
    setNotice(`${user.organization} is back to waiting for approval.`);
  });

  return (
    <>
      <PageHeader title="Issuers" description="Approving an issuer adds its wallet to the contract, which is what lets it publish." />
      <Alert tone="error" id="issuers-error">{error || actionError}</Alert>
      <Alert tone="success" id="issuers-notice">{notice}</Alert>
      <Card>
        <Table
          rows={issuers}
          empty="No universities have signed up yet."
          columns={[
            { label: "University", render: (u) => u.organization },
            { label: "Contact", render: (u) => u.email },
            { label: "Wallet", render: (u) => (u.wallet ? <Hash value={u.wallet} /> : <span className="muted">Not linked</span>) },
            { label: "Status", render: (u) => <Badge value={u.status} /> },
            {
              label: "Actions",
              render: (u) => (
                <div className="row">
                  {u.status === "pending" && (
                    <button type="button" className="button small primary" disabled={!u.wallet || busyId === u.id} title={u.wallet ? undefined : "The issuer must link a wallet first"} onClick={() => approve(u)}>
                      {busyId === u.id ? "Check MetaMask…" : "Approve"}
                    </button>
                  )}
                  {u.status !== "disabled" && <button type="button" className="button small danger" disabled={busyId === u.id} onClick={() => remove(u)}>Remove</button>}
                  {u.status === "disabled" && <button type="button" className="button small" onClick={() => restore(u)}>Restore</button>}
                </div>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}

export function AdminUsers() {
  const { user: me } = useAuth();
  const { data, error, reload } = useLoad(async () => (await api.get("/admin/users")).users);
  const [actionError, setActionError] = useState("");
  const rows = data ?? [];

  const setStatus = async (user, action) => {
    setActionError("");
    try {
      await api.post(`/admin/users/${user.id}/${action}`);
      reload();
    } catch (e) {
      setActionError(e.message);
    }
  };

  const exportRows = () =>
    downloadCsv(
      "users.csv",
      rows.map((u) => ({ ...u, joined: formatDate(u.createdAt) })),
      [
        { key: "name", label: "Name" },
        { key: "email", label: "Email" },
        { key: "role", label: "Role" },
        { key: "status", label: "Status" },
        { key: "organization", label: "Organization" },
        { key: "wallet", label: "Wallet" },
        { key: "joined", label: "Joined" },
      ]
    );

  return (
    <>
      <PageHeader
        title="Users"
        description="Disabling an account logs it out. Use Issuers to remove a university's on-chain approval."
        actions={<button type="button" id="export-users" className="button" disabled={!rows.length} onClick={exportRows}>Export CSV</button>}
      />
      <Alert tone="error">{error || actionError}</Alert>
      <Card>
        <Table
          rows={rows}
          columns={[
            { label: "Name", render: (u) => u.name },
            { label: "Email", render: (u) => u.email },
            { label: "Role", render: (u) => u.role },
            { label: "Status", render: (u) => <Badge value={u.status} /> },
            { label: "Joined", render: (u) => formatDate(u.createdAt) },
            {
              label: "Action",
              render: (u) => u.id !== me.id && u.role !== "issuer" && (
                u.status === "disabled"
                  ? <button type="button" className="button small" onClick={() => setStatus(u, "enable")}>Enable</button>
                  : <button type="button" className="button small danger" onClick={() => setStatus(u, "disable")}>Disable</button>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}

export function AdminBatches() {
  const { config } = useAuth();
  const { data, error, reload } = useLoad(async () => (await api.get("/admin/batches")).batches);
  const [actionError, setActionError] = useState("");
  const [revoking, setRevoking] = useState(null);
  const [reason, setReason] = useState("");
  const rows = data ?? [];

  const revoke = async (e) => {
    e.preventDefault();
    if (!reason.trim()) return setActionError("Enter a reason. It's public and permanent.");
    setActionError("");
    try {
      const { account, registry } = await connectOwner(config);
      await registry.methods.revokeBatch(revoking.root, reason.trim()).send({ from: account });
      await api.post(`/batches/${revoking.root}/revoked`);
      setRevoking(null);
      setReason("");
      reload();
    } catch (err) {
      setActionError(err.status ? err.message : chainError(err));
    }
  };

  return (
    <>
      <PageHeader title="Batches" description="Revoke a whole batch here if an issuer's key is stolen." />
      <Alert tone="error" id="admin-batches-error">{error || actionError}</Alert>
      {revoking && (
        <Card title={`Revoke this batch from ${revoking.issuer}`} description={`This permanently revokes ${revoking.count} certificate(s). The reason is public and stored on-chain.`}>
          <form id="admin-revoke-form" onSubmit={revoke}>
            <Field label="Reason">
              <input id="admin-revoke-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
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
          empty="No batches have been published yet."
          columns={[
            { label: "Issuer", render: (b) => b.issuer },
            { label: "Batch root", render: (b) => <Hash value={b.root} /> },
            { label: "Certificates", numeric: true, render: (b) => formatNumber(b.count) },
            { label: "Status", render: (b) => <Badge value={b.status} /> },
            { label: "Published", render: (b) => formatDate(b.published_at) },
            {
              label: "Action",
              render: (b) => b.status === "published" && (
                <button type="button" className="button small danger" onClick={() => setRevoking(b)}>Revoke</button>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}

export function AdminAudit() {
  const { data, error } = useLoad(async () => (await api.get("/admin/audit")).entries);
  const rows = data ?? [];
  const exportRows = () =>
    downloadCsv(
      "audit-log.csv",
      rows.map((e) => ({ ...e, time: formatDateTime(e.created_at) })),
      [
        { key: "time", label: "Time" },
        { key: "email", label: "User" },
        { key: "action", label: "Action" },
        { key: "detail", label: "Detail" },
      ]
    );
  return (
    <>
      <PageHeader
        title="Audit log"
        description="The latest 500 actions in this app. Anything on-chain has its own permanent record."
        actions={<button type="button" id="export-audit" className="button" disabled={!rows.length} onClick={exportRows}>Export CSV</button>}
      />
      <Alert tone="error">{error}</Alert>
      <Card>
        <Table
          rows={rows}
          columns={[
            { label: "Time", render: (e) => formatDateTime(e.created_at) },
            { label: "User", render: (e) => e.email ?? "—" },
            { label: "Action", render: (e) => e.action.replaceAll("_", " ") },
            { label: "Detail", render: (e) => <span className="break">{e.detail}</span> },
          ]}
        />
      </Card>
    </>
  );
}
