import { BrowserRouter, NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { Alert } from "./ui";
import { Landing, Login, Signup } from "./pages/Public";
import PublicVerify from "./pages/PublicVerify";
import { IssuerBatches, IssuerCertificates, IssuerCosts, IssuerOverview, IssuerPending } from "./pages/Issuer";
import NewBatch from "./pages/NewBatch";
import { StudentCertificates, StudentLinks } from "./pages/Student";
import { VerifierHistory, VerifierHome } from "./pages/Verifier";
import { AdminAudit, AdminBatches, AdminIssuers, AdminOverview, AdminUsers } from "./pages/Admin";

const HOME = { admin: "/admin", issuer: "/issuer", student: "/student", verifier: "/verifier" };
const ROLE_LABEL = { admin: "Admin", issuer: "Issuer", student: "Student", verifier: "Verifier" };

const NAV = {
  admin: [
    ["/admin", "Overview"], ["/admin/issuers", "Issuers"], ["/admin/users", "Users"],
    ["/admin/batches", "Batches"], ["/admin/audit", "Audit log"],
  ],
  issuer: [
    ["/issuer", "Overview"], ["/issuer/new", "New batch"], ["/issuer/certificates", "Certificates"],
    ["/issuer/batches", "Batches"], ["/issuer/costs", "Cost estimates"],
  ],
  student: [["/student", "My certificates"], ["/student/links", "Share links"]],
  verifier: [["/verifier", "Verify"], ["/verifier/history", "History"]],
};

export const homeFor = (user) => HOME[user.role];

function Shell({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const items = user.status === "active" ? NAV[user.role] : [];

  const signOut = async () => {
    await logout();
    navigate("/login");
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">CertChain</div>
        <nav aria-label="Main">
          {items.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === HOME[user.role]}>{label}</NavLink>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="sidebar-name">{user.name}</div>
          <div className="sidebar-role">{user.organization || ROLE_LABEL[user.role]}</div>
          <button type="button" id="logout-button" className="link-button" onClick={signOut}>Log out</button>
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}

function Protected({ role, children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={homeFor(user)} replace />;
  if (role === "issuer" && user.status !== "active") return <Shell><IssuerPending /></Shell>;
  return <Shell>{children}</Shell>;
}

function Guest({ children }) {
  const { user } = useAuth();
  return user ? <Navigate to={homeFor(user)} replace /> : children;
}

function Screens() {
  const { ready, startupError } = useAuth();
  if (!ready) return <p className="loading">Loading…</p>;
  if (startupError) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>CertChain can't start</h1>
          <Alert tone="error">{startupError}</Alert>
          <p className="muted small">Start the API with <code>npm start</code> in the <code>server</code> folder, then reload.</p>
        </div>
      </div>
    );
  }

  const guarded = (role, element) => <Protected role={role}>{element}</Protected>;

  return (
    <Routes>
      <Route path="/" element={<Guest><Landing /></Guest>} />
      <Route path="/login" element={<Guest><Login /></Guest>} />
      <Route path="/signup" element={<Guest><Signup /></Guest>} />
      <Route path="/verify" element={<PublicVerify />} />
      <Route path="/verify/:token" element={<PublicVerify />} />

      <Route path="/admin" element={guarded("admin", <AdminOverview />)} />
      <Route path="/admin/issuers" element={guarded("admin", <AdminIssuers />)} />
      <Route path="/admin/users" element={guarded("admin", <AdminUsers />)} />
      <Route path="/admin/batches" element={guarded("admin", <AdminBatches />)} />
      <Route path="/admin/audit" element={guarded("admin", <AdminAudit />)} />

      <Route path="/issuer" element={guarded("issuer", <IssuerOverview />)} />
      <Route path="/issuer/new" element={guarded("issuer", <NewBatch />)} />
      <Route path="/issuer/certificates" element={guarded("issuer", <IssuerCertificates />)} />
      <Route path="/issuer/batches" element={guarded("issuer", <IssuerBatches />)} />
      <Route path="/issuer/costs" element={guarded("issuer", <IssuerCosts />)} />

      <Route path="/student" element={guarded("student", <StudentCertificates />)} />
      <Route path="/student/links" element={guarded("student", <StudentLinks />)} />

      <Route path="/verifier" element={guarded("verifier", <VerifierHome />)} />
      <Route path="/verifier/history" element={guarded("verifier", <VerifierHistory />)} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Screens />
      </AuthProvider>
    </BrowserRouter>
  );
}
