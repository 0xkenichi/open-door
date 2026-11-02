// Open Door: members earn a Sputnik DAO role by showing up.
// Hosts open a call with a secret code. Members check in with the code.
// Once a member has `threshold` check-ins inside `window_days`, this contract
// files an AddMemberToRole proposal on the DAO. The DAO council still approves it.
import {
  NearBindgen,
  near,
  call,
  view,
  initialize,
  NearPromise,
  UnorderedMap,
  LookupMap,
  assert,
  encode,
} from "near-sdk-js";
import { WEB4_FILES } from "./web4-files";

const NS_PER_DAY = BigInt("86400000000000");
const GAS_PROPOSAL = BigInt("50000000000000"); // 50 Tgas for add_proposal
const GAS_CALLBACK = BigInt("15000000000000"); // 15 Tgas for on_proposal

type Session = {
  id: string;
  title: string;
  host: string;
  opened_at: string; // ns, as a string because JSON has no bigint
  ends_at: string;
  code_hash: string; // hex sha256 of `${id}:${code}`
  closed: boolean;
  attendees: string[];
};

type Member = {
  checkins: { session_id: string; at: string }[];
  voided: string[];
  status: "none" | "pending" | "proposed";
  proposal_id: number | null;
};

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
  }
  return out;
}

function codeHash(sessionId: string, code: string): string {
  return toHex(near.sha256(encode(`${sessionId}:${code.trim().toUpperCase()}`)));
}

function emit(event: string, data: Record<string, unknown>) {
  near.log(
    `EVENT_JSON:${JSON.stringify({ standard: "open_door", version: "1.0.0", event, data: [data] })}`
  );
}

@NearBindgen({ requireInit: true })
export class OpenDoor {
  dao_id = "";
  hosts: string[] = [];
  threshold = 3;
  window_days = 30;
  role = "member";
  bond = "100000000000000000000000"; // 0.1 NEAR, must match the DAO's proposal_bond
  sessions = new UnorderedMap<Session>("s");
  members = new LookupMap<Member>("m");
  member_list: string[] = [];

  @initialize({ privateFunction: true })
  init({
    dao_id,
    hosts,
    threshold = 3,
    window_days = 30,
    role = "member",
    bond = "100000000000000000000000",
  }: {
    dao_id: string;
    hosts: string[];
    threshold?: number;
    window_days?: number;
    role?: string;
    bond?: string;
  }) {
    assert(hosts.length > 0, "At least one host is required");
    assert(threshold >= 1, "threshold must be at least 1");
    this.dao_id = dao_id;
    this.hosts = hosts;
    this.threshold = threshold;
    this.window_days = window_days;
    this.role = role;
    this.bond = bond;
  }

  // ---------- hosts ----------

  @call({})
  open_session({
    session_id,
    title,
    duration_minutes = 120,
    code_hash,
  }: {
    session_id: string;
    title: string;
    duration_minutes?: number;
    code_hash: string;
  }) {
    this.assertHost();
    assert(this.sessions.get(session_id) === null, "Session already exists");
    assert(/^[0-9a-f]{64}$/.test(code_hash), "code_hash must be 64 hex characters");
    const now = near.blockTimestamp();
    const ends = now + BigInt(duration_minutes) * BigInt(60) * BigInt(1_000_000_000);
    const session: Session = {
      id: session_id,
      title,
      host: near.predecessorAccountId(),
      opened_at: now.toString(),
      ends_at: ends.toString(),
      code_hash,
      closed: false,
      attendees: [],
    };
    this.sessions.set(session_id, session);
    emit("session_opened", { session_id, title, host: session.host, ends_at: session.ends_at });
  }

  @call({})
  close_session({ session_id }: { session_id: string }) {
    this.assertHost();
    const s = this.getSession(session_id);
    s.closed = true;
    this.sessions.set(session_id, s);
    emit("session_closed", { session_id, attendees: s.attendees.length });
  }

  // A host can remove a check-in they believe was faked (for example, a shared code).
  @call({})
  void_check_in({ session_id, account_id }: { session_id: string; account_id: string }) {
    this.assertHost();
    const s = this.getSession(session_id);
    const m = this.members.get(account_id);
    assert(m !== null && s.attendees.includes(account_id), "No such check-in");
    s.attendees = s.attendees.filter((a) => a !== account_id);
    m.checkins = m.checkins.filter((c) => c.session_id !== session_id);
    m.voided.push(session_id);
    this.sessions.set(session_id, s);
    this.members.set(account_id, m);
    emit("check_in_voided", { session_id, account_id });
  }

  // ---------- members ----------

  @call({})
  check_in({ session_id, code }: { session_id: string; code: string }): NearPromise | void {
    const who = near.predecessorAccountId();
    const s = this.getSession(session_id);
    const now = near.blockTimestamp();
    assert(!s.closed && now <= BigInt(s.ends_at), "This call is closed");
    assert(codeHash(session_id, code) === s.code_hash, "Wrong check-in code");
    assert(!s.attendees.includes(who), "Already checked in to this call");

    let m = this.members.get(who);
    if (m === null) {
      m = { checkins: [], voided: [], status: "none", proposal_id: null };
      this.member_list.push(who);
    }
    assert(!m.voided.includes(session_id), "Your check-in for this call was voided");
    m.checkins.push({ session_id, at: now.toString() });
    s.attendees.push(who);
    this.sessions.set(session_id, s);

    const count = this.countInWindow(m, now);
    emit("checked_in", { session_id, account_id: who, count, threshold: this.threshold });

    if (count >= this.threshold && m.status === "none") {
      m.status = "pending";
      this.members.set(who, m);
      const recent = m.checkins.slice(-this.threshold).map((c) => c.session_id).join(", ");
      const description =
        `Open Door: ${who} attended ${count} community calls in the last ${this.window_days} days ` +
        `(${recent}). Proposed role: ${this.role}.`;
      const args = JSON.stringify({
        proposal: { description, kind: { AddMemberToRole: { member_id: who, role: this.role } } },
      });
      return NearPromise.new(this.dao_id)
        .functionCall("add_proposal", args, BigInt(this.bond), GAS_PROPOSAL)
        .then(
          NearPromise.new(near.currentAccountId()).functionCall(
            "on_proposal",
            JSON.stringify({ account_id: who }),
            BigInt(0),
            GAS_CALLBACK
          )
        )
        .asReturn();
    }
    this.members.set(who, m);
  }

  @call({ privateFunction: true })
  on_proposal({ account_id }: { account_id: string }): number | null {
    const m = this.members.get(account_id);
    assert(m !== null, "Unknown member");
    try {
      const id = Number(JSON.parse(near.promiseResult(0)));
      m.status = "proposed";
      m.proposal_id = id;
      this.members.set(account_id, m);
      emit("door_opened", { account_id, dao_id: this.dao_id, proposal_id: id, role: this.role });
      return id;
    } catch (_e) {
      // The DAO rejected the proposal (for example, the bond ran out). Let the next check-in retry.
      m.status = "none";
      this.members.set(account_id, m);
      emit("door_failed", { account_id, dao_id: this.dao_id });
      return null;
    }
  }

  // ---------- views ----------

  @view({})
  get_config() {
    return {
      dao_id: this.dao_id,
      hosts: this.hosts,
      threshold: this.threshold,
      window_days: this.window_days,
      role: this.role,
      bond: this.bond,
    };
  }

  @view({})
  get_session({ session_id }: { session_id: string }) {
    const s = this.sessions.get(session_id);
    if (s === null) return null;
    const { code_hash: _hidden, ...rest } = s;
    return rest;
  }

  @view({})
  get_sessions({ from_index = 0, limit = 50 }: { from_index?: number; limit?: number }) {
    return this.sessions
      .toArray()
      .slice(from_index, from_index + limit)
      .map(([, s]) => {
        const { code_hash: _hidden, ...rest } = s;
        return rest;
      });
  }

  @view({})
  get_member({ account_id }: { account_id: string }) {
    const m = this.members.get(account_id);
    if (m === null) return null;
    const now = near.blockTimestamp();
    return {
      account_id,
      checkins: m.checkins,
      count_in_window: this.countInWindow(m, now),
      threshold: this.threshold,
      status: m.status,
      proposal_id: m.proposal_id,
    };
  }

  @view({})
  get_members({ from_index = 0, limit = 100 }: { from_index?: number; limit?: number }) {
    const now = near.blockTimestamp();
    return this.member_list.slice(from_index, from_index + limit).map((id) => {
      const m = this.members.get(id) as Member;
      return {
        account_id: id,
        count_in_window: this.countInWindow(m, now),
        status: m.status,
        proposal_id: m.proposal_id,
      };
    });
  }

  // ---------- web4: the contract serves its own web app at <account>.testnet.page ----------

  @view({})
  web4_get({ request }: { request: { path?: string } }) {
    const p = !request?.path || request.path === "/" ? "/index.html" : request.path;
    const f = WEB4_FILES[p];
    if (!f) {
      return { status: 404, contentType: "text/plain; charset=utf-8", body: "Tm90IGZvdW5k" }; // "Not found"
    }
    return { contentType: f.t, body: f.b };
  }

  // ---------- helpers ----------

  private assertHost() {
    assert(this.hosts.includes(near.predecessorAccountId()), "Only a host can do this");
  }

  private getSession(session_id: string): Session {
    const s = this.sessions.get(session_id);
    assert(s !== null, "Unknown session");
    return s as Session;
  }

  private countInWindow(m: Member, now: bigint): number {
    const since = now - BigInt(this.window_days) * NS_PER_DAY;
    return m.checkins.filter((c) => BigInt(c.at) >= since).length;
  }
}
