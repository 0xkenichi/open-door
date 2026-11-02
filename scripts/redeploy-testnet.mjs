// Upgrades the code of the deployed Open Door contract (deployments.testnet.json) in place.
// State is kept: no init call. Run: npm run build && node scripts/redeploy-testnet.mjs
import fs from "node:fs";
import path from "node:path";
import { connect, keyStores, utils } from "near-api-js";

const d = JSON.parse(fs.readFileSync("deployments.testnet.json", "utf8"));
const keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.resolve(".near-credentials"));
const near = await connect({ networkId: "testnet", nodeUrl: "https://rpc.testnet.near.org", keyStore });
const door = await near.account(d.door);

const before = await door.getAccountBalance();
console.log("available before:", utils.format.formatNearAmount(before.available, 3), "NEAR");
const o = await door.deployContract(fs.readFileSync("build/open_door.wasm"));
console.log("redeployed:", `https://testnet.nearblocks.io/txns/${o.transaction.hash}`);
const cfg = await door.viewFunction({ contractId: d.door, methodName: "get_config", args: {} });
console.log("state kept, config:", cfg);
console.log(`web app: https://${d.door.replace(/\.testnet$/, "")}.testnet.page`);
