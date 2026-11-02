# Digital Signatures

**Owner:** Nanda
**Covers:** ECDSA with EIP-712 for batch approval, and `personal_sign` for wallet linking
**Visual explanation:** open [visual.html](visual.html) in a browser

---

## 1. The problem

A blockchain record proves that some data was published. It doesn't prove that a university approved it.

| # | Problem | What goes wrong without a fix |
|---|---|---|
| 1 | **Anyone can claim to be a university.** | A wallet publishes a certificate naming a real university, and verifiers can't tell it's fake. |
| 2 | **Approvals could be replayed.** | A valid approval made for a test chain or another contract gets reused on the real one. |
| 3 | **Approvals could be changed.** | An attacker keeps the signature but alters the batch's contents or its count. |
| 4 | **The app must tie a user account to a wallet.** | An attacker claims a university's wallet address on their own account. |

### The base paper's position

Its `generateCertificate` function is public, with no check on the caller. Any wallet can write a certificate under any organization's name. There's no issuer list and no signature on the certificate itself.

### What we need

- **Authenticity:** the signature proves which key approved the data.
- **Integrity:** any change invalidates the approval.
- **Non-repudiation:** the issuer can't plausibly deny using its key.
- **Binding to context:** an approval works only on one chain and one contract.

---

## 2. The key idea

A digital signature uses a key pair:

```text
Sign(private key, message)            -> signature
Verify(public key, message, signature) -> true or false
```

Only the private key's holder can sign. Anyone with the public key can check. Hashes alone can't provide this, because anyone can compute a hash.

---

## 3. The algorithms

### 3.1 Elliptic curve secp256k1

Ethereum uses the curve `y² = x³ + 7` over a 256-bit prime field.

- **Point addition:** two points on the curve combine to give a third.
- **Generator G:** a fixed, published point.
- **Private key `d`:** a random number from 1 to `n - 1`, where `n` is about 2^256.
- **Public key `Q`:** `Q = d × G`, meaning G added to itself `d` times, computed quickly with double-and-add.
- **Security:** recovering `d` from `Q` is the elliptic curve discrete logarithm problem. The best known classical attacks need about 2^128 steps.

**Ethereum address:** the last 20 bytes of `keccak256(x || y)`.

### 3.2 ECDSA

**Signing a digest `z` with private key `d`:**

```text
1. Choose a secret one-time value k
2. R = k × G
3. r = x coordinate of R (mod n)
4. s = (z + r × d) / k (mod n)
5. Signature = (r, s, v), where v records which y value R had
```

**Standard verification with public key `Q`:**

```text
u1 = z / s,  u2 = r / s
R' = u1 × G + u2 × Q
Valid if the x coordinate of R' equals r
```

**Why it works:** substituting `Q = d × G` gives `R' = ((z + r × d) / s) × G`. Since `s = (z + r × d) / k`, this equals `k × G`, the original R.

**Recovery (`ecrecover`):** Ethereum doesn't need `Q` to be supplied. It rebuilds R from `r` and `v`, then computes:

```text
Q = (s × R - z × G) / r
```

Recovery always gives some address, even with a wrong message. So the check is never "did recovery work?" but "is the recovered address the one we expect?"

### 3.3 EIP-712: structured signing

Signing raw hashes has two problems: users can't see what they're approving, and nothing ties the signature to a particular application. EIP-712 fixes both.

```text
domainSeparator = keccak256(
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    keccak256("AcademicCertificates"),
    keccak256("1"),
    chainId,
    registry address
)

structHash = keccak256(
    keccak256("Batch(bytes32 root,uint32 count)"),
    root,
    count
)

digest = keccak256(0x19 0x01 || domainSeparator || structHash)
```

| Part | What it stops |
|---|---|
| `0x19 0x01` prefix | The digest being confused with a normal Ethereum transaction |
| `chainId` | Replay on another chain |
| `verifyingContract` | Replay on another contract |
| `name`, `version` | Reuse by a different app or a later version |
| `root`, `count` | Changing the batch or its size |

MetaMask shows the root and count as labelled fields, not as an opaque hash.

### 3.4 `personal_sign`

This signs a readable message with a fixed prefix:

```text
digest = keccak256("\x19Ethereum Signed Message:\n" + length + message)
```

The prefix ensures a signed message can't double as a valid transaction. The project uses it for proof of wallet ownership, where there's no on-chain contract involved.

### 3.5 Signature malleability

If `(r, s, v)` is valid, `(r, n - s, flipped v)` is also valid for the same message and key. Anyone can compute this twin without the private key.

OpenZeppelin's `ECDSA.recover` therefore accepts only the lower half of `s` values. This gives each signature one accepted form. It also rejects a `v` other than 27 or 28, and a recovered zero address.

---

## 4. How it works in the project

### 4.1 Issuing a batch

```text
1. Owner approves the issuer         addIssuer(wallet, "Demo University")
2. Browser builds the batch          batchRoot, count (see Commitments)
3. MetaMask shows typed data         University signs (no gas)
4. Any account sends the transaction publishBatch(root, count, signature)
5. Contract rebuilds the digest      _hashTypedDataV4(...)
6. Contract recovers the signer      ECDSA.recover(digest, signature)
7. Contract checks the registry      require(issuers[signer].active)
8. Contract records the issuer       batches[root] = { issuer: signer, ... }
```

**Key design point:** the contract trusts the **signer**, not `msg.sender`. A relayer can pay the gas, and it can't pretend to be the university. The signature also travels inside each student's credential, so it can be checked later without reading transaction history.

### 4.2 Verifying a certificate

`verifyPresentation` makes these signature-related checks without any wallet:

1. Reads the batch's recorded `issuer` and `count` from the chain.
2. Recovers the signer from the signature, using the on-chain count.
3. Requires the signer to equal the batch's issuer. Otherwise: `UNKNOWN_ISSUER`.
4. Reads the issuer's name from the registry. No name: `UNKNOWN_ISSUER`.
5. If `organizationName` is disclosed, requires it to match the registry's name. An approved university can't pose as another.

### 4.3 Linking a wallet

```text
Browser                                Server
-------                                ------
POST /api/wallet/challenge  --------->  nonce = 32 random bytes
                                        stored in users.wallet_nonce
message with the code  <-------------
personal_sign in MetaMask
POST /api/wallet/link  --------------> recover signer from the message
  { address, signature }                signer must equal address
                                        wallet must not be on another account
                                        save wallet, clear nonce
```

The nonce makes each signature single-use. Sending the same signature again fails, because the code has been cleared.

### 4.4 Who may do what

| Action | Who | Enforced by |
|---|---|---|
| Add or remove an issuer | Contract owner | `onlyOwner` |
| Publish a batch | Any account, with an active issuer's signature | `ECDSA.recover` and the `issuers` mapping |
| Revoke a certificate or batch | The active batch issuer, or the owner | `_requireBatchAuthority` |
| Verify | Anyone | Free read calls |

---

## 5. Where it is in the code

| What | Where |
|---|---|
| Contract imports | [`CertificateRegistry.sol:4`](../../code/truffle/contracts/CertificateRegistry.sol#L4) |
| Domain name and version | [`CertificateRegistry.sol:41`](../../code/truffle/contracts/CertificateRegistry.sol#L41) |
| `Batch` type hash | [`CertificateRegistry.sol:27`](../../code/truffle/contracts/CertificateRegistry.sol#L27) |
| Approve an issuer | [`CertificateRegistry.sol:44`](../../code/truffle/contracts/CertificateRegistry.sol#L44) |
| Publish and recover the signer | [`CertificateRegistry.sol:61`](../../code/truffle/contracts/CertificateRegistry.sol#L61) |
| Revocation authority | [`CertificateRegistry.sol:142`](../../code/truffle/contracts/CertificateRegistry.sol#L142) |
| High-s rejection | `truffle/node_modules/@openzeppelin/contracts/utils/cryptography/ECDSA.sol:134` |
| Client domain and types | [`certcrypto.mjs:98`](../../code/client/src/certcrypto.mjs#L98) |
| Typed data for MetaMask | [`certcrypto.mjs:110`](../../code/client/src/certcrypto.mjs#L110) |
| Off-chain signer recovery | [`certcrypto.mjs:125`](../../code/client/src/certcrypto.mjs#L125) |
| Signer check during verification | [`certcrypto.mjs:273`](../../code/client/src/certcrypto.mjs#L273) |
| University name check | [`certcrypto.mjs:283`](../../code/client/src/certcrypto.mjs#L283) |
| Send signing request to MetaMask | [`chain.js:34`](../../code/client/src/chain.js#L34) |
| Batch signed during issuing | [`NewBatch.jsx:196`](../../code/client/src/pages/NewBatch.jsx#L196) |
| `personal_sign` request | [`chain.js:37`](../../code/client/src/chain.js#L37) |
| Wallet linking in the UI | [`Issuer.jsx:24`](../../code/client/src/pages/Issuer.jsx#L24) |
| Challenge message | [`app.js:34`](../../code/server/src/app.js#L34) |
| Challenge route | [`app.js:184`](../../code/server/src/app.js#L184) |
| Link route and verification | [`app.js:190`](../../code/server/src/app.js#L190) |

### Core code

```solidity
// code/truffle/contracts/CertificateRegistry.sol
function publishBatch(bytes32 _root, uint32 _count, bytes memory _signature) public {
    require(_root != bytes32(0), "Invalid batch root");
    require(_count != 0, "Batch is empty");
    require(batches[_root].publishedAt == 0, "Batch already published");

    bytes32 digest = _hashTypedDataV4(
        keccak256(abi.encode(BATCH_TYPEHASH, _root, _count))
    );
    address signer = ECDSA.recover(digest, _signature);
    require(issuers[signer].active, "Signer is not an approved issuer");
    ...
}
```

### Tests

| Test | Where |
|---|---|
| Rejects a batch signed by an unapproved key | [`certificateRegistry.js:83`](../../code/truffle/test/certificateRegistry.js#L83) |
| Removed issuer can't publish, but earlier certificates stay valid | [`certificateRegistry.js:89`](../../code/truffle/test/certificateRegistry.js#L89) |
| Signer recorded as issuer when another account pays gas | [`certificateRegistry.js:104`](../../code/truffle/test/certificateRegistry.js#L104) |
| Rejects a changed count | [`certificateRegistry.js:118`](../../code/truffle/test/certificateRegistry.js#L118) |
| Rejects a signature for another contract or chain | [`certificateRegistry.js:124`](../../code/truffle/test/certificateRegistry.js#L124) |
| Rejects a high-s signature | [`certificateRegistry.js:132`](../../code/truffle/test/certificateRegistry.js#L132) |
| Rejects a swapped signature during verification | [`certificateRegistry.js:297`](../../code/truffle/test/certificateRegistry.js#L297) |
| Rejects an issuer claiming to be another university | [`certificateRegistry.js:303`](../../code/truffle/test/certificateRegistry.js#L303) |
| Wallet needs a signature, and a code can't be reused | [`api.test.js:264`](../../code/server/test/api.test.js#L264) |
| One wallet can't be linked to two accounts | [`api.test.js:276`](../../code/server/test/api.test.js#L276) |

---

## 6. Alternatives and why we chose these

"Better" here means better for this project.

### Who approved the data

| Alternative | Verdict | Reason |
|---|---|---|
| No access control (base paper) | Rejected | Anyone can issue under any name. |
| `msg.sender` check alone | Weaker | It proves who sent the transaction, but leaves no signature to carry with the certificate, and the issuer must pay gas itself. |
| **EIP-712 signature + registry** | **Chosen** | Allows relayed publishing and gives each credential a portable proof that verifiers can check. |
| Signature per certificate | Rejected | Each student would need a separate MetaMask approval from the university. One batch signature covers all of them through the Merkle root. |
| Multisig issuers | Stronger | Better for protecting a university's key, but it would need EIP-1271 and more UI. Good future work. |

### Signature scheme

| Alternative | Verdict | Reason |
|---|---|---|
| RSA | Rejected | Signatures are far larger (256+ bytes), and on-chain verification costs more. MetaMask doesn't offer it. |
| Ed25519 | Good in general | Avoids per-signature randomness and malleability by design, but the EVM has no built-in verifier, and MetaMask accounts don't use it. |
| BLS | Good for aggregation | Combines many signatures into one, but isn't needed with a single batch signature. Wallet support is limited. |
| **ECDSA on secp256k1** | **Chosen** | It's what every Ethereum wallet has, and `ecrecover` is cheap on-chain. |

### Message format

| Alternative | Verdict | Reason |
|---|---|---|
| `eth_sign` on a raw hash | Rejected | MetaMask discourages it because users can't see what they're approving, and a hash could be a transaction. |
| `personal_sign` for batches | Rejected | No built-in chain or contract binding, and the fields wouldn't be labelled. |
| **EIP-712 for batches** | **Chosen** | Readable in the wallet, with replay protection built in. |
| **`personal_sign` for wallet linking** | **Chosen** | Simple and readable. No contract is involved. |
| Sign-In with Ethereum (EIP-4361) | Stronger | Adds domain, URI and expiry to the message. See the limitations section. |

---

## 7. Limitations

1. **A stolen issuer key is powerful.** The attacker can publish batches until the owner removes the issuer. Fraudulent batches must then be revoked one at a time.
2. **The owner is a single point of trust.** One key approves issuers and can revoke any batch. A multisig would reduce this risk.
3. **Removing an issuer doesn't undo the past.** Earlier batches stay valid unless revoked. This is deliberate, and the verifier adds a note that the issuer has been removed.
4. **The registry trusts the owner's naming.** The chain can't confirm that a wallet really belongs to the university named. That's an off-chain, human check.
5. **Wallet linking isn't bound to a site.** The message has a code but no domain or expiry. A malicious site could relay a live challenge and ask a user to sign it, linking their wallet to the attacker's account. EIP-4361 would address this. An admin must still approve an issuer on-chain, which limits the damage.
6. **Quantum computers.** A large enough quantum computer could break ECDSA using Shor's algorithm. Ethereum as a whole would have to migrate.
7. **Not tested with real MetaMask yet.** The automated tests and browser run used a simulated wallet. The real typed-data flow still needs a run.

---

## 8. How to explain it in 60 seconds

> A blockchain record alone doesn't prove who approved it, so each batch is signed by the university's wallet using ECDSA. We use EIP-712 so the signature covers the Merkle root, the count, the chain ID and the contract address. Changing any of those, or replaying it elsewhere, makes the contract recover a different address, which isn't in the registry, so the transaction reverts. The contract trusts whoever signed, not whoever paid gas, and the signature travels with each student's credential for later verification. Separately, `personal_sign` on a one-time code proves that a user controls the wallet they want to link.

---

## 9. Likely viva questions

**Why isn't the signature checked by comparing with a public key?**
Ethereum recovers the signer's address from the signature, then compares addresses. This saves storing or sending public keys.

**What happens when a wrong signature is recovered?**
It normally gives a different, random-looking address. The registry check then fails, so the revert message is "Signer is not an approved issuer".

**Does signing cost gas?**
No. Signing happens in the wallet. Only `publishBatch` is a transaction.

**Why sign `count` as well as `root`?**
So the size the contract records is the size the university approved. The test at line 118 covers this.

**What is `v`?**
A recovery value that says which of the two possible points R was, so recovery gives one answer.

**Why reject high-s signatures if they recover the same signer?**
To give each signature one accepted form, so nothing can treat a signature as a unique ID and be fooled by its twin.

**Why does `k` matter so much?**
Two signatures with the same `k` reveal the private key. Section 6 of the visual runs this attack. This famously affected the PlayStation 3's firmware signing in 2010. MetaMask handles `k` here, not our code.

**Could a verifier be fooled by a fake registry?**
A presentation names a chain and registry, but `verifyPresentation` compares them with the app's configured values and returns `NOT_ANCHORED` if they differ.

**What's the difference between signing and encrypting?**
Signing proves who approved something and leaves it readable. Encrypting hides it. Signatures here don't hide anything, and Merkle roots do the hiding.

---

## 10. Further reading

- SEC 2, Recommended Elliptic Curve Domain Parameters (secp256k1)
- EIP-712, Typed Structured Data Hashing and Signing
- EIP-191, Signed Data Standard
- EIP-4361, Sign-In with Ethereum
- RFC 6979, Deterministic Usage of DSA and ECDSA
