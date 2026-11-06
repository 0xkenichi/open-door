// Open Door web app: no build step. Reads state over NEAR JSON-RPC and signs with NEAR Wallet Selector.
// Signing in creates a function-call key limited to `check_in`, so checking in needs no wallet pop-up.
import { CONFIG } from "./config.js";

// js-sha256 (used inside the wallet libraries) mistakes the CDN's `process` shim for Node.js and
// calls require(). This flag is its documented switch for browser mode.
globalThis.JS_SHA256_NO_NODE_JS = true;

const WS = "https://esm.sh/@near-wallet-selector";
const WS_VERSION = "10.1.4";
const GAS = "300000000000000";
const $ = (id) => document.getElementById(id);

let selector = null;
let modal = null;
let accountId = null;
let config = null;

// ---------- chain reads ----------

async function view(contractId, method, args = {}) {
  const res = await fetch(CONFIG.nodeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "open-door",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.data || json.error.message);
  if (json.result.error) throw new Error(json.result.error);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(json.result.result)));
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const nowNs = () => BigInt(Date.now()) * 1_000_000n;
const short = (id) => (id.length > 28 ? `${id.slice(0, 12)}…${id.slice(-12)}` : id);
const explorerAccount = (id) => `${CONFIG.explorer}/address/${id}`;

function contractError(err) {
  const text = String(err?.message || err);
  const m = text.match(/assertion failed: ([^\n\\"]+)/) || text.match(/panicked: ([^\n\\"]+)/);
  return m ? m[1].trim() : "Something went wrong. Try again.";
}

// ---------- wallet ----------

async function initWallet() {
  try {
    const [core, ui, mnw, meteor, here, intear] = await Promise.all([
      import(`${WS}/core@${WS_VERSION}`),
      import(`${WS}/modal-ui@${WS_VERSION}`),
      import(`${WS}/my-near-wallet@${WS_VERSION}`),
      import(`${WS}/meteor-wallet@${WS_VERSION}`),
      import(`${WS}/here-wallet@${WS_VERSION}`),
      import(`${WS}/intear-wallet@${WS_VERSION}`),
    ]);
    selector = await core.setupWalletSelector({
      network: CONFIG.networkId,
      modules: [mnw.setupMyNearWallet(), meteor.setupMeteorWallet(), here.setupHereWallet(), intear.setupIntearWallet()],
      createAccessKeyFor: { contractId: CONFIG.doorId, methodNames: ["check_in"] },
    });
    modal = ui.setupModal(selector, { contractId: CONFIG.doorId, methodNames: ["check_in"] });
    const pick = (state) => state.accounts.find((a) => a.active)?.accountId || null;
    accountId = pick(selector.store.getState());
    selector.store.observable.subscribe((state) => {
      const next = pick(state);
      if (next !== accountId) {
        accountId = next;
        renderAuth();
        refresh();
      }
    });
  } catch (e) {
    console.error("Wallet Selector failed to load", e);
    $("auth").textContent = "Wallets unavailable";
    $("auth").disabled = true;
  }
  renderAuth();
}

function renderAuth() {
  const btn = $("auth");
  if (!selector) return;
  btn.disabled = false;
  btn.textContent = accountId ? `${short(accountId)} · Sign out` : "Sign in";
  btn.onclick = async () => {
    if (!accountId) return modal.show();
    const wallet = await selector.wallet();
    await wallet.signOut();
  };
}

async function callDoor(methodName, args) {
  if (!accountId) {
    modal?.show();
    throw new Error("Sign in first.");
  }
  const wallet = await selector.wallet();
  return wallet.signAndSendTransaction({
    receiverId: CONFIG.doorId,
    actions: [{ type: "FunctionCall", params: { methodName, args, gas: GAS, deposit: "0" } }],
  });
}

// ---------- check in ----------

async function renderSessions() {
  const sessions = await view(CONFIG.doorId, "get_sessions", { from_index: 0, limit: 100 });
  const open = sessions.filter((s) => !s.closed && BigInt(s.ends_at) >= nowNs()).reverse();
  const sel = $("session");
  sel.innerHTML = "";
  for (const s of open) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = `${s.title} · ${s.attendees.length} here`;
    sel.appendChild(opt);
  }
  $("session-hint").textContent = open.length
    ? "Type the code your host reads out on the call."
    : "No call is open right now. Check back when the next call starts.";
  $("checkin-form").hidden = open.length === 0;
  return sessions;
}

$("checkin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("checkin-status");
  const btn = $("checkin-btn");
  const session_id = $("session").value;
  const code = $("code").value.trim();
  if (!code) return;
  btn.disabled = true;
  status.className = "status";
  status.textContent = "Checking you in…";
  try {
    await callDoor("check_in", { session_id, code });
    $("code").value = "";
    const m = await view(CONFIG.doorId, "get_member", { account_id: accountId });
    status.className = "status ok";
    status.textContent =
      m.status === "proposed"
        ? `That's ${m.count_in_window} calls. A proposal to give you a vote is on the DAO.`
        : `You're in. ${Math.max(0, m.threshold - m.count_in_window)} more call(s) to earn your vote.`;
    refresh();
  } catch (err) {
    status.className = "status bad";
    status.textContent = contractError(err);
  } finally {
    btn.disabled = false;
  }
});

// ---------- record ----------

// Read-only "view as" mode (?as=account.testnet): shows anyone's public path to a vote without signing in.
const viewAs = new URLSearchParams(location.search).get("as");

async function renderRecord(voters) {
  const box = $("record");
  const who = accountId || viewAs;
  if (!who) {
    box.innerHTML = `<p class="muted">Sign in to see your check-ins.</p>`;
    return;
  }
  const m = await view(CONFIG.doorId, "get_member", { account_id: who });
  const viewing = !accountId ? `<p class="muted">Viewing ${short(who)} (read-only)</p>` : "";
  const count = m?.count_in_window ?? 0;
  const threshold = config.threshold;
  const dots = Array.from({ length: threshold }, (_, i) => `<span class="dot ${i < count ? "on" : ""}"></span>`).join("");
  let line;
  if (voters.includes(who)) line = `${accountId ? "You're" : "They're"} a voter. The door is open.`;
  else if (m?.status === "proposed")
    line = `Proposal #${m.proposal_id} to give ${accountId ? "you" : "them"} a vote is waiting for the council.`;
  else line = `${Math.max(0, threshold - count)} more call(s) in ${config.window_days} days to earn ${accountId ? "your" : "their"} vote.`;
  box.innerHTML = `${viewing}
    <div class="dots" aria-label="${count} of ${threshold} check-ins">${dots}</div>
    <p class="big">${count} of ${threshold} calls</p>
    <p>${line}</p>
    ${m?.proposal_id != null ? `<p class="muted">DAO: <a href="${explorerAccount(CONFIG.daoId)}" target="_blank" rel="noopener">${short(CONFIG.daoId)}</a> · proposal #${m.proposal_id}</p>` : ""}`;
}

// ---------- host ----------

function newCode() {
  const n = crypto.getRandomValues(new Uint16Array(1))[0] % 9000;
  return `DOOR-${1000 + n}`;
}

async function renderHost(sessions) {
  const isHost = accountId && config.hosts.includes(accountId);
  $("host-card").hidden = !isHost;
  if (!isHost) return;
  const open = sessions.filter((s) => !s.closed && BigInt(s.ends_at) >= nowNs());
  const box = $("host-sessions");
  box.innerHTML = open.length ? `<h3>Open calls</h3>` : "";
  for (const s of open) {
    const row = document.createElement("div");
    row.className = "session";
    const saved = sessionStorage.getItem(`od-code:${s.id}`);
    row.innerHTML = `<span>${s.title} · ${s.attendees.length} checked in${saved ? ` · code <b>${saved}</b>` : ""}</span>`;
    const close = document.createElement("button");
    close.className = "btn";
    close.textContent = "Close";
    close.onclick = async () => {
      close.disabled = true;
      try { await callDoor("close_session", { session_id: s.id }); } catch (e) { alert(contractError(e)); }
      refresh();
    };
    row.appendChild(close);
    box.appendChild(row);
  }
}

$("host-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("host-title").value.trim();
  const minutes = Number($("host-minutes").value) || 120;
  const session_id = `call-${Date.now().toString(36)}`;
  const code = newCode();
  // Keep the code locally: some wallets redirect away and back while signing.
  sessionStorage.setItem(`od-code:${session_id}`, code);
  const big = $("host-code");
  big.hidden = false;
  big.textContent = code;
  try {
    const code_hash = await sha256Hex(`${session_id}:${code.toUpperCase()}`);
    await callDoor("open_session", { session_id, title, duration_minutes: minutes, code_hash });
    $("host-title").value = "";
    refresh();
  } catch (err) {
    big.textContent = contractError(err);
  }
});

// ---------- board ----------

async function renderBoard() {
  const [members, policy] = await Promise.all([
    view(CONFIG.doorId, "get_members", { from_index: 0, limit: 100 }),
    view(CONFIG.daoId, "get_policy"),
  ]);
  const role = policy.roles.find((r) => r.name === config.role);
  const voters = role?.kind?.Group || [];
  $("members").innerHTML = members.length
    ? members
        .sort((a, b) => b.count_in_window - a.count_in_window)
        .map((m) => {
          const badge = voters.includes(m.account_id)
            ? `<span class="badge voter">voter</span>`
            : m.status === "proposed"
            ? `<span class="badge proposed">proposed #${m.proposal_id}</span>`
            : `<span class="badge">${m.count_in_window}/${config.threshold}</span>`;
          return `<li><a href="${explorerAccount(m.account_id)}" target="_blank" rel="noopener">${short(m.account_id)}</a>${badge}</li>`;
        })
        .join("")
    : `<li class="muted">Nobody has checked in yet.</li>`;
  $("voters").innerHTML = voters.length
    ? voters.map((v) => `<li><span>${short(v)}</span><span class="badge voter">earned</span></li>`).join("")
    : `<li class="muted">No one has earned a vote yet.</li>`;
  return voters;
}

// ---------- boot ----------

async function refresh() {
  try {
    const sessions = await renderSessions();
    const voters = await renderBoard();
    await Promise.all([renderRecord(voters), renderHost(sessions)]);
  } catch (e) {
    console.error(e);
    $("session-hint").textContent = "Couldn't reach NEAR testnet. Check your connection and refresh.";
  }
}

async function main() {
  config = await view(CONFIG.doorId, "get_config");
  $("rule").textContent =
    `${config.threshold} check-ins within ${config.window_days} days files a proposal to add you to "${config.role}". The DAO council approves it. ` +
    `Use it or lose it: after ${config.inactive_days ?? 30} days without a check-in, anyone can ask the council to remove the role. Show up again to earn it back.`;
  $("links").innerHTML = `<a href="${explorerAccount(CONFIG.doorId)}" target="_blank" rel="noopener">Contract</a> · <a href="${explorerAccount(CONFIG.daoId)}" target="_blank" rel="noopener">DAO</a> · <a href="${CONFIG.repo}" target="_blank" rel="noopener">Code</a>`;
  await refresh();
  initWallet().then(refresh);
}

main();
