import { useRef, useState } from "react";
import { useEth } from "./contexts/EthContext";
import { IPFS_GATEWAY, uploadToIpfs, checkPdfAgainstCid } from "./ipfs.mjs";
import "./styles.css";

// state key + label for every text input (keys match the contract argument names).
const FIELDS = [
  { key: "certificateId", label: "Certificate ID" },
  { key: "uid", label: "UID" },
  { key: "candidateName", label: "Candidate Name" },
  { key: "courseName", label: "Course Name" },
  { key: "organizationName", label: "Organization Name" },
  { key: "cgpa", label: "CGPA" },
  { key: "completionYear", label: "Completion Year" },
];
const EMPTY = Object.fromEntries(FIELDS.map(({ key }) => [key, ""]));

// Pull the human-readable revert reason out of a web3 / MetaMask error.
const reason = (e) => {
  const m = String((e && (e.message || e)) || "");
  const hit = m.match(/Certificate with this ID (already exists|does not exist)/);
  if (hit) return hit[0];
  if (/User denied|rejected/i.test(m)) return "Transaction rejected in MetaMask.";
  if (/Returned values aren't valid/i.test(m)) return "Contract call returned nothing: there is no contract at the address in client/src/contracts on this chain. Redeploy with 'truffle migrate --reset' (Ganache was probably restarted) and reload the page.";
  if (/revert/i.test(m)) return "Transaction reverted by the contract (is this Certificate ID already used?).";
  return m.split("\n")[0];
};

function MainComp() {
  const { state: { contract, accounts, networkID } } = useEth();

  const [form, setForm] = useState(EMPTY);
  const [pdfFile, setPdfFile] = useState(null);
  const [genStatus, setGenStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const pdfInput = useRef(null);

  const [fetchId, setFetchId] = useState("");
  const [details, setDetails] = useState(null);
  const [fetchStatus, setFetchStatus] = useState("");

  const [verifyId, setVerifyId] = useState("");
  const [verifyPdf, setVerifyPdf] = useState(null);
  const [verifyStatus, setVerifyStatus] = useState("");
  const [verifyOk, setVerifyOk] = useState(null);

  const noContract = () =>
    `Contract not found on this network (chainId ${networkID ?? "?"}). Connect MetaMask to Ganache (chain 1337) and redeploy with truffle migrate.`;

  // ---- Generate: PDF -> IPFS -> CID -> contract.generateCertificate(CID) -> MetaMask -> Ganache
  const handleGenerate = async (e) => {
    e.preventDefault(); // never let the form submit / reload the page (it would abort the upload and the tx)
    if (busy) return;
    const f = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim()]));
    const year = Number(f.completionYear);
    if (!contract) return setGenStatus(noContract());
    if (FIELDS.some(({ key }) => !f[key])) return setGenStatus("Fill in every field.");
    if (!Number.isInteger(year) || year < 0 || year > 65535) return setGenStatus("Completion Year must be a whole number.");
    if (!pdfFile) return setGenStatus("Select the certificate PDF first.");

    setBusy(true);
    try {
      // Fail early (before pinning anything) if the ID is taken.
      const existing = await contract.methods.verifyCertificate(f.certificateId).call();
      if (existing[0]) return setGenStatus(`Certificate ID "${f.certificateId}" already exists on-chain. Use a different ID.`);

      setGenStatus("1/3 Uploading PDF to IPFS...");
      const cid = await uploadToIpfs(pdfFile);
      console.log("IPFS CID:", cid);

      setGenStatus(`2/3 Uploaded. CID = ${cid}. Confirm the transaction in MetaMask...`);
      const receipt = await contract.methods
        .generateCertificate(f.certificateId, f.uid, f.candidateName, f.courseName, f.organizationName, cid, f.cgpa, year)
        .send({ from: accounts[0] });

      setGenStatus(`3/3 Stored on-chain. ID ${f.certificateId} -> CID ${cid} (tx ${receipt.transactionHash})`);
      setForm(EMPTY);
      setPdfFile(null);
      if (pdfInput.current) pdfInput.current.value = "";
      document.querySelectorAll("#gen-form input.input").forEach((i) => { if (i.type !== "file") i.value = ""; });
    } catch (err) {
      console.error("Error generating certificate:", err);
      setGenStatus("Error: " + reason(err));
    } finally {
      setBusy(false);
    }
  };

  // ---- Fetch: read everything stored under an ID, including the CID
  const handleFetch = async () => {
    setDetails(null);
    if (!contract) return setFetchStatus(noContract());
    if (!fetchId.trim()) return setFetchStatus("Enter a certificate ID.");
    try {
      const d = await contract.methods.getCertificate(fetchId.trim()).call();
      setDetails({
        uid: d[0], candidateName: d[1], courseName: d[2], organizationName: d[3],
        ipfsHash: d[4], cgpa: d[5], completionYear: d[6],
      });
      setFetchStatus("");
    } catch (err) {
      console.error("Error fetching certificate details:", err);
      setFetchStatus("Error: " + reason(err));
    }
  };

  // ---- Verify: on-chain existence, plus (optional) tamper check of a PDF against the on-chain CID
  const handleVerify = async () => {
    setVerifyOk(null);
    if (!contract) return setVerifyStatus(noContract());
    const id = verifyId.trim();
    if (!id) return setVerifyStatus("Enter a certificate ID.");
    try {
      const r = await contract.methods.verifyCertificate(id).call();
      if (!r[0]) {
        setVerifyOk(false);
        return setVerifyStatus("Certificate is invalid or does not exist.");
      }
      let msg = `Certificate is valid: ${r[1]}, ${r[2]}, ${r[3]}, CGPA ${r[4]}, ${r[5]}.`;
      if (verifyPdf) {
        const { ipfsHash } = await contract.methods.getCertificate(id).call().then((d) => ({ ipfsHash: d[4] }));
        const c = await checkPdfAgainstCid(verifyPdf, ipfsHash);
        if (!c.match) {
          setVerifyOk(false);
          return setVerifyStatus(`TAMPERED / MISMATCH: this PDF does not match the on-chain CID ${ipfsHash} (PDF hashes to ${c.recomputed}). ${c.note || ""}`);
        }
        msg += ` The PDF matches the on-chain CID ${ipfsHash}${c.note ? " (" + c.note + ")" : ""}.`;
      }
      setVerifyOk(true);
      setVerifyStatus(msg);
    } catch (err) {
      console.error("Error verifying certificate:", err);
      setVerifyOk(false);
      setVerifyStatus("Error: " + reason(err));
    }
  };

  return (
    <div id="App">
      <h1 className="title">Certification DApp</h1>
      <div className="horizontal-container">
        {/* Left Section */}
        <div className="left-section">
          <div className="card">
            <h2>Generate Certificate</h2>
            <form id="gen-form" onSubmit={handleGenerate}>
              {FIELDS.map(({ key, label }) => (
                <input
                  key={key}
                  name={key}
                  className="input"
                  placeholder={label}
                  onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                />
              ))}
              <input
                ref={pdfInput}
                id="pdf-input"
                className="input"
                type="file"
                accept="application/pdf"
                onChange={(e) => setPdfFile(e.target.files[0] || null)}
              />
              <button type="submit" className="button" disabled={busy}>
                {busy ? "Working..." : "Generate Certificate"}
              </button>
              {genStatus && <p id="gen-status">{genStatus}</p>}
            </form>
          </div>
        </div>

        {/* Right Section */}
        <div className="right-section">
          <div className="card">
            <h2>Fetch Certificate</h2>
            <input id="fetch-id" className="input" placeholder="Certificate ID" onChange={(e) => setFetchId(e.target.value)} />
            <button type="button" className="button" onClick={handleFetch}>
              Fetch Certificate Details
            </button>
            {fetchStatus && <p id="fetch-status">{fetchStatus}</p>}

            {details && (
              <div className="details" id="details">
                <h3>Certificate Details</h3>
                {Object.entries(details).map(([key, value]) => (
                  <p key={key}>
                    <strong>{key.replace(/([A-Z])/g, " $1")}: </strong>
                    {value}
                    {key === "ipfsHash" && value && (
                      <>
                        {" "}
                        (<a href={`${IPFS_GATEWAY}/ipfs/${value}`} target="_blank" rel="noreferrer">open PDF</a>)
                      </>
                    )}
                  </p>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <h2>Verify Certificate</h2>
            <input id="verify-id" className="input" placeholder="Certificate ID" onChange={(e) => setVerifyId(e.target.value)} />
            <label style={{ fontSize: "0.85rem" }}>Optional: PDF to check against the on-chain CID</label>
            <input
              id="verify-pdf"
              className="input"
              type="file"
              accept="application/pdf"
              onChange={(e) => setVerifyPdf(e.target.files[0] || null)}
            />
            <button type="button" className="button" onClick={handleVerify}>
              Verify Certificate
            </button>
            {verifyStatus && (
              <p id="verify-status" style={{ color: verifyOk === false ? "#b00020" : verifyOk ? "#1b7f3b" : "inherit" }}>
                {verifyStatus}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default MainComp;
