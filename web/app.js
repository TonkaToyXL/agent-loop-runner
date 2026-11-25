// Relay dashboard. No framework: state + render functions + one SSE stream.
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const LEVELS = ["off", "low", "medium", "high", "max"];
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const S = {
  agents: [],
  tasks: new Map(),
  lb: { today: [], week: [], all: [] },
  kpis: {},
  channels: [],
  lead: "",
  period: "week",
  filter: "all",
  target: store.get("relay-target") || "auto",
  notes: [],
  handoffs: [],
  pos: {},
  token: store.get("relay-token") || "",
  editing: null,
};

// ------------------------------------------------------------------ helpers
const agentById = (id) => S.agents.find((a) => a.id === id);
const nameOf = (id) => (id === "you" ? "You" : agentById(id)?.name ?? id);
const colorOf = (id) => (id === "you" ? "var(--text)" : agentById(id)?.color ?? "var(--accent)");
const fmtK = (n = 0) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
const fmtUsd = (n = 0) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
const fmtMs = (ms) => (ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 5 ? "now" : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const think = (level) => {
  const n = Math.max(0, LEVELS.indexOf(level));
  return `<span class="think" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<s class="${i <= n ? "on" : ""}"></s>`).join("")}</span>`;
};
const CHANNEL_LABEL = { web: "web", telegram: "telegram", imessage: "imessage", system: "hub" };

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 2600);
}

// Small, safe markdown: code fences, inline code, bold, italics, lists, headings, links.
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])(https?:\/\/[^\s<)"]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}
function md(src = "") {
  return String(src)
    .split("```")
    .map((part, i) => {
      if (i % 2) return `<pre><code>${esc(part.replace(/^[\w-]*\n/, ""))}</code></pre>`;
      const out = [];
      let list = null;
      let para = [];
      const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; };
      const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join("")}</${list.tag}>`); list = null; };
      for (const line of part.split("\n")) {
        const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
        const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        const h = /^#{1,4}\s+(.*)$/.exec(line);
        if (ul || ol) {
          flushPara();
          const tag = ul ? "ul" : "ol";
          if (list && list.tag !== tag) flushList();
          list ??= { tag, items: [] };
          list.items.push((ul || ol)[1]);
        } else if (h) {
          flushPara(); flushList();
          out.push(`<h4>${inline(h[1])}</h4>`);
        } else if (!line.trim()) {
          flushPara(); flushList();
        } else {
          flushList();
          para.push(line);
        }
      }
      flushPara(); flushList();
      return out.join("");
    })
    .join("");
}

// ------------------------------------------------------------------ api
async function api(path, opts = {}) {
  const headers = { "content-type": "application/json" };
  if (S.token) headers.authorization = `Bearer ${S.token}`;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    showLock();
    throw new Error("locked");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showLock() {
  $("#lock").hidden = false;
  setTimeout(() => $("#lockInput").focus(), 50);
}

$("#lockForm").addEventListener("submit", (e) => {
  e.preventDefault();
  S.token = $("#lockInput").value.trim();
  store.set("relay-token", S.token);
  $("#lock").hidden = true;
  boot();
});

// ------------------------------------------------------------------ live state
function applySnapshot(snap) {
  S.agents = snap.agents;
  S.lead = snap.lead;
  S.lb = snap.leaderboard;
  S.kpis = snap.kpis;
  S.channels = snap.channels;
  S.tasks = new Map(snap.tasks.map((t) => [t.id, t]));
  S.handoffs = seedHandoffs(snap.tasks);
  dirty.add("all");
  flush();
}

function seedHandoffs(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return tasks
    .filter((t) => t.kind === "direct" || t.kind === "subtask" || t.kind === "goal")
    .slice(-16)
    .reverse()
    .map((t) => {
      const parent = t.parentId ? byId.get(t.parentId) : null;
      const from = t.kind === "subtask" ? parent?.agentId ?? S.lead : "you";
      return { from: t.reroutedFrom ?? from, to: t.agentId, taskId: t.id, kind: t.reroutedFrom ? "reroute" : "delegate", at: Date.parse(t.createdAt) };
    })
    .filter((h) => h.from !== h.to);
}

let source = null;
function connect() {
  source?.close();
  const qs = S.token ? `?token=${encodeURIComponent(S.token)}` : "";
  source = new EventSource(`/api/events${qs}`);
  let first = true;
  source.addEventListener("hello", () => {
    // After a reconnect, resync anything we missed.
    if (!first) api("/api/state").then(applySnapshot).catch(() => {});
    first = false;
  });
  source.addEventListener("task", (e) => {
    const t = JSON.parse(e.data);
    S.tasks.set(t.id, t);
    dirty.add("tasks");
    flush();
  });
  source.addEventListener("agents", (e) => {
    const d = JSON.parse(e.data);
    S.agents = d.agents;
    S.lb = d.leaderboard;
    S.kpis = d.kpis;
    S.lead = d.lead;
    dirty.add("agents");
    flush();
  });
  source.addEventListener("channels", (e) => {
    S.channels = JSON.parse(e.data);
    dirty.add("channels");
    flush();
  });
  source.addEventListener("baton", (e) => {
    const b = JSON.parse(e.data);
    if (b.from === b.to) return;
    S.handoffs.unshift({ ...b, at: Date.now() });
    S.handoffs.length = Math.min(S.handoffs.length, 30);
    animateBaton(b);
    dirty.add("handoffs");
    flush();
  });
}

// Animate only items that are new since the last render, so live updates don't flicker.
const seen = { thread: new Set(), lanes: new Set(), handoffs: new Set() };
let booted = false;
function enter(list, key) {
  if (seen[list].has(key)) return "";
  seen[list].add(key);
  return booted ? " enter" : "";
}

const dirty = new Set();
let frame = 0;
function flush() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const all = dirty.has("all");
    const agents = all || dirty.has("agents");
    const tasks = all || dirty.has("tasks");
    if (agents) { renderKpis(); renderCrew(); renderRanks(); renderTargets(); renderMap(); }
    if (all || dirty.has("channels")) renderChannels();
    if (tasks) { renderLanes(); renderThread(); }
    if (agents || tasks || dirty.has("handoffs")) renderHandoffs();
    dirty.clear();
    booted = true;
  });
}

// ------------------------------------------------------------------ top bar
function renderKpis() {
  const k = S.kpis;
  $("#kpis").innerHTML = [
    `<div class="kpi live"><b>${k.running ?? 0}</b><span>working now</span></div>`,
    `<div class="kpi"><b>${k.tasksToday ?? 0}</b><span>asks today</span></div>`,
    `<div class="kpi"><b>${fmtK(k.tokensToday)}</b><span>tokens today</span></div>`,
    `<div class="kpi"><b>${fmtUsd(k.costMonth)}</b><span>this month</span></div>`,
  ].join("");
}

function renderChannels() {
  const chans = [{ name: "web", connected: true, detail: "this dashboard" }, ...S.channels];
  const all = ["web", "telegram", "imessage"].map((n) => chans.find((c) => c.name === n) ?? { name: n, connected: false, detail: "not configured", off: true });
  const label = { web: "Web", telegram: "Telegram", imessage: "iMessage" };
  $("#channels").innerHTML = all
    .map((c) => `<span class="chan ${c.connected ? "on" : c.off ? "" : "err"}" title="${esc(label[c.name])}: ${esc(c.detail)}"><i></i><span class="lbl">${label[c.name]}</span></span>`)
    .join("");
}

// ------------------------------------------------------------------ crew map
const MAP = { cx: 170, cy: 166, r: 104 };
function renderMap() {
  const svg = $("#map");
  if (!$("#mapNodes", svg)) {
    svg.innerHTML = `<g id="mapLines"></g><g id="mapNodes"></g><g id="mapBatons"></g>`;
  }
  const n = S.agents.length;
  S.pos = { you: { x: MAP.cx, y: MAP.cy } };
  S.agents.forEach((a, i) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    S.pos[a.id] = { x: MAP.cx + MAP.r * Math.cos(ang), y: MAP.cy + MAP.r * Math.sin(ang), ang };
  });
  let lines = `<circle class="ring-orbit" cx="${MAP.cx}" cy="${MAP.cy}" r="${MAP.r}"/>`;
  for (const a of S.agents) {
    const p = S.pos[a.id];
    lines += `<line class="spoke" x1="${MAP.cx}" y1="${MAP.cy}" x2="${p.x}" y2="${p.y}"/>`;
  }
  $("#mapLines", svg).innerHTML = lines;

  let nodes = `<circle class="you" cx="${MAP.cx}" cy="${MAP.cy}" r="21"/><text class="you-text" x="${MAP.cx}" y="${MAP.cy + 4}">YOU</text>`;
  for (const a of S.agents) {
    const p = S.pos[a.id];
    const up = Math.sin(p.ang) < -0.3;
    const ly = up ? -52 : 40;
    nodes += `<g transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" opacity="${a.enabled ? 1 : 0.4}">
      ${a.status === "working" ? `<circle class="pulse" r="25" fill="none" stroke="${a.color}" stroke-width="2"/>` : ""}
      <circle r="25" fill="${a.color}" fill-opacity="0.14" stroke="${a.color}" stroke-width="1.6"/>
      <text y="1" text-anchor="middle" dominant-baseline="central" style="font:800 19px var(--font-display)" fill="${a.color}">${esc(a.name[0])}</text>
      ${a.isLead ? `<text class="crown" y="${up ? 37 : -32}" fill="var(--accent-text)">LEAD</text>` : ""}
      <text class="node-label" y="${ly}">${esc(a.name)}</text>
      <text class="node-sub" y="${ly + (up ? 14 : 13)}">${esc(a.model.length > 18 ? a.model.slice(0, 17) + "…" : a.model)}</text>
    </g>`;
  }
  $("#mapNodes", svg).innerHTML = nodes;
  const lead = agentById(S.lead);
  $("#leadLabel").textContent = lead ? `${lead.name} leads team goals` : "";
}

function animateBaton(b) {
  const layer = $("#mapBatons");
  const a = S.pos[b.from];
  const z = S.pos[b.to];
  if (!layer || !a || !z || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const color = b.kind === "return" ? colorOf(b.from) : b.kind === "reroute" ? "var(--warn)" : colorOf(b.to);
  // Curve away from the center so passes between agents arc around it.
  const mx = (a.x + z.x) / 2, my = (a.y + z.y) / 2;
  const dx = mx - MAP.cx, dy = my - MAP.cy;
  const d = Math.hypot(dx, dy) || 1;
  const bend = b.from === "you" || b.to === "you" ? 18 : 34;
  const cx = mx + (dx / d) * bend + (d < 2 ? 20 : 0), cy = my + (dy / d) * bend;
  const ns = "http://www.w3.org/2000/svg";
  const trail = Array.from({ length: 6 }, (_, i) => {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("r", String(5 - i * 0.7));
    c.setAttribute("fill", color);
    c.setAttribute("opacity", String(1 - i * 0.15));
    layer.appendChild(c);
    return c;
  });
  const glow = document.createElementNS(ns, "circle");
  glow.setAttribute("r", "11");
  glow.setAttribute("fill", color);
  glow.setAttribute("opacity", "0.22");
  layer.appendChild(glow);
  const at = (t) => {
    const u = 1 - t;
    return [u * u * a.x + 2 * u * t * cx + t * t * z.x, u * u * a.y + 2 * u * t * cy + t * t * z.y];
  };
  const start = performance.now();
  const dur = 1100;
  const step = (now) => {
    const raw = Math.min(1, (now - start) / dur);
    const t = raw < 0.5 ? 2 * raw * raw : 1 - (-2 * raw + 2) ** 2 / 2;
    trail.forEach((c, i) => {
      const [x, y] = at(Math.max(0, t - i * 0.035));
      c.setAttribute("cx", x);
      c.setAttribute("cy", y);
    });
    const [gx, gy] = at(t);
    glow.setAttribute("cx", gx);
    glow.setAttribute("cy", gy);
    if (raw < 1) requestAnimationFrame(step);
    else {
      glow.setAttribute("r", "4");
      let o = 0.6;
      const fade = () => {
        o -= 0.06;
        glow.setAttribute("r", String(Number(glow.getAttribute("r")) + 1.6));
        glow.setAttribute("opacity", String(Math.max(0, o)));
        if (o > 0) requestAnimationFrame(fade);
        else [...trail, glow].forEach((c) => c.remove());
      };
      trail.forEach((c) => c.setAttribute("opacity", "0"));
      requestAnimationFrame(fade);
    }
  };
  requestAnimationFrame(step);
}

function renderHandoffs() {
  const list = S.handoffs.slice(0, 14);
  $("#handoffs").innerHTML = list.length
    ? list
        .map((h) => {
          const t = S.tasks.get(h.taskId);
          const verb = h.kind === "return" ? "returned" : h.kind === "reroute" ? "rerouted" : "";
          return `<li class="${enter("handoffs", `${h.taskId}:${h.kind}:${h.from}`).trim()}">
            <span class="route"><span class="dot" style="--c:${colorOf(h.from)}"></span>${esc(nameOf(h.from))}
              <svg viewBox="0 0 16 16"><path d="M3 8h9M9 4.5 12.5 8 9 11.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <span class="dot" style="--c:${colorOf(h.to)}"></span>${esc(nameOf(h.to))}</span>
            <span class="what">${verb ? `<b style="color:${h.kind === "reroute" ? "var(--warn)" : "var(--muted)"};font-weight:500">${verb}</b> · ` : ""}${esc(t?.title ?? "")}</span>
            <time data-ago="${h.at}">${ago(h.at)}</time>
          </li>`;
        })
        .join("")
    : `<li class="empty" style="display:block">No handoffs yet. Send <b>@team</b> a goal and watch the baton move.</li>`;
}

// ------------------------------------------------------------------ crew cards
function ring(r, share, cls) {
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(1, share ?? 0));
  return `<circle class="g-track" r="${r}" cx="26" cy="26" fill="none" stroke-width="4"/>
    <circle class="${cls}" r="${r}" cx="26" cy="26" fill="none" stroke-width="4" stroke-linecap="round"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" transform="rotate(-90 26 26)"/>`;
}

function meter(label, used, cap, fmt, share) {
  const cls = cap ? (share >= 1 ? "full" : share >= 0.8 ? "warn" : "") : "off";
  return `<div class="meter"><span class="k">${label}</span>
    <div class="bar ${cls}"><span style="width:${cap ? Math.max(2, share * 100).toFixed(1) : 0}%"></span></div>
    <span class="v"><b>${fmt(used)}</b> / ${cap ? fmt(cap) : "∞"}</span></div>`;
}

const STATUS_TEXT = { idle: "idle", working: "working", limited: "at limit", paused: "paused" };
function renderCrew() {
  $("#crew").innerHTML = S.agents
    .map((a) => {
      const u = a.usage;
      const l = a.limit;
      const working = a.status === "working" ? `${STATUS_TEXT.working}${a.running > 1 ? ` ×${a.running}` : ""}` : STATUS_TEXT[a.status];
      const rate = a.rate && (a.rate.remainingRequests != null || a.rate.remainingTokens != null)
        ? `<div class="meter"><span class="k">Provider</span><span class="v" style="grid-column:2/4">${a.rate.remainingRequests != null ? `<b>${fmtK(a.rate.remainingRequests)}</b> req` : ""} ${a.rate.remainingTokens != null ? `<b>${fmtK(a.rate.remainingTokens)}</b> tok` : ""} left · ${ago(Date.parse(a.rate.at))} ago</span></div>`
        : "";
      return `<article class="agent ${a.enabled ? "" : "paused"}" style="--c:${a.color}" data-edit="${a.id}">
        <div class="agent-top">
          <svg class="glyph" viewBox="0 0 52 52" aria-hidden="true">
            ${ring(23, l.requests, "g-req")}${ring(16.5, l.tokens, "g-tok")}
            <text x="26" y="27">${esc(a.name[0])}</text>
          </svg>
          <div class="agent-id" style="padding-right:76px">
            <div class="agent-name">${esc(a.name)} ${a.isLead ? '<span class="badge lead">Lead</span>' : ""}${a.live ? "" : '<span class="badge demo">Demo</span>'}</div>
            <div class="agent-tag" title="${esc(a.tagline)}">${esc(a.tagline)}</div>
          </div>
          <span class="status ${a.status}"><i></i>${working}</span>
        </div>
        <div class="labels">
          <span class="chip" title="Model"><span class="k">model</span>${esc(a.model)}</span>
          <span class="chip" title="Reasoning effort"><span class="k">reasoning</span>${think(a.reasoning)}${esc(a.reasoning)}</span>
        </div>
        <div class="meters">
          ${meter("Requests", u.requestsToday, a.limits.dailyRequests, (n) => fmtK(n), l.requests ?? 0)}
          ${meter("Tokens", u.tokensToday, a.limits.dailyTokens, fmtK, l.tokens ?? 0)}
          ${meter("Spend/mo", u.costMonth, a.limits.monthlyBudgetUsd, fmtUsd, l.budget ?? 0)}
          ${rate}
        </div>
        <div class="agent-foot">
          <span class="conn ${a.live ? "live" : ""}" title="${esc(a.connectorLabel)}"><i></i>${esc(a.connectorLabel)}</span>
          <button class="btn" data-edit="${a.id}" aria-label="Edit ${esc(a.name)}">Edit</button>
        </div>
      </article>`;
    })
    .join("");
}

$("#crew").addEventListener("click", (e) => {
  const card = e.target.closest("[data-edit]");
  if (card) openEditor(card.dataset.edit);
});

// ------------------------------------------------------------------ board
function tcard(t) {
  const a = agentById(t.agentId);
  const parent = t.parentId ? S.tasks.get(t.parentId) : null;
  const secs = t.startedAt ? (t.finishedAt ? fmtMs(Date.parse(t.finishedAt) - Date.parse(t.startedAt)) : `<span data-since="${t.startedAt}">${fmtMs(Date.now() - Date.parse(t.startedAt))}</span>`) : ago(Date.parse(t.createdAt));
  const tok = t.usage ? ` · ${fmtK(t.usage.input + t.usage.output)} tok` : "";
  const bad = t.status === "failed" || t.status === "blocked" || t.status === "cancelled";
  return `<div class="tcard ${bad ? "err" : ""}${enter("lanes", `${t.id}:${t.status}`)}" style="--c:${a?.color ?? "var(--accent)"}">
    <span class="kind">${t.kind === "direct" ? CHANNEL_LABEL[t.channel] ?? "" : parent ? `team · ${t.kind}` : t.kind}${t.reroutedFrom ? " · rerouted" : ""}</span>
    <div class="t">${esc(t.title)}</div>
    ${bad && t.error ? `<div class="e">${esc(t.error.slice(0, 140))}</div>` : ""}
    <div class="m"><span class="who"><span class="dot"></span>${esc(a?.name ?? t.agentId)}</span><span>${secs}${tok}</span></div>
  </div>`;
}

function renderLanes() {
  const work = [...S.tasks.values()].filter((t) => t.kind !== "goal");
  const by = (st) => work.filter((t) => st.includes(t.status));
  const recent = (arr, n) => arr.sort((x, y) => Date.parse(y.finishedAt ?? y.createdAt) - Date.parse(x.finishedAt ?? x.createdAt)).slice(0, n);
  const lanes = [
    ["Working", by(["running"])],
    ["Queued", by(["queued"])],
    ["Done", recent(by(["done"]), 15)],
    ["Failed / blocked", recent(by(["failed", "blocked", "cancelled"]), 10)],
  ];
  $("#lanes").innerHTML = lanes
    .map(([name, items]) => `<div class="lane"><div class="lane-head">${name}<b>${items.length}</b></div>
      <div class="lane-list">${items.length ? items.map(tcard).join("") : `<div class="empty">Nothing here</div>`}</div></div>`)
    .join("");
  const done = work.filter((t) => t.status === "done").length;
  $("#boardCount").textContent = `${done} finished · ${work.length} total`;
}

// ------------------------------------------------------------------ ranks
function renderRanks() {
  const rows = S.lb[S.period] ?? [];
  const top = rows.slice(0, 3);
  const max = Math.max(1, ...top.map((r) => r.score));
  // Podium order: 2nd, 1st, 3rd.
  const order = [top[1], top[0], top[2]];
  $("#podium").innerHTML = order
    .map((r, i) => {
      if (!r) return `<div></div>`;
      const a = agentById(r.agentId);
      const place = i === 1 ? 1 : i === 0 ? 2 : 3;
      const h = r.score > 0 ? 30 + (Math.max(0, r.score) / max) * 70 : 22;
      return `<div class="step" style="--c:${a?.color}">
        <div class="who"><b>${esc(a?.name ?? r.agentId)}</b><span>${r.done} done · ${fmtK(r.tokens)} tok</span></div>
        <div class="col" style="height:${h}%">${place}</div></div>`;
    })
    .join("");
  $("#rankTable").innerHTML =
    `<div class="rrow head"><span>#</span><span>Agent</span><span class="num">Done</span><span class="num">Tokens</span><span class="num">Success</span><span class="num hide-sm">Avg time</span></div>` +
    rows
      .map((r, i) => {
        const a = agentById(r.agentId);
        return `<div class="rrow"><span class="n">${i + 1}</span>
          <span class="a"><span class="dot" style="--c:${a?.color}"></span>${esc(a?.name ?? r.agentId)}<span class="chip" style="padding:1px 6px;font-size:10.5px">${esc(a?.model ?? "")}</span></span>
          <span class="num">${r.done}${r.failed ? `<span class="muted"> / ${r.failed}✕</span>` : ""}</span>
          <span class="num">${fmtK(r.tokens)}</span>
          <span class="num">${r.done + r.failed ? Math.round(r.successRate * 100) + "%" : "—"}</span>
          <span class="num hide-sm">${r.avgMs ? fmtMs(r.avgMs) : "—"}</span></div>`;
      })
      .join("");
}

$("#rankSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-p]");
  if (!b) return;
  S.period = b.dataset.p;
  $$("#rankSeg button").forEach((x) => x.classList.toggle("on", x === b));
  renderRanks();
});

// ------------------------------------------------------------------ thread
function stateLabel(t) {
  return { queued: "queued", running: "working", done: "done", failed: "failed", blocked: "blocked", cancelled: "cancelled" }[t.status];
}

function thinking(t, label) {
  const since = t.startedAt ?? t.createdAt;
  return `<div class="thinking"><span class="bars"><i></i><i></i><i></i></span>${label} · <span data-since="${since}">${fmtMs(Date.now() - Date.parse(since))}</span></div>`;
}

function footer(t) {
  const tok = t.usage ? fmtK(t.usage.input + t.usage.output) + " tok" : "";
  const dur = t.startedAt && t.finishedAt ? fmtMs(Date.parse(t.finishedAt) - Date.parse(t.startedAt)) : "";
  const cost = t.costUsd ? fmtUsd(t.costUsd) : "";
  const cancel = t.status === "running" || t.status === "queued" ? `<button data-cancel="${t.id}">cancel</button>` : "";
  const copy = t.status === "done" && t.result ? `<button data-copy="${t.id}">copy</button>` : "";
  return `<div class="afoot">${[tok, dur, cost].filter(Boolean).map((x) => `<span>${x}</span>`).join("")}${copy}${cancel}</div>`;
}

function agentBubble(t) {
  const a = agentById(t.agentId);
  const head = `<div class="ahead"><span class="dot" style="--c:${a?.color}"></span><span class="nm">${esc(a?.name ?? t.agentId)}</span>
    <span class="chip">${esc(t.model ?? a?.model ?? "")}</span><span class="chip" style="--c:${a?.color}">${think(t.reasoning)}${esc(t.reasoning ?? "")}</span></div>`;
  const reroute = t.reroutedFrom ? `<div class="reroute">↪ Rerouted from ${esc(nameOf(t.reroutedFrom))} (at limit or paused)</div>` : "";
  let body;
  if (t.status === "done") body = `<div class="body">${md(t.result)}</div>`;
  else if (t.status === "running" || t.status === "queued") body = thinking(t, t.status === "queued" ? "waiting for a free slot" : "thinking");
  else body = `<div class="err-text">${esc(stateLabel(t))}: ${esc(t.error ?? "")}</div>`;
  return `<div class="msg bot"><div class="bubble" style="--c:${a?.color}">${head}${reroute}${body}${footer(t)}</div></div>`;
}

function goalBubble(t) {
  const lead = agentById(t.agentId);
  const kids = [...S.tasks.values()].filter((c) => c.parentId === t.id).sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
  const label = (c) => (c.kind === "plan" ? "Plan" : c.kind === "synthesis" ? "Wrap-up" : nameOf(c.agentId));
  const steps = kids.length
    ? `<div class="steps">${kids
        .map((c) => `<details><summary><span class="dot" style="--c:${colorOf(c.agentId)}"></span><span class="sname">${esc(label(c))}</span>
            <span class="stitle">${esc(c.kind === "subtask" ? c.title : nameOf(c.agentId))}</span><span class="sstate ${c.status}">${esc(stateLabel(c))}</span></summary>
            <div class="sbody body">${c.status === "done" ? (c.kind === "plan" ? `<pre><code>${esc(c.result)}</code></pre>` : md(c.result)) : c.error ? `<span class="err-text">${esc(c.error)}</span>` : "…"}</div></details>`)
        .join("")}</div>`
    : "";
  let body;
  if (t.status === "done") body = `<div class="body">${md(t.result)}</div>`;
  else if (t.status === "running" || t.status === "queued") {
    const stage = kids.some((c) => c.kind === "synthesis") ? "wrapping up" : kids.some((c) => c.kind === "subtask") ? "crew working" : "planning";
    body = thinking(t, stage);
  } else body = `<div class="err-text">${esc(stateLabel(t))}: ${esc(t.error ?? "")}</div>`;
  return `<div class="msg bot"><div class="bubble" style="--c:var(--accent)">
    <div class="ahead"><span class="dot" style="--c:var(--accent);background:conic-gradient(var(--a1) 0 33%,var(--a2) 0 66%,var(--a3) 0)"></span><span class="nm">Team</span><span class="chip">led by ${esc(lead?.name ?? "")}</span></div>
    ${steps}${body}${footer(t)}</div></div>`;
}

function userBubble(text, meta, cls = "") {
  return `<div class="msg user${cls}"><div class="meta">${meta}</div><div class="bubble">${esc(text)}</div></div>`;
}

const TRIES = [
  ["@team", "plan a launch week for our new product: research, copy, and a task list"],
  ["@grok", "what are people on X saying about AI agents this week?"],
  ["@muse", "write 5 punchy hook lines for a short video"],
  ["@hermes", "outline a script that backs up my projects folder nightly"],
];

function renderThread() {
  const el = $("#thread");
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  const tops = [...S.tasks.values()]
    .filter((t) => (t.kind === "direct" || t.kind === "goal") && (S.filter === "all" || t.channel === S.filter))
    .map((t) => ({ at: Date.parse(t.createdAt), t }));
  const notes = S.filter === "all" || S.filter === "web" ? S.notes.map((n) => ({ at: n.at, n })) : [];
  const items = [...tops, ...notes].sort((a, b) => a.at - b.at).slice(-80);
  if (!items.length) {
    const ids = new Set(S.agents.map((a) => a.id));
    el.innerHTML = `<div class="welcome"><h3>One line to your <em>whole crew.</em></h3>
      <p>Talk to one agent, or hand the team a goal and let the lead split it up. Same commands work from Telegram and iMessage.</p>
      <div class="tries">${TRIES.filter(([who]) => who === "@team" || ids.has(who.slice(1)))
        .map(([who, text]) => `<button class="try" data-try="${esc(`${who} ${text}`)}"><b>${who}</b> ${esc(text)}</button>`)
        .join("")}</div></div>`;
    return;
  }
  el.innerHTML = items
    .map(({ t, n, at }) => {
      if (n) {
        const cls = enter("thread", `note:${at}`);
        return userBubble(n.text, `web · ${clock(new Date(at).toISOString())}`, cls) + `<div class="msg sys${cls}"><div class="bubble">${esc(n.reply)}</div></div>`;
      }
      const who = t.replyTo?.from ? `${esc(t.replyTo.from)} · ` : "";
      const to = t.kind === "goal" ? "→ team" : t.routing === "auto" ? `→ auto · ${esc(nameOf(t.reroutedFrom ?? t.agentId))}` : `→ ${esc(nameOf(t.reroutedFrom ?? t.agentId))}`;
      const meta = `${who}${CHANNEL_LABEL[t.channel]} · ${clock(t.createdAt)} · ${to}`;
      const cls = enter("thread", t.id);
      const reply = (t.kind === "goal" ? goalBubble(t) : agentBubble(t)).replace('<div class="msg bot">', `<div class="msg bot${cls}">`);
      return userBubble(t.prompt, meta, cls) + reply;
    })
    .join("");
  if (nearBottom || renderThread.forceBottom) {
    el.scrollTop = el.scrollHeight;
    renderThread.forceBottom = false;
  }
}

$("#thread").addEventListener("click", async (e) => {
  const tryBtn = e.target.closest("[data-try]");
  if (tryBtn) {
    $("#input").value = tryBtn.dataset.try;
    autosize();
    $("#input").focus();
    return;
  }
  const c = e.target.closest("[data-cancel]");
  if (c) {
    await api(`/api/tasks/${c.dataset.cancel}/cancel`, { method: "POST" }).catch((err) => toast(err.message));
    toast("Cancelling…");
    return;
  }
  const cp = e.target.closest("[data-copy]");
  if (cp) {
    const t = S.tasks.get(cp.dataset.copy);
    await navigator.clipboard?.writeText(t?.result ?? "").then(() => toast("Copied"), () => toast("Copy failed"));
  }
});

$("#threadFilter").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-f]");
  if (!b) return;
  S.filter = b.dataset.f;
  $$("#threadFilter button").forEach((x) => x.classList.toggle("on", x === b));
  renderThread.forceBottom = true;
  renderThread();
});

// ------------------------------------------------------------------ composer
function renderTargets() {
  if (S.target !== "auto" && S.target !== "team" && !agentById(S.target)) S.target = "auto";
  const chips = [
    { id: "auto", name: "Auto", cls: "", color: "var(--muted)" },
    { id: "team", name: "Team", cls: "team", color: "var(--accent)" },
    ...S.agents.map((a) => ({ id: a.id, name: a.name, cls: "", color: a.color, off: !a.enabled })),
  ];
  $("#targets").innerHTML = chips
    .map((c) => `<button type="button" class="target ${c.cls} ${S.target === c.id ? "on" : ""}" data-target="${c.id}" style="--c:${c.color}${c.off ? ";opacity:.5" : ""}"><span class="dot"></span>${esc(c.name)}</button>`)
    .join("");
  const ph = S.target === "auto" ? "Ask anyone. Relay picks the best agent…" : S.target === "team" ? "Give the crew a goal…" : `Message ${nameOf(S.target)}…`;
  $("#input").placeholder = ph;
}

$("#targets").addEventListener("click", (e) => {
  const b = e.target.closest("[data-target]");
  if (!b) return;
  S.target = b.dataset.target;
  store.set("relay-target", S.target);
  renderTargets();
  $("#input").focus();
});

const COMMANDS = [
  ["/agents", "models, reasoning, usage"],
  ["/status", "what's running now"],
  ["/board", "who did the most work"],
  ["/team ", "give the crew a goal"],
  ["/model ", "<agent> <model-id>"],
  ["/reasoning ", "<agent> off|low|medium|high|max"],
  ["/lead ", "<agent> plans team goals"],
  ["/help", "all commands"],
];

function autosize() {
  const t = $("#input");
  t.style.height = "auto";
  t.style.height = Math.min(160, t.scrollHeight) + "px";
}

function renderSlash() {
  const v = $("#input").value;
  const box = $("#slash");
  if (!v.startsWith("/") || /\s/.test(v)) {
    box.hidden = true;
    return;
  }
  const hits = COMMANDS.filter(([c]) => c.startsWith(v));
  box.hidden = !hits.length;
  box.innerHTML = hits.map(([c, d]) => `<button type="button" data-cmd="${esc(c)}"><code>${esc(c.trim())}</code><span>${esc(d)}</span></button>`).join("");
}

$("#slash").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cmd]");
  if (!b) return;
  $("#input").value = b.dataset.cmd;
  $("#slash").hidden = true;
  $("#input").focus();
  if (!b.dataset.cmd.endsWith(" ")) $("#composer").requestSubmit();
});

$("#input").addEventListener("input", () => {
  autosize();
  renderSlash();
});
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
  if (e.key === "Escape") $("#slash").hidden = true;
});

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = $("#input").value.trim();
  if (!raw) return;
  let text = raw;
  if (!raw.startsWith("@") && !raw.startsWith("/")) {
    if (S.target === "team") text = `@team ${raw}`;
    else if (S.target !== "auto") text = `@${S.target} ${raw}`;
  }
  $("#input").value = "";
  autosize();
  $("#slash").hidden = true;
  renderThread.forceBottom = true;
  try {
    const res = await api("/api/command", { method: "POST", body: JSON.stringify({ text }) });
    if (!res.taskId) {
      S.notes.push({ at: Date.now(), text: raw, reply: res.reply });
      renderThread();
    }
  } catch (err) {
    if (err.message !== "locked") {
      $("#input").value = raw;
      toast(err.message);
    }
  }
});

// ------------------------------------------------------------------ editor drawer
function openEditor(id) {
  const a = agentById(id);
  if (!a) return;
  S.editing = id;
  const d = $("#drawer");
  d.style.setProperty("--c", a.color);
  d.innerHTML = `
    <div class="drawer-head">
      <svg class="glyph" viewBox="0 0 52 52" style="--c:${a.color}" aria-hidden="true">${ring(23, a.limit.requests, "g-req")}${ring(16.5, a.limit.tokens, "g-tok")}<text x="26" y="27">${esc(a.name[0])}</text></svg>
      <div><h3>${esc(a.name)}</h3><div class="muted small">${esc(a.tagline)}</div></div>
      <button class="icon-btn x" data-close aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </div>
    <form class="drawer-body" id="editForm">
      <div class="conn-box">${a.live ? `● Connected via <b>${esc(a.connectorLabel)}</b>` : `◌ <b>Demo mode.</b> ${esc(a.connectorLabel.replace(/^Demo · /, "To go live: "))} in <code>.env</code>, then restart the hub.`}</div>
      <div class="field">
        <label for="fModel">Model</label>
        <input class="input mono" id="fModel" list="modelList" value="${esc(a.model)}" spellcheck="false" />
        <datalist id="modelList">${a.modelOptions.map((m) => `<option value="${esc(m)}"></option>`).join("")}</datalist>
        <span class="help">Pick a suggestion or type any model ID the provider accepts.</span>
      </div>
      <div class="field">
        <span class="lbl">Reasoning</span>
        <div class="levels" id="fLevels">${LEVELS.map((l) => `<button type="button" data-level="${l}" class="${a.reasoning === l ? "on" : ""}">${think(l)}${l}</button>`).join("")}</div>
        <span class="help">Shown as a label everywhere. Sent to the provider only if its connector sets a reasoning parameter.</span>
      </div>
      <div class="field">
        <span class="lbl">Usage limits <span class="help">(0 = no limit)</span></span>
        <div class="grid3">
          <div class="field"><label for="fReq">Requests/day</label><input class="input mono" id="fReq" type="number" min="0" step="1" value="${a.limits.dailyRequests}"/></div>
          <div class="field"><label for="fTok">Tokens/day</label><input class="input mono" id="fTok" type="number" min="0" step="1000" value="${a.limits.dailyTokens}"/></div>
          <div class="field"><label for="fBud">Budget $/mo</label><input class="input mono" id="fBud" type="number" min="0" step="1" value="${a.limits.monthlyBudgetUsd}"/></div>
        </div>
        <span class="help">When an agent hits a limit, auto-routed and team work moves to a teammate. Direct asks stop and tell you.</span>
      </div>
      <div class="field">
        <span class="lbl">Pricing per 1M tokens (for spend tracking)</span>
        <div class="grid2">
          <div class="field"><label for="fIn">Input $</label><input class="input mono" id="fIn" type="number" min="0" step="0.01" value="${a.pricing.inputPerMTok}"/></div>
          <div class="field"><label for="fOut">Output $</label><input class="input mono" id="fOut" type="number" min="0" step="0.01" value="${a.pricing.outputPerMTok}"/></div>
        </div>
      </div>
      <div class="field">
        <label for="fSkills">Strengths (for auto-routing)</label>
        <input class="input" id="fSkills" value="${esc(a.skills.join(", "))}" />
      </div>
      <div class="grid2">
        <div class="field"><label for="fPar">Parallel tasks</label><input class="input mono" id="fPar" type="number" min="1" max="8" value="${a.maxConcurrent}"/></div>
        <div class="field"><label for="fTag">Tagline</label><input class="input" id="fTag" value="${esc(a.tagline)}"/></div>
      </div>
      <label class="switch"><span><b>Active</b><br><span class="muted small">Paused agents get no new work.</span></span><input type="checkbox" id="fOn" ${a.enabled ? "checked" : ""}/></label>
    </form>
    <div class="drawer-foot">
      <button class="btn ghost" id="makeLead" ${a.isLead ? "disabled" : ""}>${a.isLead ? "★ Team lead" : "Make team lead"}</button>
      <div style="display:flex;gap:8px"><button class="btn" data-close>Cancel</button><button class="btn primary" id="saveAgent">Save</button></div>
    </div>`;
  $("#scrim").hidden = false;
  d.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => d.classList.add("open"));
  setTimeout(() => $("#fModel")?.focus(), 250);
}

function closeEditor() {
  const d = $("#drawer");
  d.classList.remove("open");
  d.setAttribute("aria-hidden", "true");
  $("#scrim").hidden = true;
  S.editing = null;
}

$("#scrim").addEventListener("click", closeEditor);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && S.editing) closeEditor();
});
$("#drawer").addEventListener("click", async (e) => {
  if (e.target.closest("[data-close]")) return closeEditor();
  const lvl = e.target.closest("[data-level]");
  if (lvl) {
    $$("#fLevels button").forEach((b) => b.classList.toggle("on", b === lvl));
    return;
  }
  const id = S.editing;
  if (e.target.closest("#makeLead")) {
    await api("/api/lead", { method: "POST", body: JSON.stringify({ agentId: id }) }).then(
      () => { toast(`${nameOf(id)} now leads team goals`); closeEditor(); },
      (err) => toast(err.message),
    );
    return;
  }
  if (e.target.closest("#saveAgent")) {
    const n = (sel) => Number($(sel).value || 0);
    const patch = {
      model: $("#fModel").value.trim(),
      reasoning: $("#fLevels .on")?.dataset.level,
      limits: { dailyRequests: n("#fReq"), dailyTokens: n("#fTok"), monthlyBudgetUsd: n("#fBud") },
      pricing: { inputPerMTok: n("#fIn"), outputPerMTok: n("#fOut") },
      skills: $("#fSkills").value.split(",").map((s) => s.trim()).filter(Boolean),
      maxConcurrent: n("#fPar") || 1,
      tagline: $("#fTag").value.trim(),
      enabled: $("#fOn").checked,
    };
    try {
      const a = await api(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      toast(`Saved. ${a.name} runs ${a.model} · ${a.reasoning}`);
      closeEditor();
    } catch (err) {
      toast(err.message);
    }
  }
});
$("#drawer").addEventListener("submit", (e) => e.preventDefault());

// ------------------------------------------------------------------ tabs, theme, ticks
function setTab(tab) {
  document.body.dataset.tab = tab;
  $$("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.go === tab));
  if (tab === "thread") {
    renderThread.forceBottom = true;
    renderThread();
  }
}
$("#tabbar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-go]");
  if (b) setTab(b.dataset.go);
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "light" ? "#f3f1ea" : "#0a0a0c";
}
applyTheme(store.get("relay-theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
$("#themeBtn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  store.set("relay-theme", next);
  applyTheme(next);
});

setInterval(() => {
  $$("[data-since]").forEach((el) => (el.textContent = fmtMs(Date.now() - Date.parse(el.dataset.since))));
  $$("[data-ago]").forEach((el) => (el.textContent = ago(Number(el.dataset.ago))));
}, 1000);

async function boot() {
  try {
    applySnapshot(await api("/api/state"));
    connect();
  } catch (err) {
    if (err.message !== "locked") toast(`Can't reach the hub: ${err.message}`);
  }
}

setTab("thread");
boot();
