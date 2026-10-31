// Deploys a demo Open Door on NEAR testnet:
//   1. creates two throwaway testnet accounts through the public testnet helper (10 test NEAR each)
//   2. creates a Sputnik DAO through the official factory sputnik-v2.testnet, plus demo host/alice sub-accounts
//   3. deploys build/open_door.wasm to the second account and initialises it against that DAO
// Testnet only. Keys for these demo accounts are written to ./.near-credentials (git-ignored).
// Run: npm run build && node scripts/deploy-testnet.mjs
import fs from "node:fs";
import path from "node:path";
import { connect, keyStores, KeyPair, accountCreator, utils } from "near-api-js";

const NETWORK = "testnet";
const FACTORY = "sputnik-v2.testnet";
const HELPER = "https://helper.testnet.near.org";
const GAS = BigInt("300000000000000");
const yocto = (n) => BigInt(utils.format.parseNearAmount(n));
const BOND = utils.format.parseNearAmount("0.1");
const tag = Date.now().toString(36).slice(-6);

const keyStore = new keyStores.UnencryptedFileSystemKeyStore(path.resolve(".near-credentials"));
const near = await connect({ networkId: NETWORK, nodeUrl: "https://rpc.testnet.near.org", keyStore });
const creator = new accountCreator.UrlAccountCreator(near.connection, HELPER);

async function topLevel(id) {
  const kp = KeyPair.fromRandom("ed25519");
  await keyStore.setKey(NETWORK, id, kp);
  await creator.createAccount(id, kp.getPublicKey());
  console.log("created", id);
  return near.account(id);
}

async function subAccount(parent, name, amount) {
  const id = `${name}.${parent.accountId}`;
  const kp = KeyPair.fromRandom("ed25519");
  await keyStore.setKey(NETWORK, id, kp);
  await parent.createAccount(id, kp.getPublicKey(), yocto(amount));
  console.log("created", id);
  return near.account(id);
}

const call = (account, contractId, methodName, args, deposit = "0") =>
  account.functionCall({ contractId, methodName, args, gas: GAS, attachedDeposit: BigInt(deposit) });

const root = await topLevel(`opendoor-${tag}.testnet`);
const host = await subAccount(root, "host", "1.5");
const alice = await subAccount(root, "alice", "1");

const daoName = `opendoor-${tag}`;
const policy = {
  roles: [
    { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
    {
      name: "council",
      kind: { Group: [host.accountId] },
      permissions: ["*:AddProposal", "*:VoteApprove", "*:VoteReject", "*:VoteRemove", "*:Finalize"],
      vote_policy: {},
    },
    {
      name: "member",
      kind: { Group: [] },
      permissions: ["transfer:AddProposal", "transfer:VoteApprove", "transfer:VoteReject"],
      vote_policy: {},
    },
  ],
  default_vote_policy: { weight_kind: "RoleWeight", quorum: "0", threshold: [1, 2] },
  proposal_bond: BOND,
  proposal_period: "86400000000000",
  bounty_bond: utils.format.parseNearAmount("1"),
  bounty_forgiveness_period: "86400000000000",
};
const daoArgs = Buffer.from(
  JSON.stringify({ config: { name: daoName, purpose: "Open Door demo: show up, get a say", metadata: "" }, policy })
).toString("base64");
await call(root, FACTORY, "create", { name: daoName, args: daoArgs }, utils.format.parseNearAmount("6"));
const daoId = `${daoName}.${FACTORY}`;
console.log("dao:", daoId);

const door = await topLevel(`opendoor-door-${tag}.testnet`);
await door.deployContract(fs.readFileSync("build/open_door.wasm"));
await call(door, door.accountId, "init", { dao_id: daoId, hosts: [host.accountId], threshold: 3, window_days: 30, role: "member", bond: BOND });

const out = {
  network: NETWORK,
  root: root.accountId,
  host: host.accountId,
  alice: alice.accountId,
  door: door.accountId,
  dao: daoId,
  created_at: new Date().toISOString(),
  explorer: `https://testnet.nearblocks.io/address/${door.accountId}`,
};
fs.writeFileSync("deployments.testnet.json", JSON.stringify(out, null, 2) + "\n");
console.log(out);
