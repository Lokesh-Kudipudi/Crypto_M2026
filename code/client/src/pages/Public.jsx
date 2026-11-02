import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { Alert, Badge, Field, Modal, useLoad } from "../ui";

export function Landing() {
  return (
    <div className="landing">
      <header className="landing-header">
        <div className="brand dark">CertChain</div>
        <div className="row">
          <Link className="button" to="/login">Log in</Link>
          <Link className="button primary" to="/signup">Sign up</Link>
        </div>
      </header>
      <section className="hero">
        <div className="hero-copy">
          <h1>Academic certificates anyone can verify, and no one can forge.</h1>
          <p>
            Universities sign and publish certificates to a blockchain. Students decide which details to share.
            Employers check them in seconds, for free.
          </p>
          <div className="row wrap">
            <Link className="button primary" to="/signup">Get started</Link>
            <Link className="button" to="/verify">Verify a certificate</Link>
          </div>
        </div>
        <figure className="preview" aria-label="Example of a verification result">
          <div className="preview-header">
            <span className="preview-title">Example result</span>
            <Badge value="valid" label="Valid certificate" />
          </div>
          <dl className="preview-fields">
            <div><dt>Course</dt><dd>B.Tech Computer Science</dd></div>
            <div><dt>Issued by</dt><dd>Demo University</dd></div>
            <div><dt>CGPA</dt><dd className="muted">Hidden by the student</dd></div>
          </dl>
          <ul className="preview-checks">
            {["Issuer signature", "Merkle proof", "Published on-chain", "Not revoked"].map((check) => (
              <li key={check}><span aria-hidden="true">✓</span> {check}</li>
            ))}
          </ul>
        </figure>
      </section>
      <section className="landing-grid">
        <div className="landing-card">
          <span className="landing-step">1</span>
          <div>
            <h2>Universities issue</h2>
            <p>Import a class from a CSV, see the gas cost first, and publish the whole batch in one transaction.</p>
          </div>
        </div>
        <div className="landing-card">
          <span className="landing-step">2</span>
          <div>
            <h2>Students share</h2>
            <p>Claim certificates with a code, then share only what's needed, such as your degree but not your CGPA.</p>
          </div>
        </div>
        <div className="landing-card">
          <span className="landing-step">3</span>
          <div>
            <h2>Verifiers check</h2>
            <p>Open a link or upload a file. Each result is checked directly against the chain, with no wallet needed.</p>
          </div>
        </div>
      </section>
    </div>
  );
}

const DEMO_ROLES = {
  admin: { label: "Admin", note: "Users, approvals and the audit log.", wallet: true },
  issuer: { label: "University", note: "Certificates, batches and costs.", wallet: true },
  student: { label: "Student", note: "Two certificates, a share link, and a code to claim.", wallet: false },
  verifier: { label: "Verifier", note: "Verify documents and see past checks.", wallet: false },
};

const shortAddress = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function DemoModal({ onClose }) {
  const { demoLogin } = useAuth();
  const navigate = useNavigate();
  const { data, error: loadError, loading } = useLoad(async () => {
    const [config, manifest] = await Promise.all([
      api.get("/config"),
      fetch("/demo/manifest.json").then((r) => r.json()).catch(() => null),
    ]);
    return { accounts: config.demoAccounts ?? [], manifest };
  });
  const [error, setError] = useState("");
  const accounts = data?.accounts ?? [];
  const manifest = data?.manifest;

  const enter = async (email) => {
    setError("");
    try {
      await demoLogin(email);
      navigate("/");
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <Modal title="Try a demo account" description="One click, no password. These accounts use sample data on your local chain." onClose={onClose}>
      <Alert tone="error">{error || loadError}</Alert>
      {!loading && !accounts.length && (
        <Alert tone="info" id="demo-empty">
          No demo accounts yet. With the chain and IPFS running, run <code>npm run seed:demo</code> in the <code>server</code> folder, then reopen this.
        </Alert>
      )}
      <div id="demo-accounts">
        {accounts.map((account) => {
          const role = DEMO_ROLES[account.role];
          return (
            <div key={account.email} className="demo-account">
              <div>
                <div className="list-item-title">{role.label}</div>
                <div className="muted small">{role.note}</div>
                {role.wallet && manifest?.issuerWallet && (
                  <div className="muted small">Actions need MetaMask on {shortAddress(manifest.issuerWallet)}.</div>
                )}
              </div>
              <button type="button" className="button primary small" data-demo-role={account.role} onClick={() => enter(account.email)}>
                Log in
              </button>
            </div>
          );
        })}
      </div>
      {manifest && (
        <div id="demo-documents" className="demo-documents">
          <h3>Demo documents</h3>
          <p className="small">
            <Link id="demo-share-link" to={manifest.sharePath}>Open a sample share link</Link> to see a verified certificate.
          </p>
          <p className="small">
            Claim code for {manifest.claimCertificate}: <code id="demo-claim-code" className="claim-code">{manifest.claimCode}</code>
          </p>
          {manifest.groups.map((group) => (
            <div key={group.title}>
              <h4>{group.title}</h4>
              <ul>
                {group.files.map(({ file, label, note }) => (
                  <li key={file}>
                    <a href={`/demo/${file}`} download>{label}</a> <span className="muted small">{note}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function Login() {
  const { login, config } = useAuth();
  const navigate = useNavigate();
  const [demoOpen, setDemoOpen] = useState(false);
  const closeDemo = useCallback(() => setDemoOpen(false), []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email.trim(), password);
      navigate("/");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form id="login-form" className="auth-card" onSubmit={submit}>
        <Link to="/" className="brand dark">CertChain</Link>
        <h1>Log in</h1>
        <Alert tone="error">{error}</Alert>
        <Field label="Email">
          <input name="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <input name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <button type="submit" className="button primary full" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
        {config?.demoEnabled && (
          <button type="button" id="demo-button" className="button full demo-button" onClick={() => setDemoOpen(true)}>Try a demo account</button>
        )}
        <p className="muted small center">New here? <Link to="/signup">Create an account</Link></p>
        <p className="muted small center">Checking a certificate? <Link to="/verify">Verify without an account</Link></p>
      </form>
      {demoOpen && <DemoModal onClose={closeDemo} />}
    </div>
  );
}

const ROLES = [
  { value: "student", label: "Student", description: "Receive and share your certificates." },
  { value: "issuer", label: "University", description: "Issue certificates. Needs a wallet and admin approval." },
  { value: "verifier", label: "Verifier", description: "Check certificates and keep a history." },
];

export function Signup() {
  const { signup, config } = useAuth();
  const navigate = useNavigate();
  const isFirst = !!config?.setupRequired;
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "student", organization: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await signup({ ...form, email: form.email.trim() });
      navigate("/");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <form id="signup-form" className="auth-card" onSubmit={submit}>
        <Link to="/" className="brand dark">CertChain</Link>
        <h1>Create your account</h1>
        <Alert tone="error">{error}</Alert>
        {isFirst ? (
          <Alert tone="info" id="first-account-note">This is the first account, so it becomes the admin.</Alert>
        ) : (
          <fieldset className="role-picker">
            <legend className="field-label">I am a</legend>
            {ROLES.map((r) => (
              <label key={r.value} className={`role-option ${form.role === r.value ? "selected" : ""}`}>
                <input type="radio" name="role" value={r.value} checked={form.role === r.value} onChange={set("role")} />
                <span>
                  <strong>{r.label}</strong>
                  <span className="muted small block">{r.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {!isFirst && form.role === "issuer" && (
          <Field label="University name" hint="Shown to verifiers, and recorded on-chain when you're approved.">
            <input name="organization" required value={form.organization} onChange={set("organization")} />
          </Field>
        )}
        <Field label="Your name">
          <input name="name" autoComplete="name" required value={form.name} onChange={set("name")} />
        </Field>
        <Field label="Email">
          <input name="email" type="email" autoComplete="email" required value={form.email} onChange={set("email")} />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <input name="password" type="password" autoComplete="new-password" minLength={8} required value={form.password} onChange={set("password")} />
        </Field>
        <button type="submit" className="button primary full" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
        <p className="muted small center">Already have an account? <Link to="/login">Log in</Link></p>
      </form>
    </div>
  );
}
