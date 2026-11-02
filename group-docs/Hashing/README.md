# Hashing

**Owner:** Suresh
**Covers:** SHA-256 for PDFs, SHA-256 for tokens, and scrypt for passwords
**Visual explanation:** open [visual.html](visual.html) in a browser

---

## 1. The problem

CertChain has three separate problems that hashing solves.

| # | Problem | What goes wrong without a fix |
|---|---|---|
| 1 | **A certificate PDF could be swapped or edited.** | An attacker changes a grade in the file, and nothing shows the change. |
| 2 | **Tokens act like keys.** Session cookies, claim codes and share links each grant access. | Anyone who copies the database can log in as any user, claim any certificate and open any share link. |
| 3 | **Passwords must be checked, but mustn't be stored.** | A database leak exposes every password, and people reuse passwords on other sites. |

All three need the same kind of tool: a way to check that a value is right without keeping the sensitive value itself.

### The base paper's position

The base paper relies on IPFS content hashes and on-chain records. Those show that stored content exists, but its contract doesn't tie a file a verifier holds to a university's approval. It also has no accounts, so problems 2 and 3 only appear because this project added a login system.

---

## 2. What a hash function is

A cryptographic hash function turns any input into a fixed-size output, called a digest.

```text
SHA-256("CGPA 8.72")  -> 256 bits
SHA-256(a 5 MB PDF)   -> 256 bits
```

It needs three security properties:

| Property | Meaning | Why CertChain needs it |
|---|---|---|
| **Preimage resistance** | Given a digest, you can't find an input that produces it. | A stolen token hash doesn't reveal the token. |
| **Second-preimage resistance** | Given an input, you can't find a different input with the same digest. | An attacker can't build a fake PDF that matches the signed hash. |
| **Collision resistance** | You can't find any two inputs with the same digest. | Nobody can prepare two PDFs with the same hash and swap one for the other later. |

It also has the **avalanche effect**: changing one input bit flips about half of the output bits. Section 1 of the visual shows this live.

---

## 3. The algorithms

### 3.1 SHA-256

SHA-256 belongs to the SHA-2 family, standardized in NIST FIPS 180-4. It works as follows:

1. **Pad** the message to a multiple of 512 bits. The padding includes the message's length.
2. **Split** it into 512-bit blocks.
3. **Start** with eight fixed 32-bit values, which form the internal state.
4. **Expand** each block into 64 words.
5. **Mix** those words into the state over 64 rounds, using rotations, XOR, addition and fixed constants.
6. **Output** the final 256-bit state after the last block.

The best known generic attacks need about 2^256 work for a preimage and about 2^128 for a collision (the birthday bound). Both are far out of reach.

### 3.2 scrypt

scrypt was designed by Colin Percival and is specified in RFC 7914. It's deliberately slow and needs a lot of memory.

1. **Stretch:** PBKDF2-HMAC-SHA-256 turns the password and salt into a starting block.
2. **Fill memory:** it computes `N` blocks one after another and stores them all. Each depends on the one before.
3. **Read memory:** it runs `N` more steps. Each picks a block at a position that depends on the current data, mixes it in and continues.
4. **Finish:** PBKDF2 turns the result into the output.

Because the read positions depend on the data, an attacker can't predict which blocks are needed. Skipping the storage means recomputing blocks, which costs far more time. That reduces the advantage of GPUs and custom chips, which have plenty of computing power but relatively little memory per core.

**Memory used:** `128 x N x r` = 128 x 32,768 x 8 = **32 MiB per password check**.

| Setting in this project | Value | Purpose |
|---|---|---|
| `N` | 2^15 (32,768) | Memory and time cost |
| `r` | 8 | Block size (1 KiB) |
| `p` | 1 | Parallel lanes |
| Salt | 16 random bytes | A different hash for each user |
| Output | 64 bytes | Stored hash |
| `maxmem` | 64 MiB | Node's safety limit |

### 3.3 Why tokens use SHA-256, but passwords use scrypt

This is the most important idea in this group.

| | Passwords | Tokens and claim codes |
|---|---|---|
| Chosen by | A person | A secure random generator |
| Entropy | Often low and guessable | 256 bits for tokens, about 98 bits for claim codes |
| Attacker's best move | Try likely passwords | No shortcut, as every value is equally likely |
| Hash needed | Slow, salted, memory-hard | Fast |

A slow hash only helps when guessing is realistic. For a 256-bit random token, guessing is hopeless at any speed, and SHA-256 keeps each request fast. Running scrypt on every request would cost 32 MiB and noticeable time per request for no security gain.

The claim code's strength comes from `30^20`, which is about 2^98: 20 characters from a 30-character alphabet.

---

## 4. How it works in the project

### 4.1 PDF integrity

```text
University browser                     Verifier browser
------------------                     ----------------
PDF bytes                              PDF bytes received
   | SHA-256                              | SHA-256
   v                                      v
pdfSha256  -> certificate field        computed hash
   |                                      |
   v                                      v
Merkle commitment + issuer signature   compare with the disclosed pdfSha256
```

1. The hash is taken from the **original PDF**, not the encrypted one.
2. It becomes the certificate field `pdfSha256`, which the Merkle tree and the issuer's signature then cover.
3. The verifier gets the file, hashes it and compares the result. `checkPdf` returns a match or a mismatch.
4. A mismatch makes the whole result `TAMPERED`.

The hash on its own proves nothing, because an attacker could hash a fake file. It's useful because the **signed commitment** fixes which hash is correct. See the Digital Signatures and Commitments groups for those parts.

### 4.2 Tokens

```text
Login:   token = 32 random bytes -> cookie goes to the browser
         SHA-256(token) -> stored in sessions.token_hash

Request: SHA-256(cookie) -> look up the row -> find the user
```

The same pattern protects claim codes and share links. A stolen database contains only hashes. Sending a hash as the cookie fails, because the server hashes it again and finds no row.

### 4.3 Passwords

```text
Signup: scrypt(password, random salt) -> "scrypt$<salt>$<hash>"
Login:  read the salt -> scrypt(attempt, salt) -> constant-time compare
```

The login route adds three more protections:

- **Constant-time comparison:** `timingSafeEqual` doesn't stop early, so timing reveals nothing about how many bytes matched.
- **Dummy hash:** an unknown email still runs a full password check, so response time doesn't reveal which emails exist.
- **Rate limit:** 10 attempts per email every 15 minutes.

---

## 5. Where it is in the code

| What | Where |
|---|---|
| PDF hash function | [`certcrypto.mjs:130`](../../code/client/src/certcrypto.mjs#L130) `sha256Hex` |
| Hash added to the certificate | [`NewBatch.jsx:186`](../../code/client/src/pages/NewBatch.jsx#L186) |
| PDF comparison during verification | [`certcrypto.mjs:233`](../../code/client/src/certcrypto.mjs#L233) in `checkPdf` |
| scrypt settings | [`security.js:7`](../../code/server/src/security.js#L7) |
| Password hashing | [`security.js:11`](../../code/server/src/security.js#L11) `hashPassword` |
| Password checking | [`security.js:17`](../../code/server/src/security.js#L17) `verifyPassword` |
| Token generation | [`security.js:24`](../../code/server/src/security.js#L24) `randomToken` |
| Token hashing | [`security.js:25`](../../code/server/src/security.js#L25) `hashToken` |
| Claim code generation | [`security.js:28`](../../code/server/src/security.js#L28) `randomClaimCode` |
| Session created | [`app.js:60`](../../code/server/src/app.js#L60) `startSession` |
| Session looked up | [`app.js:72`](../../code/server/src/app.js#L72) |
| Signup uses scrypt | [`app.js:127`](../../code/server/src/app.js#L127) |
| Dummy hash for unknown emails | [`app.js:139`](../../code/server/src/app.js#L139) |
| Login check | [`app.js:146`](../../code/server/src/app.js#L146) |
| Claim code lookup | [`app.js:386`](../../code/server/src/app.js#L386) |
| Share link token stored | [`app.js:422`](../../code/server/src/app.js#L422) |

### Core code

```js
// code/server/src/security.js
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_BYTES, SCRYPT);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export const hashToken = (token) => createHash("sha256").update(token).digest("hex");
```

### Tests

| Test | Where |
|---|---|
| Stores a salted password hash | [`api.test.js:144`](../../code/server/test/api.test.js#L144) |
| Same error for a wrong password or unknown email | [`api.test.js:153`](../../code/server/test/api.test.js#L153) |
| Limits repeated login attempts | [`api.test.js:167`](../../code/server/test/api.test.js#L167) |
| Keeps claim codes out of the database | [`api.test.js:406`](../../code/server/test/api.test.js#L406) |
| Detects a tampered PDF supplied by the verifier | [`certificateRegistry.js:310`](../../code/truffle/test/certificateRegistry.js#L310) |

---

## 6. Alternatives and why we chose these

"Better" here means better for this project. Some alternatives are excellent in general.

### PDF hash

| Alternative | Verdict | Reason |
|---|---|---|
| MD5 | Rejected | Practical collisions have been public since 2004. |
| SHA-1 | Rejected | A real collision was demonstrated in 2017 (SHAttered), using two different PDFs. |
| **SHA-256** | **Chosen** | Secure, standardized and built into every browser through Web Crypto, so it needs no extra code. |
| SHA-3 | Equally secure | Not available in Web Crypto, so it would need an extra library. |
| Keccak-256 | Workable | The project already uses it for Merkle hashing, but it isn't in Web Crypto. A JavaScript version would be slower on large PDFs. |
| BLAKE3 | Faster | Not in Web Crypto, and less standard for an audit-style check. |

### Token storage

| Alternative | Verdict | Reason |
|---|---|---|
| Store plain tokens | Rejected | A database copy would give access to every account. |
| **SHA-256 of a random token** | **Chosen** | Simple and fast. The tokens' high entropy makes it safe. |
| HMAC-SHA-256 | Slightly stronger | It adds a server key, but random 256-bit tokens gain little from it. |
| JWT | Rejected | Revoking a JWT before it expires requires extra server-side state. Here, deleting a row logs the user out at once. |
| scrypt on tokens | Rejected | It would slow every request with no security gain. |

### Password hashing

| Alternative | Verdict | Reason |
|---|---|---|
| SHA-256 (even with a salt) | Rejected | Far too fast, so guessing is cheap. |
| PBKDF2 | Weaker here | It uses little memory, so GPUs attack it efficiently. |
| bcrypt | Acceptable | Uses a small fixed amount of memory and only reads the first 72 bytes of a password. It also needs an extra package. |
| **scrypt** | **Chosen** | Memory-hard and built into `node:crypto`, so it needs no native dependency. |
| Argon2id | Stronger choice in general | It's OWASP's first recommendation, but it isn't built into Node's stable API and would need a native package. |

**Be honest in a viva:** scrypt was the best fit for a project with minimal dependencies. It's not the strongest password hash available. Argon2id is the usual first choice for new systems.

---

## 7. Limitations

1. **The scrypt setting is on the low side.** OWASP's recommended setting is reported as N = 2^17, r = 8, p = 1, which uses about 128 MiB per check. This project uses N = 2^15, which uses 32 MiB, so it's below that guidance. Check the current cheat sheet before quoting exact figures. Raising N is a small change in `security.js`, but `maxmem` must rise above 128 MiB, and existing hashes would need the next limitation solved first.
2. **The settings aren't stored with the hash.** The format is `scrypt$salt$hash`, so changing the settings would break existing passwords unless the format also records them.
3. **There's no pepper.** A server-side secret mixed into password hashing would add protection if only the database leaks.
4. **Rate limiting resets on restart.** Attempts are held in memory and counted per email.
5. **Salting doesn't save weak passwords.** It stops shared tables, but an attacker can still try common passwords against one account. The project only requires 8 characters.
6. **The hash only protects a file if it's disclosed.** If a student hides `pdfSha256`, the verifier sees "the file could not be checked" rather than a match.

---

## 8. How to explain it in 60 seconds

> Hashing gives every file or secret a fixed-size fingerprint that can't be reversed. We use SHA-256 to fingerprint each PDF, and that fingerprint is signed, so one changed byte is detected. Session tokens, claim codes and share links are random, so we store only their SHA-256 hash, and a stolen database can't be used to log in. Passwords are different because people choose guessable ones, so we use scrypt with a random salt. It needs 32 MiB per guess, which makes large-scale guessing expensive.

---

## 9. Likely viva questions

**Why not use scrypt for tokens too?**
Tokens are 256 bits of randomness, so guessing is already hopeless. scrypt would slow every request for no benefit.

**Can two different PDFs have the same SHA-256 hash?**
Yes, in theory, because there are more possible files than hashes. Nobody has found one, and the expected work is about 2^128.

**What does the salt protect against?**
It stops precomputed tables and makes equal passwords produce different hashes. It doesn't make one weak password strong.

**Is the salt secret?**
No. It's stored next to the hash. It only has to be unique and unpredictable.

**Why hash the original PDF rather than the encrypted one?**
A verifier may be handed the plain PDF and has no ciphertext to compare. Hashing the original also ties the signature to the document's actual content.

**Why use `timingSafeEqual`?**
A normal comparison stops at the first difference, so response time could leak how much of the value matched.

**Why does the project use both SHA-256 and Keccak-256?**
SHA-256 is built into browsers and handles large files quickly. Keccak-256 is built into the EVM and is cheap to compute on-chain, so the Merkle tree uses it.

**If AES-GCM detects tampering, why also hash the PDF?**
GCM only proves the file was encrypted with that key. Anyone holding the key could encrypt a different PDF. The signed hash proves it's the file the university approved.

---

## 10. Further reading

- NIST FIPS 180-4, Secure Hash Standard
- RFC 7914, The scrypt Password-Based Key Derivation Function
- OWASP Password Storage Cheat Sheet
