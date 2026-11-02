// End-to-end tests in a local NEAR sandbox, against the real Sputnik DAO v2 wasm
// (res/sputnikdao2.wasm, pulled from a live sputnik-v2.testnet DAO).
import test from "ava";
import crypto from "node:crypto";
import { Worker, parseNEAR } from "near-workspaces";

const yocto = (n) => BigInt(parseNEAR(n));

const BOND = parseNEAR("0.1");
const codeHash = (sessionId, code) =>
  crypto.createHash("sha256").update(`${sessionId}:${code.trim().toUpperCase()}`).digest("hex");

function daoPolicy(council) {
  return {
    roles: [
      { name: "all", kind: "Everyone", permissions: ["*:AddProposal"], vote_policy: {} },
      {
        name: "council",
        kind: { Group: council },
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
}

test.beforeEach(async (t) => {
  const worker = await Worker.init();
  const root = worker.rootAccount;
  const mk = (name, amount) => root.createSubAccount(name, { initialBalance: yocto(amount) });
  const host = await mk("host", "20");
  const alice = await mk("alice", "10");
  const bob = await mk("bob", "10");
  const dao = await mk("dao", "30");
  const door = await mk("door", "10");

  await dao.deploy("res/sputnikdao2.wasm");
  await dao.call(dao, "new", {
    config: { name: "opendoor", purpose: "Open Door demo DAO", metadata: "" },
    policy: daoPolicy([host.accountId]),
  });

  await door.deploy("build/open_door.wasm");
  await door.call(door, "init", {
    dao_id: dao.accountId,
    hosts: [host.accountId],
    threshold: 3,
    window_days: 30,
    role: "member",
    bond: BOND,
  });

  const open = (id, code) =>
    host.call(door, "open_session", { session_id: id, title: `Community call ${id}`, duration_minutes: 120, code_hash: codeHash(id, code) });

  t.context = { worker, host, alice, bob, dao, door, open };
});

test.afterEach.always(async (t) => {
  await t.context.worker.tearDown().catch(() => {});
});

const GAS = 300000000000000n;

test("third check-in files an AddMemberToRole proposal on the DAO", async (t) => {
  const { alice, dao, door, open } = t.context;
  await open("call-1", "DOOR-1111");
  await open("call-2", "DOOR-2222");
  await open("call-3", "DOOR-3333");

  await alice.call(door, "check_in", { session_id: "call-1", code: "door-1111" }, { gas: GAS });
  await alice.call(door, "check_in", { session_id: "call-2", code: "DOOR-2222" }, { gas: GAS });
  t.is(await dao.view("get_last_proposal_id", {}), 0, "no proposal before the threshold");

  const id = await alice.call(door, "check_in", { session_id: "call-3", code: "DOOR-3333" }, { gas: GAS });
  t.is(id, 0);

  const proposal = await dao.view("get_proposal", { id: 0 });
  t.deepEqual(proposal.kind, { AddMemberToRole: { member_id: alice.accountId, role: "member" } });
  t.is(proposal.proposer, door.accountId);
  t.regex(proposal.description, /attended 3 community calls/);

  const member = await door.view("get_member", { account_id: alice.accountId });
  t.is(member.status, "proposed");
  t.is(member.proposal_id, 0);
  t.is(member.count_in_window, 3);
});

test("council approves, the new member votes a treasury transfer through", async (t) => {
  const { host, alice, dao, door, open } = t.context;
  for (const [id, code] of [["c1", "A1"], ["c2", "B2"], ["c3", "C3"]]) {
    await open(id, code);
    await alice.call(door, "check_in", { session_id: id, code }, { gas: GAS });
  }
  const kind = { AddMemberToRole: { member_id: alice.accountId, role: "member" } };
  await host.call(dao, "act_proposal", { id: 0, action: "VoteApprove", proposal: kind }, { gas: GAS });
  t.is((await dao.view("get_proposal", { id: 0 })).status, "Approved");

  const policy = await dao.view("get_policy", {});
  t.deepEqual(policy.roles.find((r) => r.name === "member").kind, { Group: [alice.accountId] });

  // Alice, who earned the role by showing up, proposes and passes a payout to the host.
  const transfer = { Transfer: { token_id: "", receiver_id: host.accountId, amount: parseNEAR("1") } };
  const before = (await host.balance()).total;
  await alice.call(dao, "add_proposal", { proposal: { description: "Pay this week's call host 1 NEAR", kind: transfer } }, { attachedDeposit: BigInt(BOND), gas: GAS });
  await alice.call(dao, "act_proposal", { id: 1, action: "VoteApprove", proposal: transfer }, { gas: GAS });
  t.is((await dao.view("get_proposal", { id: 1 })).status, "Approved");
  const after = (await host.balance()).total;
  t.true(BigInt(after) > BigInt(before), "host received the treasury payout");
});

test("wrong code, double check-in and closed calls are rejected", async (t) => {
  const { host, alice, door, open } = t.context;
  await open("w1", "RIGHT-1");
  await t.throwsAsync(alice.call(door, "check_in", { session_id: "w1", code: "WRONG" }, { gas: GAS }), { message: /Wrong check-in code/ });
  await alice.call(door, "check_in", { session_id: "w1", code: "right-1" }, { gas: GAS });
  await t.throwsAsync(alice.call(door, "check_in", { session_id: "w1", code: "RIGHT-1" }, { gas: GAS }), { message: /Already checked in/ });

  await open("w2", "RIGHT-2");
  await host.call(door, "close_session", { session_id: "w2" });
  await t.throwsAsync(alice.call(door, "check_in", { session_id: "w2", code: "RIGHT-2" }, { gas: GAS }), { message: /closed/ });
});

test("only hosts open calls, and a voided check-in stops counting", async (t) => {
  const { host, alice, bob, door, open } = t.context;
  await t.throwsAsync(
    bob.call(door, "open_session", { session_id: "x", title: "x", code_hash: codeHash("x", "X") }),
    { message: /Only a host/ }
  );
  await open("v1", "V1");
  await alice.call(door, "check_in", { session_id: "v1", code: "V1" }, { gas: GAS });
  t.is((await door.view("get_member", { account_id: alice.accountId })).count_in_window, 1);
  await host.call(door, "void_check_in", { session_id: "v1", account_id: alice.accountId });
  t.is((await door.view("get_member", { account_id: alice.accountId })).count_in_window, 0);
  await t.throwsAsync(alice.call(door, "check_in", { session_id: "v1", code: "V1" }, { gas: GAS }), { message: /voided/ });
});

test("the check-in code is never readable from views", async (t) => {
  const { door, open } = t.context;
  await open("h1", "SECRET-9");
  const s = await door.view("get_session", { session_id: "h1" });
  t.is(s.code_hash, undefined);
  t.is(s.title, "Community call h1");
});

test("web4: the contract serves its own web app", async (t) => {
  const { door } = t.context;
  const home = await door.view("web4_get", { request: { path: "/" } });
  t.regex(home.contentType, /text\/html/);
  t.regex(Buffer.from(home.body, "base64").toString(), /<title>Open Door/);
  const js = await door.view("web4_get", { request: { path: "/app.js" } });
  t.regex(js.contentType, /javascript/);
  const missing = await door.view("web4_get", { request: { path: "/nope" } });
  t.is(missing.status, 404);
});
