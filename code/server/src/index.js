import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createChain } from "./chain.js";
import { openDatabase } from "./db.js";
import { loadOrCreateKey } from "./security.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.resolve(here, "../data");
const port = Number(process.env.PORT) || 4000;
const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
const ipfsApi = process.env.IPFS_API || "http://127.0.0.1:5001";

const app = createApp({
  db: openDatabase(path.join(dataDir, "app.db")),
  sealKey: loadOrCreateKey(path.join(dataDir, "secret.key")),
  chain: createChain({
    rpcUrl,
    registryAddress: process.env.REGISTRY_ADDRESS,
    baselineAddress: process.env.BASELINE_ADDRESS,
  }),
  config: { rpcUrl, ipfsApi },
  demoEnabled: process.env.DEMO_ACCOUNTS !== "off",
});

// Local only: bound to this machine, and cookies aren't marked Secure because there's no HTTPS
app.listen(port, "127.0.0.1", () => console.log(`API listening on http://127.0.0.1:${port}`));
