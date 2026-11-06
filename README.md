# Open Door

**Show up, get a say.** Open Door lets a community's members earn a voting role in its Sputnik DAO by attending community calls. After enough check-ins, the contract files the DAO proposal that adds them to the voting role. The council still approves it, and from then on the new member votes on treasury spending.

Built at **NEAR HACKATHON** (track: `social`, also `open`).

## The problem

In most DAOs, the people who turn up every week, answer newcomers and run the calls have no vote. Votes sit with a small council or whoever bought tokens early. Adding a contributor is a manual favour, so access depends on knowing the right person.

Open Door turns showing up into a verifiable, rule-based path to a vote, on top of the multisig the community already uses.

## How it works

1. **A host opens a call.** A council member calls `open_session` with a hash of a short code, such as `DOOR-4821`, and reads the code out during the call. Only the hash is stored, and no view returns it.
2. **Members check in.** A member calls `check_in` with the code. The contract checks the session is open, the code matches, and this account hasn't already checked in. Every check-in is tied to a NEAR named account and logged as a `checked_in` event.
3. **The door opens.** On a member's `threshold`-th check-in inside `window_days` (default 3 in 30 days), the contract calls the DAO's `add_proposal` with `AddMemberToRole { member_id, role: "member" }`, pays the proposal bond itself, and lists the calls attended in the description.
4. **The council decides.** It approves or rejects in Sputnik DAO as usual. The contract only proposes; it never gives itself power.
5. **The member votes.** The `member` role can propose and vote on `transfer` proposals, so the new member helps decide where the treasury goes.

Hosts can `void_check_in` a check-in they believe was faked. That account can't re-check-in to that call, and the check-in stops counting.

**Use it or lose it.** A vote earned by showing up isn't permanent. If a member with an open door goes `inactive_days` (default 30) without a check-in, **anyone** can call `sweep`. The contract then files `RemoveMemberFromRole` on the DAO, and the council decides as usual. Old check-ins stop counting, so the member earns the vote back the same way: by showing up again.

## Do X, see Y

| Do | See |
|---|---|
| `npm install && npm test` | The contract builds to `build/open_door.wasm`, and 8 sandbox tests run against the real Sputnik DAO v2 wasm (`res/sputnikdao2.wasm`) |
| Test 1: Alice checks in to 3 calls | After the 3rd check-in, `dao.get_proposal({id:0})` is `AddMemberToRole { member_id: alice, role: "member" }`, proposed by the Open Door contract |
| Test 2: the council approves, then Alice proposes and votes "pay the host 1 NEAR" | `get_policy` shows Alice in `member`, the transfer proposal is `Approved`, and the host's balance goes up |
| Test 3: wrong code, the same call twice, a closed call | Each is rejected with a clear error |
| Test 4: a non-host opens a call, then a host voids a check-in | The non-host is rejected, and Alice's count drops back to 0 |
| Test 5: read a session through the views | The check-in code hash is never returned |
| Test 6: `web4_get` on `/` and `/app.js` | The contract serves the web app (HTML and JS), and unknown paths return 404 |
| Test 7: a voter goes inactive past `inactive_days`, then anyone calls `sweep` | The DAO gets `RemoveMemberFromRole`; old check-ins stop counting; one new check-in isn't enough to get the vote back |
| Test 8: `sweep` on an active member, or on someone without a vote | Both rejected (`Still active` / `no open door`) |

## Live on NEAR testnet

**Web app, served by the contract itself through web4:** https://opendoor-door-vw50k1.testnet.page

To see a member's earned vote, open https://opendoor-door-vw50k1.testnet.page/?as=ada-6geh.testnet

| Piece | Account |
|---|---|
| Open Door contract | [`opendoor-door-vw50k1.testnet`](https://testnet.nearblocks.io/address/opendoor-door-vw50k1.testnet) |
| Sputnik DAO (made by the official `sputnik-v2.testnet` factory) | [`opendoor-vw50k1.sputnik-v2.testnet`](https://testnet.nearblocks.io/address/opendoor-vw50k1.sputnik-v2.testnet) |
| Host (council) / Alice (member) | `host.opendoor-vw50k1.testnet` / `alice.opendoor-vw50k1.testnet` |

**Full loop run on testnet on 31 Oct 2026** (`node scripts/demo-testnet.mjs`):
1. Alice's 3rd check-in files the DAO proposal: [tx](https://testnet.nearblocks.io/txns/AANyQV6ogYZjZwYp4iJQN39h5PPXGUsAvDHjpMx21p3G). It logs `door_opened` with proposal 0.
2. The council approves: [tx](https://testnet.nearblocks.io/txns/GddksF7L71MCMZ9i6KmdWb1bNz4LDbeNrnCnQYe7zmVL). Alice is now in `member`.
3. Alice proposes a 0.5 NEAR payout to the host: [tx](https://testnet.nearblocks.io/txns/9pvKrqTerDox2AFPpBtjpwh7zxStPNHjVdFxiVRo8bmE).
4. Alice votes it through, with status `Approved`: [tx](https://testnet.nearblocks.io/txns/FMX2qRkszrtjJRnxsqnQtgkMmtmfzP2nwdRV5XCv9HbV).

**Second run, with a brand-new member, Ada (`ada-6geh.testnet`), on 31 Oct 2026** (`node scripts/demo-step.mjs …`):
- Ada checks in to 3 calls. The 3rd check-in files proposal #2.
- The council approves it: [tx](https://testnet.nearblocks.io/txns/9bvoektjPoaNgmbkZoTiMx1nQv3L8XTLZp3vtc3dg8sb).
- Ada proposes payout #3: [tx](https://testnet.nearblocks.io/txns/HteCwKCPs11ybZX6JvPodyjNBVwuDjP4p3YhKB4JQKD1). With two earned voters, Sputnik needs a majority, so Ada [votes](https://testnet.nearblocks.io/txns/HJMVCyGtDsoWJu8zHF8ARYoHbmS9AWJE3mjdB8NnQz71) and Alice [votes](https://testnet.nearblocks.io/txns/C6bc82apDTjNoPBiDFV7LLrym2Woug4nSRVqz29R8Hjj). Status: `Approved`, and 0.2 NEAR goes to the host.

To view any member's progress without signing in, open the web app with `?as=<account>`, for example `?as=ada-6geh.testnet`.

To run your own copy:
- `npm run build && node scripts/deploy-testnet.mjs` creates fresh demo accounts through the testnet helper, a DAO through the factory, and the contract.
- Then `node scripts/demo-testnet.mjs` runs the loop.
- Demo keys go to `./.near-credentials`, which is git-ignored.

## Web app (`web/`, no build step)

The web app is static HTML and JS. It reads state over NEAR JSON-RPC and signs with NEAR Wallet Selector 10 (MyNearWallet, Meteor, HERE, Intear), loaded from a CDN.

- **Sign in:** this creates a **function-call access key limited to `check_in`** on the Open Door contract, so a check-in is one tap with no wallet pop-up.
- **Screens:**
  - **Today's call:** pick the open call, type the code, check in.
  - **Your path to a vote:** check-in dots, calls still needed, and the proposal status.
  - **Host a call:** hosts only. It generates a code, shows it large for screen-share, sends only its hash on chain, and lets the host close calls.
  - **The door:** who is showing up, and who has earned the DAO `member` role (read live from `get_policy`).
- **Run locally:** `python3 -m http.server 5180 --directory web`, then open http://localhost:5180. Settings are in `web/config.js`.
- **Hosted on NEAR (web4):** `npm run build` packs `web/` into the contract (`scripts/gen-web4.mjs` generates `src/web4-files.ts`). The contract's `web4_get` view serves it at `https://<contract-account>.testnet.page`, so no separate web host is needed. `node scripts/redeploy-testnet.mjs` upgrades the deployed contract's code in place, keeping its state.

## Contract API (`src/contract.ts`, near-sdk-js)

| Method | Who | What |
|---|---|---|
| `init({dao_id, hosts, threshold, window_days, role, bond, inactive_days})` | deployer | Configure the DAO, the hosts and the rules |
| `web4_get({request})` | view | Serves the web app (web4) |
| `open_session({session_id, title, duration_minutes, code_hash})` | host | Open a call. `code_hash = sha256("<session_id>:<CODE>")`, with the code uppercased |
| `close_session({session_id})` | host | Close a call early |
| `void_check_in({session_id, account_id})` | host | Remove a faked check-in |
| `sweep({account_id})` | anyone | If an earned voter hasn't checked in for `inactive_days`, file `RemoveMemberFromRole` on the DAO ("use it or lose it") |
| `check_in({session_id, code})` | anyone | Check in. On reaching the threshold, files the DAO proposal |
| `get_config`, `get_session`, `get_sessions`, `get_member`, `get_members` | view | Public board data. Never returns code hashes |

Events (NEP-297 style, `standard: "open_door"`): `session_opened`, `checked_in`, `door_opened`, `door_failed`, `door_closed`, `door_close_failed`, `check_in_voided`, `session_closed`.

## DAO set-up (Sputnik DAO v2)

The DAO policy has three roles:
- `all`: anyone can add proposals.
- `council`: the hosts, with full voting.
- `member`: starts empty and is earned through Open Door. It can propose and vote on `transfer` proposals.

`proposal_bond` must equal the Open Door `bond` (0.1 NEAR on testnet). Keep the Open Door contract funded for bonds, which are refunded when proposals finish. See `daoPolicy()` in `tests/open-door.test.mjs`.

## Built with
- `near-sdk-js` 2.0.0, `near-workspaces` 5.0.0, `ava`.
- Sputnik DAO v2 (unmodified): the wasm in `res/` was read with `view_code` from a live DAO created by `sputnik-v2.testnet`.
- **AI disclosure:** the contract, tests and docs were written with Claude Code (Anthropic) as a pair programmer, directed and reviewed by the author.
- **Baseline:** this is a new repository started on 31 Oct 2026. It uses no code from the author's other projects.

## License
MIT. See `LICENSE`.
