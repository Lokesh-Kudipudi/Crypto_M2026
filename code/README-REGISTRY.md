# Certificate registry

The DApp now runs on `CertificateRegistry.sol`. The paper's `AcademicCertificates.sol` is unchanged and still deployed, as a baseline for comparison, and `scripts/e2e.mjs` still tests it.

## What changed

| Addition | Where |
|---|---|
| Only approved issuers can publish, and the owner manages them | `truffle/contracts/CertificateRegistry.sol` |
| EIP-712 issuer signatures, bound to this chain and contract | Contract, `client/src/certcrypto.mjs` |
| Only a Merkle root goes on-chain, with a random salt per field | Contract, `certcrypto.mjs` |
| Batch issuance and field-by-field disclosure | `certcrypto.mjs`, `client/src/Main.jsx` |
| PDFs encrypted with AES-256-GCM before upload to IPFS | `certcrypto.mjs`, `Main.jsx` |
| Revocation of one certificate or a whole batch | Contract, `Main.jsx` |
| One verification result: valid, tampered, revoked, unknown issuer or not on this registry | `certcrypto.mjs`, `Main.jsx` |

## Flow

1. **University:** adds certificates to a batch, signs the batch root in MetaMask and publishes it. Each student's credential file downloads.
2. **Student:** loads their credential file, chooses what to reveal and downloads a presentation file.
3. **Verifier:** loads the presentation, and optionally the PDF, and gets one result. No wallet transaction is needed.

Credential files hold the PDF key and all salts, so students must keep them private. Presentation files are safe to share, but including the PDF also gives the verifier its key.

## Run

Needs a local IPFS node ([Kubo](https://docs.ipfs.tech/install/command-line/)) and MetaMask.

1. Set up IPFS, then start the node. Skip `ipfs init` if you've run it before, and restart the node if it's already running, as it only reads these settings on start. The gateway moves to port 8081 because the app uses 8080.

```bash
ipfs init
```

```bash
ipfs config Addresses.Gateway /ip4/127.0.0.1/tcp/8081
```

```bash
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Origin '["http://localhost:8080"]'
```

```bash
ipfs config --json API.HTTPHeaders.Access-Control-Allow-Methods '["POST"]'
```

```bash
ipfs daemon
```

2. Start the chain in a second terminal. Its data is kept in `truffle/.ganache`, so it survives restarts.

```bash
cd truffle && npm install && npm run chain
```

3. Deploy in a third terminal. Run this again only after deleting `.ganache`.

```bash
cd truffle && npx truffle migrate --reset
```

4. Start the API in a new terminal. It needs Node 22.13 or newer, and keeps its SQLite database and encryption key in `server/data`.

```bash
cd server && npm install && npm start
```

5. Start the app in another terminal, then open http://localhost:8080.

```bash
cd client && npm install && npm start
```

6. In MetaMask, add the network `http://127.0.0.1:8545` with chain ID 1337, and import the first account's private key from the `npm run chain` output. That account is the contract owner. These keys are public test keys, so never use them on a real network.

7. Sign up. **The first account becomes the admin.** After that:
   - **University:** signs up, links a wallet, and waits for approval.
   - **Admin:** approves it under **Issuers**, using the contract owner's wallet.
   - **Student and verifier:** sign up straight away, and don't need a wallet.

To start over, stop the API and delete `server/data`.

## Demo accounts and documents

With the chain and IPFS running:

```bash
cd server && npm run seed:demo
```

This creates an admin, a university, a student and a verifier, then publishes a sample batch of four certificates: two claimed by the student, one left to claim, and one revoked. Open **Try a demo account** on the login page to log in with one click and download the documents. They're generated in `client/public/demo`, and everything in them is fictional.

- **Start over:** `npm run seed:demo -- --reset` replaces only the demo data. Its old transactions stay on the chain.
- **Wallet:** student and verifier accounts need none. The admin and university need MetaMask on the wallet the modal shows for any on-chain action.
- **Turn it off:** start the API with `DEMO_ACCOUNTS=off`. Anyone who can reach the app can open a demo account without a password, including the demo admin, so keep this off anywhere that isn't your own machine.
- **New chain:** if you delete `truffle/.ganache` and redeploy, run the reset command, as the demo data belongs to the old chain.

On newer Node versions, Ganache prints a µWS warning and falls back to a slower server. It still works.

## Test

With the chain running:

```bash
cd truffle && npx truffle test
```

With the chain and IPFS running, and the contracts deployed:

```bash
node scripts/e2e-registry.mjs
```

With nothing else needed:

```bash
cd server && npm test
```

## What SQLite stores

The chain stays the source of truth. Every check of a certificate reads the chain directly, and the API only records a publication or revocation after confirming it on-chain. SQLite holds accounts, certificate details for dashboards, sealed credentials, share links and logs.

| Data | How it's stored |
|---|---|
| Passwords | scrypt hash with a random salt |
| Sessions, claim codes, share tokens | SHA-256 hash of a random value |
| Credentials, presentations | AES-256-GCM, with the key in `server/data/secret.key` |
| Names, courses, CGPA (for the issuer's dashboard) | Plain text |

## Known limits

- **The server can read credentials:** sealing protects a copied database file, not a compromised server. Anyone with the database and key can read salts and PDF keys, so this trades some of the design's privacy for convenience.
- **No email verification or password reset:** claim codes, rather than email addresses, decide who gets a certificate.
- **Local only:** there's no HTTPS, and the API only listens on this machine. The first person to sign up becomes the admin, so this isn't safe to expose as is.

- **Certificate IDs aren't unique on-chain:** the contract only sees roots, so it only rejects duplicates within a batch in the app. The issuer must keep IDs unique across batches.
- **A stolen issuer key:** the owner must remove the issuer and revoke any fraudulent batches, one at a time. The owner key is a single point of trust.
- **Deleting data:** discarding the PDF key makes the file unreadable, but only if every copy of the key is gone. Salted hashes stay on-chain permanently.
- **Local only:** one Ganache chain and one IPFS node can't demonstrate decentralization or availability.
