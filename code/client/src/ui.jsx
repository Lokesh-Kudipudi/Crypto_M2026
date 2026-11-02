import { useCallback, useEffect, useRef, useState } from "react";
import { toCsv } from "./csv.mjs";

export const formatDate = (seconds) =>
  seconds ? new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";
export const formatDateTime = (seconds) =>
  seconds ? new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
export const formatNumber = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString());
export const formatUsd = (n) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: n < 10 ? 4 : 2 });
export const formatEth = (n) => `${n.toLocaleString(undefined, { maximumFractionDigits: 6 })} ETH`;
export const shortHash = (hash) => (hash ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : "—");
export const safeName = (s) => String(s).replace(/[^\w.-]+/g, "_");

export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export const downloadJson = (name, data) =>
  downloadBlob(name, new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));

export const downloadCsv = (name, rows, columns) =>
  downloadBlob(name, new Blob([toCsv(rows, columns)], { type: "text/csv" }));

/** Load data on mount and whenever deps change. */
export function useLoad(load, deps = []) {
  const [state, setState] = useState({ data: null, error: "", loading: true });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useCallback(load, deps);

  const reload = useCallback(async () => {
    try {
      const data = await stable();
      setState({ data, error: "", loading: false });
    } catch (e) {
      setState((prev) => ({ ...prev, error: e.message, loading: false }));
    }
  }, [stable]);

  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

export function Modal({ title, description, onClose, children }) {
  const dialog = useRef(null);

  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.focus();
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialog} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabIndex={-1}>
        <div className="modal-header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description && <p className="muted small">{description}</p>}
          </div>
          <button type="button" id="modal-close" className="button small" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export const PageHeader = ({ title, description, actions }) => (
  <div className="page-header">
    <div>
      <h1>{title}</h1>
      {description && <p className="muted">{description}</p>}
    </div>
    {actions && <div className="row">{actions}</div>}
  </div>
);

export const Card = ({ title, description, actions, children, id }) => (
  <section className="card" id={id}>
    {(title || actions) && (
      <div className="card-header">
        <div>
          {title && <h2>{title}</h2>}
          {description && <p className="muted small">{description}</p>}
        </div>
        {actions && <div className="row">{actions}</div>}
      </div>
    )}
    {children}
  </section>
);

export const Stat = ({ label, value, note }) => (
  <div className="stat">
    <div className="stat-label">{label}</div>
    <div className="stat-value">{value}</div>
    {note && <div className="stat-note">{note}</div>}
  </div>
);

const BADGE_TONES = {
  active: "good", published: "good", valid: "good", claimed: "good",
  pending: "warn", draft: "warn", unclaimed: "neutral",
  revoked: "bad", disabled: "bad", tampered: "bad", expired: "neutral",
  unknown_issuer: "bad", not_anchored: "bad",
};

export const Badge = ({ value, label }) => (
  <span className={`badge ${BADGE_TONES[String(value).toLowerCase()] || "neutral"}`}>{label || value}</span>
);

export const Alert = ({ tone = "info", children, id }) =>
  children ? <div id={id} className={`alert ${tone}`} role={tone === "error" ? "alert" : "status"}>{children}</div> : null;

export const Field = ({ label, hint, children }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
    {hint && <span className="field-hint">{hint}</span>}
  </label>
);

export function Table({ columns, rows, rowKey = "id", empty = "Nothing here yet." }) {
  if (!rows.length) return <p className="empty">{empty}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map((c) => <th key={c.label} className={c.numeric ? "numeric" : undefined}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row[rowKey] ?? i}>
              {columns.map((c) => <td key={c.label} className={c.numeric ? "numeric" : undefined}>{c.render(row)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return <button type="button" className="button small" onClick={copy}>{copied ? "Copied" : label}</button>;
}

export const Hash = ({ value }) => <code title={value}>{shortHash(value)}</code>;
