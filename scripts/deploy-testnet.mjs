// Deploys a demo Open Door on NEAR testnet:
//   1. creates free testnet accounts (host, alice, door) through the testnet helper
//   2. creates a Sputnik DAO through the official factory sputnik-v2.testnet
//   3. deploys build/open_door.wasm and initialises it against that DAO
// Testnet only. Keys for these throwaway demo accounts are stored by near-workspaces
// under ~/.near-credentials/workspaces/testnet. Run: npm run build && node scripts/deploy-testnet.mjs
import { Worker, parseNEAR } from "near-workspaces";
import fs from "node:fs";

const yocto = (n) => BigInt(parseNEAR(n));

const FACTORY = "sputnik-v2.testnet";
const BOND = parseNEAR("0.1");
const tag = Date.now().toString(36).slice(-5);

const worker = await Worker.init({ network: "testnet", rootAccountId: `opendoor-${tag}` });
const root = worker.rootAccount;
console.log("root:", root.accountId);

const host = await root.createSubAccount("host", { initialBalance: yocto("2") });
const alice = await root.createSubAccount("alice", { initialBalance: yocto("1") });
const door = await root.createSubAccount("door", { initialBalance: yocto("6") });

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
  bounty_bond: parseNEAR("1"),
  bounty_forgiveness_period: "86400000000000",
};
const args = Buffer.from(
  JSON.stringify({ config: { name: daoName, purpose: "Open Door demo: show up, get a say", metadata: "" }, policy })
).toString("base64");
await root.call(FACTORY, "create", { name: daoName, args }, { attachedDeposit: yocto("6"), gas: 300000000000000n });
const daoId = `${daoName}.${FACTORY}`;
console.log("dao:", daoId);

await door.deploy("build/open_door.wasm");
await door.call(door, "init", { dao_id: daoId, hosts: [host.accountId], threshold: 3, window_days: 30, role: "member", bond: BOND });

const out = { network: "testnet", root: root.accountId, host: host.accountId, alice: alice.accountId, door: door.accountId, dao: daoId, created_at: new Date().toISOString() };
fs.writeFileSync("deployments.testnet.json", JSON.stringify(out, null, 2));
console.log(out);
console.log(`Explorer: https://testnet.nearblocks.io/address/${door.accountId}`);
