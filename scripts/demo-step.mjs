// Step-by-step version of the demo, for recording. State lives in .demo-state.json (git-ignored).
//   node scripts/demo-step.mjs member          create a fresh member account (testnet helper)
//   node scripts/demo-step.mjs open <n>        host opens call n and prints its code
//   node scripts/demo-step.mjs checkin <n>     member checks in to call n
//   node scripts/demo-step.mjs approve         council approves the member's AddMemberToRole proposal
//   node scripts/demo-step.mjs payout          member proposes a 0.2 NEAR payout to the host and votes for it
//   node scripts/demo-step.mjs vote            a second earned member (alice) votes the latest payout through
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { connect, keyStores, KeyPair, accountCreator, utils } from "near-api-js";

const d = JSON.parse(fs.readFileSync("deployments.testnet.json", "utf8"));
const STATE = ".demo-state.json";
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const GAS = BigInt("300000000000000");
const keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.resolve(".near-credentials"));
const near = await connect({ networkId: "testnet", nodeUrl: "https://rpc.testnet.near.org", keyStore });
const tx = (o) => `https://testnet.nearblocks.io/txns/${o.transaction.hash}`;
const call = async (signerId, contractId, methodName, args, deposit = "0") =>
  (await near.account(signerId)).functionCall({ contractId, methodName, args, gas: GAS, attachedDeposit: BigInt(deposit) });
const view = (contractId, methodName, args = {}) => near.connection.provider
  .query({ request_type: "call_function", finality: "final", account_id: contractId, method_name: methodName, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") })
  .then((r) => JSON.parse(Buffer.from(r.result).toString()));

const [cmd, arg] = process.argv.slice(2);
state.run ||= Date.now().toString(36).slice(-4);
const sid = (n) => `call-${state.run}-${n}`;

if (cmd === "member") {
  const id = `ada-${state.run}.testnet`;
  const kp = KeyPair.fromRandom("ed25519");
  await keyStore.setKey("testnet", id, kp);
  await new accountCreator.UrlAccountCreator(near.connection, "https://helper.testnet.near.org").createAccount(id, kp.getPublicKey());
  state.member = id;
  save();
  console.log(`member ${id} created. Web app: http://localhost:5180/?as=${id}`);
} else if (cmd === "open") {
  const code = `DOOR-${1000 + crypto.randomInt(9000)}`;
  const hash = crypto.createHash("sha256").update(`${sid(arg)}:${code}`).digest("hex");
  const o = await call(d.host, d.door, "open_session", { session_id: sid(arg), title: `Community call #${arg}`, duration_minutes: 180, code_hash: hash });
  state.codes = { ...(state.codes || {}), [arg]: code };
  save();
  console.log(`host opened ${sid(arg)}. Code to read out: ${code}\n${tx(o)}`);
} else if (cmd === "checkin") {
  const o = await call(state.member, d.door, "check_in", { session_id: sid(arg), code: state.codes[arg] });
  const m = await view(d.door, "get_member", { account_id: state.member });
  console.log(`${state.member} checked in to ${sid(arg)}: ${m.count_in_window}/${m.threshold}, status ${m.status}${m.proposal_id != null ? `, proposal #${m.proposal_id}` : ""}\n${tx(o)}`);
} else if (cmd === "approve") {
  const m = await view(d.door, "get_member", { account_id: state.member });
  const kind = { AddMemberToRole: { member_id: state.member, role: "member" } };
  const o = await call(d.host, d.dao, "act_proposal", { id: m.proposal_id, action: "VoteApprove", proposal: kind });
  console.log(`council approved proposal #${m.proposal_id}\n${tx(o)}`);
} else if (cmd === "payout") {
  const transfer = { Transfer: { token_id: "", receiver_id: d.host, amount: utils.format.parseNearAmount("0.2") } };
  const p = await call(state.member, d.dao, "add_proposal", { proposal: { description: "Pay this week's call host 0.2 NEAR", kind: transfer } }, utils.format.parseNearAmount("0.1"));
  const id = (await view(d.dao, "get_last_proposal_id")) - 1;
  const v = await call(state.member, d.dao, "act_proposal", { id, action: "VoteApprove", proposal: transfer });
  const prop = await view(d.dao, "get_proposal", { id });
  console.log(`payout proposal #${id}: ${prop.status}\npropose ${tx(p)}\nvote ${tx(v)}`);
} else if (cmd === "vote") {
  // A second earned member (Alice from the first run) votes the latest payout through.
  const id = (await view(d.dao, "get_last_proposal_id")) - 1;
  const prop = await view(d.dao, "get_proposal", { id });
  const o = await call(d.alice, d.dao, "act_proposal", { id, action: "VoteApprove", proposal: prop.kind });
  const after = await view(d.dao, "get_proposal", { id });
  console.log(`alice voted on proposal #${id}: ${after.status}\nvote ${tx(o)}`);
} else {
  console.log("usage: member | open <n> | checkin <n> | approve | payout | vote");
}
