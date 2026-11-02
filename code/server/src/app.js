import express from "express";
import { getAddress, isHexString, verifyMessage } from "ethers";
import { transaction } from "./db.js";
import {
  hashPassword, hashToken, normalizeClaimCode, randomClaimCode, randomToken, seal, unseal, verifyPassword,
} from "./security.js";

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const COOKIE = "session";
const SIGNUP_ROLES = ["issuer", "student", "verifier"];
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_SHARE_DAYS = 365;
const MAX_FIELD_LENGTH = 200;

const now = () => Math.floor(Date.now() / 1000);
const isEmail = (s) => typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;
const isBytes32 = (s) => isHexString(s, 32);
const isText = (s, max = MAX_FIELD_LENGTH) => typeof s === "string" && s.trim().length > 0 && s.length <= max;

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const publicUser = (u) => ({
  id: u.id, email: u.email, name: u.name, role: u.role, status: u.status,
  organization: u.organization, wallet: u.wallet, createdAt: u.created_at,
});

const walletMessage = (nonce) =>
  `Link this wallet to your certificate account.\n\nThis costs nothing and sends no transaction.\n\nCode: ${nonce}`;

export function createApp({ db, chain, sealKey, config, demoEnabled = false }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "20mb" }));

  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const audit = (userId, action, detail = "") =>
    run("INSERT INTO audit_log (user_id, action, detail, created_at) VALUES (?, ?, ?, ?)", userId, action, detail, now());

  // Slows password and claim code guessing. Resets when the server restarts.
  const attempts = new Map();
  function limit(key) {
    const entry = attempts.get(key);
    const time = Date.now();
    if (!entry || time - entry.start > ATTEMPT_WINDOW_MS) {
      attempts.set(key, { start: time, count: 1 });
      return;
    }
    if (++entry.count > MAX_ATTEMPTS) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
  }

  function startSession(res, userId) {
    const token = randomToken();
    run("DELETE FROM sessions WHERE expires_at < ?", now());
    run("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", hashToken(token), userId, now() + SESSION_SECONDS);
    res.setHeader("Set-Cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_SECONDS}`);
  }

  function sessionToken(req) {
    const match = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return match && match[1];
  }

  app.use((req, res, next) => {
    const token = sessionToken(req);
    if (token) {
      req.user = get(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ? AND u.status != 'disabled'`,
        hashToken(token), now()
      );
    }
    next();
  });

  const signedIn = (req, res, next) => next(req.user ? undefined : new HttpError(401, "Please log in."));
  const role = (...roles) => (req, res, next) => {
    if (!req.user) return next(new HttpError(401, "Please log in."));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, "Your role can't do this."));
    if (req.user.status !== "active") return next(new HttpError(403, "Your account is waiting for approval."));
    next();
  };

  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const onChain = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      throw new HttpError(503, "The blockchain can't be reached, or the contract isn't deployed.");
    }
  };

  // ---- Public

  app.get("/api/config", wrap(async (req, res) => {
    const addresses = await chain.addresses().catch(() => ({ chainId: null, registry: null, baseline: null }));
    res.json({
      ...config,
      ...addresses,
      setupRequired: !get("SELECT 1 FROM users LIMIT 1"),
      demoEnabled,
      demoAccounts: demoEnabled ? all("SELECT role, name, email, organization FROM users WHERE is_demo = 1 ORDER BY id") : [],
    });
  }));

  app.post("/api/auth/signup", wrap(async (req, res) => {
    const { email, name, password, role: wanted, organization } = req.body ?? {};
    if (!isEmail(email)) throw new HttpError(400, "Enter a valid email address.");
    if (!isText(name)) throw new HttpError(400, "Enter your name.");
    if (typeof password !== "string" || password.length < 8 || password.length > 200) {
      throw new HttpError(400, "Use a password of at least 8 characters.");
    }
    const isFirst = !get("SELECT 1 FROM users LIMIT 1");
    const userRole = isFirst ? "admin" : wanted;
    if (!isFirst && !SIGNUP_ROLES.includes(userRole)) throw new HttpError(400, "Choose a role.");
    if (userRole === "issuer" && !isText(organization)) throw new HttpError(400, "Enter your organization's name.");
    if (get("SELECT 1 FROM users WHERE email = ?", email)) throw new HttpError(409, "An account with this email already exists.");

    const hash = await hashPassword(password);
    const { lastInsertRowid } = run(
      "INSERT INTO users (email, name, password_hash, role, status, organization, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      email, name.trim(), hash, userRole, userRole === "issuer" ? "pending" : "active",
      userRole === "issuer" ? organization.trim() : null, now()
    );
    audit(lastInsertRowid, "signup", userRole);
    startSession(res, lastInsertRowid);
    res.status(201).json({ user: publicUser(get("SELECT * FROM users WHERE id = ?", lastInsertRowid)) });
  }));

  // Compared when the email is unknown, so response time doesn't reveal which emails exist
  const dummyHash = hashPassword(randomToken());

  app.post("/api/auth/login", wrap(async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") throw new HttpError(400, "Enter your email and password.");
    limit(`login:${email.toLowerCase()}`);
    const user = get("SELECT * FROM users WHERE email = ?", email);
    const matches = await verifyPassword(password, user ? user.password_hash : await dummyHash);
    if (!user || !matches) throw new HttpError(401, "Incorrect email or password.");
    if (user.status === "disabled") throw new HttpError(403, "This account has been disabled.");
    attempts.delete(`login:${email.toLowerCase()}`);
    audit(user.id, "login");
    startSession(res, user.id);
    res.json({ user: publicUser(user) });
  }));

  // One-click login for seeded demo accounts only, which have random passwords nobody knows
  app.post("/api/auth/demo", (req, res) => {
    if (!demoEnabled) throw new HttpError(404, "Demo accounts are turned off.");
    const user = get("SELECT * FROM users WHERE email = ? AND is_demo = 1", String(req.body?.email ?? ""));
    if (!user) throw new HttpError(404, "That demo account doesn't exist.");
    if (user.status === "disabled") throw new HttpError(403, "This account has been disabled.");
    audit(user.id, "demo_login");
    startSession(res, user.id);
    res.json({ user: publicUser(user) });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = sessionToken(req);
    if (token) run("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
    res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.status(204).end();
  });

  app.get("/api/auth/me", (req, res) => res.json({ user: req.user ? publicUser(req.user) : null }));

  app.get("/api/share/:token", (req, res, next) => {
    const link = get("SELECT * FROM share_links WHERE token_hash = ?", hashToken(req.params.token));
    if (!link || link.revoked_at || link.expires_at < now()) return next(new HttpError(404, "This link has expired or doesn't exist."));
    run("UPDATE share_links SET views = views + 1 WHERE id = ?", link.id);
    res.json({ presentation: JSON.parse(unseal(sealKey, link.presentation_sealed)) });
  });

  // ---- Wallet linking: signing a one-time code proves the user holds the key

  app.post("/api/wallet/challenge", signedIn, (req, res) => {
    const nonce = randomToken();
    run("UPDATE users SET wallet_nonce = ? WHERE id = ?", nonce, req.user.id);
    res.json({ message: walletMessage(nonce) });
  });

  app.post("/api/wallet/link", signedIn, (req, res, next) => {
    const { address, signature } = req.body ?? {};
    const nonce = req.user.wallet_nonce;
    if (!nonce) return next(new HttpError(400, "Start wallet linking again."));
    let signer;
    try {
      signer = verifyMessage(walletMessage(nonce), signature);
    } catch {
      return next(new HttpError(400, "That signature isn't valid."));
    }
    if (typeof address !== "string" || signer.toLowerCase() !== address.toLowerCase()) {
      return next(new HttpError(400, "The signature doesn't match this wallet."));
    }
    if (get("SELECT 1 FROM users WHERE wallet = ? AND id != ?", signer, req.user.id)) {
      return next(new HttpError(409, "This wallet is linked to another account."));
    }
    run("UPDATE users SET wallet = ?, wallet_nonce = NULL WHERE id = ?", signer, req.user.id);
    audit(req.user.id, "wallet_linked", signer);
    res.json({ user: publicUser(get("SELECT * FROM users WHERE id = ?", req.user.id)) });
  });

  // ---- Issuer

  const issuer = role("issuer");

  app.get("/api/issuer/summary", issuer, (req, res) => {
    const id = req.user.id;
    res.json({
      certificates: get(
        `SELECT COUNT(*) total,
                COALESCE(SUM(c.status = 'active'), 0) active,
                COALESCE(SUM(c.status = 'revoked'), 0) revoked,
                COALESCE(SUM(c.student_id IS NOT NULL), 0) claimed
         FROM certificates c JOIN batches b ON b.id = c.batch_id
         WHERE c.issuer_id = ? AND b.status != 'draft'`, id),
      batches: get(
        `SELECT COUNT(*) total,
                COALESCE(SUM(gas_used), 0) gasUsed,
                COALESCE(SUM(baseline_gas), 0) baselineGas,
                COALESCE(SUM(stored_bytes), 0) storedBytes
         FROM batches WHERE issuer_id = ? AND status != 'draft'`, id),
    });
  });

  app.get("/api/issuer/batches", issuer, (req, res) => {
    res.json({ batches: all("SELECT * FROM batches WHERE issuer_id = ? ORDER BY id DESC", req.user.id) });
  });

  app.get("/api/issuer/certificates", issuer, (req, res) => {
    res.json({
      certificates: all(
        `SELECT c.id, c.certificate_id, c.uid, c.candidate_name, c.course_name, c.cgpa, c.completion_year,
                c.cert_root, c.batch_proof, c.status, c.revoked_reason, c.student_id IS NOT NULL AS claimed, b.root AS batch_root, b.published_at
         FROM certificates c JOIN batches b ON b.id = c.batch_id
         WHERE c.issuer_id = ? AND b.status != 'draft' ORDER BY c.id DESC`, req.user.id
      ).map((c) => ({ ...c, batch_proof: JSON.parse(c.batch_proof) })),
    });
  });

  // Saved before the transaction is sent, so credentials can't be lost if the browser closes mid-way
  app.post("/api/issuer/batches", issuer, (req, res) => {
    const { root, certificates, baselineGas, storedBytes } = req.body ?? {};
    if (!isBytes32(root)) throw new HttpError(400, "Invalid batch root.");
    if (!Array.isArray(certificates) || !certificates.length) throw new HttpError(400, "The batch is empty.");

    const ids = certificates.map((c) => c?.credential?.fields?.certificateId?.value);
    const duplicates = ids.filter((id) => get("SELECT 1 FROM certificates WHERE issuer_id = ? AND certificate_id = ?", req.user.id, id));
    if (duplicates.length) throw new HttpError(409, `Already used: ${duplicates.join(", ")}`, { duplicates });
    if (get("SELECT 1 FROM batches WHERE root = ?", root)) throw new HttpError(409, "This batch already exists.");

    const codes = [];
    transaction(db, () => {
      const { lastInsertRowid: batchId } = run(
        "INSERT INTO batches (root, issuer_id, status, count, baseline_gas, stored_bytes, created_at) VALUES (?, ?, 'draft', ?, ?, ?, ?)",
        root, req.user.id, certificates.length, Number(baselineGas) || null, Number(storedBytes) || null, now()
      );
      for (const { credential } of certificates) {
        const f = credential?.fields;
        if (!f || !isBytes32(credential.certRoot) || !Array.isArray(credential.batchProof)) {
          throw new HttpError(400, "A certificate in this batch is malformed.");
        }
        const code = randomClaimCode();
        run(
          `INSERT INTO certificates (batch_id, issuer_id, certificate_id, uid, candidate_name, course_name, cgpa, completion_year,
             cert_root, batch_proof, credential_sealed, claim_code_hash, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          batchId, req.user.id, f.certificateId.value, f.uid.value, f.candidateName.value, f.courseName.value, f.cgpa.value,
          f.completionYear.value, credential.certRoot, JSON.stringify(credential.batchProof),
          seal(sealKey, JSON.stringify(credential)), hashToken(code)
        );
        codes.push({ certificateId: f.certificateId.value, candidateName: f.candidateName.value, claimCode: code });
      }
    });
    audit(req.user.id, "batch_drafted", root);
    res.status(201).json({ codes });
  });

  const ownBatch = (req, root) => {
    const batch = get("SELECT * FROM batches WHERE root = ?", root);
    if (!batch || (batch.issuer_id !== req.user.id && req.user.role !== "admin")) throw new HttpError(404, "Batch not found.");
    return batch;
  };

  // Marks a draft as published only after the chain confirms it
  app.post("/api/issuer/batches/:root/confirm", issuer, wrap(async (req, res) => {
    const batch = ownBatch(req, req.params.root);
    const { txHash } = req.body ?? {};
    const onChainBatch = await onChain(() => chain.getBatch(batch.root));
    if (!onChainBatch.publishedAt) throw new HttpError(409, "This batch isn't on-chain yet.");
    if (onChainBatch.issuer.toLowerCase() !== String(req.user.wallet).toLowerCase()) {
      throw new HttpError(403, "This batch was signed by a different wallet.");
    }
    const gasUsed = isBytes32(txHash) ? await onChain(() => chain.getGasUsed(txHash)) : null;
    run(
      "UPDATE batches SET status = 'published', tx_hash = ?, gas_used = ?, published_at = ? WHERE id = ?",
      isBytes32(txHash) ? txHash : batch.tx_hash, gasUsed ?? batch.gas_used, onChainBatch.publishedAt, batch.id
    );
    audit(req.user.id, "batch_published", batch.root);
    res.json({ batch: get("SELECT * FROM batches WHERE id = ?", batch.id) });
  }));

  app.delete("/api/issuer/batches/:root", issuer, wrap(async (req, res) => {
    const batch = ownBatch(req, req.params.root);
    if (batch.status !== "draft") throw new HttpError(409, "Published batches can't be deleted. Revoke them instead.");
    const onChainBatch = await onChain(() => chain.getBatch(batch.root));
    if (onChainBatch.publishedAt) throw new HttpError(409, "This batch is already on-chain, so confirm it instead.");
    run("DELETE FROM batches WHERE id = ?", batch.id);
    audit(req.user.id, "batch_draft_deleted", batch.root);
    res.status(204).end();
  }));

  const ownCertificate = (req) => {
    const certificate = get("SELECT * FROM certificates WHERE id = ? AND issuer_id = ?", req.params.id, req.user.id);
    if (!certificate) throw new HttpError(404, "Certificate not found.");
    return certificate;
  };

  // The revocation itself is a chain transaction from the browser; this only records it
  app.post("/api/issuer/certificates/:id/revoked", issuer, wrap(async (req, res) => {
    const certificate = ownCertificate(req);
    const revocation = await onChain(() => chain.getRevocation(certificate.cert_root));
    if (!revocation.revokedAt) throw new HttpError(409, "This certificate isn't revoked on-chain.");
    run(
      "UPDATE certificates SET status = 'revoked', revoked_reason = ?, revoked_at = ? WHERE id = ?",
      revocation.reason, revocation.revokedAt, certificate.id
    );
    audit(req.user.id, "certificate_revoked", certificate.certificate_id);
    res.status(204).end();
  }));

  app.post("/api/issuer/certificates/:id/claim-code", issuer, (req, res) => {
    const certificate = ownCertificate(req);
    if (certificate.student_id) throw new HttpError(409, "This certificate has already been claimed.");
    const code = randomClaimCode();
    run("UPDATE certificates SET claim_code_hash = ? WHERE id = ?", hashToken(code), certificate.id);
    audit(req.user.id, "claim_code_reset", certificate.certificate_id);
    res.json({ claimCode: code });
  });

  // ---- Batch revocation, by the batch's issuer or the admin

  app.post("/api/batches/:root/revoked", role("issuer", "admin"), wrap(async (req, res) => {
    const batch = ownBatch(req, req.params.root);
    const revocation = await onChain(() => chain.getRevocation(batch.root));
    if (!revocation.revokedAt) throw new HttpError(409, "This batch isn't revoked on-chain.");
    transaction(db, () => {
      run("UPDATE batches SET status = 'revoked', revoked_reason = ? WHERE id = ?", revocation.reason, batch.id);
      run(
        "UPDATE certificates SET status = 'revoked', revoked_reason = ?, revoked_at = ? WHERE batch_id = ?",
        revocation.reason, revocation.revokedAt, batch.id
      );
    });
    audit(req.user.id, "batch_revoked", batch.root);
    res.status(204).end();
  }));

  // ---- Student

  const student = role("student");

  app.get("/api/student/certificates", student, (req, res) => {
    res.json({
      certificates: all(
        `SELECT c.id, c.certificate_id, c.candidate_name, c.course_name, c.completion_year, c.status, c.revoked_reason,
                u.organization AS issuer, b.published_at
         FROM certificates c JOIN batches b ON b.id = c.batch_id JOIN users u ON u.id = c.issuer_id
         WHERE c.student_id = ? ORDER BY c.id DESC`, req.user.id
      ),
    });
  });

  app.post("/api/student/claim", student, (req, res) => {
    limit(`claim:${req.user.id}`);
    const certificate = get(
      `SELECT c.* FROM certificates c JOIN batches b ON b.id = c.batch_id
       WHERE c.claim_code_hash = ? AND c.student_id IS NULL AND b.status != 'draft'`,
      hashToken(normalizeClaimCode(req.body?.code ?? ""))
    );
    if (!certificate) throw new HttpError(404, "That code isn't valid or has already been used.");
    run("UPDATE certificates SET student_id = ?, claim_code_hash = NULL WHERE id = ?", req.user.id, certificate.id);
    audit(req.user.id, "certificate_claimed", certificate.certificate_id);
    res.json({ certificateId: certificate.certificate_id });
  });

  const ownClaimed = (req, id) => {
    const certificate = get("SELECT * FROM certificates WHERE id = ? AND student_id = ?", id, req.user.id);
    if (!certificate) throw new HttpError(404, "Certificate not found.");
    return certificate;
  };

  app.get("/api/student/certificates/:id/credential", student, (req, res) => {
    res.json({ credential: JSON.parse(unseal(sealKey, ownClaimed(req, req.params.id).credential_sealed)) });
  });

  app.get("/api/student/shares", student, (req, res) => {
    res.json({
      shares: all(
        `SELECT s.id, s.fields, s.views, s.expires_at, s.revoked_at, s.created_at, c.certificate_id
         FROM share_links s JOIN certificates c ON c.id = s.certificate_id
         WHERE s.student_id = ? ORDER BY s.id DESC`, req.user.id
      ).map((s) => ({ ...s, fields: JSON.parse(s.fields) })),
    });
  });

  app.post("/api/student/certificates/:id/shares", student, (req, res) => {
    const certificate = ownClaimed(req, req.params.id);
    const { presentation, expiresInDays } = req.body ?? {};
    const days = Number(expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_SHARE_DAYS) throw new HttpError(400, "Choose an expiry of 1 to 365 days.");
    if (!Array.isArray(presentation?.disclosed) || presentation.certRoot !== certificate.cert_root) {
      throw new HttpError(400, "This presentation doesn't belong to this certificate.");
    }
    const token = randomToken();
    run(
      `INSERT INTO share_links (certificate_id, student_id, token_hash, presentation_sealed, fields, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      certificate.id, req.user.id, hashToken(token), seal(sealKey, JSON.stringify(presentation)),
      JSON.stringify(presentation.disclosed.map((f) => f.name)), now() + days * 86400, now()
    );
    audit(req.user.id, "share_created", certificate.certificate_id);
    res.status(201).json({ token });
  });

  app.delete("/api/student/shares/:id", student, (req, res) => {
    const { changes } = run("UPDATE share_links SET revoked_at = ? WHERE id = ? AND student_id = ? AND revoked_at IS NULL", now(), req.params.id, req.user.id);
    if (!changes) throw new HttpError(404, "Link not found.");
    audit(req.user.id, "share_revoked", req.params.id);
    res.status(204).end();
  });

  // ---- Verification history. Each browser checks the chain itself; this is only a log of results.

  app.get("/api/verifications", signedIn, (req, res) => {
    res.json({ verifications: all("SELECT * FROM verifications WHERE user_id = ? ORDER BY id DESC LIMIT 500", req.user.id) });
  });

  app.post("/api/verifications", signedIn, (req, res) => {
    const { status, certificateRef, issuerName, batchRoot, message } = req.body ?? {};
    if (!isText(status, 40)) throw new HttpError(400, "Invalid result.");
    const short = (v) => (typeof v === "string" ? v.slice(0, 500) : null);
    run(
      "INSERT INTO verifications (user_id, status, certificate_ref, issuer_name, batch_root, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      req.user.id, status, short(certificateRef), short(issuerName), short(batchRoot), short(message), now()
    );
    res.status(201).end();
  });

  // ---- Admin

  const admin = role("admin");

  app.get("/api/admin/summary", admin, (req, res) => {
    res.json({
      users: all("SELECT role, status, COUNT(*) count FROM users GROUP BY role, status"),
      certificates: get(
        `SELECT COUNT(*) total, COALESCE(SUM(c.status = 'revoked'), 0) revoked
         FROM certificates c JOIN batches b ON b.id = c.batch_id WHERE b.status != 'draft'`
      ),
      batches: get("SELECT COUNT(*) total, COALESCE(SUM(gas_used), 0) gasUsed FROM batches WHERE status != 'draft'"),
    });
  });

  app.get("/api/admin/users", admin, (req, res) => {
    res.json({ users: all("SELECT * FROM users ORDER BY id DESC").map(publicUser) });
  });

  app.get("/api/admin/batches", admin, (req, res) => {
    res.json({
      batches: all(
        `SELECT b.*, u.organization AS issuer FROM batches b JOIN users u ON u.id = b.issuer_id
         WHERE b.status != 'draft' ORDER BY b.id DESC`
      ),
    });
  });

  app.get("/api/admin/audit", admin, (req, res) => {
    res.json({
      entries: all(
        `SELECT a.id, a.action, a.detail, a.created_at, u.email
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 500`
      ),
    });
  });

  const targetUser = (req) => {
    const user = get("SELECT * FROM users WHERE id = ?", req.params.id);
    if (!user) throw new HttpError(404, "User not found.");
    return user;
  };

  // The admin sends addIssuer from their wallet first; the chain stays the source of truth
  app.post("/api/admin/users/:id/approve", admin, wrap(async (req, res) => {
    const user = targetUser(req);
    if (user.role !== "issuer") throw new HttpError(400, "Only issuer accounts need approval.");
    if (!user.wallet) throw new HttpError(409, "This issuer hasn't linked a wallet yet.");
    const onChainIssuer = await onChain(() => chain.getIssuer(getAddress(user.wallet)));
    if (!onChainIssuer.active || onChainIssuer.name !== user.organization) {
      throw new HttpError(409, "This wallet isn't approved on-chain under this organization's name.");
    }
    run("UPDATE users SET status = 'active' WHERE id = ?", user.id);
    audit(req.user.id, "issuer_approved", user.email);
    res.json({ user: publicUser(get("SELECT * FROM users WHERE id = ?", user.id)) });
  }));

  app.post("/api/admin/users/:id/disable", admin, (req, res) => {
    const user = targetUser(req);
    if (user.id === req.user.id) throw new HttpError(400, "You can't disable your own account.");
    transaction(db, () => {
      run("UPDATE users SET status = 'disabled' WHERE id = ?", user.id);
      run("DELETE FROM sessions WHERE user_id = ?", user.id);
    });
    audit(req.user.id, "user_disabled", user.email);
    res.json({ user: publicUser(get("SELECT * FROM users WHERE id = ?", user.id)) });
  });

  app.post("/api/admin/users/:id/enable", admin, (req, res) => {
    const user = targetUser(req);
    // A re-enabled issuer goes back through approval, in case it was removed on-chain
    run("UPDATE users SET status = ? WHERE id = ?", user.role === "issuer" ? "pending" : "active", user.id);
    audit(req.user.id, "user_enabled", user.email);
    res.json({ user: publicUser(get("SELECT * FROM users WHERE id = ?", user.id)) });
  });

  // ---- Errors

  app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
    if (err.type === "entity.parse.failed" || err.type === "entity.too.large") {
      return res.status(400).json({ error: "The request body is invalid or too large." });
    }
    console.error(err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });

  return app;
}
