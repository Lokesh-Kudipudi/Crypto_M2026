const path = require("path");
const CertificateRegistry = artifacts.require("CertificateRegistry");

const LIB = path.resolve(__dirname, "../../client/src/certcrypto.mjs");
const ETHERS = path.resolve(__dirname, "../../client/node_modules/ethers/lib.esm/index.js");
const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const PDF = new TextEncoder().encode("%PDF-1.4 demo certificate");

const expectRevert = async (promise, message) => {
  try {
    await promise;
  } catch (e) {
    assert.include(e.message, message);
    return;
  }
  assert.fail(`Expected revert: ${message}`);
};

contract("CertificateRegistry", (accounts) => {
  const [owner, relayer, stranger] = accounts;
  let lib, ethers, chainId, registry, issuer, otherIssuer;

  const sign = (wallet, root, count, target = registry.address, chain = chainId) => {
    const { domain, types, message } = lib.batchTypedData(chain, target, root, count);
    const { EIP712Domain, ...rest } = types;
    return wallet.signTypedData(domain, rest, message);
  };

  const makeCert = async (overrides = {}) => {
    const cert = lib.buildCertificate({
      certificateId: `CERT-${Math.random()}`,
      uid: "UID-1",
      candidateName: "Asha Rao",
      courseName: "B.Tech",
      organizationName: "Demo University",
      cgpa: "8.5",
      completionYear: "2025",
      pdfSha256: await lib.sha256Hex(PDF),
      pdfCid: "QmDemo",
      ...overrides,
    });
    return { ...cert, pdfKey: "0x" + "11".repeat(32) };
  };

  // Publish a batch and return one credential per certificate
  const issue = async (certs, wallet = issuer) => {
    const { batchRoot, count } = lib.buildBatch(certs.map((c) => c.certRoot));
    const signature = await sign(wallet, batchRoot, count);
    const receipt = await registry.publishBatch(batchRoot, count, signature, { from: relayer });
    return {
      receipt,
      credentials: lib.buildCredentials(certs, { chainId, registry: registry.address, signature }),
    };
  };

  const verify = (presentation, options = {}) =>
    lib.verifyPresentation(presentation, lib.registryReader(registry.contract), {
      chainId,
      address: registry.address,
      ...options,
    });

  before(async () => {
    lib = await import(LIB);
    ethers = await import(ETHERS);
    chainId = await web3.eth.getChainId();
  });

  beforeEach(async () => {
    registry = await CertificateRegistry.new({ from: owner });
    issuer = ethers.Wallet.createRandom();
    otherIssuer = ethers.Wallet.createRandom();
    await registry.addIssuer(issuer.address, "Demo University", { from: owner });
    await registry.addIssuer(otherIssuer.address, "Other University", { from: owner });
  });

  describe("issuer registry", () => {
    it("only lets the owner add or remove issuers", async () => {
      await expectRevert(registry.addIssuer(stranger, "Fake", { from: stranger }), "caller is not the owner");
      await expectRevert(registry.removeIssuer(issuer.address, { from: stranger }), "caller is not the owner");
    });

    it("rejects a batch signed by an unapproved key", async () => {
      const root = lib.batchLeaf((await makeCert()).certRoot);
      const signature = await sign(ethers.Wallet.createRandom(), root, 1);
      await expectRevert(registry.publishBatch(root, 1, signature, { from: relayer }), "not an approved issuer");
    });

    it("stops a removed issuer publishing but keeps its earlier certificates valid", async () => {
      const cert = await makeCert();
      const { credentials } = await issue([cert]);
      await registry.removeIssuer(issuer.address, { from: owner });

      const next = lib.batchLeaf((await makeCert()).certRoot);
      await expectRevert(registry.publishBatch(next, 1, await sign(issuer, next, 1)), "not an approved issuer");

      const result = await verify(lib.createPresentation(credentials[0], ["candidateName"]));
      assert.equal(result.status, lib.STATUS.VALID);
      assert.equal(result.issuerActive, false);
    });
  });

  describe("batch signatures", () => {
    it("records the signer as issuer even when another account pays the gas", async () => {
      const certs = [await makeCert(), await makeCert()];
      const { credentials } = await issue(certs);
      const batch = await registry.batches(credentials[0].batchRoot);
      assert.equal(batch.issuer, issuer.address);
      assert.equal(batch.count.toNumber(), 2);
    });

    it("rejects a duplicate batch", async () => {
      const cert = await makeCert();
      await issue([cert]);
      await expectRevert(issue([cert]), "already published");
    });

    it("rejects a signature whose count was changed", async () => {
      const root = lib.batchLeaf((await makeCert()).certRoot);
      const signature = await sign(issuer, root, 1);
      await expectRevert(registry.publishBatch(root, 2, signature), "not an approved issuer");
    });

    it("rejects a signature made for another contract or chain", async () => {
      const root = lib.batchLeaf((await makeCert()).certRoot);
      const otherContract = await sign(issuer, root, 1, stranger);
      await expectRevert(registry.publishBatch(root, 1, otherContract), "not an approved issuer");
      const otherChain = await sign(issuer, root, 1, registry.address, 999);
      await expectRevert(registry.publishBatch(root, 1, otherChain), "not an approved issuer");
    });

    it("rejects a malleated (high-s) signature", async () => {
      const root = lib.batchLeaf((await makeCert()).certRoot);
      const sig = ethers.Signature.from(await sign(issuer, root, 1));
      const highS = "0x" + (SECP256K1_N - BigInt(sig.s)).toString(16).padStart(64, "0");
      const flipped = ethers.concat([sig.r, highS, sig.v === 27 ? "0x1c" : "0x1b"]);
      await expectRevert(registry.publishBatch(root, 1, flipped), "invalid signature 's' value");
    });
  });

  describe("Merkle trees", () => {
    it("builds proofs that the library and the contract both accept, for every batch size", async () => {
      for (let size = 1; size <= 9; size++) {
        const roots = Array.from({ length: size }, () => ethers.hexlify(ethers.randomBytes(32)));
        const { batchRoot, proofs } = lib.buildBatch(roots);
        for (let i = 0; i < size; i++) {
          assert.isTrue(lib.verifyProof(batchRoot, lib.batchLeaf(roots[i]), proofs[i]));
          assert.isTrue(await registry.isIncluded(batchRoot, roots[i], proofs[i]));
        }
        assert.isFalse(await registry.isIncluded(batchRoot, ethers.ZeroHash, proofs[0]));
      }
    });

    it("does not accept an inner node as a certificate (second preimage)", async () => {
      const roots = Array.from({ length: 4 }, () => ethers.hexlify(ethers.randomBytes(32)));
      const leaves = roots.map(lib.batchLeaf);
      const { batchRoot } = lib.buildBatch(roots);
      const inner = lib.hashNode(leaves[0], leaves[1]);
      const sibling = lib.hashNode(leaves[2], leaves[3]);
      assert.equal(lib.hashNode(inner, sibling), batchRoot);
      assert.isFalse(await registry.isIncluded(batchRoot, inner, [sibling]));
    });

    it("salts commitments, so equal values give different roots", async () => {
      const values = { certificateId: "SAME", pdfCid: "SAME" };
      assert.notEqual((await makeCert(values)).certRoot, (await makeCert(values)).certRoot);
    });
  });

  describe("revocation", () => {
    it("lets the batch issuer revoke, and verification then reports it", async () => {
      const issuerAccount = accounts[3];
      await registry.addIssuer(issuerAccount, "Demo University", { from: owner });
      const certs = [await makeCert(), await makeCert()];
      const { batchRoot, count } = lib.buildBatch(certs.map((c) => c.certRoot));
      const signature = await web3.currentProvider.request({
        method: "eth_signTypedData_v4",
        // Ganache takes an object here; MetaMask takes the same data as a JSON string
        params: [issuerAccount, lib.batchTypedData(chainId, registry.address, batchRoot, count)],
      });
      await registry.publishBatch(batchRoot, count, signature, { from: relayer });
      const [revoked, kept] = lib.buildCredentials(certs, { chainId, registry: registry.address, signature });

      await registry.revokeCertificate(batchRoot, revoked.certRoot, revoked.batchProof, "Issued in error", { from: issuerAccount });

      const bad = await verify(lib.createPresentation(revoked, ["candidateName"]));
      assert.equal(bad.status, lib.STATUS.REVOKED);
      assert.include(bad.message, "Issued in error");
      assert.equal((await verify(lib.createPresentation(kept, ["candidateName"]))).status, lib.STATUS.VALID);
    });

    it("stops strangers and other issuers revoking", async () => {
      const { credentials: [c] } = await issue([await makeCert()]);
      const otherAccount = accounts[4];
      await registry.addIssuer(otherAccount, "Other University", { from: owner });
      for (const from of [stranger, otherAccount]) {
        await expectRevert(registry.revokeCertificate(c.batchRoot, c.certRoot, c.batchProof, "x", { from }), "Not allowed to revoke");
        await expectRevert(registry.revokeBatch(c.batchRoot, "x", { from }), "Not allowed to revoke");
      }
    });

    it("rejects revoking a certificate that is not in the batch", async () => {
      const { credentials: [c] } = await issue([await makeCert()]);
      await expectRevert(
        registry.revokeCertificate(c.batchRoot, (await makeCert()).certRoot, [], "x", { from: owner }),
        "not in this batch"
      );
    });

    it("lets the owner revoke a whole batch", async () => {
      const { credentials: [a, b] } = await issue([await makeCert(), await makeCert()]);
      await registry.revokeBatch(a.batchRoot, "Key stolen", { from: owner });
      for (const c of [a, b]) {
        assert.equal((await verify(lib.createPresentation(c, ["uid"]))).status, lib.STATUS.REVOKED);
      }
    });
  });

  describe("PDF encryption", () => {
    it("round-trips, and rejects altered ciphertext or a wrong key", async () => {
      const { ciphertext, key } = await lib.encryptPdf(PDF);
      assert.deepEqual([...(await lib.decryptPdf(ciphertext, key))], [...PDF]);
      assert.notInclude(Buffer.from(ciphertext).toString("latin1"), "%PDF");

      const altered = ciphertext.slice();
      altered[altered.length - 1] ^= 1;
      let failures = 0;
      await lib.decryptPdf(altered, key).catch(() => failures++);
      await lib.decryptPdf(ciphertext, "0x" + "22".repeat(32)).catch(() => failures++);
      assert.equal(failures, 2);
    });
  });

  describe("verification", () => {
    let credential;

    beforeEach(async () => {
      credential = (await issue([await makeCert(), await makeCert(), await makeCert()])).credentials[1];
    });

    it("accepts a valid presentation and reveals only the chosen fields", async () => {
      const presentation = lib.createPresentation(credential, ["courseName", "organizationName"]);
      const text = JSON.stringify(presentation);
      assert.notInclude(text, "Asha Rao");
      assert.notInclude(text, "8.5");

      const result = await verify(presentation);
      assert.equal(result.status, lib.STATUS.VALID);
      assert.deepEqual(result.disclosed, { courseName: "B.Tech", organizationName: "Demo University" });
      assert.isFalse(result.pdfChecked);
    });

    it("keeps personal data out of the published transaction", async () => {
      const { receipt } = await issue([await makeCert()]);
      const tx = await web3.eth.getTransaction(receipt.tx);
      const input = Buffer.from(tx.input.slice(2), "hex").toString("latin1");
      for (const secret of ["Asha Rao", "B.Tech", "UID-1", "QmDemo"]) assert.notInclude(input, secret);
    });

    it("detects an altered field value", async () => {
      const presentation = lib.createPresentation(credential, ["cgpa"]);
      presentation.disclosed[0].value = "9.9";
      assert.equal((await verify(presentation)).status, lib.STATUS.TAMPERED);
    });

    it("detects a forged proof and a certificate moved to another batch", async () => {
      const forged = lib.createPresentation(credential, ["cgpa"]);
      forged.disclosed[0].proof[0] = ethers.ZeroHash;
      assert.equal((await verify(forged)).status, lib.STATUS.TAMPERED);

      const moved = lib.createPresentation(credential, ["cgpa"]);
      moved.batchProof = [];
      assert.equal((await verify(moved)).status, lib.STATUS.TAMPERED);
    });

    it("treats malformed input as tampered instead of crashing", async () => {
      const malformed = lib.createPresentation(credential, ["cgpa"]);
      malformed.disclosed[0].salt = "not-hex";
      assert.equal((await verify(malformed)).status, lib.STATUS.TAMPERED);
      assert.equal((await verify({ hello: "world" })).status, lib.STATUS.TAMPERED);
    });

    it("rejects a certificate that was never published", async () => {
      const [unpublished] = lib.buildCredentials([await makeCert()], {
        chainId,
        registry: registry.address,
        signature: await sign(issuer, ethers.ZeroHash, 1),
      });
      assert.equal((await verify(lib.createPresentation(unpublished, ["uid"]))).status, lib.STATUS.NOT_ANCHORED);
    });

    it("rejects a certificate from another registry", async () => {
      const result = await verify(lib.createPresentation(credential, ["uid"]), { address: stranger });
      assert.equal(result.status, lib.STATUS.NOT_ANCHORED);
    });

    it("rejects a swapped signature", async () => {
      const presentation = lib.createPresentation(credential, ["uid"]);
      presentation.signature = await sign(otherIssuer, credential.batchRoot, credential.count);
      assert.equal((await verify(presentation)).status, lib.STATUS.UNKNOWN_ISSUER);
    });

    it("rejects an approved issuer claiming to be another university", async () => {
      const { credentials: [c] } = await issue([await makeCert({ organizationName: "Famous University" })], otherIssuer);
      const result = await verify(lib.createPresentation(c, ["organizationName"]));
      assert.equal(result.status, lib.STATUS.UNKNOWN_ISSUER);
      assert.include(result.message, "Other University");
    });

    it("checks a PDF supplied by the verifier", async () => {
      const presentation = lib.createPresentation(credential, ["uid", "pdfSha256"]);
      const good = await verify(presentation, { pdfBytes: PDF });
      assert.equal(good.status, lib.STATUS.VALID);
      assert.isTrue(good.pdfChecked);

      const altered = PDF.slice();
      altered[0] ^= 1;
      assert.equal((await verify(presentation, { pdfBytes: altered })).status, lib.STATUS.TAMPERED);
    });

    it("says the file was not checked when the PDF hash is not disclosed", async () => {
      const result = await verify(lib.createPresentation(credential, ["uid"]), { pdfBytes: PDF.slice(1) });
      assert.equal(result.status, lib.STATUS.VALID);
      assert.isFalse(result.pdfChecked);
      assert.include(result.message, "could not be checked");
    });

    it("fetches and decrypts the stored PDF, and detects a corrupted copy", async () => {
      const { ciphertext, key } = await lib.encryptPdf(PDF);
      const cert = await makeCert();
      cert.pdfKey = key;
      const { credentials: [c] } = await issue([cert]);
      const presentation = lib.createPresentation(c, ["uid"], { includePdf: true });

      const good = await verify(presentation, { fetchCiphertext: async () => ciphertext });
      assert.equal(good.status, lib.STATUS.VALID);
      assert.isTrue(good.pdfChecked);

      const corrupted = ciphertext.slice();
      corrupted[20] ^= 1;
      assert.equal((await verify(presentation, { fetchCiphertext: async () => corrupted })).status, lib.STATUS.TAMPERED);

      const offline = await verify(presentation, { fetchCiphertext: async () => { throw new Error("offline"); } });
      assert.equal(offline.status, lib.STATUS.VALID);
      assert.isFalse(offline.pdfChecked);
    });
  });
});
