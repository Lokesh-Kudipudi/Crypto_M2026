# Academic Certificate Verification (Blockchain + IPFS) — Beginner's Guide

A complete start-to-finish guide for Windows + PowerShell. Follow it top to bottom the first time; after that, use the **"Every-day startup"** cheat sheet in Part 9.

---

## Part 0 — What this project does

You upload a certificate PDF in a web page. Then:

1. The PDF is stored on **IPFS** (a file-storage network). IPFS gives it a fingerprint called a **CID** (looks like `Qm...`).
2. The CID plus the student's details are saved on a **blockchain** (a local test one, **Ganache**) by a **smart contract**, and you approve that save in **MetaMask**.
3. Later, anyone can enter the Certificate ID to **fetch** the details, **verify** it exists, and (optionally) upload a PDF to check it hasn't been **tampered with**.

### The programs that must be running

| Program | What it is for | Port |
|---|---|---|
| **IPFS Desktop** (runs Kubo) | stores the PDF files | API `5001`, files `8081` |
| **Ganache** | fake local blockchain for testing | `8545` |
| **React app** (`npm start`) | the web page you use | `8080` |
| **MetaMask** (browser extension) | your wallet; approves transactions | — |

### Folder map

```
Academic-Certificate-Verification-in-Blockchain-Technology-main\
  client\            the web page (React). src\Main.jsx = page logic, src\ipfs.mjs = IPFS helper
  truffle\           the smart contract (contracts\AcademicCertificates.sol) and deploy scripts
  scripts\           diagnose-ipfs.ps1, fix-ipfs-cors.ps1, repair-ipfs-config.mjs, e2e.mjs
  README-IPFS-PIPELINE.md   technical write-up (root cause of the CORS problem, evidence)
  BEGINNER-GUIDE.md         this file
```

---

## Part 1 — Install the prerequisites (one time)

1. **Node.js (LTS version)** — https://nodejs.org . Install with default options, then **close and reopen PowerShell** and check:
   ```powershell
   node -v
   npm -v
   ```
   Both should print version numbers.
2. **Google Chrome** (or Edge/Brave) — the browser where MetaMask will live.
3. **MetaMask** — install the extension from https://metamask.io/download (use only the official site). Create a wallet and **write down your Secret Recovery Phrase on paper; never share it with anyone or type it into any website**.
4. **IPFS Desktop** — https://docs.ipfs.tech/install/ipfs-desktop/ . Install and open it once.
5. **Ganache and Truffle** need no separate install: the commands below use `npx`, which downloads them on first use. If `npx` asks *"Need to install the following packages… Ok to proceed? (y)"*, type `y` and press Enter.
   (Optional global install instead: `npm install -g ganache truffle`, then you can drop `npx` from the commands.)

> **Safety:** the private keys Ganache prints are **test keys, known to anyone** who runs Ganache. Only ever import those into MetaMask. **Never** use your real wallet's keys or recovery phrase with this project.

---

## Part 2 — Open the project and install its libraries (one time)

```powershell
cd "C:\Users\vakan\Documents\Academic-Certificate-Verification-in-Blockchain-Technology-main\Academic-Certificate-Verification-in-Blockchain-Technology-main"
cd client
npm install
cd ..
cd truffle
npm install
cd ..
```

You are now back in the project folder. **Every PowerShell command in this guide starts from this project folder unless it says otherwise.**

---

## Part 3 — Start IPFS and make sure the browser is allowed to talk to it

Browsers block a web page from talking to another program unless that program says it's allowed (this rule is called **CORS**). Our page runs at `http://localhost:8080` and IPFS listens at `http://127.0.0.1:5001`, so IPFS must be told to allow `http://localhost:8080`. IPFS only reads this setting **when it starts**, so a restart is needed after changing it.

1. Open **IPFS Desktop** and wait until it says it's running (green/"Connected").
2. From the project folder, run the checker:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\diagnose-ipfs.ps1
   ```
3. Read the last line:
   - **`VERDICT: CORS is ACTIVE for http://localhost:8080`** → perfect, go to Part 4.
   - Anything else → use the fixes below, then run the checker again until you see **CORS is ACTIVE**.

### If IPFS Desktop shows "Could not connect to the Kubo RPC", or the checker says it can't reach the daemon

Your IPFS settings file may be damaged. To see the real error, run Kubo by hand (close IPFS Desktop first):

```powershell
& "$env:LOCALAPPDATA\Programs\IPFS Desktop\resources\app.asar.unpacked\node_modules\kubo\kubo\ipfs.exe" daemon
```

- `Daemon is ready` → it works; leave this window open (and don't also run IPFS Desktop).
- `Error: failure to decode config: ...` → repair the settings file (keeps your identity, keeps a backup of the old file, never deletes your data):
  1. **Quit IPFS Desktop completely** (tray icon → Quit).
  2. Preview (changes nothing), then apply:
     ```powershell
     node scripts\repair-ipfs-config.mjs "$HOME\.ipfs"
     node scripts\repair-ipfs-config.mjs "$HOME\.ipfs" --apply
     ```
  3. Start IPFS Desktop again (or the manual `ipfs.exe daemon` command above), then re-run the checker.

### If the daemon works but the checker says CORS is not active

```powershell
powershell -ExecutionPolicy Bypass -File scripts\fix-ipfs-cors.ps1 -Shutdown
```
This adds the allowed addresses (keeping any existing ones) and stops IPFS. **Start IPFS Desktop again**, then re-run the checker.

> Never run `ipfs init` on your existing IPFS folder, and don't delete `C:\Users\<you>\.ipfs` — it holds your IPFS identity and stored files.

---

## Part 4 — Start Ganache (the test blockchain)

Open a **new PowerShell window**, go to the project folder, and run:

```powershell
npx ganache --chain.chainId 1337 --chain.networkId 1337
```

- Leave this window **open** the whole time.
- It prints **Available Accounts** (addresses) and **Private Keys**. Each account has 1000 test ETH. You'll import one key into MetaMask in Part 5.
- Ganache keeps its data **only in memory** by default: if you close and restart it, the blockchain starts empty again — you must redeploy the contract (Part 6) and your old certificates are gone. (Optional, makes things easier: see "Make Ganache remember things" in Part 9.)

---

## Part 5 — Set up MetaMask for Ganache (one time)

### 5.1 Add the Ganache network

1. Click the MetaMask fox icon → click the **network selector** at the top-left (it says "Ethereum Mainnet" or similar) → **Add a custom network** (or "Add network manually").
2. Enter exactly:
   | Field | Value |
   |---|---|
   | Network name | `Ganache Local` |
   | New RPC URL | `http://127.0.0.1:8545` |
   | Chain ID | `1337` |
   | Currency symbol | `ETH` |
3. **Save**, then switch MetaMask to **Ganache Local**.

### 5.2 Import a funded Ganache account

1. In the Ganache window, copy **one private key** (the long `0x...` string under *Private Keys*).
2. In MetaMask click the **account name** at the top → **Add account or hardware wallet** → **Import account** → paste the key → **Import**.
3. Check the balance on **Ganache Local**: it should show about **1000 ETH**. If it shows 0 ETH, you pasted a key from a different Ganache run, or you're on the wrong network.

Use this imported account for everything in this project.

---

## Part 6 — Deploy the smart contract

Ganache must be running. In a PowerShell window, from the project folder:

```powershell
cd truffle
npx truffle migrate --reset
cd ..
```

- The first time it downloads a Solidity compiler (needs internet) — this can take a minute.
- At the end it prints `AcademicCertificates contract deployed at address: 0x...`. The address is saved automatically into `client\src\contracts\`, which is where the web page reads it.
- **Repeat this step every time you restart Ganache with a fresh chain** (not needed if you used the "remember" option in Part 9).

---

## Part 7 — Run the automatic test (recommended before using the web page)

IPFS Desktop, Ganache and the deployed contract must be ready. From the project folder:

```powershell
node scripts\e2e.mjs
```

You want **`ALL CHECKS PASSED`**. It tests, without a browser: IPFS CORS → uploading a PDF → CID → saving on the blockchain → reading it back → verify → tampered file rejected → duplicate ID rejected.

If it fails:
- fails at **step 1 (CORS)** → redo Part 3.
- says **"Couldn't connect to node http://127.0.0.1:8545"** → Ganache isn't running (Part 4).
- says there is no contract at the address → run Part 6 again.

(You can test with your own PDF: `node scripts\e2e.mjs "C:\path\to\file.pdf"`.)

---

## Part 8 — Run the web app and use it

### 8.1 Start the page

Open another PowerShell window, from the project folder:

```powershell
cd client
npm start
```

Leave it running. Wait for `compiled`. Then open **http://localhost:8080** in the Chrome profile that has MetaMask. (Use `localhost`, not `127.0.0.1`.)

### 8.2 Connect MetaMask to the page

- MetaMask should ask to connect: pick your **funded Ganache account** and approve.
- Check the page uses that account: MetaMask network must be **Ganache Local**, and the funded account must be the **selected** one *before* you reload the page.

### 8.3 Create a certificate

1. In **Generate Certificate** fill all fields. Use a **new, unique Certificate ID** each time (e.g. `CERT-001`).
   Example: UID `STU001`, Name `Asha Rao`, Course `B.Tech CSE`, Organization `Sample University`, CGPA `8.7`, Year `2024`.
2. Click **Choose file** and select a certificate **PDF**.
3. Click **Generate Certificate**. The page shows:
   - `1/3 Uploading PDF to IPFS...`
   - `2/3 Uploaded. CID = Qm... Confirm the transaction in MetaMask...`
4. The **MetaMask popup** appears. Check that it shows your funded account and **Ganache Local**, then click **Confirm**.
5. Wait for `3/3 Stored on-chain. ID ... -> CID ...`.

### 8.4 Fetch a certificate

In **Fetch Certificate**, enter the ID and click **Fetch Certificate Details**. You see all details including the **ipfs Hash**, and an **open PDF** link that opens your PDF from IPFS.

### 8.5 Verify a certificate

In **Verify Certificate**, enter the ID and click **Verify Certificate**:
- *Without* a PDF: "Certificate is valid …" (it exists on the blockchain).
- *With* the **original** PDF chosen in the optional box: "…The PDF matches the on-chain CID".
- With a **different or edited** PDF: red **"TAMPERED / MISMATCH"**.
- An ID that was never created: "Certificate is invalid or does not exist."

### 8.6 Duplicate protection

Generating again with an ID that already exists shows "Certificate ID … already exists" — nothing is uploaded and MetaMask doesn't pop up.

---

## Part 9 — Every-day startup (after the first setup)

Do these in order each time you want to use the project:

1. Open **IPFS Desktop** (wait until running). *Optional check:* `powershell -ExecutionPolicy Bypass -File scripts\diagnose-ipfs.ps1`
2. Start **Ganache** (Part 4 command), leave the window open.
3. **Only if you restarted Ganache with a fresh chain:** redeploy (`cd truffle; npx truffle migrate --reset; cd ..`) and, if MetaMask shows stuck/nonce errors, go to MetaMask → Settings → Advanced → **Clear activity tab data**.
4. Start the page: `cd client; npm start`, open http://localhost:8080.
5. In MetaMask: network **Ganache Local**, funded account **selected and connected**, then reload the page.

To stop everything: Ctrl+C in the Ganache and `npm start` windows, and quit IPFS Desktop from its tray icon.

### Make Ganache remember things (optional)

So you don't have to redeploy and re-import keys every time, start Ganache with a fixed set of accounts and a saved database:

```powershell
npx ganache --chain.chainId 1337 --chain.networkId 1337 --wallet.deterministic --database.dbPath ".\ganache-data"
```

With `--wallet.deterministic` the accounts and private keys are the same every run, so the account you imported in MetaMask stays valid; with `--database.dbPath` the chain (including the deployed contract and stored certificates) is saved to that folder. (Note: the `--wallet.deterministic` option was tested in this project's checks; the `--database.dbPath` option was not.)

---

## Part 10 — Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| Page says *"Cannot reach the IPFS API … CORS"*, or browser console says *blocked by CORS policy* | IPFS isn't running, or hasn't loaded the allowed-origins setting | Part 3: run the checker, repair/fix, **restart** IPFS, checker must say CORS is ACTIVE |
| IPFS Desktop: *"Could not connect to the Kubo RPC"* | IPFS daemon not running (often a damaged settings file) | Part 3 manual daemon command to see the error; repair if it says *failure to decode config* |
| `Error: failure to decode config: 'true' is not a valid priority` | Old/damaged `.ipfs\config` | `node scripts\repair-ipfs-config.mjs "$HOME\.ipfs" --apply` (after quitting IPFS Desktop) |
| PowerShell web calls return **403 Forbidden** from IPFS | IPFS blocks PowerShell's default browser-like User-Agent | Use the provided scripts (they set a safe one) |
| `e2e.mjs`: *Couldn't connect to node http://127.0.0.1:8545* | Ganache not running | Part 4 |
| Page: *"no contract at the address … on this chain"* | Ganache restarted, contract gone | Part 6 (`truffle migrate --reset`), reload page |
| MetaMask popup shows red **Network fee** and **Review alert**, or request vanishes by itself | The connected account has **0 ETH** on Ganache, or isn't the account the page loaded with | Import a funded Ganache key (5.2), select it, connect it to `localhost:8080`, **reload** the page |
| MetaMask transaction stuck / nonce errors after restarting Ganache | MetaMask remembers the old chain's transaction count | MetaMask → Settings → Advanced → **Clear activity tab data**, reload page |
| MetaMask shows an orange/red **HTTP** tag next to `localhost:8080` | Normal for a local test page | Ignore |
| Console warnings: `MaxListenersExceededWarning`, `ObjectMultiplex … orphaned data` | Noise from Ganache / MetaMask | Ignore |
| `npm start` fails: port 8080 in use | Another program uses 8080 | Close it, or stop the other `npm start` |
| Page loads but nothing connects to MetaMask | Wrong browser profile or MetaMask locked | Unlock MetaMask, use the browser where it's installed |
| *open PDF* link doesn't load | IPFS gateway (port 8081) not running, or IPFS stopped | Start IPFS Desktop, run the checker |
| Verify says **TAMPERED** for the right file | You picked a different file, or one re-saved by another program (even re-saving a PDF changes its bytes) | Use the exact original file you uploaded |

### Still stuck?

Collect these three things and share them with whoever is helping you (never share private keys or your recovery phrase):
1. The text under the **Generate Certificate** button (starts with `Error:`).
2. The red line in the browser Console (F12) starting with `Error generating certificate:`.
3. The output of `powershell -ExecutionPolicy Bypass -File scripts\diagnose-ipfs.ps1`.

---

## Part 11 — Good to know

- **Certificates cannot be edited or deleted** once saved on the blockchain (that is what makes them trustworthy). Use a new ID for a new certificate. With a non-persistent Ganache, restarting wipes everything — fine for testing.
- The PDF lives on **IPFS**, the blockchain only stores the PDF's CID and the details. As long as your IPFS node has the file (it is *pinned* by the upload), the *open PDF* link works.
- The tamper check re-computes the CID of the PDF you select and compares it with the CID stored on-chain. Any change to the file, even one byte, gives a different CID.
- This is a **local test setup**. Ganache and its keys are for learning/testing only; a real deployment would need a real network, real key management and security review.
