# IPFS + Ethereum certificate pipeline (paper pipeline) — run order, tests, root cause

Pipeline implemented (paper, Steps 2–3): **select PDF → upload to IPFS → CID → `generateCertificate(…, CID, …)` → MetaMask → stored on Ganache → Fetch shows CID → Verify succeeds**, plus an optional tamper check (recompute the CID of a PDF and compare it with the on-chain CID).

The Solidity contract was **not** changed.

## Short root-cause explanation (CORS)

Symptom: browser `fetch` to `http://127.0.0.1:5001/api/v0/add` from `http://localhost:8080` → preflight `204`, `Vary: Origin`, **no** `Access-Control-Allow-Origin`; POST `403`. `curl` works because it sends no `Origin`.

What was proven (all reproduced on Kubo **0.43.1**, see "Evidence"):

1. **Kubo reads `API.HTTPHeaders` once, at daemon start.** Writing the header to the config file (or via `ipfs config` / the config API) while the daemon runs changes the file, not the running daemon. Preflight stays `204` without Allow-Origin and POST stays `403` until the daemon is restarted. This is exactly your symptom.
2. **`/api/v0/config?arg=API.HTTPHeaders` is not proof that the header is active.** It re-reads the file on every call, so it shows your origins even when the running daemon never loaded them. The only live proof is an `OPTIONS` preflight that carries an `Origin` header (`scripts/diagnose-ipfs.ps1` does it).
3. **Your `C:\Users\<you>\.ipfs\config` (modified 10:39, after your 10:17 test upload) cannot be loaded by Kubo 0.43.1 at all:** it has no `Identity.PrivKey`/`PeerID`, `"Version": 15` (must be an object) and `Swarm.Transports.Network.TCP: true` (must be a priority). `ipfs daemon` on it stops with `failure to decode config: 'true' is not a valid priority`. Kubo's own good copy is `config.backup` (10:14, has your identity, `API.HTTPHeaders` empty). So the daemon that answered your curl test was started **before** the headers were written, and **a restart from the current file would fail**. The repo also had no `api`/`repo.lock` file when I looked, i.e. no daemon attached to it at that moment.
4. **PowerShell trap:** Kubo returns `403` to any request whose `User-Agent` starts with `Mozilla/` and has no allowed Origin. `Invoke-RestMethod`/`Invoke-WebRequest` send `Mozilla/5.0 … PowerShell` by default → 403 even for `/version`. Always pass `-UserAgent`.
5. Not CORS but worth knowing: a page opened as `http://127.0.0.1:8080` is a **different origin** from `http://localhost:8080`; both are now allowed by the scripts.

I could **not** reach your live daemon from my environment (my shell is a Linux VM; browser pane navigation to 127.0.0.1 was refused), so the live-daemon proof is delivered as a script you run (`diagnose-ipfs.ps1`), not as something I observed on your machine. Everything above about the daemon's behaviour was demonstrated on a same-version sandbox.

## Run order (PowerShell, from the project root `…\Academic-Certificate-Verification-in-Blockchain-Technology-main`)

```powershell
# 0. Ganache (your existing one: 127.0.0.1:8545, chain 1337) must be running, contract deployed, MetaMask on Ganache.

# 1. Is CORS really active on the LIVE daemon?  (read-only)
powershell -ExecutionPolicy Bypass -File scripts\diagnose-ipfs.ps1
#    exit 0 = fine, skip to step 4.  Otherwise it prints the likely cause(s).

# 2. ONLY if diagnose says the config file is unloadable (no Identity.PrivKey / wrong Version):
#    QUIT IPFS Desktop completely first (tray icon -> Quit), then:
node scripts\repair-ipfs-config.mjs "$HOME\.ipfs"            # dry run: writes .ipfs\config.repaired, changes nothing else
node scripts\repair-ipfs-config.mjs "$HOME\.ipfs" --apply    # keeps your file as config.broken.<timestamp>, installs repaired one
#    It merges: starts from Kubo's own config.backup (keeps your identity) + your API.HTTPHeaders/addresses. Never `ipfs init`.
#    Then start IPFS Desktop again.

# 3. If diagnose says "headers not active" / "config changed after daemon started" (daemon running, config OK):
powershell -ExecutionPolicy Bypass -File scripts\fix-ipfs-cors.ps1 -Shutdown   # merges origins via the daemon API (URL-encoded JSON), stops daemon
#    Start IPFS Desktop again (or: ipfs daemon), then re-run step 1 until it prints "CORS is ACTIVE".
#    (Without -Shutdown: restart from the IPFS Desktop tray menu.)

# 4. React client
cd client
npm install          # first time only
npm start            # http://localhost:8080   (webpack-dev-server)
```

If the page says "no contract at the address…": Ganache was restarted. `cd truffle; npx truffle migrate --reset`, then reload the page (restart `npm start` if the artifact does not refresh).

## Test procedure

### A. Automated, no browser/MetaMask (≈10 s)

```powershell
node scripts\e2e.mjs                              # synthetic PDF
node scripts\e2e.mjs ..\Academic_Certificate_Verification_using_Blockchain_Technology.pdf   # any real PDF
```

Checks (each prints PASS/FAIL, exit code 1 on any failure): CORS preflight + POST for `http://localhost:8080` · upload → CIDv0 · contract code at the artifact address · `generateCertificate(CID)` mined · `getCertificate` CID == uploaded CID · retrieval by CID via API and gateway is byte-identical · `verifyCertificate` valid · `only-hash` recompute == stored CID · 1-byte-tampered PDF rejected · duplicate ID rejected on-chain and original record unchanged · unknown ID invalid. Env overrides: `GANACHE_URL`, `CONTRACT_ADDRESS`, `ORIGIN`.

### B. Manual UI test with MetaMask

1. Open `http://localhost:8080`. Fill all 7 fields (use a new Certificate ID), choose a PDF, click **Generate Certificate**.
   Expected: `1/3 Uploading…` → `2/3 Uploaded. CID = Qm… Confirm the transaction in MetaMask` → MetaMask popup → Confirm → `3/3 Stored on-chain…`. The page does not reload. Form clears.
2. **Fetch Certificate**: enter the ID → details incl. `ipfs Hash: Qm…` and an "open PDF" link (gateway `127.0.0.1:8081`).
3. **Verify Certificate**: enter the ID, no PDF → "Certificate is valid …". Choose the same PDF → "The PDF matches the on-chain CID".
4. Tamper: pick a *different/modified* PDF in Verify → red "TAMPERED / MISMATCH …".
5. Generate again with the same ID → "Certificate ID … already exists" before anything is uploaded or signed.
6. Unknown ID → "invalid or does not exist".

## What changed in the code

| File | Change |
|---|---|
| `client/src/ipfs.mjs` (new) | Upload (`add?pin=true`), `only-hash`, `cat`, tamper check. Fixed import params (`cid-version=0&hash=sha2-256&chunker=size-262144&raw-leaves=false`) so upload and re-hash always agree. Turns the opaque `TypeError: Failed to fetch` into an actionable CORS/daemon message. Shared with `scripts/e2e.mjs`. |
| `client/src/Main.jsx` | Form is a real `<form>` with `onSubmit → preventDefault` and a submit button (no reload, no aborted fetch/tx); state keys come from one `FIELDS` table (camelCase, same as the contract arguments); validation; duplicate-ID pre-check before pinning/signing; separate state for Fetch and Verify ids; optional PDF in Verify for the tamper check; status text instead of `alert`; friendly messages for revert / no-contract / MetaMask rejection. Your previous file is kept as `client/src/Main.jsx.before-claude`. |
| `scripts/*` (new) | `diagnose-ipfs.ps1`, `fix-ipfs-cors.ps1`, `repair-ipfs-config.mjs`, `e2e.mjs`. |

Notes: the hash check compares the CID produced with the fixed import params. A PDF uploaded earlier with other settings (e.g. IPFS Desktop's CIDv1 defaults) would produce a different CID for identical bytes; the check then falls back to comparing the actual bytes (SHA-256) fetched from IPFS under the on-chain CID, so such records do not give false "tampered" results.

## Evidence (Kubo 0.43.1, same version as yours; sandbox repos, never your repo)

| Case | Preflight (Origin `http://localhost:8080`) | POST `/add` |
|---|---|---|
| Daemon started with no `API.HTTPHeaders` | 204, no Allow-Origin | 403 |
| Headers set while running (CLI, API, or editing the file) | 204, no Allow-Origin | 403 |
| After daemon restart | 204 + `Access-Control-Allow-Origin: http://localhost:8080` | 200 |
| Origin not listed (e.g. `:3000`) after restart | 204, no Allow-Origin | 403 |

Real Chromium against the production build served on `http://localhost:8080`: before → `Access to fetch … blocked by CORS policy` and the new UI error, no transaction sent; after → generate/fetch/verify/tamper/duplicate all pass, no page navigation, no console errors.

## What I could NOT test (be aware)

- **Real MetaMask click-through.** The browser test used a minimal EIP-1193 stand-in that forwards to Ganache (accounts unlocked) with MetaMask-like gas estimation. The MetaMask popup/signing UI itself was not exercised.
- **Your live daemon and IPFS Desktop.** Unreachable from my environment. I do not know whether IPFS Desktop rewrites `config` on start or which repo your running daemon uses; `diagnose-ipfs.ps1` prints both (`repo/stat → RepoPath`, file vs process start time).
- **Windows PowerShell 5.1.** Scripts were run with PowerShell 7.5.4 on Linux and written to be 5.1-compatible (no `??`, no ternary, .NET `HttpClient`), but not run on 5.1. `Get-Process … StartTime` and Windows paths are therefore untested here.
- **`repair-ipfs-config.mjs` on your real repo.** Tested on a replica (your actual broken `config` + a `config.backup` of the same shape with a throwaway identity); your real private key was never read into my environment's tools output or copied. Run the dry run first.
- **The original `Main.jsx`.** The only copy on disk was already modified (11:15) and the folder has no `.git`, so I cannot show the original; "original repo never uploaded to IPFS" is established from the rest of the repo (see below), not from the original `Main.jsx`.
- Ganache contract address in the sandbox differed from yours, so the sandbox copy of the artifact was pointed at the sandbox deployment (not delivered). Your `client/src/contracts` was not modified.

## Repo audit answer (task 1)

Searching the whole project (excluding `node_modules`) for "ipfs": hits only in the compiled artifacts (`ipfsHash` field in the ABI), `AcademicCertificates.sol` (a `string ipfsHash` that is just stored), and `Main.jsx` (patched version). Everything else is the unmodified Truffle React box (SimpleStorage demo components, `Setup.jsx`, README). **No code in the repo, other than the patched `Main.jsx`, ever called an IPFS API; the contract only stored a caller-supplied string**, which matches your finding that the original had a typed-hash text box. The paper's text describes the upload-to-IPFS workflow (Steps 2–3) but I did not verify the Fig. 7 screenshot itself.
