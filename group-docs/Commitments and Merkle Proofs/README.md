# Commitments and Merkle Proofs

**Owner:** Lokesh
**Covers:** salted Keccak-256 commitments, Merkle trees and selective disclosure
**Visual explanation:** open [visual.html](visual.html) in a browser

---

## 1. The problem

A certificate has to be publicly checkable, yet its contents must stay private. A public blockchain makes this look contradictory.

| # | Problem | What goes wrong without a fix |
|---|---|---|
| 1 | **On-chain data is public and permanent.** | Names, UIDs and CGPAs can be read by anyone, forever. |
| 2 | **Plain hashes of short values can be guessed.** | There are only about 1,000 likely CGPAs, so an attacker tries each one and compares hashes. |
| 3 | **All-or-nothing disclosure.** | To prove a degree, a student must also reveal their CGPA and UID. |
| 4 | **One transaction per certificate is expensive.** | The original contract costs about 237,508 gas per certificate, so a class of 500 costs about 118,754,000 gas. |

### The base paper's position

Its contract stores each certificate's personal fields in plain text, one transaction per certificate, and a record can be read by anyone. There's no way to reveal only part of it.

### What we need

- **Hide** the values on-chain.
- **Bind** the issuer to exact values, so they can't be changed later.
- **Reveal any subset** of fields, and still prove they're genuine.
- **Publish in bulk** at a fixed cost.

---

## 2. The building blocks

### 2.1 Commitments

A commitment works like a sealed envelope. You publish it now and open it later.

| Property | Meaning |
|---|---|
| **Hiding** | The commitment reveals nothing about the value. |
| **Binding** | You can't later open it to a different value. |

```text
Commit:  C = keccak256(0x00 || abi.encode(name, value, salt))
Open:    reveal name, value and salt. Anyone recomputes C and compares.
```

- **Binding** comes from Keccak-256's collision resistance.
- **Hiding** comes from the 32-byte random salt. Without it, the hash can be attacked by guessing. With it, an attacker would have to guess the salt as well, which means about 2^256 possibilities.
- **Each field has its own salt.** Revealing one field's salt says nothing about the others.
- **The name is inside the hash.** A value committed as `completionYear` can't be presented as `cgpa`.

### 2.2 Keccak-256

Keccak-256 is the hash built into the Ethereum Virtual Machine. It uses a sponge construction:

1. **Absorb:** XOR 136 bytes of input into a 1,600-bit state, then scramble the state using 24 rounds of the Keccak-f permutation.
2. **Repeat** until all input has been absorbed.
3. **Squeeze:** output the first 256 bits of the state.

**Note:** Ethereum's Keccak-256 uses the original padding, so it gives different results from the NIST SHA3-256 standard.

### 2.3 Merkle trees

A Merkle tree reduces many values to a single root.

```text
                root
              /      \
           H12        H34
          /   \      /   \
         L1   L2    L3   L4
```

To prove L3 is included, you supply only `L4` and `H12`. The verifier computes:

```text
H34  = hash(L3, L4)
root = hash(H12, H34)
```

If the result equals the known root, L3 is in the tree. Forging this would require a Keccak-256 collision or second preimage. Proof size grows with the logarithm of the size: 1,000 leaves need about 10 hashes.

### 2.4 Selective disclosure

Combining these gives selective disclosure:

- Every field is a salted leaf, and the tree's root covers them all.
- To reveal a field, give the value, its salt and its Merkle proof.
- Hidden fields appear, at most, as hashes inside proofs. They can't be reversed, because each has a salted leaf.

---

## 3. The design in this project

### 3.1 Two levels of tree

```text
                         Batch root            <- stored on-chain, signed by the university
                        /          \
                     ...            ...
                     /
        batchLeaf = keccak256(0x02 || certRoot)
                     |
                  certRoot                     <- one per certificate
               /           \
             ...           ...
            /
fieldLeaf = keccak256(0x00 || abi.encode(name, value, salt))    <- 9 per certificate
```

**The 9 fields:** `certificateId`, `uid`, `candidateName`, `courseName`, `organizationName`, `cgpa`, `completionYear`, `pdfSha256`, `pdfCid`.

### 3.2 The hashing rules

```text
field leaf = keccak256(0x00 || abi.encode(name, value, salt))
tree node  = keccak256(0x01 || low || high)     children sorted by value
batch leaf = keccak256(0x02 || certRoot)
```

Each rule below addresses a known risk.

| Rule | Why |
|---|---|
| **Prefixes 0x00, 0x01, 0x02** | **Domain separation.** A node's hash can't equal a leaf's hash, which blocks second-preimage attacks. |
| **Sorted children** | A proof needs no left or right flags, so proofs are smaller, and the contract's loop is simpler. Position isn't needed, since each leaf names its own field. |
| **Odd node promoted unchanged** | Pairing a node with itself lets `[A, B, C]` and `[A, B, C, C]` share a root. That was Bitcoin's CVE-2012-2459. |
| **`abi.encode`, not `encodePacked`** | Packed encoding is ambiguous: `("ab", "c")` and `("a", "bc")` would give the same bytes. |
| **32-byte salt per field** | Stops guessing, and revealing one salt doesn't help with another. |

### 3.3 Second-preimage attack in detail

An inner node's hash input is 64 bytes: two child hashes. Without prefixes, an attacker can submit those 64 bytes as if they were a leaf's data. It hashes to the same value as the real node, so a shorter proof reaches the root and something never issued is accepted.

With prefixes, the fake is hashed as `keccak256(0x02 || data)`, while the real node was `keccak256(0x01 || data)`. They differ, so the attack fails. Section 4 of the visual runs it both ways.

---

## 4. The full flow

### 4.1 Issuing

1. `buildCertificate` gives every field a new 32-byte salt and computes the `certRoot`.
2. `buildBatch` turns the certificate roots into batch leaves and computes the `batchRoot` and each `batchProof`.
3. The university signs the batch root and count (see Digital Signatures).
4. `publishBatch` stores the root, issuer, time and count. No personal data goes on-chain.
5. `buildCredentials` gives each student a credential with all their values, salts, proofs and the signature.

### 4.2 Sharing

`createPresentation(credential, names)` picks the chosen fields. For each one, it includes the value, salt and proof. It also includes the `certRoot`, `batchRoot`, `batchProof` and signature. Choosing to include the PDF also reveals `pdfSha256`, `pdfCid` and the PDF's key.

### 4.3 Verifying

```text
Field check   fieldLeaf(name, value, salt) + proof -> must equal certRoot
Batch check   batchLeaf(certRoot) + batchProof     -> must equal batchRoot
Chain check   batches[batchRoot] exists            -> else NOT_ANCHORED
Issuer check  signature recovers the batch issuer  -> else UNKNOWN_ISSUER
Revocation    batchRoot and certRoot not revoked   -> else REVOKED
```

Any failed Merkle check gives `TAMPERED`.

### 4.4 Revoking

`revokeCertificate` takes a `batchRoot`, a `certRoot` and a proof. The contract's `isIncluded` checks the proof on-chain, so an issuer can only revoke certificates in its own batches. That's the one place the contract does Merkle verification itself, and it must match the client's rules exactly.

### 4.5 Worked example

A student reveals `courseName` only, and it's leaf index 3 of 9.

```text
Level 0 (9 nodes): sibling of index 3 is index 2 -> proof[0]
Level 1 (5 nodes): index 1, sibling is index 0   -> proof[1]
Level 2 (3 nodes): index 0, sibling is index 1   -> proof[2]
Level 3 (2 nodes): index 0, sibling is index 1   -> proof[3]
Level 4 (1 node) : the certRoot
```

So the proof has 4 hashes. The last leaf, `pdfCid`, needs only 1 because it's promoted up the odd levels. The verifier learns the course name and sees 4 hashes that reveal nothing else.

---

## 5. Where it is in the code

| What | Where |
|---|---|
| The hashing rules, summarized | [`certcrypto.mjs:4`](../../code/client/src/certcrypto.mjs#L4) |
| List of fields | [`certcrypto.mjs:13`](../../code/client/src/certcrypto.mjs#L13) |
| Salt generation | [`certcrypto.mjs:31`](../../code/client/src/certcrypto.mjs#L31) `randomHex` |
| Field leaf (commitment) | [`certcrypto.mjs:36`](../../code/client/src/certcrypto.mjs#L36) `fieldLeaf` |
| Batch leaf | [`certcrypto.mjs:39`](../../code/client/src/certcrypto.mjs#L39) `batchLeaf` |
| Sorted node hash | [`certcrypto.mjs:41`](../../code/client/src/certcrypto.mjs#L41) `hashNode` |
| Tree building and odd nodes | [`certcrypto.mjs:44`](../../code/client/src/certcrypto.mjs#L44) `treeLevels` |
| Proof generation | [`certcrypto.mjs:60`](../../code/client/src/certcrypto.mjs#L60) `merkleProof` |
| Proof verification | [`certcrypto.mjs:70`](../../code/client/src/certcrypto.mjs#L70) `verifyProof` |
| Certificate commitment | [`certcrypto.mjs:77`](../../code/client/src/certcrypto.mjs#L77) `buildCertificate` |
| Batch tree | [`certcrypto.mjs:87`](../../code/client/src/certcrypto.mjs#L87) `buildBatch` |
| Selective disclosure | [`certcrypto.mjs:176`](../../code/client/src/certcrypto.mjs#L176) `createPresentation` |
| Merkle checks during verification | [`certcrypto.mjs:256`](../../code/client/src/certcrypto.mjs#L256) in `verifyPresentation` |
| On-chain proof check | [`CertificateRegistry.sol:122`](../../code/truffle/contracts/CertificateRegistry.sol#L122) `isIncluded` |
| Root stored on-chain | [`CertificateRegistry.sol:76`](../../code/truffle/contracts/CertificateRegistry.sol#L76) |
| Certificate built during issuing | [`NewBatch.jsx:183`](../../code/client/src/pages/NewBatch.jsx#L183) |
| Student chooses fields | [`Student.jsx:25`](../../code/client/src/pages/Student.jsx#L25) |

### Core code

```js
// code/client/src/certcrypto.mjs
export const fieldLeaf = (name, value, salt) =>
  keccak256(concat(["0x00", AbiCoder.defaultAbiCoder().encode(["string", "string", "bytes32"], [name, value, salt])]));

export const hashNode = (a, b) =>
  keccak256(concat(["0x01", ...(BigInt(a) < BigInt(b) ? [a, b] : [b, a])]));

export const verifyProof = (root, leaf, proof) => proof.reduce(hashNode, leaf) === root;
```

```solidity
// code/truffle/contracts/CertificateRegistry.sol
function isIncluded(bytes32 _batchRoot, bytes32 _certRoot, bytes32[] memory _proof)
    public pure returns (bool)
{
    bytes32 hash = keccak256(abi.encodePacked(bytes1(0x02), _certRoot));
    for (uint256 i = 0; i < _proof.length; i++) {
        (bytes32 low, bytes32 high) = hash < _proof[i] ? (hash, _proof[i]) : (_proof[i], hash);
        hash = keccak256(abi.encodePacked(bytes1(0x01), low, high));
    }
    return hash == _batchRoot;
}
```

### Tests

| Test | Where |
|---|---|
| Library and contract accept the same proofs, for every batch size | [`certificateRegistry.js:142`](../../code/truffle/test/certificateRegistry.js#L142) |
| Inner node can't pass as a certificate (second preimage) | [`certificateRegistry.js:154`](../../code/truffle/test/certificateRegistry.js#L154) |
| Equal values give different roots because of salts | [`certificateRegistry.js:164`](../../code/truffle/test/certificateRegistry.js#L164) |
| Rejects revoking a certificate not in the batch | [`certificateRegistry.js:202`](../../code/truffle/test/certificateRegistry.js#L202) |
| Valid presentation reveals only the chosen fields | [`certificateRegistry.js:241`](../../code/truffle/test/certificateRegistry.js#L241) |
| Personal data stays out of the published transaction | [`certificateRegistry.js:253`](../../code/truffle/test/certificateRegistry.js#L253) |
| Detects an altered field value | [`certificateRegistry.js:260`](../../code/truffle/test/certificateRegistry.js#L260) |
| Detects a forged proof and a certificate moved to another batch | [`certificateRegistry.js:266`](../../code/truffle/test/certificateRegistry.js#L266) |

---

## 6. Measured results

| Action | Original (gas) | Improved (gas) |
|---|---|---|
| Issue 1 certificate | 237,508 | about 57,074 (about 76% less) |
| Issue 500 certificates | about 118,754,000 (calculated) | about 285,370 in 5 batches (about 99.8% less) |
| Revoke 1 certificate, batch of 1 | Not supported | 78,142 |
| Revoke 1 certificate, batch of 10 | Not supported | 84,989 |
| Revoke 1 certificate, batch of 100 | Not supported | 90,116 |

The revocation figures show logarithmic growth in action: 100 times more certificates adds only about 15% more gas. The saving isn't like for like, because the improved contract stores less on-chain and adds signatures and revocation.

---

## 7. Alternatives and why we chose these

"Better" here means better for this project.

### Storing certificate data

| Alternative | Verdict | Reason |
|---|---|---|
| Plain text on-chain (base paper) | Rejected | Public, permanent and expensive. |
| Encrypted data on-chain | Rejected | Ciphertext stays forever, and storage is still expensive. |
| One hash per certificate, on-chain | Better, but limited | Hides data, but needs one storage write per certificate and can't disclose fields separately. |
| **One Merkle root per batch** | **Chosen** | Fixed cost per batch, and it supports per-field proofs. |

### Selective disclosure

| Alternative | Verdict | Reason |
|---|---|---|
| Flat list of salted hashes (the SD-JWT approach) | Simple and sound | The verifier gets every hash, so proofs grow with field count. It works well for 9 fields, but it doesn't reuse a tree for batches. |
| **Salted Merkle tree** | **Chosen** | One structure handles fields and batches, and the contract can verify it. Proofs are small. |
| BBS+ signatures | More private | Proofs can't be linked across verifiers. But they need pairing curves, the EVM can't verify them cheaply, and MetaMask can't sign them. |
| Zero-knowledge proofs (zk-SNARKs) | Most powerful | Can prove "CGPA at least 8" without revealing it. They need circuits, and some systems need a trusted setup. This is out of scope for now and listed as future work. |
| Pedersen commitments | Additive properties | Can support range proofs, but elliptic curve operations cost much more than hashing, and we don't need those features. |

### Tree design

| Alternative | Verdict | Reason |
|---|---|---|
| **Sorted pairs with prefixes** | **Chosen** | Compact proofs, simple on-chain code and domain separation. |
| Indexed trees (left and right flags) | Workable | Adds position binding, which isn't needed because the field name is inside the leaf. |
| Double hashing the leaf (OpenZeppelin's approach) | Workable | Also prevents second-preimage attacks. Prefixes are explicit, and they separate three types of hash. |
| Verkle trees | Smaller proofs | Needs polynomial commitments, and that's unnecessary for trees this small. |
| Sparse Merkle trees | Proves non-membership | We don't need non-membership proofs. Revocation is a direct lookup. |

### Hash function

| Alternative | Verdict | Reason |
|---|---|---|
| **Keccak-256** | **Chosen** | It's a native EVM opcode, at 30 gas plus 6 per 32-byte word. |
| SHA-256 | Slightly costlier | An EVM precompile at 60 gas plus 12 per word. It's built into browsers, which is why it's used for PDFs. |
| Poseidon | Great for ZK | Efficient inside circuits, but has no native EVM support. Worth considering if zero-knowledge proofs are added. |

---

## 8. Limitations

1. **Presentations can be linked.** The same `certRoot` appears in every presentation, so two verifiers comparing notes can tell it's the same certificate. Only BBS+ or zero-knowledge proofs would solve this.
2. **Values must be revealed in full.** The system can't prove "CGPA is at least 8" without revealing it. That needs zero-knowledge proofs.
3. **Salted hashes stay on-chain permanently.** Only the root is stored, but the data's security relies on Keccak-256 and on salts staying private. Once a verifier has a value and salt, they can't be taken back.
4. **Leaked salts expose hidden fields to guessing.** The server stores salts inside sealed credentials. Someone who gets the database and sealing key can read them all.
5. **Batch size is public.** The on-chain count shows how many certificates are in the batch.
6. **Certificate IDs aren't unique on-chain.** The contract sees only roots, so the issuer must keep IDs unique across batches. The app enforces this per issuer.
7. **Revocation reasons are public.** They're stored as on-chain text, so they mustn't contain personal details. Revoked roots are public too, although a root alone doesn't reveal who it belongs to.
8. **Client and contract must stay in sync.** The hashing rules live in both JavaScript and Solidity. The test at line 142 guards against them drifting apart.

---

## 9. How to explain it in 60 seconds

> The blockchain is public, so we can't store personal data on it. Instead, each certificate field is hashed with its own random salt. A salt matters because a CGPA has only about a thousand possible values, so a plain hash could be cracked. The 9 salted hashes form a Merkle tree, and the certificate roots form a second tree for the batch. Only the batch root goes on-chain, so a whole class costs one transaction. To share a certificate, a student reveals only chosen fields with their salts and short proofs. The verifier recomputes up to the on-chain root and learns nothing about hidden fields. Any change gives a different root, so tampering is detected.

---

## 10. Likely viva questions

**Why can't the verifier work out the hidden fields?**
They see only salted hashes. Without a field's 32-byte random salt, testing guesses is infeasible.

**Why does each field need its own salt?**
Revealing one field's salt would otherwise make it possible to guess the others offline.

**Why do the hashes have prefixes?**
To stop an inner node being presented as a leaf. That's a second-preimage attack, and it's tested at line 154.

**Why sort the children?**
A proof then needs no left or right flags, so it's smaller and the contract's loop is simpler. It's safe here because each leaf contains its field's name.

**What's the size of a proof?**
Up to 4 hashes within a certificate of 9 fields, and at most 7 for a batch of 100. Growth is logarithmic.

**What stops a student changing their CGPA?**
A changed value gives a different leaf and a different root, so it no longer matches the signed on-chain root.

**What stops the university changing a certificate later?**
Its original root is already public, and it can't find different values with the same hash. It can only revoke the certificate and issue a new one.

**Is a Merkle tree a zero-knowledge proof?**
No. Revealed values are fully visible, and it only hides what isn't revealed. A zero-knowledge proof could prove a property of a value without revealing it.

**Why not store the certificate root on-chain directly?**
Each would need a storage write, which is exactly the per-certificate cost we set out to avoid.

**What happens if a salt repeats?**
Equal values would hash to the same leaf only if the name and salt also match. With 32 random bytes, the chance of a repeat is negligible.

**Why keep a batch root's `count` on-chain?**
It records how many certificates the university approved, and it's part of the signed message.

---

## 11. Further reading

- R. Merkle, "A Digital Signature Based on a Conventional Encryption Function", CRYPTO 1987
- RFC 9162, Certificate Transparency (domain separation in Merkle trees)
- CVE-2012-2459 (duplicate nodes in Bitcoin's Merkle tree)
- RFC 9901, Selective Disclosure for JWTs
