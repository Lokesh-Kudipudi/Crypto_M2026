#!/usr/bin/env node
// Repairs an IPFS repo whose `config` file Kubo 0.4x cannot load, WITHOUT running `ipfs init` and without
// touching keys, blocks, pins or the datastore.
//
//   node scripts/repair-ipfs-config.mjs [repoPath]            # dry run: writes <repo>/config.repaired, changes nothing else
//   node scripts/repair-ipfs-config.mjs [repoPath] --apply    # keeps the broken file as config.broken.<timestamp>, installs the repaired one
//
// Why this exists: if `config` has no Identity.PrivKey (or legacy value types such as `"Version": 15` or
// `Swarm.Transports.Network.TCP: true`), `ipfs daemon` stops with "failure to decode config" and IPFS Desktop
// cannot start. Kubo itself saved a complete, valid copy as `config.backup` when it migrated the repo.
//
// MERGE strategy: start from config.backup (valid, has your Identity) and overlay only the settings you
// deliberately changed in the broken file: API.HTTPHeaders (origins are unioned, never dropped), Addresses.API,
// Addresses.Gateway. The private key is never printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const repo = path.resolve(args.find((a) => !a.startsWith("--")) || process.env.IPFS_PATH || path.join(os.homedir(), ".ipfs"));
const REQUIRED_ORIGINS = ["http://localhost:8080", "http://127.0.0.1:8080"];

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
const fail = (m) => { console.error("ERROR: " + m); process.exit(1); };
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

const cfgPath = path.join(repo, "config");
const bakPath = path.join(repo, "config.backup");
if (!fs.existsSync(cfgPath)) fail(`no config file in ${repo}`);
console.log(`Repo: ${repo}`);

let cfg;
try { cfg = readJson(cfgPath); } catch (e) { cfg = null; console.log(`config is not valid JSON (${e.message}); will rebuild from config.backup`); }

const problems = [];
if (cfg) {
  if (!cfg.Identity || !cfg.Identity.PrivKey) problems.push("Identity.PrivKey is missing (Kubo cannot start without it)");
  if (cfg.Version !== undefined && !isObj(cfg.Version)) problems.push(`Version is ${JSON.stringify(cfg.Version)}, Kubo 0.4x expects an object`);
  const net = cfg.Swarm?.Transports?.Network || {};
  for (const [k, v] of Object.entries(net)) if (typeof v === "boolean") problems.push(`Swarm.Transports.Network.${k} is a boolean (Kubo 0.4x expects a priority)`);
}
if (cfg && problems.length === 0) {
  console.log("config looks structurally loadable. Nothing to repair.");
  console.log("If CORS still fails, the daemon simply needs a RESTART (see scripts\\diagnose-ipfs.ps1).");
  process.exit(0);
}
problems.forEach((p) => console.log("  problem: " + p));

if (!fs.existsSync(bakPath)) fail("config.backup not found, so there is no valid base to merge into. Restore your Identity from a backup, or ask for help; do NOT run `ipfs init` on this repo.");
const base = readJson(bakPath);
if (!base.Identity || !base.Identity.PrivKey || !base.Identity.PeerID) fail("config.backup has no Identity either; cannot repair safely.");
if (!isObj(base.Version)) fail("config.backup itself has a legacy shape; cannot use it as a base.");

const out = structuredClone(base);
const changes = [];
if (cfg) {
  // API.HTTPHeaders: union of origins (backup + broken file + required dev origins), other headers copied over.
  const cur = cfg.API?.HTTPHeaders || {};
  out.API = out.API || {};
  out.API.HTTPHeaders = { ...(out.API.HTTPHeaders || {}) };
  for (const [k, v] of Object.entries(cur)) {
    if (!Array.isArray(v)) continue;
    const prev = out.API.HTTPHeaders[k] || [];
    out.API.HTTPHeaders[k] = [...new Set([...prev, ...v])];
  }
  for (const a of [["Access-Control-Allow-Methods", ["GET", "POST", "OPTIONS"]], ["Access-Control-Allow-Headers", ["Content-Type"]]]) {
    out.API.HTTPHeaders[a[0]] = [...new Set([...(out.API.HTTPHeaders[a[0]] || []), ...a[1]])];
  }
  changes.push("API.HTTPHeaders merged from broken config");
  for (const k of ["API", "Gateway"]) {
    const v = cfg.Addresses?.[k];
    if (typeof v === "string" && v && v !== out.Addresses?.[k]) { out.Addresses[k] = v; changes.push(`Addresses.${k} = ${v}`); }
  }
}
out.API = out.API || {};
out.API.HTTPHeaders = out.API.HTTPHeaders || {};
const o = (out.API.HTTPHeaders["Access-Control-Allow-Origin"] ||= []);
for (const r of REQUIRED_ORIGINS) if (!o.includes(r)) { o.push(r); changes.push(`added origin ${r}`); }
out.API.HTTPHeaders["Access-Control-Allow-Methods"] ||= ["GET", "POST", "OPTIONS"];
out.API.HTTPHeaders["Access-Control-Allow-Headers"] ||= ["Content-Type"];

// sanity checks on the result (never print the key)
if (out.Identity.PrivKey !== base.Identity.PrivKey || out.Identity.PeerID !== base.Identity.PeerID) fail("internal error: identity changed");
console.log(`Identity preserved (PeerID ${out.Identity.PeerID}, private key kept, not shown).`);
console.log("Allow-Origin  : " + o.join(", "));
console.log("Changes       : " + (changes.length ? changes.join("; ") : "none beyond the backup"));

const repaired = path.join(repo, "config.repaired");
fs.writeFileSync(repaired, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
console.log(`\nWrote ${repaired}`);

if (!apply) {
  console.log("Dry run only: your repo is unchanged. Quit IPFS Desktop, then re-run with --apply to install it.");
  process.exit(0);
}
if (fs.existsSync(path.join(repo, "repo.lock")) || fs.existsSync(path.join(repo, "api"))) {
  fail("repo.lock/api exists: a daemon is attached to this repo. Quit IPFS Desktop completely and re-run with --apply.");
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const brokenCopy = path.join(repo, `config.broken.${stamp}`);
fs.copyFileSync(cfgPath, brokenCopy);
fs.copyFileSync(repaired, cfgPath);
console.log(`Kept your previous file as ${brokenCopy}`);
console.log(`Installed the repaired config. Start IPFS Desktop, then run scripts\\diagnose-ipfs.ps1`);
