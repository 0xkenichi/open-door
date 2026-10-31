// Runs the full Open Door loop on testnet against deployments.testnet.json and prints explorer links:
// host opens 3 calls -> alice checks in 3 times -> the 3rd check-in files AddMemberToRole on the DAO ->
// host (council) approves -> alice proposes and votes through a 0.5 NEAR treasury payout to the host.
// Run after scripts/deploy-testnet.mjs: node scripts/demo-testnet.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { connect, keyStores, utils } from "near-api-js";

const d = JSON.parse(fs.readFileSync("deployments.testnet.json", "utf8"));
const GAS = BigInt("300000000000000");
const keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.resolve(".near-credentials"));
const near = await connect({ networkId: "testnet", nodeUrl: "https://rpc.testnet.near.org", keyStore });
const host = await near.account(d.host);
const alice = await near.account(d.alice);
const root = await near.account(d.root);
const tx = (o) => `https://testnet.nearblocks.io/txns/${o.transaction.hash}`;
const call = (acct, contractId, methodName, args, deposit = "0") =>
  acct.functionCall({ contractId, methodName, args, gas: GAS, attachedDeposit: BigInt(deposit) });
const view = (contractId, methodName, args = {}) => near.connection.provider
  .query({ request_type: "call_function", finality: "final", account_id: contractId, method_name: methodName, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })
  .then((r) => JSON.parse(Buffer.from(r.result).toString()));
const codeHash = (id, code) => crypto.createHash("sha256").update(`${id}:${code.toUpperCase()}`).digest("hex");

// Seed the DAO treasury with 1 test NEAR so the payout is real.
await root.sendMoney(d.dao, BigInt(utils.format.parseNearAmount("1")));

const run = Date.now().toString(36).slice(-4);
for (let i = 1; i <= 3; i++) {
  const id = `call-${run}-${i}`;
  const code = `DOOR-${1000 + i}`;
  const o = await call(host, d.door, "open_session", { session_id: id, title: `Community call #${i}`, duration_minutes: 120, code_hash: codeHash(id, code) });
  console.log(`host opened ${id}:`, tx(o));
  const c = await call(alice, d.door, "check_in", { session_id: id, code });
  console.log(`alice checked in to ${id}:`, tx(c));
}

const member = await view(d.door, "get_member", { account_id: d.alice });
console.log("alice record:", member);
const pid = member.proposal_id;
const kind = { AddMemberToRole: { member_id: d.alice, role: "member" } };
const a = await call(host, d.dao, "act_proposal", { id: pid, action: "VoteApprove", proposal: kind });
console.log(`council approved proposal ${pid}:`, tx(a));

const transfer = { Transfer: { token_id: "", receiver_id: d.host, amount: utils.format.parseNearAmount("0.5") } };
const p = await call(alice, d.dao, "add_proposal", { proposal: { description: "Pay this week's call host 0.5 NEAR", kind: transfer } }, utils.format.parseNearAmount("0.1"));
const tid = await view(d.dao, "get_last_proposal_id") - 1;
console.log(`alice proposed payout (proposal ${tid}):`, tx(p));
const v = await call(alice, d.dao, "act_proposal", { id: tid, action: "VoteApprove", proposal: transfer });
console.log(`alice voted it through:`, tx(v));

const prop = await view(d.dao, "get_proposal", { id: tid });
const policy = await view(d.dao, "get_policy");
console.log({ payout_status: prop.status, member_role: policy.roles.find((r) => r.name === "member").kind });
