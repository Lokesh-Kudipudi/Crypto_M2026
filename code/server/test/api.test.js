import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { Wallet, hexlify } from "ethers";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { normalizeClaimCode, randomClaimCode, seal, unseal } from "../src/security.js";

const hash = () => hexlify(randomBytes(32));

// In-memory stand-in for the chain, so each test controls what's "on-chain"
function fakeChain() {
  const state = { issuers: new Map(), batches: new Map(), revocations: new Map(), gas: new Map() };
  return {
    state,
    addresses: async () => ({ chainId: 1337, registry: "0x" + "1".repeat(40), baseline: "0x" + "2".repeat(40) }),
    getIssuer: async (a) => state.issuers.get(a.toLowerCase()) ?? { name: "", active: false },
    getBatch: async (r) => state.batches.get(r) ?? { issuer: "0x" + "0".repeat(40), publishedAt: 0, count: 0 },
    getRevocation: async (r) => state.revocations.get(r) ?? { revokedAt: 0, reason: "" },
    getGasUsed: async (t) => state.gas.get(t) ?? null,
  };
}

const credential = (id, name = "Asha Rao") => {
  const field = (value) => ({ value, salt: hash() });
  return {
    certRoot: hash(),
    batchProof: [],
    pdfKey: hash(),
    fields: {
      certificateId: field(id), uid: field("U1"), candidateName: field(name), courseName: field("B.Tech"),
      organizationName: field("Demo University"), cgpa: field("8.5"), completionYear: field("2026"),
      pdfSha256: field(hash()), pdfCid: field("QmDemo"),
    },
  };
};

describe("API", () => {
  let server, base, chain, db, demoOffBase, demoOffServer;

  // A small client that keeps one account's session cookie
  const client = () => {
    let cookie = "";
    const call = async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, setCookie: set };
    };
    return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), del: (p) => call("DELETE", p) };
  };

  const signup = async (role, email, extra = {}) => {
    const c = client();
    const res = await c.post("/api/auth/signup", { email, name: "Test", password: "correct horse", role, ...extra });
    assert.equal(res.status, 201);
    return { c, user: res.body.user };
  };

  const linkWallet = async (c, wallet) => {
    const { body: { message } } = await c.post("/api/wallet/challenge");
    return c.post("/api/wallet/link", { address: wallet.address, signature: await wallet.signMessage(message) });
  };

  // Admin, an approved issuer with a wallet, and a student
  const world = async () => {
    const { c: admin } = await signup(null, "admin@test.io");
    const { c: issuer, user } = await signup("issuer", "issuer@test.io", { organization: "Demo University" });
    const wallet = Wallet.createRandom();
    await linkWallet(issuer, wallet);
    chain.state.issuers.set(wallet.address.toLowerCase(), { name: "Demo University", active: true });
    assert.equal((await admin.post(`/api/admin/users/${user.id}/approve`)).status, 200);
    const { c: student } = await signup("student", "student@test.io");
    return { admin, issuer, student, wallet };
  };

  const publish = async (issuer, wallet, ids = ["C-1"]) => {
    const root = hash();
    const creds = ids.map((id) => credential(id));
    const draft = await issuer.post("/api/issuer/batches", { root, certificates: creds.map((c) => ({ credential: c })), baselineGas: 500000 });
    assert.equal(draft.status, 201);
    const txHash = hash();
    chain.state.batches.set(root, { issuer: wallet.address, publishedAt: 1000, count: ids.length });
    chain.state.gas.set(txHash, 57000);
    const confirmed = await issuer.post(`/api/issuer/batches/${root}/confirm`, { txHash });
    assert.equal(confirmed.status, 200);
    return { root, creds, codes: draft.body.codes };
  };

  before(async () => {
    await new Promise((resolve) => {
      db = openDatabase(":memory:");
      chain = fakeChain();
      const options = { db, chain, sealKey: randomBytes(32), config: { rpcUrl: "x", ipfsApi: "y" } };
      server = createApp({ ...options, demoEnabled: true }).listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${server.address().port}`;
        demoOffServer = createApp(options).listen(0, "127.0.0.1", () => {
          demoOffBase = `http://127.0.0.1:${demoOffServer.address().port}`;
          resolve();
        });
      });
    });
  });

  after(() => {
    server.close();
    demoOffServer.close();
  });

  beforeEach(() => {
    db.exec("DELETE FROM verifications; DELETE FROM share_links; DELETE FROM certificates; DELETE FROM batches; DELETE FROM sessions; DELETE FROM audit_log; DELETE FROM users;");
    chain.state.issuers.clear();
    chain.state.batches.clear();
    chain.state.revocations.clear();
  });

  describe("accounts", () => {
    it("makes the first account the admin, whatever role it asks for", async () => {
      const { user } = await signup("student", "first@test.io");
      assert.equal(user.role, "admin");
      assert.equal((await signup("student", "second@test.io")).user.role, "student");
    });

    it("never lets later signups choose admin", async () => {
      await signup(null, "admin@test.io");
      const res = await client().post("/api/auth/signup", { email: "x@test.io", name: "X", password: "correct horse", role: "admin" });
      assert.equal(res.status, 400);
    });

    it("rejects weak passwords, bad emails and duplicate emails", async () => {
      await signup(null, "admin@test.io");
      const c = client();
      const base = { name: "X", role: "student" };
      assert.equal((await c.post("/api/auth/signup", { ...base, email: "x@test.io", password: "short" })).status, 400);
      assert.equal((await c.post("/api/auth/signup", { ...base, email: "nope", password: "correct horse" })).status, 400);
      assert.equal((await c.post("/api/auth/signup", { ...base, email: "ADMIN@test.io", password: "correct horse" })).status, 409);
    });

    it("stores a salted password hash and an HttpOnly, SameSite=Strict cookie", async () => {
      const c = client();
      const res = await c.post("/api/auth/signup", { email: "a@test.io", name: "A", password: "correct horse" });
      assert.match(res.setCookie, /HttpOnly; SameSite=Strict/);
      const row = db.prepare("SELECT password_hash FROM users").get();
      assert.match(row.password_hash, /^scrypt\$/);
      assert.ok(!row.password_hash.includes("correct horse"));
    });

    it("logs in and out, and gives the same error for a wrong password or unknown email", async () => {
      await signup(null, "admin@test.io");
      const c = client();
      const wrong = await c.post("/api/auth/login", { email: "admin@test.io", password: "wrong password" });
      const unknown = await c.post("/api/auth/login", { email: "ghost@test.io", password: "wrong password" });
      assert.equal(wrong.status, 401);
      assert.deepEqual(wrong.body, unknown.body);

      assert.equal((await c.post("/api/auth/login", { email: "admin@test.io", password: "correct horse" })).status, 200);
      assert.equal((await c.get("/api/auth/me")).body.user.email, "admin@test.io");
      await c.post("/api/auth/logout");
      assert.equal((await c.get("/api/auth/me")).body.user, null);
    });

    it("limits repeated login attempts", async () => {
      await signup(null, "limit@test.io");
      const c = client();
      let last;
      for (let i = 0; i < 11; i++) last = await c.post("/api/auth/login", { email: "limit@test.io", password: "wrong password" });
      assert.equal(last.status, 429);
    });

    it("signs a disabled user out straight away", async () => {
      const { c: admin } = await signup(null, "admin@test.io");
      const { c: student, user } = await signup("student", "s@test.io");
      await admin.post(`/api/admin/users/${user.id}/disable`);
      assert.equal((await student.get("/api/auth/me")).body.user, null);
      assert.equal((await student.post("/api/auth/login", { email: "s@test.io", password: "correct horse" })).status, 403);
    });
  });

  describe("demo accounts", () => {
    const markDemo = (id) => db.prepare("UPDATE users SET is_demo = 1 WHERE id = ?").run(id);

    it("logs in to a demo account with no password, and lists it in the config", async () => {
      await signup(null, "admin@test.io");
      const { user } = await signup("student", "demo@test.io");
      markDemo(user.id);

      assert.deepEqual((await client().get("/api/config")).body.demoAccounts, [
        { role: "student", name: "Test", email: "demo@test.io", organization: null },
      ]);
      const c = client();
      assert.equal((await c.post("/api/auth/demo", { email: "demo@test.io" })).body.user.id, user.id);
      assert.equal((await c.get("/api/auth/me")).body.user.email, "demo@test.io");
    });

    it("refuses accounts that aren't demo accounts", async () => {
      await signup(null, "admin@test.io");
      const res = await client().post("/api/auth/demo", { email: "admin@test.io" });
      assert.equal(res.status, 404);
      assert.equal(res.body.user, undefined);
      assert.equal((await client().post("/api/auth/demo", { email: { $ne: "" } })).status, 404);
    });

    it("refuses a disabled demo account", async () => {
      const { c: admin } = await signup(null, "admin@test.io");
      const { user } = await signup("student", "demo@test.io");
      markDemo(user.id);
      await admin.post(`/api/admin/users/${user.id}/disable`);
      assert.equal((await client().post("/api/auth/demo", { email: "demo@test.io" })).status, 403);
    });

    it("turns off completely when demo mode is off", async () => {
      await signup(null, "admin@test.io");
      const { user } = await signup("student", "demo@test.io");
      markDemo(user.id);
      const config = await (await fetch(`${demoOffBase}/api/config`)).json();
      assert.equal(config.demoEnabled, false);
      assert.deepEqual(config.demoAccounts, []);
      const res = await fetch(`${demoOffBase}/api/auth/demo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "demo@test.io" }),
      });
      assert.equal(res.status, 404);
      assert.equal(res.headers.get("set-cookie"), null);
    });
  });

  describe("roles", () => {
    it("blocks other roles and anonymous users from each dashboard's data", async () => {
      const { admin, issuer, student } = await world();
      assert.equal((await client().get("/api/issuer/summary")).status, 401);
      assert.equal((await student.get("/api/issuer/summary")).status, 403);
      assert.equal((await issuer.get("/api/admin/users")).status, 403);
      assert.equal((await admin.get("/api/student/certificates")).status, 403);
      assert.equal((await issuer.post("/api/student/claim", { code: "x" })).status, 403);
    });

    it("keeps a new issuer pending until the wallet is approved on-chain", async () => {
      const { c: admin } = await signup(null, "admin@test.io");
      const { c: issuer, user } = await signup("issuer", "i@test.io", { organization: "Uni" });
      assert.equal(user.status, "pending");
      assert.equal((await issuer.get("/api/issuer/summary")).status, 403);

      assert.equal((await admin.post(`/api/admin/users/${user.id}/approve`)).status, 409);
      const wallet = Wallet.createRandom();
      await linkWallet(issuer, wallet);
      assert.equal((await admin.post(`/api/admin/users/${user.id}/approve`)).status, 409);

      chain.state.issuers.set(wallet.address.toLowerCase(), { name: "Another Name", active: true });
      assert.equal((await admin.post(`/api/admin/users/${user.id}/approve`)).status, 409);

      chain.state.issuers.set(wallet.address.toLowerCase(), { name: "Uni", active: true });
      assert.equal((await admin.post(`/api/admin/users/${user.id}/approve`)).status, 200);
      assert.equal((await issuer.get("/api/issuer/summary")).status, 200);
    });
  });

  describe("wallet linking", () => {
    it("needs a signature from the wallet, and a code can't be reused", async () => {
      const { c } = await signup(null, "admin@test.io");
      const wallet = Wallet.createRandom();
      const { body: { message } } = await c.post("/api/wallet/challenge");
      const signature = await wallet.signMessage(message);

      const other = await Wallet.createRandom().signMessage(message);
      assert.equal((await c.post("/api/wallet/link", { address: wallet.address, signature: other })).status, 400);
      assert.equal((await c.post("/api/wallet/link", { address: wallet.address, signature })).body.user.wallet, wallet.address);
      assert.equal((await c.post("/api/wallet/link", { address: wallet.address, signature })).status, 400);
    });

    it("stops one wallet being linked to two accounts", async () => {
      const wallet = Wallet.createRandom();
      await linkWallet((await signup(null, "a@test.io")).c, wallet);
      assert.equal((await linkWallet((await signup("student", "b@test.io")).c, wallet)).status, 409);
    });
  });

  describe("batches", () => {
    it("won't confirm a batch that isn't on-chain or was signed by another wallet", async () => {
      const { issuer } = await world();
      const root = hash();
      await issuer.post("/api/issuer/batches", { root, certificates: [{ credential: credential("C-1") }] });
      assert.equal((await issuer.post(`/api/issuer/batches/${root}/confirm`)).status, 409);

      chain.state.batches.set(root, { issuer: Wallet.createRandom().address, publishedAt: 1000, count: 1 });
      assert.equal((await issuer.post(`/api/issuer/batches/${root}/confirm`)).status, 403);
    });

    it("rejects a certificate ID this issuer has already used", async () => {
      const { issuer, wallet } = await world();
      await publish(issuer, wallet, ["C-1"]);
      const res = await issuer.post("/api/issuer/batches", { root: hash(), certificates: [{ credential: credential("C-1") }] });
      assert.equal(res.status, 409);
      assert.deepEqual(res.body.duplicates, ["C-1"]);
    });

    it("saves nothing if one certificate in a batch is malformed", async () => {
      const { issuer } = await world();
      const bad = credential("C-2");
      bad.certRoot = "nope";
      const res = await issuer.post("/api/issuer/batches", { root: hash(), certificates: [{ credential: credential("C-1") }, { credential: bad }] });
      assert.equal(res.status, 400);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM batches").get().n, 0);
    });

    it("deletes a draft but not a published batch", async () => {
      const { issuer, wallet } = await world();
      const draft = hash();
      await issuer.post("/api/issuer/batches", { root: draft, certificates: [{ credential: credential("C-9") }] });
      assert.equal((await issuer.del(`/api/issuer/batches/${draft}`)).status, 204);
      const { root } = await publish(issuer, wallet);
      assert.equal((await issuer.del(`/api/issuer/batches/${root}`)).status, 409);
    });

    it("reports gas from the chain in the summary and hides drafts", async () => {
      const { issuer, wallet } = await world();
      await publish(issuer, wallet, ["C-1", "C-2"]);
      await issuer.post("/api/issuer/batches", { root: hash(), certificates: [{ credential: credential("C-3") }] });
      const { body } = await issuer.get("/api/issuer/summary");
      assert.equal(body.certificates.total, 2);
      assert.equal(body.batches.gasUsed, 57000);
      assert.equal(body.batches.baselineGas, 500000);
    });

    it("stops one issuer touching another's batches and certificates", async () => {
      const { admin, issuer, wallet } = await world();
      const { root } = await publish(issuer, wallet);
      const { c: other, user } = await signup("issuer", "o@test.io", { organization: "Other" });
      const otherWallet = Wallet.createRandom();
      await linkWallet(other, otherWallet);
      chain.state.issuers.set(otherWallet.address.toLowerCase(), { name: "Other", active: true });
      await admin.post(`/api/admin/users/${user.id}/approve`);

      const certId = db.prepare("SELECT id FROM certificates").get().id;
      assert.equal((await other.post(`/api/issuer/batches/${root}/confirm`)).status, 404);
      assert.equal((await other.post(`/api/batches/${root}/revoked`)).status, 404);
      assert.equal((await other.post(`/api/issuer/certificates/${certId}/revoked`)).status, 404);
      assert.equal((await other.post(`/api/issuer/certificates/${certId}/claim-code`)).status, 404);
      assert.equal((await other.get("/api/issuer/certificates")).body.certificates.length, 0);
    });
  });

  describe("revocation records", () => {
    it("only records a revocation the chain confirms, and uses the chain's reason", async () => {
      const { issuer, wallet } = await world();
      await publish(issuer, wallet);
      const cert = db.prepare("SELECT id, cert_root FROM certificates").get();
      assert.equal((await issuer.post(`/api/issuer/certificates/${cert.id}/revoked`)).status, 409);

      chain.state.revocations.set(cert.cert_root, { revokedAt: 2000, reason: "Issued in error" });
      assert.equal((await issuer.post(`/api/issuer/certificates/${cert.id}/revoked`)).status, 204);
      const [row] = (await issuer.get("/api/issuer/certificates")).body.certificates;
      assert.equal(row.status, "revoked");
      assert.equal(row.revoked_reason, "Issued in error");
    });

    it("marks every certificate when a batch is revoked, for the admin too", async () => {
      const { admin, issuer, wallet } = await world();
      const { root } = await publish(issuer, wallet, ["C-1", "C-2"]);
      chain.state.revocations.set(root, { revokedAt: 2000, reason: "Key stolen" });
      assert.equal((await admin.post(`/api/batches/${root}/revoked`)).status, 204);
      const { certificates } = (await issuer.get("/api/issuer/certificates")).body;
      assert.ok(certificates.every((c) => c.status === "revoked" && c.revoked_reason === "Key stolen"));
    });
  });

  describe("claiming", () => {
    it("gives a student the credential with a code that only works once", async () => {
      const { issuer, student, wallet } = await world();
      const { codes, creds } = await publish(issuer, wallet);

      assert.equal((await student.post("/api/student/claim", { code: "WRONG" })).status, 404);
      assert.equal((await student.post("/api/student/claim", { code: codes[0].claimCode.toLowerCase() })).status, 200);

      const [cert] = (await student.get("/api/student/certificates")).body.certificates;
      assert.equal(cert.issuer, "Demo University");
      const { body } = await student.get(`/api/student/certificates/${cert.id}/credential`);
      assert.deepEqual(body.credential, creds[0]);

      const { c: other } = await signup("student", "other@test.io");
      assert.equal((await other.post("/api/student/claim", { code: codes[0].claimCode })).status, 404);
      assert.equal((await other.get(`/api/student/certificates/${cert.id}/credential`)).status, 404);
    });

    it("can't claim from a draft", async () => {
      const { issuer, student } = await world();
      const { body } = await issuer.post("/api/issuer/batches", { root: hash(), certificates: [{ credential: credential("C-1") }] });
      assert.equal((await student.post("/api/student/claim", { code: body.codes[0].claimCode })).status, 404);
    });

    it("replaces a lost code, and the old one stops working", async () => {
      const { issuer, student, wallet } = await world();
      const { codes } = await publish(issuer, wallet);
      const { id } = db.prepare("SELECT id FROM certificates").get();
      const { body } = await issuer.post(`/api/issuer/certificates/${id}/claim-code`);
      assert.equal((await student.post("/api/student/claim", { code: codes[0].claimCode })).status, 404);
      assert.equal((await student.post("/api/student/claim", { code: body.claimCode })).status, 200);
      assert.equal((await issuer.post(`/api/issuer/certificates/${id}/claim-code`)).status, 409);
    });

    it("keeps codes, salts and PDF keys out of the database in plain text", async () => {
      const { issuer, wallet } = await world();
      const { codes, creds } = await publish(issuer, wallet);
      const row = JSON.stringify(db.prepare("SELECT * FROM certificates").get());
      assert.ok(!row.includes(codes[0].claimCode));
      assert.ok(!row.includes(creds[0].pdfKey));
      assert.ok(!row.includes(creds[0].fields.cgpa.salt));
    });
  });

  describe("share links", () => {
    const setup = async () => {
      const w = await world();
      const { codes, creds } = await publish(w.issuer, w.wallet);
      await w.student.post("/api/student/claim", { code: codes[0].claimCode });
      const [cert] = (await w.student.get("/api/student/certificates")).body.certificates;
      const presentation = { version: 1, certRoot: creds[0].certRoot, disclosed: [{ name: "courseName", value: "B.Tech" }] };
      return { ...w, cert, presentation };
    };

    it("serves a presentation publicly by token, counts views, and can be revoked", async () => {
      const { student, cert, presentation } = await setup();
      const { body: { token } } = await student.post(`/api/student/certificates/${cert.id}/shares`, { presentation, expiresInDays: 7 });

      assert.deepEqual((await client().get(`/api/share/${token}`)).body.presentation, presentation);
      const [share] = (await student.get("/api/student/shares")).body.shares;
      assert.equal(share.views, 1);
      assert.deepEqual(share.fields, ["courseName"]);

      assert.equal((await student.del(`/api/student/shares/${share.id}`)).status, 204);
      assert.equal((await client().get(`/api/share/${token}`)).status, 404);
    });

    it("stops serving an expired link", async () => {
      const { student, cert, presentation } = await setup();
      const { body: { token } } = await student.post(`/api/student/certificates/${cert.id}/shares`, { presentation, expiresInDays: 1 });
      db.exec("UPDATE share_links SET expires_at = 1");
      assert.equal((await client().get(`/api/share/${token}`)).status, 404);
    });

    it("rejects a presentation for a different certificate and a bad expiry", async () => {
      const { student, cert, presentation } = await setup();
      const path = `/api/student/certificates/${cert.id}/shares`;
      assert.equal((await student.post(path, { presentation: { ...presentation, certRoot: hash() }, expiresInDays: 7 })).status, 400);
      assert.equal((await student.post(path, { presentation, expiresInDays: 0 })).status, 400);
      assert.equal((await student.post(path, { presentation, expiresInDays: 9999 })).status, 400);
    });

    it("stops another student revoking a link or sharing the certificate", async () => {
      const { student, cert, presentation } = await setup();
      await student.post(`/api/student/certificates/${cert.id}/shares`, { presentation, expiresInDays: 7 });
      const [share] = (await student.get("/api/student/shares")).body.shares;
      const { c: other } = await signup("student", "other@test.io");
      assert.equal((await other.del(`/api/student/shares/${share.id}`)).status, 404);
      assert.equal((await other.post(`/api/student/certificates/${cert.id}/shares`, { presentation, expiresInDays: 7 })).status, 404);
    });
  });

  describe("verification history", () => {
    it("is private to each user", async () => {
      const { c: a } = await signup(null, "a@test.io");
      const { c: b } = await signup("verifier", "b@test.io");
      assert.equal((await client().post("/api/verifications", { status: "VALID" })).status, 401);
      await a.post("/api/verifications", { status: "VALID", certificateRef: "C-1" });
      assert.equal((await a.get("/api/verifications")).body.verifications.length, 1);
      assert.equal((await b.get("/api/verifications")).body.verifications.length, 0);
    });
  });

  describe("admin", () => {
    it("records actions in the audit log, and can't disable itself", async () => {
      const { c: admin, user } = await signup(null, "admin@test.io");
      assert.equal((await admin.post(`/api/admin/users/${user.id}/disable`)).status, 400);
      const { body } = await admin.get("/api/admin/audit");
      assert.ok(body.entries.some((e) => e.action === "signup"));
    });

    it("sends a re-enabled issuer back through approval", async () => {
      const { admin, issuer } = await world();
      const { id } = (await issuer.get("/api/auth/me")).body.user;
      await admin.post(`/api/admin/users/${id}/disable`);
      assert.equal((await admin.post(`/api/admin/users/${id}/enable`)).body.user.status, "pending");
    });
  });

  describe("helpers", () => {
    it("seals and unseals, and detects a changed value", () => {
      const key = randomBytes(32);
      const sealed = seal(key, "secret");
      assert.equal(unseal(key, sealed), "secret");
      const [iv, tag, body] = sealed.split(".");
      const flipped = Buffer.from(body, "base64");
      flipped[0] ^= 1;
      assert.throws(() => unseal(key, [iv, tag, flipped.toString("base64")].join(".")));
      assert.throws(() => unseal(randomBytes(32), sealed));
    });

    it("makes claim codes in a typed-friendly format", () => {
      const code = randomClaimCode();
      assert.match(code, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
      assert.equal(normalizeClaimCode(code.toLowerCase().replaceAll("-", " ")), code);
    });
  });
});
