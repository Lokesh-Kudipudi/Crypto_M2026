import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'issuer', 'student', 'verifier')),
  status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'disabled')),
  organization TEXT,
  wallet TEXT UNIQUE COLLATE NOCASE,
  wallet_nonce TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY,
  root TEXT NOT NULL UNIQUE,
  issuer_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'revoked')),
  count INTEGER NOT NULL,
  tx_hash TEXT,
  gas_used INTEGER,
  baseline_gas INTEGER,
  stored_bytes INTEGER,
  revoked_reason TEXT,
  created_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE TABLE IF NOT EXISTS certificates (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  issuer_id INTEGER NOT NULL REFERENCES users(id),
  certificate_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  candidate_name TEXT NOT NULL,
  course_name TEXT NOT NULL,
  cgpa TEXT NOT NULL,
  completion_year TEXT NOT NULL,
  cert_root TEXT NOT NULL UNIQUE,
  batch_proof TEXT NOT NULL,
  credential_sealed TEXT NOT NULL,
  claim_code_hash TEXT,
  student_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revoked_reason TEXT,
  revoked_at INTEGER,
  UNIQUE (issuer_id, certificate_id)
);

CREATE TABLE IF NOT EXISTS share_links (
  id INTEGER PRIMARY KEY,
  certificate_id INTEGER NOT NULL REFERENCES certificates(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  presentation_sealed TEXT NOT NULL,
  fields TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS verifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  certificate_ref TEXT,
  issuer_name TEXT,
  batch_root TEXT,
  message TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
`;

export function openDatabase(file) {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  // Added after the first release, so existing databases need it too
  if (!db.prepare("PRAGMA table_info(users)").all().some((c) => c.name === "is_demo")) {
    db.exec("ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0");
  }
  return db;
}

/** Run fn inside a transaction, rolling back if it throws. */
export function transaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
