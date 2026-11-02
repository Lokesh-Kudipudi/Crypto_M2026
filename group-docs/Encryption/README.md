# Encryption

**Owner:** Rishitha
**Covers:** AES-256-GCM for PDFs and AES-256-GCM for stored credentials
**Visual explanation:** open [visual.html](visual.html) in a browser

---

## 1. The problem

Hashing and signatures prove that data is genuine, but they don't hide it. CertChain has two kinds of data that must stay secret.

| # | Problem | What goes wrong without a fix |
|---|---|---|
| 1 | **Certificate PDFs live on IPFS.** IPFS is content-addressed, so anyone who has the CID can request the file from any node holding it. | Names, grades and IDs are readable by anyone who finds the CID, and removing every copy can't be guaranteed. |
| 2 | **The server stores credentials.** A credential holds a student's field values, salts and PDF key. | Anyone who copies the database file gets the secrets that selective disclosure depends on. |

### The base paper's position

The base paper uploads certificate PDFs to IPFS unencrypted, and its contract stores the hash that locates them. Nothing limits who can read them.

### What we need

1. **Confidentiality:** the data looks random without the key.
2. **Integrity:** any change is detected, and no altered data is returned.
3. **Browser and Node support:** PDFs are encrypted in the browser, and credentials on the server.

---

## 2. The key idea: authenticated encryption

Plain encryption hides data, but it doesn't reliably reveal changes. In counter mode, for example, an attacker can flip a bit of the ciphertext and flip the same bit of the plaintext without knowing what it says.

**Authenticated Encryption with Associated Data (AEAD)** provides both protections in one operation:

```text
Encrypt(key, iv, plaintext, aad) -> ciphertext + tag
Decrypt(key, iv, ciphertext, tag, aad) -> plaintext, or failure
```

Decryption either returns the exact original data or returns nothing.

---

## 3. The algorithm: AES-256-GCM

### 3.1 AES

AES is the Advanced Encryption Standard (NIST FIPS 197). It's a block cipher, so it maps 16 bytes to 16 bytes under a key. AES-256 uses a 256-bit key and 14 rounds. Each round has four steps:

1. **SubBytes:** replaces each byte using a fixed table.
2. **ShiftRows:** moves bytes between columns.
3. **MixColumns:** mixes the bytes within each column (not in the last round).
4. **AddRoundKey:** XORs in a key derived from the main key.

### 3.2 Why AES needs a mode

AES alone only handles 16 bytes. A **mode of operation** extends it to whole files. The simplest mode, ECB, encrypts each block separately, so identical blocks produce identical output and the layout of a document shows through. Section 3 of the visual demonstrates this on a real image.

### 3.3 Galois/Counter Mode (GCM)

GCM is specified in NIST SP 800-38D and has two parts.

**Part 1: encryption with a counter**

```text
Counter block i = IV (12 bytes) || i (4 bytes)
Keystream i     = AES(key, counter block i)
Ciphertext i    = Plaintext i XOR Keystream i
```

- Data blocks start at counter 2. Counter 1 is reserved for the tag.
- AES only ever runs forward, even during decryption.
- Blocks can be processed in parallel.

**Part 2: authentication with GHASH**

```text
H   = AES(key, 16 zero bytes)
S   = GHASH(H, AAD, ciphertext)      multiplication in GF(2^128)
Tag = S XOR AES(key, IV || counter 1)
```

GHASH treats the AAD and ciphertext as a polynomial and evaluates it at the secret point `H`. The result is masked with an encrypted counter to form the 16-byte tag. Without the key, an attacker can't produce a valid tag for changed data, except with negligible probability.

### 3.4 The three inputs that matter

| Input | Size here | Rule |
|---|---|---|
| **Key** | 32 bytes, random | Must stay secret |
| **IV (nonce)** | 12 bytes, random | Must never repeat under the same key, but doesn't need to be secret |
| **AAD** | `academic-certificate-pdf-v1` for PDFs | Authenticated, not encrypted, and must match on decryption |

### 3.5 Why an IV must never repeat

If two messages use the same key and IV, they use the same keystream:

```text
C1 XOR C2 = (P1 XOR K) XOR (P2 XOR K) = P1 XOR P2
```

The keystream cancels out. Anyone who knows or guesses one message can recover the other. It also exposes information about `H`, which enables forgeries. Section 4 of the visual runs this attack for real.

---

## 4. How it works in the project

### 4.1 PDFs

```text
University browser
  PDF bytes
    |-- SHA-256 ------------------> pdfSha256 field (see Hashing)
    |-- AES-256-GCM (new key) ----> [ IV | ciphertext | tag ]
                                        |
                                        v  uploaded to IPFS -> pdfCid field
  key -> goes into the student's credential as pdfKey

Student or verifier
  fetch by pdfCid -> AES-256-GCM decrypt with pdfKey -> PDF bytes -> compare SHA-256
```

1. `encryptPdf` creates a new random 32-byte key and a random 12-byte IV for each PDF.
2. It stores the IV in front of the ciphertext. Web Crypto appends the 16-byte tag at the end.
3. The result goes to IPFS, and the certificate records its CID.
4. The key goes into the student's credential.
5. A student can decrypt their own PDF, or include the key in a presentation for a verifier.

**Why a key per PDF?** Sharing one PDF only reveals that PDF, and it also makes key management simple. Discarding every copy of a key makes that file unreadable.

**Why the AAD?** It labels the format, so a ciphertext made for another purpose or format version won't decrypt as a certificate PDF.

### 4.2 Stored credentials (sealing)

```text
seal(key, text)      -> base64(iv) . base64(tag) . base64(body)
unseal(key, sealed)  -> text, or an error if anything changed
```

- **Key:** a 32-byte key in `server/data/secret.key`, created with file mode `0600`.
- **Scope:** one key protects every sealed row. Each value gets a new random IV.
- **Data sealed:** credentials and share link presentations.

### 4.3 PDF encryption compared with sealing

| | PDF encryption | Sealing |
|---|---|---|
| Runs in | The university's browser | The server |
| API | Web Crypto | `node:crypto` |
| Keys | One per PDF | One for the whole server |
| Format | `IV + ciphertext + tag` as bytes | `iv.tag.body` in base64 |
| AAD | Yes | No |
| Protects against | Anyone reading IPFS | Someone copying the database file |
| Doesn't protect against | Someone holding the credential | A compromised server, or someone who has both the database and key |

---

## 5. Where it is in the code

| What | Where |
|---|---|
| AAD and IV size | [`certcrypto.mjs:28`](../../code/client/src/certcrypto.mjs#L28) |
| Encrypt a PDF | [`certcrypto.mjs:135`](../../code/client/src/certcrypto.mjs#L135) `encryptPdf` |
| Decrypt a PDF | [`certcrypto.mjs:147`](../../code/client/src/certcrypto.mjs#L147) `decryptPdf` |
| Encrypted during issuing | [`NewBatch.jsx:180`](../../code/client/src/pages/NewBatch.jsx#L180) |
| Uploaded to IPFS | [`NewBatch.jsx:182`](../../code/client/src/pages/NewBatch.jsx#L182) |
| Student decrypts their PDF | [`Student.jsx:54`](../../code/client/src/pages/Student.jsx#L54) |
| Verifier decrypts and checks | [`certcrypto.mjs:228`](../../code/client/src/certcrypto.mjs#L228) in `checkPdf` |
| Sealing | [`security.js:42`](../../code/server/src/security.js#L42) `seal` |
| Unsealing | [`security.js:49`](../../code/server/src/security.js#L49) `unseal` |
| Sealing key created or loaded | [`security.js:56`](../../code/server/src/security.js#L56) `loadOrCreateKey` |
| Sealing key path | [`index.js:16`](../../code/server/src/index.js#L16) |
| Credential sealed | [`app.js:278`](../../code/server/src/app.js#L278) |
| Credential unsealed | [`app.js:401`](../../code/server/src/app.js#L401) |
| Presentation sealed for a share link | [`app.js:426`](../../code/server/src/app.js#L426) |
| Presentation unsealed | [`app.js:179`](../../code/server/src/app.js#L179) |

### Core code

```js
// code/client/src/certcrypto.mjs
export async function encryptPdf(bytes) {
  const key = randomHex(32);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cryptoKey = await crypto.subtle.importKey("raw", toBytes(key), "AES-GCM", false, ["encrypt"]);
  const body = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: PDF_AAD }, cryptoKey, bytes);
  const ciphertext = new Uint8Array(IV_BYTES + body.byteLength);
  ciphertext.set(iv);
  ciphertext.set(new Uint8Array(body), IV_BYTES);
  return { ciphertext, key };
}
```

```js
// code/server/src/security.js
export function seal(key, text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}
```

### Tests

| Test | Where |
|---|---|
| Round-trips, and rejects altered ciphertext or a wrong key | [`certificateRegistry.js:220`](../../code/truffle/test/certificateRegistry.js#L220) |
| Fetches and decrypts the stored PDF, and detects a corrupted copy | [`certificateRegistry.js:328`](../../code/truffle/test/certificateRegistry.js#L328) |
| Keeps codes, salts and PDF keys out of the database in plain text | [`api.test.js:406`](../../code/server/test/api.test.js#L406) |
| Seals and unseals, and detects a changed value | [`api.test.js:492`](../../code/server/test/api.test.js#L492) |

---

## 6. Alternatives and why we chose this

"Better" here means better for this project.

| Alternative | Verdict | Reason |
|---|---|---|
| No encryption (base paper) | Rejected | Anyone with the CID can read personal data. |
| AES-ECB | Rejected | Leaks the document's patterns and doesn't detect changes. |
| AES-CBC alone | Rejected | Doesn't detect changes, and is open to padding oracle attacks when errors are exposed. |
| AES-CTR alone | Rejected | Doesn't detect changes, and bits can be flipped. |
| AES-CBC + HMAC | Secure, but more work | Needs two keys and careful ordering. Doing it wrong is a common source of bugs. GCM does it in one call. |
| **AES-256-GCM** | **Chosen** | Authenticated, standardized and built into both Web Crypto and `node:crypto`. Hardware acceleration makes it fast on most modern CPUs. |
| ChaCha20-Poly1305 | Equally good | Strong and fast without AES hardware, but not available in Web Crypto. |
| AES-GCM-SIV | Safer against IV reuse | Tolerates a repeated IV better, but isn't available in Web Crypto. Random IVs and per-file keys make the risk small here. |
| RSA or ECIES directly to each student | More private, but harder | The university could encrypt straight to a student's public key. But students don't need a wallet in this design, and asymmetric encryption would still wrap a symmetric key for a large file. |
| One key for all PDFs | Rejected | Sharing one PDF with a verifier would reveal the key to every PDF. |
| SQLCipher (whole-database encryption) | Reasonable alternative | Protects every column but requires a native dependency. Sealing is simple, though it leaves some columns in plain text. |
| Cloud key management service or HSM | Stronger, out of scope | Keeps the key out of the server's files, but this project is local only. |

---

## 7. Limitations

1. **The server can read credentials.** Sealing protects a copied database file, not a compromised server. Someone with both the database and `secret.key` can read salts and PDF keys. Encrypting credentials in the student's browser would fix this but would complicate account recovery.
2. **The database and key sit in the same folder.** Both are in `server/data`, so a copy of that whole folder defeats sealing. Production would keep the key elsewhere.
3. **One key protects all rows.** There's no key rotation. With random 96-bit IVs, NIST's guidance is about 2^32 encryptions per key, which is far beyond this project's scale.
4. **Sealing has no AAD.** A sealed value isn't tied to its row, so someone with write access to the database could swap two students' sealed values without detection during unsealing. Using the row ID as AAD would prevent this.
5. **Dashboard columns are in plain text.** Names, courses and CGPAs are stored unencrypted for the issuer's dashboard. These don't get the protection that sealing gives.
6. **Encryption isn't deletion.** IPFS copies may stay forever. Discarding the key helps only if every copy of it is gone, and AES-256 needs to remain unbroken for as long as the ciphertext exists.
7. **A shared key can't be taken back.** After a student shares a PDF key, the verifier keeps access to that PDF.

---

## 8. How to explain it in 60 seconds

> IPFS has no access control, so anything uploaded there must already be protected. Before upload, the university's browser encrypts each PDF using AES-256-GCM with its own random key, and that key goes to the student. GCM gives confidentiality and integrity together, so a changed file fails to decrypt rather than returning corrupted data. On the server, credentials are sealed with AES-256-GCM too, so a copied database file doesn't reveal them. The limit is that a compromised server could still read them, because it holds the sealing key.

---

## 9. Likely viva questions

**What's the difference between encryption and hashing?**
Encryption can be reversed with a key. Hashing can't be reversed at all.

**Does the IV need to be secret?**
No. It's stored next to the ciphertext. It only has to be unique for each key.

**How large is the tag, and what does it do?**
It's 16 bytes. It proves the ciphertext and AAD weren't changed and that the key was correct.

**If GCM detects tampering, why also compare a SHA-256 hash?**
GCM only proves someone with the key encrypted this file. The signed hash proves it's the file the university approved. A student holds the key and could encrypt a different PDF.

**Why AES-256 rather than AES-128?**
Both are secure today. AES-256 gives a larger margin, including against quantum search, and is similar in speed on modern hardware.

**What happens if the same IV is used twice?**
With the same key, the keystream repeats, so the XOR of the plaintexts leaks. GCM's authentication can also be broken. Section 4 of the visual shows this.

**Why doesn't encrypting in the browser solve everything?**
The PDF key still has to reach the student. In this design, it travels inside a credential that the server seals, so the server can read it.

**Can a quantum computer break AES-256?**
Grover's algorithm would roughly halve its effective strength to about 128 bits, which is still considered secure.

---

## 10. Further reading

- NIST FIPS 197, Advanced Encryption Standard
- NIST SP 800-38D, Galois/Counter Mode
- RFC 5116, An Interface and Algorithms for Authenticated Encryption
