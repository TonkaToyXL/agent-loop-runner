// Causeway: direct a crew of AI specialists. No framework: one state object, hash routes,
// one resilient event stream, and views rendered from real hub data.
import {
  $, $$, esc, safeColor, safeJson, safeAsset, store, fmtK, fmtUsd, fmtDur, ago, clock, firstLine,
  shortModel, DEPTH, LEVELS, md, ownAsk, planWaves, makeApi, makeSound,
} from "./lib.js";

const main = $("#main");

// ------------------------------------------------------------------ state
const S = {
  agents: [],
  tasks: new Map(),
  approvals: [],
  lessons: [],
  channels: [],
  lead: "",
  kpis: {},
  connected: false,
  booted: false,
  token: store.get("relay-token") || "",
  sound: store.get("cw-sound") === "on",
  reduceMotion: store.get("cw-reduce-motion") === "on",
  draft: null,
  sel: {},
  runsFilter: "all",
  runsQuery: "",
  flash: new Map(),
  landing: new Map(),
  batons: [],
  dismissed: new Set(safeJson(store.get("cw-dismissed")) ?? []),
};

const api = makeApi(() => S.token, (msg) => showLock(msg));
const sound = makeSound(() => S.sound);

// ------------------------------------------------------------------ small helpers
const agentById = (id) => S.agents.find((a) => a.id === id);
const nameOf = (id) => (id === "you" ? "You" : agentById(id)?.name ?? id);
const roleOf = (a) => a?.role || a?.tagline || "";
const tasksArr = () => [...S.tasks.values()];
const childrenOf = (id) => tasksArr().filter((t) => t.parentId === id);
const stepsOf = (goalId) => childrenOf(goalId).filter((t) => t.kind === "subtask").sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
const pendingApprovals = () => S.approvals.filter((a) => a.status === "pending");
const approvalFor = (taskId) => S.approvals.find((a) => a.taskId === taskId && a.status === "pending");
const isRisky = (t) => /\b(send|post|tweet|publish|share|buy|purchase|pay|order|delete|remove|deploy|reply to|book|subscribe|transfer|install)\b|\bupload (?:it|this|the|my|these|them)\b|\be-?mail (?:him|her|them|the team|everyone|[a-z]+@)/i.test(t);
const isReview = (t) => /\b(review|critique|audit|verify|fact[- ]?check|pressure[- ]?test|evaluate)\b/i.test(t);

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 2600);
}
function announce(text) {
  $("#announcer").textContent = "";
  setTimeout(() => ($("#announcer").textContent = text), 30);
}
async function copyText(text, ok = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(ok);
  } catch {
    toast("Couldn't copy here");
  }
}

/** A task's state in the crew's vocabulary. */
function stateOf(t) {
  if (!t) return "queued";
  if (approvalFor(t.id) || t.awaitingApproval) return "need";
  return { queued: "queued", running: "run", done: "done", failed: "fail", blocked: "block", cancelled: "cancel" }[t.status] ?? "queued";
}
const STATE_LABEL = { queued: "Waiting", run: "On it", need: "Needs your call", block: "Blocked", fail: "Failed", done: "Done", cancel: "Stopped" };
function stPill(state, extra = "") {
  const cls = { run: "run", need: "need", block: "block", fail: "fail", done: "done" }[state] ?? "";
  return `<span class="st ${cls}">${esc(extra || STATE_LABEL[state] || state)}</span>`;
}
function since(t) {
  const start = t.startedAt ?? t.createdAt;
  return t.finishedAt
    ? `<span class="elapsed" data-since="${esc(start)}" data-until="${esc(t.finishedAt)}">${fmtDur(Date.parse(t.finishedAt) - Date.parse(start))}</span>`
    : `<span class="elapsed" data-since="${esc(start)}">${fmtDur(Date.now() - Date.parse(start))}</span>`;
}

/** What an agent is doing right now, for the roster and presence. */
function agentState(a) {
  if (!a) return "off";
  if (pendingApprovals().some((p) => p.agentId === a.id)) return "need";
  if (a.status === "working") return "run";
  if (!a.enabled || a.status === "paused") return "off";
  if (a.status === "offline") return "fail";
  if (a.status === "limited") return "block";
  if (!a.live) return "demo";
  return "ready";
}
const AGENT_STATE_LABEL = { run: "On it", need: "Needs your call", off: "Paused", fail: "Offline", block: "At its limit", demo: "Demo mode", ready: "Ready" };
function activeTasksOf(id) {
  return tasksArr().filter((t) => t.agentId === id && (t.status === "running" || t.status === "queued") && t.kind !== "goal");
}

function avatar(a, size = "", label = true) {
  const src = safeAsset(a?.avatarIdle) || safeAsset(a?.brandLogo);
  const alt = label ? esc(a?.name ?? "") : "";
  if (src) return `<img class="av ${size}" src="${src}" alt="${alt}" loading="lazy" />`;
  const ch = esc((a?.name ?? "?")[0]);
  return `<span class="av ${size} av-fallback" style="--c:${safeColor(a?.color)}" ${label ? `role="img" aria-label="${alt}"` : 'aria-hidden="true"'}>${ch}</span>`;
}
function whoChip(id, { role = false, size = "sm" } = {}) {
  if (id === "you") return `<span class="who"><span class="av ${size} av-fallback" aria-hidden="true">Y</span><b>You</b></span>`;
  const a = agentById(id);
  return `<span class="who">${avatar(a, size, false)}<span class="grow"><b>${esc(a?.name ?? id)}</b>${role && a ? ` <span class="role">${esc(roleOf(a))}</span>` : ""}</span></span>`;
}
function agentOptions(selected, { includeOff = false } = {}) {
  return S.agents
    .filter((a) => includeOff || a.enabled)
    .map((a) => {
      const st = agentState(a);
      const note = st === "demo" ? " · demo" : st === "off" ? " · paused" : st === "block" ? " · at limit" : st === "fail" ? " · offline" : "";
      return `<option value="${esc(a.id)}" ${a.id === selected ? "selected" : ""}>${esc(a.name)} · ${esc(roleOf(a))}${note}</option>`;
    })
    .join("");
}

// ------------------------------------------------------------------ "needs you"
/** Everything that needs the owner: pending approvals and questions, plus stuck work that's still recoverable. */
function needsItems() {
  const items = pendingApprovals().map((a) => ({ type: a.kind === "question" ? "question" : "approval", id: a.id, approval: a, task: S.tasks.get(a.taskId) }));
  const recent = Date.now() - 6 * 3_600_000;
  for (const t of tasksArr()) {
    if (S.dismissed.has(t.id) || t.redirectedTo) continue;
    if (t.status !== "blocked" && t.status !== "failed") continue;
    if (Date.parse(t.finishedAt ?? t.createdAt) < recent) continue;
    if (t.kind === "subtask") {
      const goal = S.tasks.get(t.parentId);
      if (goal?.status === "running") items.push({ type: "stuck", id: t.id, task: t, goal });
    } else if (t.kind === "direct") {
      items.push({ type: "stuck", id: t.id, task: t });
    }
  }
  return items;
}
function goalOf(t) {
  if (!t) return null;
  return t.kind === "goal" ? t : t.parentId ? S.tasks.get(t.parentId) : null;
}
function needCard(item) {
  if (item.type === "approval" || item.type === "question") {
    const a = item.approval;
    const goal = goalOf(item.task);
    const where = goal ? `<a class="link" href="#/run/${esc(goal.id)}">${esc(firstLine(goal.prompt, 60))}</a>` : item.task ? `<a class="link" href="#/task/${esc(item.task.id)}">Open task</a>` : "";
    const left = Math.max(0, Date.parse(a.expiresAt) - Date.now());
    const body = `${avatar(agentById(a.agentId), "", false)}
      <div class="grow"><div class="need-title">${esc(a.title)}</div>
        <div class="need-detail">${esc(firstLine(a.detail, 140))}${where ? ` · ${where}` : ""} · auto-denies in ${Math.ceil(left / 60_000)} min</div></div>`;
    if (a.kind === "question") {
      return `<div class="need-card" data-need="${esc(a.id)}">${body}
        <div class="need-actions"><button type="button" class="btn sm ghost" data-decide="${esc(a.id)}" data-approve="false">Skip</button></div>
        <form class="need-answer" data-answer-form="${esc(a.id)}"><label class="sr" for="ans-${esc(a.id)}">Your answer</label>
          <input class="input" id="ans-${esc(a.id)}" placeholder="Your answer…" autocomplete="off" required /><button class="btn sm primary" type="submit">Send</button></form></div>`;
    }
    return `<div class="need-card" data-need="${esc(a.id)}">${body}
      <div class="need-actions">
        <button type="button" class="btn sm ghost" data-decide="${esc(a.id)}" data-approve="false">Deny</button>
        <button type="button" class="btn sm pink" data-decide="${esc(a.id)}" data-approve="true">Approve</button>
      </div></div>`;
  }
  const t = item.task;
  const goal = item.goal;
  return `<div class="need-card block" data-need="${esc(t.id)}">${avatar(agentById(t.agentId), "", false)}
    <div class="grow"><div class="need-title">${esc(nameOf(t.agentId))}: ${t.status === "blocked" ? "blocked" : "failed"} on “${esc(firstLine(t.title, 60))}”</div>
      <div class="need-detail">${esc(firstLine(t.error, 160))}</div></div>
    <div class="need-actions">
      <button type="button" class="btn sm ghost" data-dismiss="${esc(t.id)}">Dismiss</button>
      <a class="btn sm" href="${goal ? `#/run/${esc(goal.id)}?step=${esc(t.id)}` : `#/task/${esc(t.id)}`}">Redirect…</a>
    </div></div>`;
}

// ------------------------------------------------------------------ routing
function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  const [path, q] = h.split("?");
  const parts = path.split("/").filter(Boolean);
  return { name: parts[0] || "overview", id: parts[1] ? decodeURIComponent(parts[1]) : "", params: new URLSearchParams(q || "") };
}
const go = (hash) => { if (location.hash !== hash) location.hash = hash; else render(true); };

let lastKey = "";
let renderQueued = false;
function schedule() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(false); });
}

/** Keep what the owner is typing when live data re-renders the view. */
function capture() {
  const vals = {};
  for (const el of $$("input[id], textarea[id], select[id]", main)) vals[el.id] = el.type === "checkbox" ? el.checked : el.value;
  const a = document.activeElement;
  return {
    vals,
    focus: a && main.contains(a) && a.id ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null,
    open: $$("details[id]", main).filter((d) => d.open).map((d) => d.id),
    insp: $(".inspector", main)?.scrollTop ?? 0,
  };
}
function restore(c) {
  for (const [id, v] of Object.entries(c.vals)) {
    const el = document.getElementById(id);
    if (!el || !main.contains(el) || el.hasAttribute("data-no-restore")) continue;
    if (el.type === "checkbox") el.checked = v;
    else el.value = v;
  }
  for (const id of c.open) { const d = document.getElementById(id); if (d) d.open = true; }
  if (c.focus) {
    const el = document.getElementById(c.focus.id);
    if (el) {
      el.focus({ preventScroll: true });
      try { if (c.focus.s != null) el.setSelectionRange(c.focus.s, c.focus.e); } catch {}
    }
  }
  const insp = $(".inspector", main);
  if (insp) insp.scrollTop = c.insp;
}

function render(force = false) {
  const r = route();
  const key = `${r.name}/${r.id}`;
  updateChrome(r);
  if (!S.booted) return;
  // Don't yank the plan editor out from under the owner on live updates.
  if (!force && r.name === "new" && key === lastKey) return;
  const same = key === lastKey;
  const kept = same ? capture() : null;
  main.innerHTML = view(r);
  if (kept) restore(kept);
  lastKey = key;
  afterRender(r, same);
}
function view(r) {
  switch (r.name) {
    case "overview": return viewOverview();
    case "new": return viewNew(r);
    case "run": return viewRun(r);
    case "compare": return viewCompare(r);
    case "runs": return viewRuns();
    case "task": return viewTask(r);
    case "crew": return r.id ? viewAgent(r.id) : viewCrew();
    case "playbooks": return viewPlaybooks();
    case "settings": return viewSettings();
    default: return `<div class="view"><div class="empty">That page doesn't exist. <a class="link" href="#/">Back to overview</a></div></div>`;
  }
}
function afterRender(r, same) {
  if (r.name === "run") {
    drawEdges();
    if (!same) $(".node.sel", main)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  if (!same) {
    main.scrollTop = 0;
    window.scrollTo(0, 0);
    const autofocus = $("[data-autofocus]", main);
    if (autofocus && matchMedia("(min-width: 761px)").matches) autofocus.focus();
  }
  autosizeAll();
}

// ------------------------------------------------------------------ chrome
function updateChrome(r) {
  const navName = r.name === "run" || r.name === "task" || r.name === "compare" ? "runs" : r.name;
  for (const a of $$("[data-nav]")) a.classList.toggle("on", a.dataset.nav === navName);
  for (const a of $$("[data-nav]")) a.toggleAttribute("aria-current", a.dataset.nav === navName);
  const n = needsItems().length;
  for (const [btnSel, countSel] of [["#needsBtn", "#needsCount"], ["#needsBtnTop", "#needsCountTop"]]) {
    $(btnSel).hidden = !n;
    $(countSel).textContent = String(n);
  }
  $("#needsLabel").textContent = n === 1 ? "Needs you" : "Need you";
  const proposed = S.lessons.filter((l) => l.status === "proposed").length;
  $("#lessonBadge").hidden = !proposed;
  $("#lessonBadge").textContent = String(proposed);
  $("#presence").innerHTML = S.agents
    .filter((a) => a.enabled)
    .map((a) => { const st = agentState(a); return `<a href="#/crew/${esc(a.id)}" title="${esc(a.name)}: ${esc(AGENT_STATE_LABEL[st])}">${avatar(a, "", false)}<i class="pip ${st === "ready" ? "ready" : st === "demo" ? "off" : st}"></i><span class="sr">${esc(a.name)}: ${esc(AGENT_STATE_LABEL[st])}</span></a>`; })
    .join("");
  const conn = $("#connState");
  conn.className = `conn ${S.connected ? "ok" : "bad"}`;
  conn.textContent = S.connected ? "Live" : "Reconnecting…";
  const sb = $("#soundBtn");
  sb.setAttribute("aria-pressed", String(S.sound));
  sb.title = `Sound cues (${S.sound ? "on" : "off"})`;
  document.documentElement.classList.toggle("reduce-motion", S.reduceMotion);
  document.title = n ? `(${n}) Causeway` : "Causeway";
  if (!$("#needsPanel").hidden) renderNeedsPanel();
}

// ------------------------------------------------------------------ overview
function pulseLine(needs, live, working) {
  const parts = [];
  if (needs) parts.push(`<span class="hot">${needs} ${needs === 1 ? "thing needs" : "things need"} your call.</span>`);
  if (live) parts.push(`<em>${live} run${live === 1 ? "" : "s"} live</em>, ${working} specialist${working === 1 ? "" : "s"} on it.`);
  if (!parts.length) return working ? `<em>${working} specialist${working === 1 ? "" : "s"} on it.</em> Nothing needs you.` : "Crew's ready. What's the goal?";
  return parts.join(" ");
}
const EXAMPLES = [
  "Research what's new in AI today and pitch 3 short video hooks",
  "Draft a launch post for the new product and have it reviewed",
  "Compare two options for our newsletter tool and recommend one",
];
function composer({ autofocus = true } = {}) {
  const books = S.lessons.filter((l) => l.kind === "playbook" && l.status === "approved").slice(-3).reverse();
  return `<form class="composer" id="goalForm" aria-label="Start a goal">
    <label class="sr" for="goal-input">Describe the goal</label>
    <textarea id="goal-input" rows="2" ${autofocus ? "data-autofocus" : ""} placeholder="What needs doing? Describe the outcome. Causeway recommends who does what, and you approve the plan."></textarea>
    <div class="composer-bar">
      <div class="starters">
        ${books.map((b) => `<button type="button" class="starter book" data-use-playbook="${esc(b.id)}" title="${esc(b.text)}">▸ ${esc(b.title.replace(/^Playbook: /, ""))}</button>`).join("")}
        ${EXAMPLES.slice(0, books.length ? 1 : 3).map((x) => `<button type="button" class="starter" data-example="${esc(x)}">${esc(x)}</button>`).join("")}
      </div>
      <button class="btn primary" type="submit">Plan it <kbd>⌘↵</kbd></button>
    </div>
  </form>`;
}
function runStrip(goal) {
  const steps = stepsOf(goal.id);
  if (!steps.length) {
    const plan = childrenOf(goal.id).find((t) => t.kind === "plan");
    return `<div class="strip"><span class="seg run" title="Planning">${plan ? avatar(agentById(plan.agentId), "", false) : ""}</span><span class="small muted" style="margin-left:6px">Planning…</span></div>`;
  }
  const waves = planWaves(steps.map((s) => ({ after: (s.after ?? []).map((n) => n - 1) })));
  let html = "";
  let prev = -1;
  steps.forEach((s, i) => {
    if (prev >= 0 && waves[i] !== prev) html += `<span class="gap" aria-hidden="true"></span>`;
    prev = waves[i];
    const st = stateOf(s);
    html += `<span class="seg ${st}" title="${esc(nameOf(s.agentId))}: ${esc(STATE_LABEL[st])} · ${esc(firstLine(s.title, 60))}">${avatar(agentById(s.agentId), "", false)}</span>`;
  });
  const done = steps.filter((s) => s.status === "done").length;
  return `<div class="strip" aria-label="${done} of ${steps.length} steps done">${html}</div>`;
}
function viewOverview() {
  const goals = tasksArr().filter((t) => t.kind === "goal");
  const liveRuns = goals.filter((g) => g.status === "running" || g.status === "queued").reverse();
  const needs = needsItems();
  const working = S.agents.filter((a) => a.status === "working").length;
  const recent = tasksArr()
    .filter((t) => (t.kind === "goal" || t.kind === "direct") && t.status === "done" && t.result)
    .sort((a, b) => Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt))
    .slice(0, 6);
  return `<div class="view">
    <div class="page-head"><div><div class="eyebrow">Tonight's board</div><p class="pulse-line">${pulseLine(needs.length, liveRuns.length, working)}</p></div></div>
    ${composer()}
    <div class="two-col sec">
      <div>
        <section aria-labelledby="h-needs">
          <div class="sec-head"><h2 id="h-needs">Needs you</h2></div>
          ${needs.length ? `<div class="need-list">${needs.slice(0, 5).map(needCard).join("")}</div>${needs.length > 5 ? `<button type="button" class="link btn ghost sm" data-open-needs>See all ${needs.length}</button>` : ""}` : `<div class="all-clear"><i class="pip"></i>All clear. Nothing is waiting on you.</div>`}
        </section>
        <section class="sec" aria-labelledby="h-live">
          <div class="sec-head"><h2 id="h-live">Live runs</h2><a href="#/runs">All runs →</a></div>
          ${liveRuns.length ? `<div class="runs-live">${liveRuns.map((g) => {
            const steps = stepsOf(g.id);
            const done = steps.filter((s) => s.status === "done").length;
            return `<a class="runline" href="#/run/${esc(g.id)}"><div class="grow"><div class="title ellipsis">${esc(firstLine(g.prompt, 90))}</div>
              <div class="meta">${steps.length ? `${done}/${steps.length} steps` : "Planning"} · started ${esc(ago(g.createdAt))}</div></div>
              ${runStrip(g)}${since(g)}</a>`;
          }).join("")}</div>` : `<div class="empty">No runs live. Describe a goal above and the crew gets a plan in seconds.</div>`}
        </section>
        <section class="sec" aria-labelledby="h-out">
          <div class="sec-head"><h2 id="h-out">Latest outputs</h2></div>
          ${recent.length ? `<div class="outputs">${recent.map((t) => {
            const crew = t.kind === "goal" ? [...new Set(stepsOf(t.id).map((s) => s.agentId))] : [t.agentId];
            return `<a class="output-item" href="${t.kind === "goal" ? `#/run/${esc(t.id)}` : `#/task/${esc(t.id)}`}">
              <span class="av-stack">${crew.slice(0, 4).map((id) => avatar(agentById(id), "sm", false)).join("")}</span>
              <div class="grow"><div class="ellipsis"><b>${esc(firstLine(t.display ?? t.prompt, 90))}</b></div><div class="excerpt">${esc(firstLine(t.result, 220))}</div></div>
              <span class="small faint">${esc(ago(t.finishedAt ?? t.createdAt))}</span></a>`;
          }).join("")}</div>` : `<div class="empty">Finished work shows up here.</div>`}
        </section>
      </div>
      <section aria-labelledby="h-crew">
        <div class="sec-head"><h2 id="h-crew">Crew right now</h2><a href="#/crew">Roster →</a></div>
        <div class="roster">${S.agents.filter((a) => a.enabled || a.status === "paused").map((a) => {
          const st = agentState(a);
          const now = activeTasksOf(a.id)[0];
          return `<a class="roster-row" href="#/crew/${esc(a.id)}" style="--c:${safeColor(a.color)}">
            <span class="who">${avatar(a, "", false)}<span class="grow"><b>${esc(a.name)}</b>${a.isLead ? ' <span class="tag">Lead</span>' : ""}<br><span class="role">${esc(roleOf(a))}</span></span></span>
            <span class="now">${now ? `<span class="ellipsis">${esc(firstLine(now.title, 70))}</span>` : `<span class="faint">${st === "demo" ? "Demo mode: add its key to go live" : "Free for work"}</span>`}</span>
            <span class="model ellipsis">${esc(shortModel(a.model, a))}</span>
            ${stPill(st === "ready" ? "idle" : st === "demo" ? "queued" : st, AGENT_STATE_LABEL[st])}</a>`;
        }).join("")}</div>
      </section>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ plan review
function viewNew(r) {
  const d = S.draft;
  const playbookId = r.params.get("playbook") ?? "";
  const books = S.lessons.filter((l) => l.kind === "playbook" && l.status === "approved");
  if (!d || (!d.steps && !d.loading && !d.error)) {
    return `<div class="view">
      <div class="page-head"><div><div class="eyebrow">New goal</div><h1>Describe the outcome.</h1>
        <p class="sub">Causeway recommends a plan: which specialist takes each step, why, and what runs in parallel. You review and edit it before anything starts.</p></div></div>
      <form class="composer" id="goalForm">
        <label class="sr" for="goal-input">Describe the goal</label>
        <textarea id="goal-input" rows="3" data-autofocus placeholder="e.g. Find what people on X are saying about our launch, draft three replies, and have them reviewed before I post.">${esc(d?.goal ?? "")}</textarea>
        <div class="composer-bar">
          <div class="starters">
            ${books.length ? `<label class="small muted" for="playbook-pick">Start from</label><select class="input" id="playbook-pick" style="width:auto;min-height:30px;padding:3px 8px">
              <option value="">A fresh plan</option>${books.map((b) => `<option value="${esc(b.id)}" ${b.id === playbookId ? "selected" : ""}>${esc(b.title)}</option>`).join("")}</select>` : ""}
            ${EXAMPLES.map((x) => `<button type="button" class="starter" data-example="${esc(x)}">${esc(x)}</button>`).join("")}
          </div>
          <button class="btn primary" type="submit">Recommend a plan <kbd>⌘↵</kbd></button>
        </div>
      </form>
      <div class="note-honest sec" style="margin-top:16px"><span>ⓘ</span><span>Planning uses one quick call to your planner (free on ClinePass). Nothing else runs until you press <b>Launch crew</b>.</span></div>
    </div>`;
  }
  if (d.loading) {
    return `<div class="view"><div class="page-head"><div><div class="eyebrow">Plan review</div><h1>${esc(firstLine(d.goal, 120))}</h1></div></div>
      <div class="drafting" role="status"><div class="bar-progress" aria-hidden="true"><i></i></div><span>${d.playbookId ? "Loading your playbook…" : d.mode === "solo" ? "Picking the right specialist…" : d.compare ? "Planning both ways…" : "Drafting a plan…"}</span></div></div>`;
  }
  if (d.error) {
    return `<div class="view"><div class="page-head"><div><div class="eyebrow">Plan review</div><h1>${esc(firstLine(d.goal, 120))}</h1></div></div>
      <div class="need-card block"><span></span><div class="grow"><div class="need-title">Couldn't draft a plan</div><div class="need-detail">${esc(d.error)}</div></div>
      <div class="need-actions"><button type="button" class="btn sm" data-draft-edit>Edit goal</button><button type="button" class="btn sm primary" data-replan>Try again</button></div></div></div>`;
  }
  const steps = d.steps;
  const waves = planWaves(steps);
  const nWaves = steps.length ? Math.max(...waves) + 1 : 0;
  const SOURCE = {
    solo: "Solo: one specialist end to end",
    planner: `Crew plan by ${esc(d.planner?.name ?? "your planner")}`,
    fast: "Quick ask: one specialist is enough",
    fallback: "Planner unavailable: matched by skills (review closely)",
    playbook: "From your approved playbook",
    rerun: "Same crew as the earlier run",
  };
  const cols = [];
  for (let w = 0; w < nWaves; w++) {
    const idx = steps.map((_, i) => i).filter((i) => waves[i] === w);
    cols.push(`<div class="wave-col" role="group" aria-label="${w === 0 ? "Starts now" : `Wave ${w + 1}`}">
      <div class="wave-head"><b>${w === 0 ? "Starts now" : `Then · wave ${w + 1}`}</b>${idx.length > 1 ? `<span class="par">${idx.length} in parallel</span>` : ""}</div>
      ${idx.map((i) => stepCard(steps[i], i, steps)).join("")}
    </div>`);
  }
  return `<div class="view">
    <div class="page-head"><div class="grow"><div class="eyebrow">Plan review</div>
      <label class="sr" for="draft-goal">Goal</label>
      <textarea class="input" id="draft-goal" rows="2" style="font:650 18px/1.35 var(--font-display);background:transparent;border-color:transparent;padding:4px 0;resize:none" data-no-restore>${esc(d.goal)}</textarea></div></div>
    <div class="plan-meta">
      ${d.source !== "playbook" && d.source !== "rerun" ? `<div class="seg" role="group" aria-label="Solo or crew">
        <button type="button" data-mode="solo" aria-pressed="${steps.length <= 1}" title="One strong specialist does it all">Solo</button>
        <button type="button" data-mode="crew" aria-pressed="${steps.length > 1}" title="Split it across specialists">Crew</button></div>` : ""}
      <span class="tag">${SOURCE[d.source] ?? esc(d.source)}</span>
      ${d.source !== "playbook" && d.source !== "rerun" ? `<button type="button" class="btn sm ghost" data-compare title="Runs it both ways side by side. Uses both runs' usage.">Compare solo vs crew</button>` : ""}
      ${d.notes?.length ? `<details id="notes-applied"><summary class="tag" style="cursor:pointer">${d.notes.length} approved note${d.notes.length === 1 ? "" : "s"} applied</summary><ul class="small muted">${d.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : ""}
    </div>
    <div class="why-setup"><div class="eyebrow">Why this setup</div><p>${d.modeReason ? `<b style="color:var(--text)">${esc(d.modeReason)}</b> ` : ""}${esc(whySetup(steps, waves))}</p></div>
    <div class="board" id="board">${cols.join("")}</div>
    <div class="plan-actions">
      <button type="button" class="btn sm" data-add-step>+ Add step</button>
      <button type="button" class="btn sm ghost" data-replan>Re-plan</button>
      <button type="button" class="btn sm ghost" data-draft-cancel>Discard</button>
      <span class="spacer"></span>
      <p class="err" id="plan-err" role="alert" hidden></p>
      <button type="button" class="btn sunset lg" data-launch>${steps.length === 1 ? `Send to ${esc(nameOf(steps[0].agentId))}` : "Launch crew"} <kbd style="border-color:rgba(20,8,20,.25);color:rgba(20,8,20,.7)">⌘↵</kbd></button>
    </div>
  </div>`;
}
function whySetup(steps, waves) {
  if (!steps.length) return "Add at least one step.";
  if (steps.length === 1) return `${nameOf(steps[0].agentId)} takes it end to end with its strongest settings. Switch to Crew to split it, or compare both.`;
  const names = (ids) => [...new Set(ids.map((i) => nameOf(steps[i].agentId)))].join(" and ");
  const first = steps.map((_, i) => i).filter((i) => waves[i] === 0);
  const nW = Math.max(...waves) + 1;
  const parts = [`${steps.length} step${steps.length === 1 ? "" : "s"} in ${nW} wave${nW === 1 ? "" : "s"}.`];
  parts.push(first.length > 1 ? `${names(first)} start at the same time.` : `${names(first)} starts right away.`);
  const later = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.after.length);
  for (const { s, i } of later.slice(0, 3)) {
    const ups = names(s.after);
    parts.push(isReview(s.task) ? `${nameOf(s.agentId)} reviews ${ups}'s work once it lands.` : `${nameOf(s.agentId)} builds on ${ups}'s results (step ${i + 1}).`);
  }
  const gated = steps.filter((s) => agentById(s.agentId)?.actsInWorld && isRisky(s.task));
  if (gated.length) parts.push(`${names(steps.map((s, i) => (gated.includes(s) ? i : -1)).filter((i) => i >= 0))} will ask for your OK before acting.`);
  if (steps.length > 1) parts.push("A wrap-up combines everything into one answer.");
  return parts.join(" ");
}
function stepCard(s, i, steps) {
  const a = agentById(s.agentId);
  const st = agentState(a);
  const why = s.agentId !== s.origAgent ? `You picked ${a?.name ?? s.agentId}: ${a?.tagline ?? ""}` : s.why;
  const review = s.after.length > 0 && isReview(s.task);
  const gated = a?.actsInWorld && isRisky(s.task);
  return `<div class="step-card" style="--c:${safeColor(a?.color)}" data-step-card="${i}">
    <div class="step-top">
      <span class="step-num">#${i + 1}</span>
      ${avatar(a, "sm", false)}
      <label class="sr" for="step-agent-${i}">Specialist for step ${i + 1}</label>
      <select class="input grow" id="step-agent-${i}" data-step-agent="${i}" data-no-restore>${agentOptions(s.agentId)}</select>
      <span class="step-tools">
        <button type="button" class="icon-btn" data-step-move="${i}" data-dir="-1" title="Move up" aria-label="Move step ${i + 1} earlier" ${i === 0 ? "disabled" : ""}><svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg></button>
        <button type="button" class="icon-btn" data-step-remove="${i}" title="Remove step" aria-label="Remove step ${i + 1}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </span>
    </div>
    <label class="sr" for="step-task-${i}">What step ${i + 1} should produce</label>
    <textarea class="input" id="step-task-${i}" data-step-task="${i}" rows="3" data-no-restore placeholder="What should this step produce?">${esc(s.task)}</textarea>
    ${why ? `<div class="step-why"><b>Why ${esc(a?.name ?? "")}:</b> ${esc(why)}</div>` : ""}
    ${i > 0 ? `<div class="deps" role="group" aria-label="Step ${i + 1} builds on"><span>Builds on</span>${steps.slice(0, i).map((u, j) => `<label class="dep"><input type="checkbox" data-step-dep="${i}" data-dep="${j}" ${s.after.includes(j) ? "checked" : ""} data-no-restore />#${j + 1} ${esc(nameOf(u.agentId))}</label>`).join("")}</div>` : ""}
    <div class="row wrap" style="gap:6px">
      ${review ? `<span class="tag review">Peer review</span>` : ""}
      ${gated ? `<span class="tag ok-needed">Asks for your OK first</span>` : ""}
      ${a?.actsInWorld && !gated ? `<span class="tag">Can use live tools</span>` : ""}
    </div>
    ${st === "demo" ? `<div class="step-warn">${esc(a?.name)} is in demo mode: answers will be placeholders.</div>` : st === "block" || st === "fail" || st === "off" ? `<div class="step-warn">${esc(a?.name)} is ${esc(AGENT_STATE_LABEL[st].toLowerCase())}; it may be rerouted.</div>` : ""}
  </div>`;
}
function readDraftInputs() {
  const d = S.draft;
  if (!d?.steps) return;
  const g = $("#draft-goal");
  if (g) d.goal = g.value;
  d.steps.forEach((s, i) => {
    const t = $(`#step-task-${i}`);
    if (t) s.task = t.value;
  });
}
function editDraft(fn) {
  readDraftInputs();
  fn(S.draft);
  render(true);
}
async function startDraft(goal, { playbookId = "", mode = "" } = {}) {
  const text = goal.trim();
  if (!text) { toast("Describe the goal first"); return; }
  S.draft = { goal: text, loading: true, playbookId, mode };
  go("#/new");
  render(true);
  try {
    const d = await api("/api/plan", { method: "POST", body: { goal: text, ...(playbookId ? { playbookId } : {}), ...(mode ? { mode } : {}) } });
    if (S.draft?.goal !== text) return;
    S.draft = { ...d, playbookId, steps: d.steps.map((s) => ({ ...s, origAgent: s.agentId })) };
    announce(`Plan ready: ${d.steps.length} steps. Review it, then launch.`);
  } catch (err) {
    if (err.message === "locked") return;
    S.draft = { goal: text, error: err.message, playbookId };
  }
  if (route().name === "new") render(true);
}
async function launchDraft() {
  readDraftInputs();
  const d = S.draft;
  if (!d?.steps) return;
  const errEl = $("#plan-err");
  const steps = d.steps.map((s) => ({ agentId: s.agentId, task: s.task.trim(), after: s.after, why: s.agentId === s.origAgent ? s.why : `You picked ${nameOf(s.agentId)}.` }));
  const bad = steps.findIndex((s) => !s.task);
  if (!d.goal.trim() || bad >= 0) {
    errEl.hidden = false;
    errEl.textContent = !d.goal.trim() ? "Describe the goal." : `Step ${bad + 1} needs a task.`;
    return;
  }
  const btn = $("[data-launch]");
  if (btn) btn.disabled = true;
  try {
    const res = await api("/api/goals", { method: "POST", body: { goal: d.goal.trim(), steps } });
    S.draft = null;
    announce("Crew launched.");
    go(`#/run/${res.taskId}`);
  } catch (err) {
    if (btn) btn.disabled = false;
    if (err.message === "locked") return;
    errEl.hidden = false;
    errEl.textContent = err.message;
  }
}

// ------------------------------------------------------------------ run view
function runEdges(goal, plan, steps, synth) {
  const edges = [];
  const cls = (up, down) => {
    const su = up ? stateOf(up) : "done";
    const sd = stateOf(down);
    if (su === "fail" || su === "block") return "fail";
    if (su !== "done") return "";
    return sd === "run" || sd === "need" ? "live" : sd === "done" ? "landed" : "";
  };
  const planNode = plan ? plan.id : "plan";
  for (const s of steps) {
    const ups = (s.after ?? []).map((n) => steps.find((x) => x.step === n)).filter(Boolean);
    if (!ups.length) edges.push({ from: planNode, to: s.id, cls: cls(plan, s) });
    for (const u of ups) edges.push({ from: u.id, to: s.id, cls: cls(u, s) });
  }
  if (synth) {
    const used = new Set(steps.flatMap((s) => s.after ?? []));
    for (const s of steps) if (!used.has(s.step)) edges.push({ from: s.id, to: synth.id, cls: cls(s, synth) });
  }
  const now = Date.now();
  for (const e of edges) if (now - (S.landing.get(`${e.from}>${e.to}`) ?? 0) < 900) e.cls += " landing";
  return edges;
}
let currentEdges = [];
function drawEdges() {
  const g = $(".graph", main);
  const svg = $(".edges", main);
  if (!g || !svg) return;
  const wrap = g.parentElement;
  const scrolls = wrap.scrollWidth > wrap.clientWidth + 4;
  wrap.classList.toggle("scrolls", scrolls && wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 4);
  const hint = $(".scroll-hint", main);
  if (hint) hint.hidden = !scrolls;
  if (!wrap.dataset.bound) { wrap.dataset.bound = "1"; wrap.addEventListener("scroll", () => wrap.classList.toggle("scrolls", wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 4), { passive: true }); }
  const gr = g.getBoundingClientRect();
  const W = g.offsetWidth;
  const H = g.offsetHeight;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.style.width = `${W}px`;
  svg.style.height = `${H}px`;
  svg.innerHTML = currentEdges
    .map((e) => {
      const a = g.querySelector(`[data-node="${CSS.escape(e.from)}"]`);
      const b = g.querySelector(`[data-node="${CSS.escape(e.to)}"]`);
      if (!a || !b) return "";
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const x1 = ra.right - gr.left;
      const y1 = ra.top + ra.height / 2 - gr.top;
      const x2 = rb.left - gr.left;
      const y2 = rb.top + rb.height / 2 - gr.top;
      const dx = Math.max(14, (x2 - x1) / 2);
      return `<path class="${e.cls}" d="M${x1.toFixed(1)} ${y1.toFixed(1)} C${(x1 + dx).toFixed(1)} ${y1.toFixed(1)}, ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}" />`;
    })
    .join("");
}
function flashCls(t) {
  const at = S.flash.get(t.id);
  return at && Date.now() - at < 140 ? ` flash ${stateOf(t) === "need" ? "need" : ""}` : "";
}
function node(t, { minor = false, label = "" } = {}, selId, steps = []) {
  const a = agentById(t.agentId);
  const st = stateOf(t);
  const built = (t.after ?? []).map((n) => steps.find((x) => x.step === n)).filter(Boolean);
  const reviewedBy = steps.filter((x) => (x.after ?? []).includes(t.step) && isReview(x.prompt));
  return `<button type="button" class="node ${st === "queued" ? "queued" : st}${minor ? " minor" : ""}${t.id === selId ? " sel" : ""}${flashCls(t)}" data-node="${esc(t.id)}" data-select="${esc(t.id)}" style="--c:${safeColor(a?.color)}" aria-pressed="${t.id === selId}">
    <span class="n-top">${avatar(a, "sm", false)}<span class="grow"><span class="n-who">${esc(a?.name ?? t.agentId)}</span> <span class="n-role">${esc(label || roleOf(a))}</span></span>${stPill(st)}</span>
    <span class="n-task">${esc(firstLine(t.kind === "subtask" ? ownAsk(t.prompt) : t.title, 180))}</span>
    <span class="n-foot">
      ${t.step ? `<span class="tag">#${t.step}</span>` : ""}
      ${built.length ? `<span class="n-built">↳ builds on ${built.map((b) => `#${b.step} ${esc(nameOf(b.agentId))}`).join(", ")}</span>` : ""}
      ${t.kind === "subtask" && built.length && isReview(t.prompt) ? `<span class="tag review">Peer review</span>` : ""}
      ${reviewedBy.length ? `<span class="tag review">Reviewed by ${esc(reviewedBy.map((r) => nameOf(r.agentId)).join(", "))}</span>` : ""}
      ${t.reroutedFrom ? `<span class="tag reroute">from ${esc(nameOf(t.reroutedFrom))}</span>` : ""}
      ${t.status !== "queued" ? since(t) : ""}
    </span>
  </button>`;
}
function viewRun(r) {
  const goal = S.tasks.get(r.id);
  if (!goal) return `<div class="view"><div class="empty">This run isn't in recent history. <a class="link" href="#/runs">See all runs</a></div></div>`;
  if (goal.kind !== "goal") { setTimeout(() => go(`#/task/${goal.id}`)); return ""; }
  const kids = childrenOf(goal.id);
  const plan = kids.find((t) => t.kind === "plan");
  const steps = stepsOf(goal.id);
  const synth = kids.find((t) => t.kind === "synthesis");
  const waves = planWaves(steps.map((s) => ({ after: (s.after ?? []).map((n) => steps.findIndex((x) => x.step === n)).filter((i) => i >= 0) })));
  const nW = steps.length ? Math.max(...waves) + 1 : 0;
  const pick = r.params.get("step");
  if (pick && S.tasks.has(pick)) S.sel[goal.id] = pick;
  const needing = steps.find((s) => stateOf(s) === "need") ?? steps.find((s) => s.status === "blocked" || s.status === "failed");
  let selId = S.sel[goal.id];
  if (!selId || !S.tasks.has(selId)) selId = (needing ?? steps.find((s) => s.status === "running") ?? synth ?? steps[steps.length - 1] ?? plan)?.id;
  currentEdges = runEdges(goal, plan, steps, synth);
  const gst = stateOf(goal);
  const live = goal.status === "running" || goal.status === "queued";
  const crew = [...new Set(steps.map((s) => s.agentId))];
  const cols = [];
  cols.push(`<div class="col"><div class="col-head">Plan</div>${plan ? node(plan, { minor: true, label: "planner" }, selId) : `<div class="node minor" data-node="plan"><span class="n-top"><span class="av sm av-fallback" aria-hidden="true">Y</span><span class="grow"><span class="n-who">${goal.planSource === "owner" ? "Your plan" : "Quick route"}</span></span>${stPill("done", goal.planSource === "owner" ? "Approved" : "Direct")}</span><span class="n-task">${goal.planSource === "owner" ? "You reviewed and launched this plan." : "One specialist, no plan needed."}</span></div>`}</div>`);
  for (let w = 0; w < nW; w++) {
    const idx = steps.map((_, i) => i).filter((i) => waves[i] === w);
    cols.push(`<div class="col"><div class="col-head">${w === 0 ? "Wave 1" : `Wave ${w + 1}`}${idx.length > 1 ? ` · ${idx.length} parallel` : ""}</div>${idx.map((i) => node(steps[i], {}, selId, steps)).join("")}</div>`);
  }
  if (synth) cols.push(`<div class="col"><div class="col-head">Wrap-up</div>${node(synth, { minor: true, label: "combines it all" }, selId)}</div>`);
  if (!steps.length && live) cols.push(`<div class="col"><div class="col-head">Wave 1</div><div class="empty small">Planning the steps…</div></div>`);
  const lessons = S.lessons.filter((l) => l.goalId === goal.id && l.status !== "dismissed");
  const waveCols = Math.max(1, nW || 1);
  const gridCols = `minmax(128px, 0.7fr) repeat(${waveCols}, minmax(176px, 1fr))${synth ? " minmax(140px, 0.75fr)" : ""}`;
  return `<div class="view">
    <div class="run-head">
      <div class="grow"><div class="eyebrow"><a class="link" href="#/runs" style="color:var(--faint)">Runs</a> / Team run</div>
        <h1 class="run-title">${esc(goal.prompt.length > 220 ? `${goal.prompt.slice(0, 219)}…` : goal.prompt)}</h1>
        <div class="run-facts">${stPill(gst, gst === "done" ? "Finished" : gst === "run" ? "Running" : undefined)} ${since(goal)}
          <span class="tag" title="${esc(goal.modeReason ?? "")}">${steps.length > 1 || goal.mode === "crew" ? "Crew" : "Solo"}</span>
          <span>${steps.length} step${steps.length === 1 ? "" : "s"} · ${nW} wave${nW === 1 ? "" : "s"}</span>
          ${goal.compareId ? `<a class="link" href="#/compare/${esc(goal.compareId)}">Compare solo vs crew →</a>` : ""}
          <span class="av-stack">${crew.map((id) => avatar(agentById(id), "sm", false)).join("")}</span>
          ${goal.costUsd ? `<span>${fmtUsd(goal.costUsd)}</span>` : ""}
          ${goal.usage ? `<span>${fmtK(goal.usage.input + goal.usage.output)} tokens</span>` : ""}</div></div>
      <div class="run-controls">
        ${live ? `<button type="button" class="btn danger" data-stop="${esc(goal.id)}">Stop run</button>` : ""}
        <button type="button" class="btn" data-rerun="${esc(goal.id)}" ${steps.length ? "" : "disabled"}>Run again…</button>
        ${goal.result ? `<button type="button" class="btn" data-copy-result="${esc(goal.id)}">Copy result</button>` : ""}
      </div>
    </div>
    ${gst === "done" ? `<div class="done-stripe" aria-hidden="true"></div>` : ""}
    ${steps.filter((s) => stateOf(s) === "need").map((s) => needCard({ type: approvalFor(s.id)?.kind === "question" ? "question" : "approval", approval: approvalFor(s.id), task: s })).join("")}
    <div class="run-grid">
      <div class="grow">
        <div class="graph-wrap" aria-label="Run graph: steps, dependencies and handoffs"><div class="graph" style="--cols:${gridCols}"><svg class="edges" aria-hidden="true"></svg>${cols.join("")}</div></div>
        <div class="scroll-hint" hidden>Scroll sideways for later waves →</div>
        ${goal.result || goal.error ? `<section class="final ${goal.status === "done" ? "done" : ""}" aria-labelledby="h-final">
          <div class="final-head"><h2 id="h-final">${goal.status === "done" ? "Final output" : "What happened"}</h2>
            ${goal.result ? `<button type="button" class="btn sm" data-copy-result="${esc(goal.id)}">Copy</button>` : ""}</div>
          ${goal.result ? `<div class="prose">${md(goal.result)}</div>` : `<p class="err">${esc(goal.error)}</p>`}
        </section>` : ""}
        ${lessons.length ? `<section class="sec" aria-labelledby="h-lessons"><div class="sec-head"><h2 id="h-lessons">Lessons from this run</h2><a href="#/playbooks">Playbooks →</a></div>
          <div class="lessons">${lessons.map(lessonCard).join("")}</div></section>` : ""}
        <section class="sec" aria-labelledby="h-time"><div class="sec-head"><h2 id="h-time">What happened, in order</h2></div>${timeline(goal, plan, steps, synth)}</section>
      </div>
      ${inspector(S.tasks.get(selId), goal, steps)}
    </div>
  </div>`;
}
function timeline(goal, plan, steps, synth) {
  const ev = [];
  const push = (at, state, html) => at && ev.push({ at, state, html });
  push(goal.createdAt, "done", `<b>You</b> launched the run${goal.planSource === "owner" ? " with your reviewed plan" : ""}.`);
  if (plan) {
    push(plan.startedAt, "run", `<b>${esc(nameOf(plan.agentId))}</b> started planning.`);
    push(plan.finishedAt, stateOf(plan), `<b>${esc(nameOf(plan.agentId))}</b> ${plan.status === "done" ? "handed out the plan" : "couldn't plan; keyword fallback used"}.`);
  }
  for (const s of steps) {
    const ups = (s.after ?? []).map((n) => steps.find((x) => x.step === n)).filter(Boolean);
    if (s.reroutedFrom) push(s.startedAt ?? s.createdAt, "block", `Step #${s.step} moved from <b>${esc(nameOf(s.reroutedFrom))}</b> to <b>${esc(nameOf(s.agentId))}</b>.`);
    push(s.startedAt, "run", ups.length ? `Handoff landed: <b>${esc(ups.map((u) => nameOf(u.agentId)).join(" + "))}</b> → <b>${esc(nameOf(s.agentId))}</b> (#${s.step}).` : `<b>${esc(nameOf(s.agentId))}</b> started #${s.step}.`);
    for (const ap of S.approvals.filter((x) => x.taskId === s.id)) {
      push(ap.createdAt, "need", `<b>${esc(nameOf(ap.agentId))}</b> asked for your call: ${esc(firstLine(ap.title, 80))}.`);
      if (ap.decidedAt) push(ap.decidedAt, ap.status === "approved" ? "done" : "block", `You ${ap.status === "approved" ? "approved" : ap.status === "expired" ? "didn't answer; it expired" : "denied"}${ap.decidedVia && ap.decidedVia !== "web" ? ` (via ${esc(ap.decidedVia)})` : ""}.`);
    }
    if (s.finishedAt) push(s.finishedAt, stateOf(s), `<b>${esc(nameOf(s.agentId))}</b> ${s.status === "done" ? `finished #${s.step}` : `${STATE_LABEL[stateOf(s)].toLowerCase()} on #${s.step}: ${esc(firstLine(s.error, 90))}`}.`);
  }
  if (synth) {
    push(synth.startedAt, "run", `<b>${esc(nameOf(synth.agentId))}</b> started the wrap-up.`);
    push(synth.finishedAt, stateOf(synth), `<b>${esc(nameOf(synth.agentId))}</b> ${synth.status === "done" ? "delivered the final output" : "couldn't wrap up"}.`);
  }
  if (goal.finishedAt) push(goal.finishedAt, stateOf(goal), `Run ${goal.status === "done" ? "finished" : goal.status === "cancelled" ? "stopped" : "ended"}.`);
  ev.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return `<ol class="timeline">${ev.map((e) => `<li><span class="t">${esc(clock(e.at))}</span><i class="pip ${e.state === "queued" ? "" : e.state}"></i><span class="e">${e.html}</span></li>`).join("")}</ol>`;
}
function redirectBox(t, goal) {
  const live = t.status === "queued" || t.status === "running";
  const inRun = t.kind === "subtask" && goal?.status === "running" && live;
  const title = inRun ? "Redirect this step" : live ? "Redirect" : "Follow up or hand to someone else";
  const help = inRun
    ? "Restarts this step on who you pick, with your note. Its inputs come along; nothing else in the run restarts."
    : "Starts new work with the original ask, your note, and this attempt as context.";
  return `<form class="redirect-box" data-redirect-form="${esc(t.id)}">
    <div class="lbl">${title}</div>
    <label class="sr" for="redir-agent-${esc(t.id)}">Specialist</label>
    <select class="input" id="redir-agent-${esc(t.id)}">${agentOptions(t.agentId)}</select>
    <label class="sr" for="redir-note-${esc(t.id)}">Your direction</label>
    <textarea class="input" id="redir-note-${esc(t.id)}" rows="2" placeholder="Your direction (optional if you change who)…"></textarea>
    <div class="row"><span class="small faint grow">${esc(help)}</span><button class="btn sm primary" type="submit">${inRun ? "Redirect step" : "Send"}</button></div>
  </form>`;
}
function inspector(t, goal, steps) {
  if (!t) return `<aside class="inspector" aria-label="Step details"><div class="empty">Select a step to see its handoffs and output.</div></aside>`;
  const a = agentById(t.agentId);
  const st = stateOf(t);
  const ups = (t.after ?? []).map((n) => steps.find((x) => x.step === n)).filter(Boolean);
  const downs = t.kind === "subtask" ? steps.filter((x) => (x.after ?? []).includes(t.step)) : [];
  const ap = approvalFor(t.id);
  const live = t.status === "queued" || t.status === "running";
  const kindLabel = t.kind === "plan" ? "Planner" : t.kind === "synthesis" ? "Wrap-up" : `Step #${t.step}`;
  return `<aside class="inspector" aria-label="Step details" style="--c:${safeColor(a?.color)}">
    <div class="insp-head">${avatar(a, "lg", false)}<div class="grow"><div class="eyebrow">${esc(kindLabel)}</div><h3>${esc(a?.name ?? t.agentId)}</h3><div class="role">${esc(roleOf(a))}</div></div>${stPill(st)}</div>
    ${t.why ? `<div class="insp-sec"><span class="lbl">Why ${esc(a?.name ?? "")}</span><div class="small">${esc(t.why)}</div></div>` : ""}
    ${ap ? needCard({ type: ap.kind === "question" ? "question" : "approval", approval: ap, task: t }) : ""}
    ${t.kind === "plan" ? `<div class="insp-sec"><span class="lbl">The plan</span>${steps.map((s) => `<div class="small">#${s.step} <b>${esc(nameOf(s.agentId))}</b>: ${esc(firstLine(ownAsk(s.prompt), 110))}</div>`).join("") || '<div class="small muted">Waiting for the planner…</div>'}</div>` : `<div class="insp-sec"><span class="lbl">The ask</span><div class="small" style="white-space:pre-wrap">${esc(t.kind === "synthesis" ? "Combine every step into one finished answer." : ownAsk(t.display ?? t.prompt).slice(0, 1200))}</div></div>`}
    ${ups.length ? `<div class="insp-sec"><span class="lbl">Handoffs in</span>${ups.map((u) => `<div class="handoff" style="--c:${safeColor(agentById(u.agentId)?.color)}">
      <div class="h-head">${avatar(agentById(u.agentId), "sm", false)}${esc(nameOf(u.agentId))}'s ${isReview(t.prompt) ? "draft, under review" : "findings"} <span class="faint">#${u.step}</span>${stPill(stateOf(u))}</div>
      <div class="h-body">${u.result ? esc(firstLine(u.result, 280)) : u.status === "done" ? "(empty)" : "Not ready yet: this step waits for it."}</div>
      ${u.result ? `<button type="button" class="link btn ghost sm" data-select="${esc(u.id)}">Open #${u.step}</button>` : ""}</div>`).join("")}</div>` : ""}
    ${downs.length ? `<div class="insp-sec"><span class="lbl">Hands off to</span><div class="row wrap">${downs.map((d) => `<button type="button" class="btn sm ghost" data-select="${esc(d.id)}">${whoChip(d.agentId)} <span class="faint">#${d.step}${isReview(d.prompt) ? " · review" : ""}</span></button>`).join("")}</div></div>` : ""}
    ${t.result ? `<div class="insp-sec"><span class="lbl">Output</span><div class="prose small">${md(t.result.length > 6000 ? `${t.result.slice(0, 6000)}\n\n…` : t.result)}</div><div class="row"><button type="button" class="btn sm" data-copy-task="${esc(t.id)}">Copy</button><a class="btn sm ghost" href="#/task/${esc(t.id)}">Open full output</a></div></div>` : ""}
    ${t.error ? `<div class="insp-sec"><span class="lbl">What went wrong</span><p class="err">${esc(t.error)}</p></div>` : ""}
    ${t.kind !== "plan" && t.kind !== "synthesis" ? redirectBox(t, goal) : ""}
    ${live && t.kind === "subtask" ? `<button type="button" class="btn sm danger" data-stop="${esc(t.id)}">Stop this step</button>` : ""}
    <div class="small faint">${esc(shortModel(t.servedModel ?? t.model ?? "", a))}${t.reasoning ? ` · ${esc(DEPTH[t.reasoning] ?? t.reasoning)}` : ""}${t.usage ? ` · ${fmtK(t.usage.input + t.usage.output)} tok` : ""}${t.costUsd ? ` · ${fmtUsd(t.costUsd)}` : ""}</div>
  </aside>`;
}

// ------------------------------------------------------------------ solo vs crew
function viewCompare(r) {
  const runs = tasksArr().filter((t) => t.kind === "goal" && t.compareId === r.id);
  const solo = runs.find((t) => t.compareSide === "solo");
  const crewRun = runs.find((t) => t.compareSide === "crew");
  if (!solo || !crewRun) return `<div class="view"><div class="empty">This comparison isn't in recent history. <a class="link" href="#/runs">See runs</a></div></div>`;
  const winner = solo.compareWinner;
  const both = solo.status === "done" && crewRun.status === "done";
  const side = (g, label, blurb) => {
    const steps = stepsOf(g.id);
    const ids = [...new Set(steps.map((s) => s.agentId))];
    const tokens = g.usage ? g.usage.input + g.usage.output : 0;
    return `<section class="final ${g.status === "done" ? "done" : ""} compare-side${winner === g.compareSide ? " won" : ""}" aria-label="${esc(label)}">
      <div class="final-head"><div><div class="eyebrow">${esc(label)}</div><div class="small muted">${esc(blurb)}</div></div>${winner === g.compareSide ? '<span class="st done">Your pick</span>' : stPill(stateOf(g), g.status === "done" ? "Finished" : undefined)}</div>
      <div class="run-facts" style="margin:0 0 12px"><span class="av-stack">${ids.map((id) => avatar(agentById(id), "sm", false)).join("")}</span>${since(g)}<span>${steps.length} step${steps.length === 1 ? "" : "s"}</span>${tokens ? `<span>${fmtK(tokens)} tokens</span>` : ""}${g.costUsd ? `<span>${fmtUsd(g.costUsd)}</span>` : ""}<a class="link" href="#/run/${esc(g.id)}">Open run →</a></div>
      ${g.result ? `<div class="prose">${md(g.result)}</div>` : g.error ? `<p class="err">${esc(g.error)}</p>` : `<div style="margin-top:6px">${runStrip(g)}</div>`}
    </section>`;
  };
  return `<div class="view">
    <div class="page-head"><div class="grow"><div class="eyebrow"><a class="link" href="#/runs" style="color:var(--faint)">Runs</a> / Solo vs crew</div>
      <h1 class="run-title">${esc(firstLine(solo.prompt, 200))}</h1>
      <p class="sub">Same goal, run two ways. Judge the outputs, not the theory: your pick sets the default for similar goals.</p></div></div>
    ${needsItems().filter((n) => [solo.id, crewRun.id].includes(goalOf(n.task)?.id)).map(needCard).join("")}
    <div class="compare-grid">${side(solo, "Solo", "One strong specialist, end to end")}${side(crewRun, "Crew", "Planned, split, handed off, wrapped up")}</div>
    <div class="verdict" role="group" aria-label="Which was better?">
      <span class="eyebrow">${both ? "Which was better?" : "Pick a winner once both finish"}</span>
      <button type="button" class="btn ${winner === "solo" ? "primary" : ""}" data-verdict="solo" data-compare-id="${esc(r.id)}" ${both ? "" : "disabled"}>Solo was better</button>
      <button type="button" class="btn ${winner === "crew" ? "primary" : ""}" data-verdict="crew" data-compare-id="${esc(r.id)}" ${both ? "" : "disabled"}>Crew was better</button>
      <button type="button" class="btn ghost ${winner === "tie" ? "primary" : ""}" data-verdict="tie" data-compare-id="${esc(r.id)}" ${both ? "" : "disabled"}>About the same</button>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ single output
function viewTask(r) {
  const t = S.tasks.get(r.id);
  if (!t) return `<div class="view"><div class="empty">That output isn't in recent history. <a class="link" href="#/runs">See runs</a></div></div>`;
  if (t.kind === "goal") { setTimeout(() => go(`#/run/${t.id}`)); return ""; }
  const a = agentById(t.agentId);
  const goal = goalOf(t);
  const steps = goal ? stepsOf(goal.id) : [];
  const ups = (t.after ?? []).map((n) => steps.find((x) => x.step === n)).filter(Boolean);
  const ap = approvalFor(t.id);
  const prev = t.continues ? S.tasks.get(t.continues) : null;
  const next = t.redirectedTo ? S.tasks.get(t.redirectedTo) : null;
  const kind = t.kind === "direct" ? `Direct ask · ${t.channel}` : t.kind === "subtask" ? `Step #${t.step}` : t.kind === "synthesis" ? "Wrap-up" : "Plan";
  return `<div class="view">
    <div class="page-head"><div class="grow"><div class="eyebrow">${goal ? `<a class="link" href="#/run/${esc(goal.id)}" style="color:var(--faint)">Run</a> / ` : `<a class="link" href="#/runs" style="color:var(--faint)">Runs</a> / `}${esc(kind)}</div>
      <h1 style="font-size:24px">${esc(firstLine(t.display ?? ownAsk(t.prompt), 160))}</h1>
      <div class="run-facts">${whoChip(t.agentId, { role: true })} ${stPill(stateOf(t))} ${t.status !== "queued" ? since(t) : ""} <span>${esc(shortModel(t.servedModel ?? t.model ?? "", a))}</span></div></div>
      <div class="run-controls">${t.result ? `<button type="button" class="btn" data-copy-task="${esc(t.id)}">Copy</button>` : ""}${t.status === "running" || t.status === "queued" ? `<button type="button" class="btn danger" data-stop="${esc(t.id)}">Stop</button>` : ""}</div></div>
    ${prev ? `<div class="note-honest"><span>↩</span><span>Continues <a class="link" href="#/task/${esc(prev.id)}">${esc(nameOf(prev.agentId))}'s earlier attempt</a>.</span></div>` : ""}
    ${next ? `<div class="note-honest"><span>↪</span><span>You redirected this. <a class="link" href="#/task/${esc(next.id)}">See ${esc(nameOf(next.agentId))}'s follow-up</a>.</span></div>` : ""}
    ${ap ? needCard({ type: ap.kind === "question" ? "question" : "approval", approval: ap, task: t }) : ""}
    <div class="two-col sec" style="margin-top:16px">
      <div>
        ${t.result ? `<section class="final done"><div class="final-head"><h2>Output</h2></div><div class="prose">${md(t.result)}</div></section>` : t.error ? `<section class="final"><h2>What went wrong</h2><p class="err">${esc(t.error)}</p></section>` : `<div class="empty">${esc(nameOf(t.agentId))} is ${t.status === "running" ? "on it" : "waiting to start"}.</div>`}
      </div>
      <div>
        <div class="card"><div class="lbl">The ask</div><div class="small" style="white-space:pre-wrap">${esc(ownAsk(t.display ?? t.prompt).slice(0, 3000))}</div></div>
        ${ups.length ? `<div class="card"><div class="lbl">Built on</div>${ups.map((u) => `<a class="handoff" style="--c:${safeColor(agentById(u.agentId)?.color)};display:block;text-decoration:none" href="#/task/${esc(u.id)}"><div class="h-head">${avatar(agentById(u.agentId), "sm", false)}${esc(nameOf(u.agentId))} · #${u.step}</div><div class="h-body">${esc(firstLine(u.result, 240))}</div></a>`).join("")}</div>` : ""}
        ${t.kind !== "plan" && t.kind !== "synthesis" ? `<div class="card">${redirectBox(t, goal)}</div>` : ""}
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ runs
function viewRuns() {
  const q = S.runsQuery.trim().toLowerCase();
  const needIds = new Set(needsItems().map((n) => n.task?.id).filter(Boolean));
  const rows = tasksArr()
    .filter((t) => t.kind === "goal" || t.kind === "direct")
    .filter((t) => {
      const kids = t.kind === "goal" ? childrenOf(t.id) : [];
      const needs = needIds.has(t.id) || kids.some((k) => needIds.has(k.id));
      if (S.runsFilter === "live" && !(t.status === "running" || t.status === "queued")) return false;
      if (S.runsFilter === "needs" && !needs) return false;
      if (S.runsFilter === "done" && t.status !== "done") return false;
      if (S.runsFilter === "failed" && !["failed", "blocked", "cancelled"].includes(t.status)) return false;
      return !q || `${t.prompt} ${t.display ?? ""} ${nameOf(t.agentId)}`.toLowerCase().includes(q);
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 150);
  const F = [["all", "All"], ["live", "Live"], ["needs", "Needs you"], ["done", "Done"], ["failed", "Stopped or failed"]];
  return `<div class="view">
    <div class="page-head"><div><div class="eyebrow">History</div><h1>Runs</h1><p class="sub">Every team goal and direct ask, newest first. Open one to see who did what and how it fit together.</p></div>
      <a class="btn sunset" href="#/new">New goal</a></div>
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Filter runs">${F.map(([k, l]) => `<button type="button" data-runs-filter="${k}" aria-pressed="${S.runsFilter === k}">${l}</button>`).join("")}</div>
      <label class="sr" for="runs-q">Search runs</label>
      <input class="input" id="runs-q" style="max-width:280px" placeholder="Search runs…" value="${esc(S.runsQuery)}" autocomplete="off" />
    </div>
    ${rows.length ? `<div class="tbl" role="table" aria-label="Runs">
      <div class="tbl-row head" role="row"><span role="columnheader">Status</span><span role="columnheader">Goal</span><span role="columnheader">Crew</span><span role="columnheader">Started</span><span role="columnheader" class="num">Time</span></div>
      ${rows.map((t) => {
        const steps = t.kind === "goal" ? stepsOf(t.id) : [];
        const crew = t.kind === "goal" ? [...new Set(steps.map((s) => s.agentId))] : [t.agentId];
        const st = needIds.has(t.id) || steps.some((s) => needIds.has(s.id)) ? "need" : stateOf(t);
        const dur = t.startedAt && t.finishedAt ? fmtDur(Date.parse(t.finishedAt) - Date.parse(t.startedAt)) : t.status === "running" ? "…" : "—";
        return `<a class="tbl-row" role="row" href="${t.kind === "goal" ? `#/run/${esc(t.id)}` : `#/task/${esc(t.id)}`}">
          <span role="cell">${stPill(st)}</span>
          <span role="cell" class="grow"><span class="ellipsis" style="display:block;font-weight:600">${esc(firstLine(t.display ?? t.prompt, 120))}</span><span class="kind">${t.kind === "goal" ? `${steps.length > 1 ? "Crew" : "Solo"} run · ${steps.length} step${steps.length === 1 ? "" : "s"}${t.compareId ? " · part of a comparison" : ""}` : `Direct ask · ${esc(t.channel)}`}</span></span>
          <span role="cell" class="av-stack">${crew.slice(0, 5).map((id) => avatar(agentById(id), "sm", false)).join("")}</span>
          <span role="cell" class="small muted">${esc(ago(t.createdAt))}</span>
          <span role="cell" class="num">${dur}</span></a>`;
      }).join("")}</div>` : `<div class="empty">Nothing here yet.</div>`}
  </div>`;
}

// ------------------------------------------------------------------ crew
function toolsList(a) {
  const tools = Array.isArray(a.tools) ? a.tools : [];
  return `<div class="tools">${tools.map((t) => `<span class="tool">${esc(t)}</span>`).join("")}${a.actsInWorld ? `<span class="tool act" title="Causeway asks before it sends, posts, spends, or changes things">Asks before acting</span>` : ""}</div>`;
}
function viewCrew() {
  return `<div class="view">
    <div class="page-head"><div><div class="eyebrow">Crew</div><h1>Your specialists</h1><p class="sub">Each one has a lane. Plans run them in parallel and pass work between them; you can hand anything to anyone.</p></div></div>
    <div class="crew-list">${S.agents.map((a) => {
      const st = agentState(a);
      const doing = activeTasksOf(a.id);
      const lim = a.limit ?? {};
      const used = a.limits?.dailyRequests ? Math.min(100, Math.round(((a.usage?.requestsToday ?? 0) / a.limits.dailyRequests) * 100)) : 0;
      return `<div class="crew-row" style="--c:${safeColor(a.color)}">
        <a href="#/crew/${esc(a.id)}" aria-label="${esc(a.name)} profile">${avatar(a, "lg", false)}</a>
        <div><div class="row"><a class="name" href="#/crew/${esc(a.id)}" style="text-decoration:none">${esc(a.name)}</a>${a.isLead ? '<span class="tag">Lead</span>' : ""}<span class="role">${esc(roleOf(a))}</span></div>
          <div class="best">${esc(a.tagline)}</div>${toolsList(a)}</div>
        <div class="doing">${stPill(st === "ready" ? "idle" : st === "demo" ? "queued" : st, AGENT_STATE_LABEL[st])}
          ${doing.length ? doing.slice(0, 2).map((t) => `<div class="ellipsis small" style="margin-top:6px"><a class="link" href="${goalOf(t) ? `#/run/${esc(goalOf(t).id)}?step=${esc(t.id)}` : `#/task/${esc(t.id)}`}">${esc(firstLine(t.title, 70))}</a></div>`).join("") : `<div class="small faint" style="margin-top:6px">${st === "demo" ? esc(a.connectorLabel) : "Free for work"}</div>`}
          ${a.limits?.dailyRequests ? `<div class="meter ${used > 80 ? "warn" : ""}" title="${a.usage?.requestsToday ?? 0} of ${a.limits.dailyRequests} asks today"><i style="width:${used}%"></i></div>` : ""}
          ${lim.ok === false ? `<div class="small" style="color:var(--amber)">${esc(lim.reason)}</div>` : ""}</div>
        <div class="acts"><a class="btn sm" href="#/crew/${esc(a.id)}#direct">Ask ${esc(a.name)}</a><a class="btn sm ghost" href="#/crew/${esc(a.id)}">Profile</a></div>
      </div>`;
    }).join("")}</div>
  </div>`;
}
function viewAgent(id) {
  const a = agentById(id);
  if (!a) return `<div class="view"><div class="empty">No specialist called “${esc(id)}”. <a class="link" href="#/crew">Crew</a></div></div>`;
  const st = agentState(a);
  const mine = tasksArr().filter((t) => t.agentId === id && t.kind !== "goal").sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
  const now = mine.filter((t) => t.status === "running" || t.status === "queued");
  const recent = mine.filter((t) => !now.includes(t)).slice(0, 8);
  const opts = Array.from(new Set([a.model, ...(a.modelOptions ?? [])]));
  const q = a.providerQuota;
  return `<div class="view">
    <div class="profile-head" style="--c:${safeColor(a.color)}">${avatar(a, "xl")}
      <div class="grow"><div class="eyebrow"><a class="link" href="#/crew" style="color:var(--faint)">Crew</a> / ${esc(roleOf(a))}</div>
        <div class="name">${esc(a.name)}</div>
        <div class="row wrap" style="margin-top:6px">${stPill(st === "ready" ? "idle" : st === "demo" ? "queued" : st, AGENT_STATE_LABEL[st])}${a.isLead ? '<span class="tag">Crew lead</span>' : ""}<span class="small muted">${esc(a.connectorLabel)}</span></div></div></div>
    <div class="profile">
      <div>
        <div class="card"><div class="lbl">Best at</div><div>${esc(a.tagline)}</div>${a.personality ? `<div class="small muted">${esc(a.personality)}</div>` : ""}
          <div class="lbl">Tools it can use</div>${toolsList(a)}
          ${a.actsInWorld ? `<div class="note-honest"><span>🛡</span><span>${esc(a.name)} can act outside Causeway, so it <b>asks for your OK before sending, posting, spending, or changing things</b>.</span></div>` : `<div class="small faint">Text only: it can't act on your accounts or computer.</div>`}</div>
        <div class="card" id="direct"><div class="lbl">Direct line</div>
          <form class="direct-line" data-direct="${esc(a.id)}"><label class="sr" for="direct-${esc(a.id)}">Message ${esc(a.name)}</label>
            <textarea class="input" id="direct-${esc(a.id)}" rows="3" placeholder="Ask ${esc(a.name)} directly. Recent chat comes along as context."></textarea>
            <div class="row"><span class="small faint grow">For multi-step work, a <a class="link" href="#/new">goal</a> gets you a plan and reviews.</span><button class="btn primary sm" type="submit">Send to ${esc(a.name)}</button></div></form></div>
        <div class="card"><div class="lbl">Now</div>${now.length ? now.map((t) => `<a class="output-item" href="${goalOf(t) ? `#/run/${esc(goalOf(t).id)}?step=${esc(t.id)}` : `#/task/${esc(t.id)}`}"><span>${stPill(stateOf(t))}</span><div class="grow ellipsis">${esc(firstLine(t.title, 90))}</div>${since(t)}</a>`).join("") : `<div class="small faint">Nothing in progress.</div>`}
          <div class="lbl">Recent work</div>${recent.length ? recent.map((t) => `<a class="output-item" href="${goalOf(t) ? `#/run/${esc(goalOf(t).id)}?step=${esc(t.id)}` : `#/task/${esc(t.id)}`}"><span>${stPill(stateOf(t))}</span><div class="grow"><div class="ellipsis">${esc(firstLine(t.display ?? ownAsk(t.prompt), 90))}</div><div class="excerpt">${esc(firstLine(t.result ?? t.error, 160))}</div></div><span class="small faint">${esc(ago(t.createdAt))}</span></a>`).join("") : `<div class="small faint">No work yet.</div>`}</div>
      </div>
      <div>
        <form class="card" data-agent-form="${esc(a.id)}"><div class="lbl">Settings</div>
          <div class="field"><label for="ag-model">Model</label><select class="input" id="ag-model">${opts.map((m) => `<option value="${esc(m)}" ${m === a.model ? "selected" : ""}>${esc(shortModel(m, a))}</option>`).join("")}</select></div>
          <div class="field"><label for="ag-depth">Thinking depth</label><select class="input" id="ag-depth" ${a.sendsReasoning ? "" : "disabled"}>${LEVELS.map((l) => `<option value="${l}" ${l === a.reasoning ? "selected" : ""}>${DEPTH[l]}</option>`).join("")}</select>${a.sendsReasoning ? "" : `<span class="small faint">This connection doesn't take a thinking setting.</span>`}</div>
          <div class="switch-row"><label for="ag-on"><b>Active</b><br><span class="small muted">Paused specialists sit out of plans.</span></label><input type="checkbox" class="toggle" id="ag-on" ${a.enabled ? "checked" : ""} /></div>
          <div class="grid3"><div class="field"><label for="ag-req">Asks / day</label><input class="input mono" id="ag-req" type="number" min="0" value="${a.limits.dailyRequests}" /></div>
            <div class="field"><label for="ag-tok">Tokens / day</label><input class="input mono" id="ag-tok" type="number" min="0" step="1000" value="${a.limits.dailyTokens}" /></div>
            <div class="field"><label for="ag-bud">$ / month</label><input class="input mono" id="ag-bud" type="number" min="0" value="${a.limits.monthlyBudgetUsd}" /></div></div>
          <div class="small faint">0 means no limit.</div>
          <details id="ag-adv"><summary class="small muted" style="cursor:pointer">Voice and instructions</summary>
            <div class="field" style="margin-top:8px"><label for="ag-system">Instructions</label><textarea class="input" id="ag-system" rows="6">${esc(a.system)}</textarea></div>
            <div class="field"><label for="ag-tag">Best at (one line)</label><input class="input" id="ag-tag" value="${esc(a.tagline)}" maxlength="120" /></div></details>
          <div class="row"><button type="button" class="btn sm ghost" data-make-lead="${esc(a.id)}" ${a.isLead ? "disabled" : ""}>${a.isLead ? "Crew lead" : "Make crew lead"}</button><span class="grow"></span><button class="btn sm primary" type="submit">Save</button></div>
        </form>
        <div class="card"><div class="lbl">Connection</div><dl class="kv">
          <dt>Runs on</dt><dd>${esc(a.connectorLabel)}${a.live ? "" : " (demo)"}</dd>
          <dt>Billing</dt><dd>${esc({ subscription: "A plan you already pay for", local: "Runs on your Mac", metered: "Pay per use (blocked unless allowed)", prepaid: "Prepaid credit, capped monthly" }[a.billing] ?? (a.live ? "—" : "Not connected yet (demo answers)"))}</dd>
          ${a.healthDetail ? `<dt>Health</dt><dd>${esc(a.healthDetail)}</dd>` : ""}
          ${q ? `<dt>Plan usage</dt><dd>${q.live ? esc([q.plan, ...(q.windows ?? []).map((w) => `${w.label} ${Math.round(w.usedPercent)}%`), q.creditsRemainingUsd != null ? `${fmtUsd(q.creditsRemainingUsd)} left` : ""].filter(Boolean).join(" · ")) : esc(q.note ?? "")}</dd>` : ""}
          <dt>Today</dt><dd>${a.usage?.requestsToday ?? 0} asks · ${fmtK(a.usage?.tokensToday ?? 0)} tokens${a.usage?.costMonth ? ` · ${fmtUsd(a.usage.costMonth)} this month` : ""}</dd>
        </dl><div class="small faint">Tools are set in relay.config.json; editing them here isn't supported yet.</div></div>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ playbooks & lessons
function lessonCard(l) {
  const from = S.tasks.get(l.goalId);
  return `<div class="lesson ${l.status}" data-lesson="${esc(l.id)}">
    <div class="l-head"><span class="tag ${l.kind === "playbook" ? "review" : ""}">${l.kind === "playbook" ? "Playbook" : "Planning note"}</span><b>${esc(l.title)}</b>
      ${from ? `<a class="link small" href="#/run/${esc(from.id)}">from “${esc(firstLine(from.prompt, 50))}”</a>` : ""}<span class="grow"></span>${l.status === "approved" ? '<span class="st done">Approved</span>' : l.status === "dismissed" ? '<span class="st">Dismissed</span>' : '<span class="st need">Needs review</span>'}</div>
    ${l.kind === "playbook" && l.steps?.length ? `<div class="l-steps">${l.steps.map((s, i) => `${i ? "<span aria-hidden=\"true\">→</span>" : ""}${whoChip(s.agentId)}<span class="faint">${esc(firstLine(s.task, 40))}</span>`).join(" ")}</div><div class="small muted">${esc(l.text)}</div>`
      : `<label class="sr" for="lesson-text-${esc(l.id)}">Note text</label><textarea class="input" id="lesson-text-${esc(l.id)}" rows="2">${esc(l.text)}</textarea>`}
    <div class="l-actions">
      ${l.status !== "approved" ? `<button type="button" class="btn sm primary" data-lesson-set="approved">Approve</button>` : ""}
      ${l.kind === "note" ? `<button type="button" class="btn sm" data-lesson-save>Save edit</button>` : ""}
      ${l.kind === "playbook" && l.status === "approved" ? `<a class="btn sm" href="#/new?playbook=${esc(l.id)}">Use for a new goal</a>` : ""}
      ${l.status === "approved" ? `<button type="button" class="btn sm ghost" data-lesson-set="proposed">Un-approve</button>` : ""}
      ${l.status !== "dismissed" ? `<button type="button" class="btn sm ghost" data-lesson-set="dismissed">Dismiss</button>` : `<button type="button" class="btn sm ghost" data-lesson-set="proposed">Restore</button>`}
    </div></div>`;
}
function viewPlaybooks() {
  const by = (s) => S.lessons.filter((l) => l.status === s).slice().reverse();
  const proposed = by("proposed");
  const approved = by("approved");
  const dismissed = by("dismissed");
  return `<div class="view">
    <div class="page-head"><div><div class="eyebrow">Learning loop</div><h1>Playbooks and lessons</h1>
      <p class="sub">After each run, Causeway proposes what it noticed: a plan worth reusing, a backup that worked, an approval that timed out. You decide what sticks.</p></div></div>
    <div class="note-honest"><span>ⓘ</span><span>Approved notes are added to the planner's brief for future plans, and approved playbooks can start a new goal. <b>No agent is retrained</b>: this is your team's playbook, not model training.</span></div>
    <section class="sec"><div class="sec-head"><h2>Waiting for your review</h2></div>${proposed.length ? `<div class="lessons">${proposed.map(lessonCard).join("")}</div>` : `<div class="empty">Nothing new. Finished runs add proposals here.</div>`}</section>
    <section class="sec"><div class="sec-head"><h2>Approved</h2></div>${approved.length ? `<div class="lessons">${approved.map(lessonCard).join("")}</div>` : `<div class="empty">Approve a proposal to start your playbook.</div>`}</section>
    ${dismissed.length ? `<details class="sec" id="dismissed-lessons"><summary class="small muted" style="cursor:pointer">Dismissed (${dismissed.length})</summary><div class="lessons" style="margin-top:10px">${dismissed.map(lessonCard).join("")}</div></details>` : ""}
  </div>`;
}

// ------------------------------------------------------------------ settings
function viewSettings() {
  const lead = agentById(S.lead);
  return `<div class="view">
    <div class="page-head"><div><div class="eyebrow">Settings</div><h1>How the crew runs</h1></div></div>
    <div class="two-col">
      <div>
        <div class="card"><h2>Crew lead</h2><p class="small muted" style="margin:0">The lead owns team goals. When the lead can act on your Mac (Hermes), planning and wrap-up move to a free text-only teammate, so untrusted content never reaches local tools.</p>
          <div class="field"><label for="set-lead">Lead</label><select class="input" id="set-lead">${agentOptions(S.lead)}</select></div>
          <div class="small faint">Current: ${esc(lead?.name ?? S.lead)}.</div></div>
        <div class="card"><h2>Connections</h2>
          ${S.agents.map((a) => `<div class="switch-row"><span class="who">${avatar(a, "sm", false)}<span><b>${esc(a.name)}</b> <span class="small muted">${esc(a.connectorLabel)}</span>${a.healthDetail ? `<br><span class="small faint">${esc(a.healthDetail)}</span>` : ""}</span></span>${stPill(a.live ? (a.online === false ? "fail" : "done") : "queued", a.live ? (a.online === false ? "Offline" : "Connected") : "Demo")}</div>`).join("")}
          ${S.channels.map((c) => `<div class="switch-row"><span><b>${esc(c.name[0].toUpperCase() + c.name.slice(1))}</b> <span class="small muted">${esc(c.detail)}</span></span>${stPill(c.connected ? "done" : c.enabled ? "fail" : "queued", c.connected ? "Connected" : c.enabled ? "Not connected" : "Off")}</div>`).join("")}
          <div class="small faint">Keys and channels are set up from the Terminal (npm run setup:mac and friends), never in this page.</div></div>
      </div>
      <div>
        <div class="card"><h2>Feel</h2>
          <div class="switch-row"><label for="set-sound"><b>Sound cues</b><br><span class="small muted">A short chord when a run finishes, two taps when something needs your call.</span></label><input type="checkbox" class="toggle" id="set-sound" ${S.sound ? "checked" : ""} /></div>
          <div class="row"><button type="button" class="btn sm ghost" data-test-sound="done">Hear “finished”</button><button type="button" class="btn sm ghost" data-test-sound="ask">Hear “needs you”</button></div>
          <div class="switch-row"><label for="set-motion"><b>Reduce motion</b><br><span class="small muted">Your system setting is always respected; this turns motion off here too.</span></label><input type="checkbox" class="toggle" id="set-motion" ${S.reduceMotion ? "checked" : ""} /></div>
          <div class="switch-row"><span><b>Desktop alerts</b><br><span class="small muted">A notification when an approval arrives while this tab is in the background.</span></span><button type="button" class="btn sm" data-notify ${typeof Notification === "undefined" ? "disabled" : ""}>${typeof Notification !== "undefined" && Notification.permission === "granted" ? "On" : "Turn on"}</button></div></div>
        <div class="card"><h2>Keyboard</h2><dl class="kv small">
          <dt><kbd>N</kbd></dt><dd>New goal</dd><dt><kbd>⌘K</kbd></dt><dd>Command palette</dd><dt><kbd>!</kbd></dt><dd>What needs you</dd>
          <dt><kbd>G</kbd> then <kbd>O R C P S</kbd></dt><dd>Overview, Runs, Crew, Playbooks, Settings</dd><dt><kbd>⌘↵</kbd></dt><dd>Plan it / Launch crew</dd><dt><kbd>Esc</kbd></dt><dd>Close panels</dd></dl></div>
        <div class="card"><h2>This device</h2>
          <div class="row wrap"><button type="button" class="btn sm" data-replay-intro>Show the intro again</button>${S.token ? `<button type="button" class="btn sm danger" data-forget-token>Forget access token</button>` : ""}</div></div>
        <div class="card"><h2>Not supported yet</h2><ul class="small muted" style="margin:0;padding-left:18px">
          <li>Scheduling goals to run later or on repeat.</li><li>Editing a specialist's tools from here (they're set in relay.config.json).</li>
          <li>Changing a step's direction mid-answer without restarting that step: redirect restarts it with your note.</li></ul></div>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------------------ overlays: needs panel, palette, onboarding, lock
let panelTrigger = null;
function renderNeedsPanel() {
  const items = needsItems();
  $("#needsBody").innerHTML = items.length ? items.map(needCard).join("") : `<div class="all-clear"><i class="pip"></i>All clear.</div>`;
}
function openNeeds() {
  panelTrigger = document.activeElement;
  renderNeedsPanel();
  $("#scrim").hidden = false;
  const p = $("#needsPanel");
  p.hidden = false;
  p.classList.remove("open-anim");
  void p.offsetWidth;
  p.classList.add("open-anim");
  ($("button, input", $("#needsBody")) ?? $("[data-close-panel]", p)).focus();
}
function closeNeeds() {
  $("#needsPanel").hidden = true;
  $("#scrim").hidden = true;
  if (panelTrigger instanceof HTMLElement && panelTrigger.isConnected) panelTrigger.focus();
}

const palette = { items: [], idx: 0, trigger: null };
function paletteCatalog() {
  const items = [
    { label: "New goal", hint: "N", run: () => go("#/new") },
    { label: "Overview", group: "Go", run: () => go("#/") },
    { label: "Runs", group: "Go", run: () => go("#/runs") },
    { label: "Crew", group: "Go", run: () => go("#/crew") },
    { label: "Playbooks and lessons", group: "Go", run: () => go("#/playbooks") },
    { label: "Settings", group: "Go", run: () => go("#/settings") },
  ];
  if (needsItems().length) items.unshift({ label: `What needs you (${needsItems().length})`, hint: "!", run: () => openNeeds() });
  for (const a of S.agents) items.push({ label: `Ask ${a.name}`, group: roleOf(a), run: () => { go(`#/crew/${a.id}`); setTimeout(() => $(`#direct-${a.id}`)?.focus(), 60); } });
  for (const g of tasksArr().filter((t) => t.kind === "goal").slice(-8).reverse()) items.push({ label: firstLine(g.prompt, 70), group: `Run · ${STATE_LABEL[stateOf(g)]}`, run: () => go(`#/run/${g.id}`) });
  items.push({ label: S.sound ? "Turn sound cues off" : "Turn sound cues on", group: "Feel", run: () => setSound(!S.sound) });
  return items;
}
function renderPalette() {
  const q = $("#paletteInput").value.trim().toLowerCase();
  palette.items = paletteCatalog().filter((i) => !q || `${i.label} ${i.group ?? ""}`.toLowerCase().includes(q)).slice(0, 14);
  palette.idx = Math.min(palette.idx, Math.max(0, palette.items.length - 1));
  $("#paletteList").innerHTML = palette.items.length
    ? palette.items.map((i, n) => `<li role="option" id="pal-${n}" aria-selected="${n === palette.idx}" data-pal="${n}"><span>${esc(i.label)}</span>${i.hint ? `<kbd>${esc(i.hint)}</kbd>` : ""}<span class="grp">${esc(i.group ?? "")}</span></li>`).join("")
    : `<li aria-disabled="true" class="faint">No matches</li>`;
  $("#paletteInput").setAttribute("aria-activedescendant", palette.items.length ? `pal-${palette.idx}` : "");
}
function openPalette() {
  palette.trigger = document.activeElement;
  palette.idx = 0;
  $("#palette").hidden = false;
  $("#paletteInput").value = "";
  renderPalette();
  $("#paletteInput").focus();
}
function closePalette() {
  $("#palette").hidden = true;
  if (palette.trigger instanceof HTMLElement && palette.trigger.isConnected) palette.trigger.focus();
}
function runPalette(n) {
  const item = palette.items[n];
  if (!item) return;
  closePalette();
  item.run();
}

const INTRO = [
  () => `<div class="eyebrow">Welcome to Causeway</div><h2 id="onboardTitle" style="font-size:24px">Meet your crew.</h2>
    <p class="muted" style="margin:0">Specialists, each with a lane. Causeway plans who does what and hands work between them.</p>
    <div class="roster">${S.agents.filter((a) => a.enabled).map((a) => { const st = agentState(a); return `<div class="roster-row" style="grid-template-columns:minmax(0,1fr) auto"><span class="who">${avatar(a, "", false)}<span><b>${esc(a.name)}</b> <span class="role">${esc(roleOf(a))}</span><br><span class="small muted">${esc(a.tagline)}</span></span></span>${stPill(st === "demo" ? "queued" : st === "ready" ? "done" : st, st === "demo" ? "Demo" : st === "ready" ? "Live" : AGENT_STATE_LABEL[st])}</div>`; }).join("")}</div>`,
  () => `<div class="eyebrow">How it works</div><h2 id="onboardTitle" style="font-size:24px">Start with a goal, not a chatbot.</h2>
    <ol class="muted" style="margin:0;padding-left:20px;display:grid;gap:8px">
      <li><b style="color:var(--text)">Describe the outcome.</b> Causeway recommends a plan: who takes each step, why, and what runs in parallel.</li>
      <li><b style="color:var(--text)">Edit, then launch.</b> Swap specialists, rewrite steps, change what builds on what.</li>
      <li><b style="color:var(--text)">Watch it come together.</b> The run view shows parallel work, handoffs, reviews, and blockers live, then the final output.</li>
      <li><b style="color:var(--text)">Keep what worked.</b> Approve lessons and playbooks for the next plan. Nobody gets retrained.</li></ol>`,
  () => `<div class="eyebrow">You're in control</div><h2 id="onboardTitle" style="font-size:24px">Nothing irreversible without you.</h2>
    <ul class="muted" style="margin:0;padding-left:20px;display:grid;gap:8px">
      <li>Specialists that can act (Hermes on your Mac, Grok on X) <b style="color:var(--text)">ask before sending, posting, spending, or changing things</b>. No answer in 15 minutes means no.</li>
      <li><span style="color:var(--pink);font-weight:600">Pink</span> means something needs your call. It shows on every screen.</li>
      <li>Stop a run or a step anytime, or redirect a step to someone else with a note.</li>
      <li>Shortcuts: <kbd>N</kbd> new goal, <kbd>⌘K</kbd> palette, <kbd>!</kbd> needs you.</li></ul>`,
];
let introStep = 0;
function showIntro(step = 0) {
  introStep = step;
  const box = $("#onboardBox");
  box.innerHTML = `<div class="onboard-hero" aria-hidden="true"></div><div class="onboard-inner">
      <div class="onboard-dots" aria-hidden="true">${INTRO.map((_, i) => `<i class="${i === step ? "on" : ""}"></i>`).join("")}</div>${INTRO[step]()}</div>
    <div class="onboard-foot"><button type="button" class="btn ghost" data-intro-skip>${step === INTRO.length - 1 ? "Close" : "Skip"}</button>
      <div class="row">${step ? `<button type="button" class="btn" data-intro-go="${step - 1}">Back</button>` : ""}${step < INTRO.length - 1 ? `<button type="button" class="btn primary" data-intro-go="${step + 1}">Next</button>` : `<button type="button" class="btn sunset" data-intro-done>Plan my first goal</button>`}</div></div>`;
  $("#onboard").hidden = false;
  $("button.primary, button.sunset", box)?.focus();
}
function closeIntro(goNew = false) {
  $("#onboard").hidden = true;
  store.set("cw-onboarded", "1");
  if (goNew) go("#/new");
}

function showLock(msg = "") {
  source?.close();
  source = null;
  $("#lock").hidden = false;
  const err = $("#lockErr");
  err.textContent = msg;
  err.hidden = !msg;
  setTimeout(() => $("#lockInput").focus(), 30);
}

// ------------------------------------------------------------------ actions
function setSound(on) {
  S.sound = on;
  store.set("cw-sound", on ? "on" : null);
  if (on) sound.play("done");
  toast(on ? "Sound cues on" : "Sound cues off");
  render(true);
}
async function decide(id, approve) {
  try {
    await api(`/api/approvals/${id}`, { method: "POST", body: { approve } });
    toast(approve ? "Approved. It's running." : "Denied. It won't run.");
  } catch (err) {
    if (err.message !== "locked") toast(err.message);
  }
}
async function answer(id, text) {
  try {
    await api(`/api/approvals/${id}`, { method: "POST", body: { answer: text } });
    toast("Answer sent");
  } catch (err) {
    if (err.message !== "locked") toast(err.message);
  }
}
async function stopTask(id) {
  const t = S.tasks.get(id);
  if (t?.kind === "goal" && !confirm("Stop this run? Steps that are running stop, and the rest won't start.")) return;
  try {
    await api(`/api/tasks/${id}/cancel`, { method: "POST", body: {} });
    toast(t?.kind === "goal" ? "Stopping the run" : "Stopping");
  } catch (err) {
    if (err.message !== "locked") toast(err.message);
  }
}
async function redirect(taskId, form) {
  const agentId = $(`#redir-agent-${CSS.escape(taskId)}`, form).value;
  const noteEl = $(`#redir-note-${CSS.escape(taskId)}`, form);
  try {
    const res = await api(`/api/tasks/${taskId}/redirect`, { method: "POST", body: { agentId, note: noteEl.value } });
    noteEl.value = "";
    if (res.mode === "step") {
      toast(`Step redirected to ${nameOf(agentId)}`);
      render(true);
    } else {
      toast(`Sent to ${nameOf(agentId)}`);
      go(`#/task/${res.taskId}`);
    }
  } catch (err) {
    if (err.message !== "locked") toast(err.message);
  }
}
async function sendDirect(agentId, textarea) {
  const text = textarea.value.trim();
  if (!text) return;
  try {
    const res = await api("/api/command", { method: "POST", body: { text: `@${agentId} ${text}` } });
    textarea.value = "";
    toast(firstLine(res.reply, 90) || `Sent to ${nameOf(agentId)}`);
    if (res.taskId) go(`#/task/${res.taskId}`);
  } catch (err) {
    if (err.message !== "locked") toast(err.message);
  }
}
async function saveAgent(id, form) {
  const a = agentById(id);
  if (!a) return;
  const n = (sel) => Math.max(0, Number($(sel, form).value || 0));
  const model = $("#ag-model", form).value;
  const patch = {
    model,
    enabled: $("#ag-on", form).checked,
    limits: { dailyRequests: n("#ag-req"), dailyTokens: n("#ag-tok"), monthlyBudgetUsd: n("#ag-bud") },
  };
  if (a.sendsReasoning) patch.reasoning = $("#ag-depth", form).value;
  if (a.supportsProvider && a.discoveredProvider && model !== a.model) patch.provider = model === "hermes-agent" ? "" : a.discoveredProvider;
  const sys = $("#ag-system", form)?.value.trim();
  if (sys && sys !== a.system) patch.system = sys;
  const tag = $("#ag-tag", form)?.value.trim();
  if (tag && tag !== a.tagline) patch.tagline = tag;
  try {
    const next = await api(`/api/agents/${id}`, { method: "PATCH", body: patch });
    const i = S.agents.findIndex((x) => x.id === id);
    if (i >= 0) S.agents[i] = next;
    toast(`${a.name} saved`);
    render(true);
  } catch (err) {
    if (err.message !== "locked") toast(err.message);
  }
}
async function setLead(id) {
  try {
    await api("/api/lead", { method: "POST", body: { agentId: id } });
    S.lead = id;
    S.agents = S.agents.map((a) => ({ ...a, isLead: a.id === id }));
    toast(`${nameOf(id)} leads team goals now`);
    render(true);
  } catch (err) {
    if (err.message !== "locked") toast(err.message);
  }
}
async function setLesson(id, patch) {
  try {
    const l = await api(`/api/lessons/${id}`, { method: "PATCH", body: patch });
    const i = S.lessons.findIndex((x) => x.id === id);
    if (i >= 0) S.lessons[i] = l;
    toast(patch.status === "approved" ? "Approved. The planner will use it." : patch.status === "dismissed" ? "Dismissed" : "Saved");
    render(true);
  } catch (err) {
    if (err.message !== "locked") toast(err.message);
  }
}
async function startCompare(goal) {
  const text = goal.trim();
  if (!text) { toast("Describe the goal first"); return; }
  S.draft = { goal: text, loading: true, compare: true };
  render(true);
  try {
    const res = await api("/api/compare", { method: "POST", body: { goal: text } });
    S.draft = null;
    announce("Comparison started: one specialist and the full crew, side by side.");
    go(`#/compare/${res.compareId}`);
  } catch (err) {
    if (err.message === "locked") return;
    S.draft = { goal: text, error: err.message };
    render(true);
  }
}
async function sendVerdict(compareId, winner) {
  try {
    await api(`/api/compare/${compareId}/verdict`, { method: "POST", body: { winner } });
    toast(winner === "tie" ? "Noted: about the same." : `Saved. Similar goals will start as ${winner === "solo" ? "solo" : "a crew"}.`);
  } catch (err) {
    if (err.message !== "locked") toast(err.message);
  }
}

function rerunFrom(goalId) {
  const goal = S.tasks.get(goalId);
  const steps = stepsOf(goalId);
  if (!goal || !steps.length) return;
  S.draft = {
    goal: goal.prompt,
    source: "rerun",
    notes: [],
    steps: steps.map((s) => ({ agentId: s.agentId, origAgent: s.agentId, task: ownAsk(s.prompt).replace(/\n\nOwner's direction:[\s\S]*$/, ""), after: (s.after ?? []).map((n) => steps.findIndex((x) => x.step === n)).filter((i) => i >= 0), why: s.why ?? "" })),
  };
  go("#/new");
  render(true);
}

// ------------------------------------------------------------------ events
document.addEventListener("click", (e) => {
  const el = e.target.closest("button, a, li[data-pal]");
  if (!el) return;
  const d = el.dataset;
  if (d.decide) return void decide(d.decide, d.approve === "true");
  if (d.dismiss) { S.dismissed.add(d.dismiss); store.set("cw-dismissed", JSON.stringify([...S.dismissed].slice(-200))); render(true); return; }
  if (d.select) {
    const r = route();
    if (r.name === "run") { S.sel[r.id] = d.select; render(true); if (matchMedia("(max-width: 1180px)").matches) $(".inspector", main)?.scrollIntoView({ behavior: S.reduceMotion ? "auto" : "smooth", block: "start" }); }
    return;
  }
  if (d.stop) return void stopTask(d.stop);
  if (d.rerun) return rerunFrom(d.rerun);
  if (d.copyResult) return void copyText(S.tasks.get(d.copyResult)?.result ?? "", "Final output copied");
  if (d.copyTask) return void copyText(S.tasks.get(d.copyTask)?.result ?? "", "Output copied");
  if (el.hasAttribute("data-copy-code")) return void copyText(el.parentElement.querySelector("code")?.textContent ?? "", "Code copied");
  if (d.example) { const ta = $("#goal-input"); if (ta) { ta.value = d.example; ta.focus(); autosize(ta); } return; }
  if (d.usePlaybook) { const ta = $("#goal-input"); const goal = ta?.value.trim(); if (!goal) { go(`#/new?playbook=${d.usePlaybook}`); return; } return void startDraft(goal, { playbookId: d.usePlaybook }); }
  if (el.hasAttribute("data-open-needs")) return openNeeds();
  if (el.hasAttribute("data-close-panel")) return closeNeeds();
  // plan editor
  if (el.hasAttribute("data-launch")) return void launchDraft();
  if (d.mode && S.draft?.steps) { readDraftInputs(); return void startDraft(S.draft.goal, { mode: d.mode }); }
  if (el.hasAttribute("data-compare")) { readDraftInputs(); return void startCompare(S.draft?.goal ?? ""); }
  if (d.verdict) return void sendVerdict(d.compareId, d.verdict);
  if (el.hasAttribute("data-replan")) { readDraftInputs(); return void startDraft(S.draft?.goal ?? "", { playbookId: S.draft?.playbookId ?? "" }); }
  if (el.hasAttribute("data-draft-cancel")) { S.draft = null; return go("#/"); }
  if (el.hasAttribute("data-draft-edit")) { S.draft = { goal: S.draft?.goal ?? "" }; return render(true); }
  if (el.hasAttribute("data-add-step")) {
    return editDraft((dr) => { dr.steps.push({ agentId: S.agents.find((a) => a.enabled)?.id ?? "", origAgent: "", task: "", after: [], why: "" }); setTimeout(() => $(`#step-task-${dr.steps.length - 1}`)?.focus(), 30); });
  }
  if (d.stepRemove != null) {
    const k = Number(d.stepRemove);
    return editDraft((dr) => {
      dr.steps.splice(k, 1);
      for (const s of dr.steps) s.after = s.after.filter((x) => x !== k).map((x) => (x > k ? x - 1 : x));
      if (!dr.steps.length) toast("Add at least one step");
    });
  }
  if (d.stepMove != null) {
    const i = Number(d.stepMove);
    if (i < 1) return;
    return editDraft((dr) => {
      const map = (x) => (x === i ? i - 1 : x === i - 1 ? i : x);
      [dr.steps[i - 1], dr.steps[i]] = [dr.steps[i], dr.steps[i - 1]];
      let dropped = false;
      dr.steps.forEach((s, j) => {
        const next = s.after.map(map);
        s.after = next.filter((x) => x < j);
        if (s.after.length !== next.length) dropped = true;
      });
      if (dropped) toast("A step can only build on earlier steps, so one link was removed");
    });
  }
  // lessons
  if (d.lessonSet) { const id = el.closest("[data-lesson]").dataset.lesson; const ta = $(`#lesson-text-${CSS.escape(id)}`); return void setLesson(id, { status: d.lessonSet, ...(ta ? { text: ta.value } : {}) }); }
  if (el.hasAttribute("data-lesson-save")) { const id = el.closest("[data-lesson]").dataset.lesson; return void setLesson(id, { text: $(`#lesson-text-${CSS.escape(id)}`).value }); }
  // agents & settings
  if (d.makeLead) return void setLead(d.makeLead);
  if (d.testSound) { const was = S.sound; S.sound = true; sound.play(d.testSound); S.sound = was; return; }
  if (el.hasAttribute("data-notify")) { if (typeof Notification !== "undefined") Notification.requestPermission().then(() => render(true)); return; }
  if (el.hasAttribute("data-replay-intro")) return showIntro(0);
  if (el.hasAttribute("data-forget-token")) { S.token = ""; store.set("relay-token", null); return showLock("Token forgotten on this device."); }
  // palette & intro
  if (d.pal != null) return runPalette(Number(d.pal));
  if (d.introGo != null) return showIntro(Number(d.introGo));
  if (el.hasAttribute("data-intro-skip")) return closeIntro(false);
  if (el.hasAttribute("data-intro-done")) return closeIntro(true);
  if (d.runsFilter) { S.runsFilter = d.runsFilter; return render(true); }
});

document.addEventListener("submit", (e) => {
  const f = e.target;
  if (f.id === "goalForm") {
    e.preventDefault();
    const pb = $("#playbook-pick")?.value ?? "";
    return void startDraft($("#goal-input").value, { playbookId: pb });
  }
  if (f.dataset.answerForm) { e.preventDefault(); const inp = $("input", f); if (inp.value.trim()) void answer(f.dataset.answerForm, inp.value.trim()); return; }
  if (f.dataset.redirectForm) { e.preventDefault(); return void redirect(f.dataset.redirectForm, f); }
  if (f.dataset.direct) { e.preventDefault(); return void sendDirect(f.dataset.direct, $("textarea", f)); }
  if (f.dataset.agentForm) { e.preventDefault(); return void saveAgent(f.dataset.agentForm, f); }
  if (f.id === "lockForm") {
    e.preventDefault();
    S.token = $("#lockInput").value.trim();
    store.set("relay-token", S.token);
    void api("/api/state", { unlockAttempt: true }).then((snap) => { $("#lock").hidden = true; applySnapshot(snap); connect(); }).catch(() => {});
  }
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.dataset.stepAgent != null) { const i = Number(el.dataset.stepAgent); return editDraft((dr) => { dr.steps[i].agentId = el.value; }); }
  if (el.dataset.stepDep != null) {
    const i = Number(el.dataset.stepDep);
    const j = Number(el.dataset.dep);
    return editDraft((dr) => { const s = dr.steps[i]; s.after = el.checked ? [...new Set([...s.after, j])].sort((a, b) => a - b) : s.after.filter((x) => x !== j); });
  }
  if (el.id === "playbook-pick" && el.value && $("#goal-input")?.value.trim()) return void startDraft($("#goal-input").value, { playbookId: el.value });
  if (el.id === "set-lead") return void setLead(el.value);
  if (el.id === "set-sound") return setSound(el.checked);
  if (el.id === "set-motion") { S.reduceMotion = el.checked; store.set("cw-reduce-motion", el.checked ? "on" : null); return render(true); }
});

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.matches("textarea")) autosize(el);
  if (el.id === "runs-q") { S.runsQuery = el.value; clearTimeout(document.rq); document.rq = setTimeout(() => render(true), 160); }
  if (el.dataset.stepTask != null && S.draft?.steps) S.draft.steps[Number(el.dataset.stepTask)].task = el.value;
  if (el.id === "paletteInput") { palette.idx = 0; renderPalette(); }
});

function autosize(el) {
  if (!el || el.tagName !== "TEXTAREA" || !el.closest(".composer, .step-card")) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.closest(".step-card") ? 340 : 260, el.scrollHeight + 2)}px`;
}
function autosizeAll() { for (const t of $$(".composer textarea, .step-card textarea", main)) autosize(t); }

$("#needsBtn").addEventListener("click", openNeeds);
$("#needsBtnTop").addEventListener("click", openNeeds);
$("#scrim").addEventListener("click", closeNeeds);
$("#soundBtn").addEventListener("click", () => setSound(!S.sound));
$("#paletteBtn").addEventListener("click", openPalette);
$("#palette").addEventListener("click", (e) => { if (e.target.id === "palette") closePalette(); });

let gPending = 0;
document.addEventListener("keydown", (e) => {
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); return $("#palette").hidden ? openPalette() : closePalette(); }
  if (!$("#palette").hidden) {
    if (e.key === "Escape") { e.preventDefault(); return closePalette(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); palette.idx = (palette.idx + (e.key === "ArrowDown" ? 1 : -1) + palette.items.length) % Math.max(1, palette.items.length); return renderPalette(); }
    if (e.key === "Enter") { e.preventDefault(); return runPalette(palette.idx); }
    return;
  }
  if (e.key === "Escape") {
    if (!$("#needsPanel").hidden) return closeNeeds();
    if (!$("#onboard").hidden) return closeIntro(false);
  }
  if (mod && e.key === "Enter") {
    const r = route();
    if (r.name === "new" && S.draft?.steps) { e.preventDefault(); return void launchDraft(); }
    if ($("#goalForm") && (e.target.id === "goal-input" || r.name === "new")) { e.preventDefault(); return $("#goalForm").requestSubmit(); }
    const form = e.target.closest?.("form");
    if (form) { e.preventDefault(); return form.requestSubmit(); }
  }
  if (typing || mod || e.altKey) return;
  if (!$("#onboard").hidden || !$("#lock").hidden) return;
  const k = e.key.toLowerCase();
  if (gPending && Date.now() - gPending < 1200) {
    gPending = 0;
    const to = { o: "#/", r: "#/runs", c: "#/crew", p: "#/playbooks", s: "#/settings" }[k];
    if (to) { e.preventDefault(); return go(to); }
  }
  if (k === "g") { gPending = Date.now(); return; }
  if (k === "n") { e.preventDefault(); return go("#/new"); }
  if (e.key === "!") { e.preventDefault(); return openNeeds(); }
  if (e.key === "/") { const g = $("#goal-input"); if (g) { e.preventDefault(); g.focus(); } }
});
$("#needsPanel").addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const f = $$("button, input, a[href], select, textarea", $("#needsPanel")).filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
});

window.addEventListener("hashchange", () => {
  const r = route();
  if (r.name === "new" && r.params.get("playbook") && S.draft?.steps) S.draft = null;
  render(true);
  // Move focus to the new page for screen readers, but never steal it from an open overlay or a field.
  const overlay = !$("#palette").hidden || !$("#needsPanel").hidden || !$("#onboard").hidden || !$("#lock").hidden;
  const a = document.activeElement;
  if (!overlay && (!a || a === document.body || main.contains(a) || a.closest("nav"))) main.focus({ preventScroll: true });
});
window.addEventListener("resize", () => { if (route().name === "run") drawEdges(); });

// Elapsed time is real: running items tick once a second, nothing else moves on its own.
setInterval(() => {
  for (const el of $$("[data-since]", main)) {
    if (el.dataset.until) continue;
    el.textContent = fmtDur(Date.now() - Date.parse(el.dataset.since));
  }
}, 1000);

// ------------------------------------------------------------------ live data
function applySnapshot(snap) {
  S.connected = true;
  S.agents = snap.agents ?? [];
  S.lead = snap.lead;
  S.kpis = snap.kpis ?? {};
  S.channels = snap.channels ?? [];
  S.approvals = snap.approvals ?? [];
  S.lessons = snap.lessons ?? [];
  S.tasks = new Map((snap.tasks ?? []).map((t) => [t.id, t]));
  const first = !S.booted;
  S.booted = true;
  render(true);
  if (first && !store.get("cw-onboarded") && $("#lock").hidden) showIntro(0);
}

let source = null;
let uiVersion = null;
let retry = null;
function connect() {
  source?.close();
  clearTimeout(retry);
  const qs = S.token ? `?token=${encodeURIComponent(S.token)}` : "";
  source = new EventSource(`/api/events${qs}`);
  let first = true;
  source.addEventListener("hello", (e) => {
    const data = safeJson(e.data) || {};
    if (data.uiVersion) {
      if (uiVersion && uiVersion !== data.uiVersion && route().name !== "new") return location.reload();
      uiVersion = data.uiVersion;
    }
    if (!S.connected) { S.connected = true; schedule(); }
    if (!first) api("/api/state").then(applySnapshot).catch(() => {});
    first = false;
  });
  source.onerror = () => {
    if (S.connected) { S.connected = false; schedule(); }
    clearTimeout(retry);
    retry = setTimeout(async () => {
      try {
        applySnapshot(await api("/api/state"));
        if (!source || source.readyState === EventSource.CLOSED) connect();
      } catch {}
    }, 3000);
  };
  source.addEventListener("task", (e) => {
    const t = safeJson(e.data);
    if (!t?.id) return;
    const prev = S.tasks.get(t.id);
    S.tasks.set(t.id, t);
    if (!prev || prev.status !== t.status) {
      S.flash.set(t.id, Date.now());
      if (prev && t.kind === "goal" && t.status === "done") { sound.play("done"); announce(`Run finished: ${firstLine(t.prompt, 80)}`); }
      if (prev && (t.kind === "subtask" || t.kind === "direct") && (t.status === "blocked" || t.status === "failed")) { sound.play("block"); announce(`${nameOf(t.agentId)} is ${t.status}: ${firstLine(t.error, 80)}`); }
      if (prev && t.kind === "subtask" && prev.status === "queued" && t.status === "running") {
        for (const n of t.after ?? []) {
          const up = tasksArr().find((x) => x.parentId === t.parentId && x.step === n);
          if (up) S.landing.set(`${up.id}>${t.id}`, Date.now());
        }
      }
    }
    schedule();
  });
  source.addEventListener("agents", (e) => {
    const d = safeJson(e.data);
    if (!d?.agents) return;
    S.agents = d.agents;
    S.kpis = d.kpis ?? S.kpis;
    S.lead = d.lead ?? S.lead;
    schedule();
  });
  source.addEventListener("channels", (e) => { const c = safeJson(e.data); if (Array.isArray(c)) { S.channels = c; schedule(); } });
  source.addEventListener("lessons", (e) => { const l = safeJson(e.data); if (Array.isArray(l)) { S.lessons = l; schedule(); } });
  source.addEventListener("baton", (e) => {
    const b = safeJson(e.data);
    if (!b?.taskId) return;
    S.batons.unshift({ ...b, at: Date.now() });
    S.batons.length = Math.min(S.batons.length, 60);
  });
  source.addEventListener("approval", (e) => {
    const a = safeJson(e.data);
    if (!a?.id) return;
    const i = S.approvals.findIndex((x) => x.id === a.id);
    if (i >= 0) S.approvals[i] = a;
    else S.approvals.push(a);
    if (i < 0 && a.status === "pending") {
      sound.play("ask");
      announce(`${a.agentName} needs your call: ${a.title}`);
      S.flash.set(a.taskId, Date.now());
      if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
        try { new Notification("Causeway needs your call", { body: a.title }); } catch {}
      }
    }
    schedule();
  });
}

/** A one-time link from Telegram (/dashboard) signs this phone in: trade the code for the token, then forget the code. */
async function pairFromLink() {
  const m = /^#pair=([\w-]{6,64})$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, "", `${location.pathname}#/`);
  try {
    const res = await fetch("/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: m[1] }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) { toast(data.error || "That sign-in link didn't work. Send /dashboard again."); return; }
    S.token = data.token;
    store.set("relay-token", S.token);
    toast("This phone is signed in.");
  } catch {
    toast("Couldn't reach Causeway to sign in.");
  }
}

async function boot(delay = 1500) {
  await pairFromLink();
  try {
    applySnapshot(await api("/api/state"));
    connect();
  } catch (err) {
    if (err.message === "locked") return;
    S.connected = false;
    updateChrome(route());
    main.innerHTML = `<div class="view"><div class="drafting" role="status"><span>Can't reach Causeway on this Mac. Retrying…</span></div></div>`;
    setTimeout(() => void boot(Math.min(10_000, delay * 1.5)), delay);
  }
}
void boot();
