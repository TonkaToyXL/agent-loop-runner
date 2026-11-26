// Relay dashboard. No framework: state + render functions + one SSE stream.
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const LEVELS = ["auto", "off", "low", "medium", "high", "max"];
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
  approvals: [],
  pos: {},
  token: store.get("relay-token") || "",
  editing: null,
  previewWork: new Set(),
};

// ------------------------------------------------------------------ official assistant avatars
function fallbackAvatarSvg(name = "?", color = "var(--accent)", working = false) {
  return `<svg class="portrait ${working ? "is-working" : "is-idle"}" viewBox="0 0 80 80" aria-hidden="true">
    <rect width="80" height="80" fill="#14141a"/>
    <circle cx="40" cy="40" r="24" fill="${color}" fill-opacity="0.16" stroke="${color}" stroke-width="1.8"/>
    <text x="40" y="42" text-anchor="middle" dominant-baseline="central" fill="${color}" style="font:800 28px var(--font-display)">${esc(name[0] || "?")}</text>
  </svg>`;
}

function renderPortraitContent(agent, working = false) {
  const idleUrl = agent?.avatarIdle;
  const workUrl = agent?.avatarWorking;
  if (idleUrl && workUrl && workUrl !== idleUrl) {
    return `<img class="portrait-img portrait-idle" src="${esc(idleUrl)}" alt="" loading="lazy"/>
      <img class="portrait-img portrait-work" src="${esc(workUrl)}" alt="" loading="lazy"/>`;
  }
  if (idleUrl) {
    return `<img class="portrait-img official-avatar" src="${esc(idleUrl)}" alt="" loading="lazy"/>`;
  }
  return fallbackAvatarSvg(agent?.name, agent?.color, working);
}

function mapPortraitMarkup(a, working) {
  const url = working ? (a.avatarWorking || a.avatarIdle) : a.avatarIdle;
  if (url) {
    return `<image href="${esc(url)}" x="-24" y="-24" width="48" height="48" preserveAspectRatio="xMidYMid slice" clip-path="url(#mapAvatarClip)"/>`;
  }
  return `<g clip-path="url(#mapAvatarClip)"><svg x="-24" y="-24" width="48" height="48" viewBox="0 0 80 80">${fallbackAvatarSvg(a.name, a.color, working).replace(/^<svg[^>]*>|<\/svg>$/g, "")}</svg></g>`;
}

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
  if (level === "auto") {
    return `<span class="think auto" aria-hidden="true"><s></s><s></s><s></s><s></s></span>`;
  }
  const n = Math.max(0, ["off", "low", "medium", "high", "max"].indexOf(level));
  return `<span class="think" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<s class="${i <= n ? "on" : ""}"></s>`).join("")}</span>`;
};
const levelLabel = (lvl) => (lvl === "auto" ? "Auto" : lvl);
const CHANNEL_LABEL = { web: "web", telegram: "telegram", imessage: "imessage", system: "hub" };

function shortModel(id, a) {
  if (!id) return "";
  if (id === "auto") return "Auto (match task)";
  if (id === "hermes-agent") {
    const def = a?.discoveredDefaultModel;
    return def ? `Default (${def.split("/").pop()})` : "Hermes default";
  }
  return id.replace(/^cline-pass\//, "");
}

function modelOptionsMarkup(a) {
  const opts = Array.from(new Set([a.model, ...(a.modelOptions ?? [])]));
  if (a.discoveredProvider && opts.includes("hermes-agent")) {
    const rest = opts.filter((m) => m !== "hermes-agent");
    const defLabel = a.discoveredDefaultModel
      ? `Hermes default (${a.discoveredDefaultModel.split("/").pop()})`
      : "Hermes default";
    const provLabel = `${a.discoveredProviderName || a.discoveredProvider} (active)`;
    return `<option value="hermes-agent" ${a.model === "hermes-agent" ? "selected" : ""}>${esc(defLabel)}</option>` +
      (rest.length
        ? `<optgroup label="${esc(provLabel)}">${rest
            .map((m) => `<option value="${esc(m)}" ${a.model === m ? "selected" : ""}>${esc(m)}</option>`)
            .join("")}</optgroup>`
        : "");
  }
  return opts
    .map((m) => `<option value="${esc(m)}" ${a.model === m ? "selected" : ""}>${esc(shortModel(m, a))}</option>`)
    .join("");
}

function activeTaskFor(agentId) {
  const list = [...S.tasks.values()].filter((t) => t.agentId === agentId && t.kind !== "goal" && (t.status === "running" || t.status === "queued"));
  return list.find((t) => t.status === "running") ?? list[0] ?? null;
}

function lastTaskFor(agentId) {
  const done = [...S.tasks.values()]
    .filter((t) => t.agentId === agentId && t.kind !== "goal" && t.finishedAt)
    .sort((x, y) => Date.parse(y.finishedAt) - Date.parse(x.finishedAt));
  return done[0] ?? null;
}

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

async function quickUpdateAgent(id, patch, selectEl) {
  const a = agentById(id);
  if (!a) return;
  if (selectEl) selectEl.disabled = true;
  try {
    const updated = await api(`/api/agents/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    const idx = S.agents.findIndex((x) => x.id === id);
    if (idx >= 0) S.agents[idx] = updated;
    dirty.add("agents");
    flush();
    if (patch.model) {
      toast(`${updated.name} switched to ${shortModel(updated.model, updated)}`);
    } else if (patch.reasoning) {
      toast(`${updated.name} reasoning set to ${updated.reasoning}`);
    }
    requestAnimationFrame(() => {
      $$(`[data-model-for="${id}"], [data-reasoning-for="${id}"]`).forEach((el) => {
        el.classList.add("saved");
        setTimeout(() => el.classList.remove("saved"), 900);
      });
    });
  } catch (err) {
    toast(err.message);
    dirty.add("agents");
    flush();
  } finally {
    if (selectEl) selectEl.disabled = false;
  }
}

function modelPatchFor(agent, nextModel) {
  const patch = { model: nextModel };
  if (agent.supportsProvider && agent.discoveredProvider) {
    patch.provider = nextModel === "hermes-agent" ? "" : agent.discoveredProvider;
  }
  return patch;
}

function focusAgent(id, { switchTab = false } = {}) {
  S.target = id;
  store.set("relay-target", id);
  renderTargets();
  renderCrewStrip();
  renderActiveBar();
  renderCrew();
  renderMap();
  if (switchTab && matchMedia("(max-width: 960px)").matches) setTab("thread");
  $("#input")?.focus();
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
  S.approvals = snap.approvals ?? [];
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
let uiVersion = null;
function connect() {
  source?.close();
  const qs = S.token ? `?token=${encodeURIComponent(S.token)}` : "";
  source = new EventSource(`/api/events${qs}`);
  let first = true;
  source.addEventListener("hello", (e) => {
    try {
      const data = JSON.parse(e.data || "{}");
      if (data.uiVersion) {
        if (uiVersion && uiVersion !== data.uiVersion) return location.reload();
        uiVersion = data.uiVersion;
      }
    } catch {}
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
  source.addEventListener("approval", (e) => {
    const a = JSON.parse(e.data);
    const i = S.approvals.findIndex((x) => x.id === a.id);
    if (i >= 0) S.approvals[i] = a;
    else S.approvals.push(a);
    if (a.status === "pending" && typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
      try { new Notification("Relay needs your OK", { body: a.title }); } catch {}
    }
    dirty.add("approvals");
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
    if (agents) { renderKpis(); renderCrew(); renderRanks(); renderTargets(); renderCrewStrip(); renderActiveBar(); renderMap(); }
    if (all || dirty.has("channels")) renderChannels();
    if (tasks) { renderLanes(); renderThread(); if (!agents) { renderCrew(); renderMap(); renderCrewStrip(); renderActiveBar(); } }
    if (agents || tasks || dirty.has("handoffs")) renderHandoffs();
    if (all || dirty.has("approvals")) { renderApprovals(); renderKpis(); if (!agents && !tasks) renderCrew(); }
    if (dirty.has("approvals") && !tasks) renderThread();
    dirty.clear();
    booted = true;
  });
}

// ------------------------------------------------------------------ top bar
function renderKpis() {
  const k = S.kpis;
  const running = k.running ?? 0;
  const readyCount = S.agents.filter((a) => a.live && a.enabled && a.status !== "offline").length;
  $("#kpis").innerHTML = [
    ...(pendingApprovals().length
      ? [`<button class="kpi ask" data-go-approvals><b>${pendingApprovals().length}</b><span>need${pendingApprovals().length === 1 ? "s" : ""} your OK</span></button>`]
      : []),
    `<div class="kpi live ${running > 0 ? "hot" : ""}"><i class="kpi-dot" aria-hidden="true"></i><b>${running > 0 ? running : readyCount}</b><span>${running > 0 ? "working now" : "ready"}</span></div>`,
    `<div class="kpi"><b>${k.tasksToday ?? 0}</b><span>asks today</span></div>`,
    `<div class="kpi"><b>${fmtK(k.tokensToday)}</b><span>tokens today</span></div>`,
    ...(k.costMonth > 0 ? [`<div class="kpi"><b>${fmtUsd(k.costMonth)}</b><span>this month</span></div>`] : []),
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
const MAP = { cx: 170, cy: 166, r: 102 };
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
    const active = a.status === "working";
    lines += `<line class="spoke ${active ? "active" : ""}" style="${active ? `stroke:${a.color}` : ""}" x1="${MAP.cx}" y1="${MAP.cy}" x2="${p.x}" y2="${p.y}"/>`;
  }
  $("#mapLines", svg).innerHTML = lines;

  let nodes = `<g class="you-node" data-map-target="team" role="button" tabindex="0" aria-label="Message whole team">
    <circle class="you" cx="${MAP.cx}" cy="${MAP.cy}" r="22"/>
    <text class="you-text" x="${MAP.cx}" y="${MAP.cy + 4}">YOU</text>
  </g>`;

  for (const a of S.agents) {
    const p = S.pos[a.id];
    const up = Math.sin(p.ang) < -0.3;
    const ly = up ? -50 : 41;
    const active = activeTaskFor(a.id);
    const isWorking = a.status === "working" || S.previewWork.has(a.id);
    const isOnline = a.live && a.enabled && a.status === "idle" && !isWorking;
    const isSelected = S.target === a.id;
    const modelShort = shortModel(a.model, a);
    nodes += `<g class="map-node ${isSelected ? "selected" : ""}" data-map-target="${a.id}" role="button" tabindex="0" aria-label="Chat with ${esc(a.name)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" opacity="${a.enabled ? 1 : 0.42}">
      ${isWorking ? `<circle class="pulse" r="26" fill="none" stroke="${a.color}" stroke-width="2"/>
        <circle class="orbit-spin" r="30" fill="none" stroke="${a.color}" stroke-width="1.6" stroke-dasharray="14 28" stroke-linecap="round"/>` : ""}
      ${isOnline ? `<circle class="breathe" r="28" fill="none" stroke="${a.color}" stroke-width="1.1"/>` : ""}
      <g class="node-core">
        ${mapPortraitMarkup(a, isWorking)}
        <circle class="node-ring" r="24" fill="none" stroke="${a.color}" stroke-width="${isSelected || isWorking ? 2.4 : 1.7}"/>
      </g>
      <circle cx="17" cy="17" r="4.8" fill="${active?.awaitingApproval ? "var(--warn)" : isWorking ? a.color : isOnline ? "var(--ok)" : a.status === "offline" ? "var(--danger)" : "var(--faint)"}" stroke="var(--panel)" stroke-width="2"/>
      ${a.isLead ? `<text class="crown" y="${up ? 37 : -32}" fill="var(--accent-text)">LEAD</text>` : ""}
      <text class="node-label" y="${ly}">${esc(a.name)}</text>
      <text class="node-sub" y="${ly + 13}">${esc(modelShort.length > 18 ? modelShort.slice(0, 17) + "…" : modelShort)}</text>
    </g>`;
  }
  $("#mapNodes", svg).innerHTML = nodes;

  const lead = agentById(S.lead);
  $("#leadLabel").textContent = lead ? `${lead.name} leads team goals` : "";

  const busy = S.agents.filter((a) => a.status === "working");
  const ready = S.agents.filter((a) => a.live && a.enabled && a.status !== "offline").length;
  const cap = $("#mapCaption");
  cap.classList.toggle("busy", busy.length > 0);
  if (busy.length) {
    const first = busy[0];
    const t = activeTaskFor(first.id);
    cap.innerHTML = `<i class="live-dot" aria-hidden="true"></i><span><b>${esc(first.name)}</b> ${t ? `is working on “${esc(t.title.slice(0, 34))}${t.title.length > 34 ? "…" : ""}”` : "is working…"}</span>`;
  } else {
    cap.innerHTML = `<i class="live-dot" aria-hidden="true"></i><span>${ready} of ${S.agents.length} assistants ready · click one to chat</span>`;
  }
}

$("#map").addEventListener("click", (e) => {
  const node = e.target.closest("[data-map-target]");
  if (!node) return;
  focusAgent(node.dataset.mapTarget, { switchTab: true });
});
$("#map").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const node = e.target.closest("[data-map-target]");
  if (!node) return;
  e.preventDefault();
  focusAgent(node.dataset.mapTarget, { switchTab: true });
});

function animateBaton(b) {
  const layer = $("#mapBatons");
  const a = S.pos[b.from];
  const z = S.pos[b.to];
  if (!layer || !a || !z || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const color = b.kind === "return" || b.kind === "handoff" ? colorOf(b.from) : b.kind === "reroute" ? "var(--warn)" : colorOf(b.to);
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
          const verb = h.kind === "return" ? "returned" : h.kind === "reroute" ? "rerouted" : h.kind === "handoff" ? "passed results" : "";
          return `<li class="${enter("handoffs", `${h.taskId}:${h.kind}:${h.from}`).trim()}">
            <span class="route"><span class="dot" style="--c:${colorOf(h.from)}"></span>${esc(nameOf(h.from))}
              <svg viewBox="0 0 16 16"><path d="M3 8h9M9 4.5 12.5 8 9 11.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <span class="dot" style="--c:${colorOf(h.to)}"></span>${esc(nameOf(h.to))}</span>
            <span class="what">${verb ? `<b style="color:${h.kind === "reroute" ? "var(--warn)" : "var(--muted)"};font-weight:500">${verb}</b> · ` : ""}${esc(t?.title ?? "")}</span>
            <time data-ago="${h.at}">${ago(h.at)}</time>
          </li>`;
        })
        .join("")
    : `<li class="empty" style="display:block">No handoffs yet. Send <b>@team</b> a goal and watch the crew pass the baton.</li>`;
}

// ------------------------------------------------------------------ crew cards
const STATUS_TEXT = { idle: "Ready", working: "Working", limited: "At limit", paused: "Paused", offline: "Offline" };
const BILL = { subscription: "Your plan", local: "Local", metered: "Pay-per-use" };
const BILL_HELP = {
  subscription: "Runs on a subscription you already have. No extra charges from Relay.",
  local: "Runs on your own machine with that assistant's own setup.",
  metered: "Billed per use by the provider.",
};
function connText(a) {
  if (!a.live || a.online === undefined) return a.connectorLabel;
  return `${a.connectorLabel} · ${a.online ? "online" : a.healthDetail || "offline"}`;
}

function fmtResetIn(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "soon";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remH = hrs % 24;
  return remH > 0 && days < 5 ? `${days}d ${remH}h` : `${days}d`;
}

function renderUsageStrip(a) {
  const u = a.usage;
  const l = a.limit;
  const pq = a.providerQuota;

  if (pq?.live && pq.windows?.length) {
    const srcLabel = pq.plan || pq.provider;
    return `<div class="usage-strip">
      <div class="usage-row">
        <span class="quota-src live" title="Live limits from ${esc(pq.provider)} (updated ${clock(pq.updatedAt)})"><i></i>${esc(srcLabel)}</span>
        <span>Today: <b>${fmtK(u.requestsToday)}</b> req · <b>${fmtK(u.tokensToday)}</b> tok</span>
      </div>
      <div class="quota-grid">
        ${pq.windows.slice(0, 3).map((w) => {
          const pct = Math.max(0, Math.min(100, w.usedPercent));
          const left = Math.max(0, Math.round(100 - pct));
          const reset = fmtResetIn(w.resetsAt);
          const cls = pct >= 92 ? "full" : pct >= 75 ? "warn" : "";
          const scale = pct > 0 ? Math.max(0.04, pct / 100).toFixed(3) : "0";
          const tip = `${w.label}: ${Math.round(pct)}% used (${left}% left)${reset ? ` · resets in ${reset}` : ""}`;
          return `<div class="qwin" title="${esc(tip)}">
            <div class="qwin-top"><span>${esc(w.label)}${reset ? ` <em>${esc(reset)}</em>` : ""}</span><b>${Math.round(pct)}%</b></div>
            <div class="bar ${cls}"><span style="transform:scaleX(${scale})"></span></div>
          </div>`;
        }).join("")}
      </div>
    </div>`;
  }

  if (pq?.live && typeof pq.creditsRemainingUsd === "number") {
    const rem = pq.creditsRemainingUsd;
    const spent = typeof pq.periodSpendUsd === "number" ? pq.periodSpendUsd : 0;
    const total = pq.monthlyCreditsUsd && pq.monthlyCreditsUsd > 0 ? pq.monthlyCreditsUsd : rem + spent;
    const share = total > 0 ? Math.max(0.04, Math.min(1, rem / total)) : 1;
    const barCls = rem < 2 ? "full" : rem < 10 ? "warn" : "";
    return `<div class="usage-strip">
      <div class="usage-row">
        <span class="quota-src live" title="Live balance from ${esc(pq.provider)} (updated ${clock(pq.updatedAt)})"><i></i><b>${fmtUsd(rem)}</b> credits left</span>
        ${spent > 0 ? `<span><b>${fmtUsd(spent)}</b> spent</span>` : `<span>${esc(pq.plan || pq.provider)}</span>`}
      </div>
      <div class="bar ${barCls}"><span style="transform:scaleX(${share.toFixed(3)})"></span></div>
      <div class="usage-sub">Today: <b>${fmtK(u.requestsToday)}</b> req · <b>${fmtK(u.tokensToday)}</b> tok · ${esc(pq.provider)}</div>
    </div>`;
  }

  if (a.limits.monthlyBudgetUsd > 0) {
    const cap = a.limits.monthlyBudgetUsd;
    const share = l.budget ?? (cap > 0 ? u.costMonth / cap : 0);
    const barCls = share >= 1 ? "full" : share >= 0.8 ? "warn" : "";
    const scale = Math.min(1, Math.max(u.costMonth > 0 ? 0.04 : 0, share)).toFixed(3);
    return `<div class="usage-strip">
      <div class="usage-row">
        <span>Relay cap: <b>${fmtUsd(u.costMonth)}</b> / ${fmtUsd(cap)}/mo</span>
        <span>Today: <b>${fmtK(u.requestsToday)}</b> req · <b>${fmtK(u.tokensToday)}</b> tok</span>
      </div>
      <div class="bar ${barCls}"><span style="transform:scaleX(${scale})"></span></div>
      ${pq?.note ? `<div class="usage-sub">${esc(pq.note)}</div>` : ""}
    </div>`;
  }

  const reqCap = a.limits.dailyRequests;
  const reqShare = l.requests ?? 0;
  const barCls = reqCap ? (reqShare >= 1 ? "full" : reqShare >= 0.8 ? "warn" : "") : "off";
  const barScale = reqCap ? Math.min(1, Math.max(u.requestsToday > 0 ? 0.04 : 0, reqShare)).toFixed(3) : "1";
  const showSpend = u.costMonth > 0;
  return `<div class="usage-strip">
    <div class="usage-row">
      <span>Today: <b>${fmtK(u.requestsToday)}</b>${reqCap ? ` / ${fmtK(reqCap)} req` : " req"} · <b>${fmtK(u.tokensToday)}</b> tok</span>
      ${showSpend ? `<span><b>${fmtUsd(u.costMonth)}</b>/mo</span>` : ""}
    </div>
    <div class="bar ${barCls}"><span style="transform:scaleX(${barScale})"></span></div>
    ${pq?.note ? `<div class="usage-sub">${esc(pq.note)}</div>` : ""}
  </div>`;
}

function renderCrew() {
  // Don't clobber an open select dropdown while the user is actively interacting with it.
  const activeEl = document.activeElement;
  if (activeEl && activeEl.matches("#crew select")) return;

  $("#crew").innerHTML = S.agents
    .map((a) => {
      const activeTask = activeTaskFor(a.id);
      const lastTask = lastTaskFor(a.id);
      const isAsk = Boolean(activeTask?.awaitingApproval);
      const isPreview = S.previewWork.has(a.id);
      const isWorking = (a.status === "working" && !isAsk) || isPreview;
      const avatarState = isAsk ? "ask" : isWorking ? "working" : a.status === "idle" && a.live ? "online" : a.status;
      const statusCls = isAsk ? "ask" : isWorking ? "working" : a.status;
      const statusLabel = isAsk
        ? "Needs OK"
        : isWorking
          ? `<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>${isPreview && a.status !== "working" ? "Preview" : `Working${a.running > 1 ? ` ×${a.running}` : ""}`}`
          : STATUS_TEXT[a.status];

      let activityHtml;
      if (isAsk && activeTask) {
        activityHtml = `<div class="agent-activity ask" data-go-approvals role="button" tabindex="0">
          <span class="act-text">Needs your OK: ${esc(activeTask.title)}</span>
          <span class="act-meta">Review →</span>
        </div>`;
      } else if (activeTask) {
        const since = activeTask.startedAt ?? activeTask.createdAt;
        activityHtml = `<div class="agent-activity live">
          <span class="act-text" title="${esc(activeTask.title)}">${activeTask.status === "queued" ? "Queued: " : ""}${esc(activeTask.title)}</span>
          <span class="act-meta"><span data-since="${since}">${fmtMs(Date.now() - Date.parse(since))}</span><button type="button" class="act-cancel" data-cancel="${activeTask.id}">Cancel</button></span>
        </div>`;
      } else if (lastTask) {
        activityHtml = `<div class="agent-activity">
          <span class="act-text" title="${esc(lastTask.title)}">Last: ${esc(lastTask.title)}</span>
          <span class="act-meta"><span data-ago="${Date.parse(lastTask.finishedAt)}">${ago(Date.parse(lastTask.finishedAt))}</span></span>
        </div>`;
      } else {
        const skills = (a.skills || []).slice(0, 3).join(", ");
        activityHtml = `<div class="agent-activity">
          <span class="act-text">${a.enabled && a.live ? `Standing by for ${esc(skills || "tasks")}` : esc(connText(a))}</span>
        </div>`;
      }

      const opts = Array.from(new Set([a.model, ...(a.modelOptions ?? [])]));
      const modelControl = opts.length > 1
        ? `<select class="inline-select" data-model-for="${a.id}" aria-label="Model for ${esc(a.name)}" title="${esc(a.model)}">${modelOptionsMarkup(a)}</select>`
        : `<div class="model-static" title="${esc(a.model)}">${esc(shortModel(a.model, a))}</div>`;

      const reasoningControl = `<select class="inline-select reasoning" data-reasoning-for="${a.id}" aria-label="Reasoning level for ${esc(a.name)}">
        ${LEVELS.map((lvl) => `<option value="${lvl}" ${a.reasoning === lvl ? "selected" : ""}>${levelLabel(lvl)}</option>`).join("")}
      </select>`;

      return `<article class="agent ${a.enabled ? "" : "paused"} ${isWorking ? "is-working" : ""} ${isAsk ? "is-ask" : ""} ${S.target === a.id ? "is-target" : ""}" style="--c:${a.color}" data-agent-card="${a.id}">
        <div class="agent-top">
          <button type="button" class="avatar ${avatarState}" data-preview-avatar="${a.id}" title="Click to preview ${esc(a.name)}'s working animation" aria-label="Preview ${esc(a.name)}'s working animation">
            <span class="aura" aria-hidden="true"></span>
            <span class="avatar-stage">${renderPortraitContent(a, isWorking)}</span>
            <i class="presence-dot" aria-hidden="true"></i>
          </button>
          <div class="agent-id">
            <div class="agent-name-row">
              <span class="agent-name">${esc(a.name)}</span>
              ${a.isLead ? '<span class="badge lead">Lead</span>' : ""}
              ${a.live ? (a.billing ? `<span class="badge bill ${a.billing}" title="${esc(BILL_HELP[a.billing])}">${BILL[a.billing]}</span>` : "") : `<span class="badge demo">${a.connectorLabel.startsWith("Off") ? "Off" : "Demo"}</span>`}
            </div>
            <div class="agent-tag" title="${esc(a.tagline)}">${esc(a.tagline)}</div>
          </div>
          <span class="status-pill ${statusCls}">${statusLabel}</span>
        </div>

        ${activityHtml}

        <div class="agent-controls">
          <div class="ctrl-box">
            <span class="ctrl-lbl"><span>Model</span>${a.lastServed && a.lastServed !== a.model ? `<span class="mono" title="Last answered by ${esc(a.lastServed)}">→ ${esc(a.lastServed.split("/").pop())}</span>` : ""}</span>
            ${modelControl}
          </div>
          <div class="ctrl-box">
            <span class="ctrl-lbl"><span>Thinking</span>${think(a.reasoning)}</span>
            ${reasoningControl}
          </div>
        </div>

        ${renderUsageStrip(a)}

        <div class="agent-foot">
          <span class="conn ${a.live ? (a.online === false ? "down" : "live") : ""}" title="${esc(connText(a))}"><i></i>${esc(connText(a))}</span>
          <div class="foot-actions">
            <button type="button" class="btn ghost" data-edit="${a.id}" aria-label="Settings for ${esc(a.name)}">Settings</button>
            <button type="button" class="btn agent-go" data-ask="${a.id}">Ask ${esc(a.name)}</button>
          </div>
        </div>
      </article>`;
    })
    .join("");
}

$("#crew").addEventListener("change", (e) => {
  const modelSel = e.target.closest("[data-model-for]");
  if (modelSel) {
    const id = modelSel.dataset.modelFor;
    const a = agentById(id);
    if (a) void quickUpdateAgent(id, modelPatchFor(a, modelSel.value), modelSel);
    return;
  }
  const rSel = e.target.closest("[data-reasoning-for]");
  if (rSel) {
    void quickUpdateAgent(rSel.dataset.reasoningFor, { reasoning: rSel.value }, rSel);
  }
});

$("#crew").addEventListener("click", async (e) => {
  if (e.target.closest("select, option")) return;
  const previewBtn = e.target.closest("[data-preview-avatar]");
  if (previewBtn) {
    const id = previewBtn.dataset.previewAvatar;
    if (S.previewWork.has(id)) S.previewWork.delete(id);
    else {
      S.previewWork.add(id);
      clearTimeout(S.previewTimers?.[id]);
      S.previewTimers ??= {};
      S.previewTimers[id] = setTimeout(() => {
        S.previewWork.delete(id);
        renderCrew();
        renderMap();
        renderCrewStrip();
      }, 4500);
    }
    renderCrew();
    renderMap();
    renderCrewStrip();
    return;
  }
  const cancelBtn = e.target.closest("[data-cancel]");
  if (cancelBtn) {
    await api(`/api/tasks/${cancelBtn.dataset.cancel}/cancel`, { method: "POST" }).catch((err) => toast(err.message));
    toast("Cancelling…");
    return;
  }
  if (e.target.closest("[data-go-approvals]")) {
    setTab("thread");
    $("#approvals").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const askBtn = e.target.closest("[data-ask]");
  if (askBtn) {
    focusAgent(askBtn.dataset.ask, { switchTab: true });
    return;
  }
  const editBtn = e.target.closest("[data-edit]");
  if (editBtn) openEditor(editBtn.dataset.edit);
});

// ------------------------------------------------------------------ board
function tcard(t) {
  const a = agentById(t.agentId);
  const parent = t.parentId ? S.tasks.get(t.parentId) : null;
  const secs = t.startedAt ? (t.finishedAt ? fmtMs(Date.parse(t.finishedAt) - Date.parse(t.startedAt)) : `<span data-since="${t.startedAt}">${fmtMs(Date.now() - Date.parse(t.startedAt))}</span>`) : ago(Date.parse(t.createdAt));
  const tok = t.usage ? ` · ${fmtK(t.usage.input + t.usage.output)} tok` : "";
  const bad = t.status === "failed" || t.status === "blocked" || t.status === "cancelled";
  return `<div class="tcard ${bad ? "err" : ""}${enter("lanes", `${t.id}:${t.status}`)}" style="--c:${a?.color ?? "var(--accent)"}">
    <span class="kind">${t.kind === "direct" ? CHANNEL_LABEL[t.channel] ?? "" : parent ? `team · ${t.step ? `step ${t.step}` : t.kind}` : t.kind}${t.after?.length ? ` · after ${t.after.join(", ")}` : ""}${t.reroutedFrom ? " · rerouted" : ""}${t.awaitingApproval ? ` · <b class="needs-ok">needs your OK</b>` : ""}</span>
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
    ["Working", by(["running"]), "Active asks show here"],
    ["Queued", by(["queued"]), "Waiting tasks queue here"],
    ["Done", recent(by(["done"]), 15), "Finished replies land here"],
    ["Failed / blocked", recent(by(["failed", "blocked", "cancelled"]), 10), "Clean slate"],
  ];
  $("#lanes").innerHTML = lanes
    .map(([name, items, emptyText]) => `<div class="lane"><div class="lane-head">${name}<b>${items.length}</b></div>
      <div class="lane-list">${items.length ? items.map(tcard).join("") : `<div class="empty">${emptyText}</div>`}</div></div>`)
    .join("");
  const done = work.filter((t) => t.status === "done").length;
  $("#boardCount").textContent = `${done} finished · ${work.length} total`;
}

// ------------------------------------------------------------------ ranks
function renderRanks() {
  const rows = S.lb[S.period] ?? [];
  const top = rows.slice(0, 3);
  const max = Math.max(1, ...top.map((r) => r.score));
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
    `<div class="rrow head"><span>#</span><span>Assistant</span><span class="num">Done</span><span class="num">Tokens</span><span class="num">Success</span><span class="num hide-sm">Avg time</span></div>` +
    rows
      .map((r, i) => {
        const a = agentById(r.agentId);
        return `<div class="rrow"><span class="n">${i + 1}</span>
          <span class="a"><span class="dot" style="--c:${a?.color}"></span>${esc(a?.name ?? r.agentId)}<span class="chip">${esc(shortModel(a?.model ?? "", a))}</span></span>
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

// ------------------------------------------------------------------ thread header crew strip
function renderCrewStrip() {
  const el = $("#crewStrip");
  if (!el) return;
  el.innerHTML = S.agents
    .map((a) => {
      const working = a.status === "working" || S.previewWork.has(a.id);
      const cls = working ? "working" : a.status === "idle" && a.live ? "online" : a.status;
      return `<button type="button" class="strip-pip ${cls} ${S.target === a.id ? "on" : ""}" style="--c:${a.color}" data-strip-target="${a.id}" title="${esc(a.name)} · ${STATUS_TEXT[a.status]} · ${esc(shortModel(a.model, a))}" aria-label="Chat with ${esc(a.name)} (${STATUS_TEXT[a.status]})">
        <span class="pip-stage">${renderPortraitContent(a, working)}</span>
        <i aria-hidden="true"></i>
      </button>`;
    })
    .join("");
}

$("#crewStrip").addEventListener("click", (e) => {
  const b = e.target.closest("[data-strip-target]");
  if (b) focusAgent(b.dataset.stripTarget);
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

function modelChip(t, a) {
  const asked = t.model ?? a?.model ?? "";
  const served = t.servedModel;
  if (!served) return `<span class="chip" title="${esc(asked)}">${esc(shortModel(asked, a))}</span>`;
  if (served === asked || served.endsWith(`/${asked}`)) return `<span class="chip" title="Model that answered">${esc(served)}</span>`;
  return `<span class="chip" title="Requested → model that answered">${esc(shortModel(asked, a))} → ${esc(served)}</span>`;
}

function agentBubble(t) {
  const a = agentById(t.agentId);
  const working = t.status === "running" || t.status === "queued";
  const head = `<div class="ahead">
    <span class="mini-av" style="--c:${a?.color ?? "var(--accent)"}">${renderPortraitContent(a ?? { id: t.agentId, name: t.agentId }, working)}</span>
    <span class="nm">${esc(a?.name ?? t.agentId)}</span>
    ${modelChip(t, a)}
    <span class="chip" style="--c:${a?.color}">${think(t.reasoning)}${esc(t.reasoning ?? "")}</span>
  </div>`;
  const reroute = t.reroutedFrom ? `<div class="reroute">↪ Rerouted from ${esc(nameOf(t.reroutedFrom))} (at limit or paused)</div>` : "";
  let body;
  if (t.status === "done") body = `<div class="body">${md(t.result)}</div>`;
  else if (t.awaitingApproval) body = `<div class="needs-ok">Waiting for your OK (see the card above, or Telegram)</div>`;
  else if (t.status === "running" || t.status === "queued") body = thinking(t, t.status === "queued" ? "waiting for a free slot" : `${esc(a?.name ?? "Assistant")} is thinking`);
  else body = `<div class="err-text">${esc(stateLabel(t))}: ${esc(t.error ?? "")}</div>`;
  return `<div class="msg bot"><div class="bubble" style="--c:${a?.color}">${head}${reroute}${body}${footer(t)}</div></div>`;
}

function goalBubble(t) {
  const lead = agentById(t.agentId);
  const kids = [...S.tasks.values()].filter((c) => c.parentId === t.id).sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
  const subtasks = kids.filter((c) => c.kind === "subtask");
  const doneSteps = subtasks.filter((c) => c.status === "done").length;
  const label = (c) => (c.kind === "plan" ? "Plan" : c.kind === "synthesis" ? "Wrap-up" : `${c.step ? `${c.step} · ` : ""}${nameOf(c.agentId)}`);
  const stepState = (c) =>
    c.awaitingApproval ? "needs your OK" : c.status === "queued" && c.after?.length ? `waits for ${c.after.join(", ")}` : stateLabel(c);
  const progressLine = subtasks.length
    ? `<div class="team-progress"><span class="muted small">${doneSteps}/${subtasks.length} steps done</span>${subtasks.some((c) => c.reroutedFrom) ? '<span class="reroute" style="margin:0">↪ auto-failover active</span>' : ""}</div>`
    : "";
  const steps = kids.length
    ? `<div class="steps">${progressLine}${kids
        .map((c) => {
          const ca = agentById(c.agentId);
          const cWorking = c.status === "running";
          const openAttr = c.status === "failed" || c.status === "blocked" ? " open" : "";
          const stepModel = c.model ? `<span class="chip" style="padding:1px 5px;font-size:10px">${esc(shortModel(c.model, ca))}</span>` : "";
          const rerouteTag = c.reroutedFrom ? `<span class="reroute" style="margin:0;font-size:10.5px">↪ from ${esc(nameOf(c.reroutedFrom))}</span>` : "";
          return `<details${openAttr}><summary><span class="mini-av step-av" style="--c:${colorOf(c.agentId)}">${renderPortraitContent(ca ?? { id: c.agentId, name: c.agentId }, cWorking)}</span><span class="sname">${esc(label(c))}</span>
            <span class="stitle">${esc(c.kind === "subtask" ? c.title : nameOf(c.agentId))}</span><span class="sstate ${c.awaitingApproval ? "ask" : c.status}">${esc(stepState(c))}</span></summary>
            <div class="sbody body">${stepModel || rerouteTag ? `<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap">${stepModel}${rerouteTag}</div>` : ""}${c.status === "done" ? (c.kind === "plan" ? `<pre><code>${esc(c.result)}</code></pre>` : md(c.result)) : c.error ? `<span class="err-text">${esc(c.error)}</span>` : "…"}</div></details>`;
        })
        .join("")}</div>`
    : "";
  let body;
  if (t.status === "done") body = `<div class="body">${md(t.result)}</div>`;
  else if (t.status === "running" || t.status === "queued") {
    const activeSub = subtasks.find((c) => c.status === "running");
    const stage = kids.some((c) => c.kind === "synthesis")
      ? `${lead?.name ?? "Lead"} wrapping up`
      : activeSub
        ? `${nameOf(activeSub.agentId)} working (step ${activeSub.step ?? ""})`
        : `${lead?.name ?? "Lead"} planning`;
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
  ["@team", "research what people say about AI agent dashboards, write 3 taglines from it, then review them"],
  ["@grok", "what's trending on X about AI agents?"],
  ["@muse", "write one sharp tagline for Relay"],
  ["@cline", "write a regex for a US ZIP code"],
  ["@hermes", "reply with one word: ready"],
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
      <p>Message one assistant, swap their model on the fly, or hand the team a goal and watch them work together.</p>
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
      return userBubble(t.display ?? t.prompt, meta, cls) + reply;
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

// ------------------------------------------------------------------ composer + active bar
function renderTargets() {
  if (S.target !== "auto" && S.target !== "team" && !agentById(S.target)) S.target = "auto";
  const chips = [
    { id: "auto", name: "Auto", cls: "", color: "var(--muted)" },
    { id: "team", name: "Team", cls: "team", color: "var(--accent)" },
    ...S.agents.map((a) => ({ id: a.id, name: a.name, cls: a.status === "working" ? "busy" : "", color: a.color, off: !a.enabled })),
  ];
  $("#targets").innerHTML = chips
    .map((c) => `<button type="button" class="target ${c.cls} ${S.target === c.id ? "on" : ""}" data-target="${c.id}" style="--c:${c.color}${c.off ? ";opacity:.5" : ""}"><span class="dot"></span>${esc(c.name)}</button>`)
    .join("");
  const ph = S.target === "auto" ? "Ask anyone. Relay picks the best assistant…" : S.target === "team" ? "Give the crew a goal…" : `Message ${nameOf(S.target)}…`;
  $("#input").placeholder = ph;
}

function renderActiveBar() {
  const bar = $("#activeBar");
  if (!bar) return;
  const activeEl = document.activeElement;
  if (activeEl && activeEl.matches("#activeBar select")) return;

  if (S.target === "auto") {
    const ready = S.agents.filter((a) => a.live && a.enabled && a.status !== "offline").length;
    bar.innerHTML = `<div class="active-bar-who"><span class="dot" style="--c:var(--ok)"></span><b>Auto-route</b><span>Picks the best of ${ready} ready</span></div>
      <span class="muted small">Select one to switch models</span>`;
    return;
  }
  if (S.target === "team") {
    const lead = agentById(S.lead);
    bar.innerHTML = `<div class="active-bar-who"><span class="dot" style="--c:var(--accent)"></span><b>Team mode</b><span>${esc(lead?.name ?? "Lead")} splits &amp; wraps up the work</span></div>`;
    return;
  }
  const a = agentById(S.target);
  if (!a) return;
  const opts = Array.from(new Set([a.model, ...(a.modelOptions ?? [])]));
  const modelSel = opts.length > 1
    ? `<select class="inline-select" data-model-for="${a.id}" style="--c:${a.color}" aria-label="Model for ${esc(a.name)}">${modelOptionsMarkup(a)}</select>`
    : `<span class="chip">${esc(shortModel(a.model, a))}</span>`;
  const rSel = `<select class="inline-select reasoning" data-reasoning-for="${a.id}" style="--c:${a.color}" aria-label="Reasoning for ${esc(a.name)}">${LEVELS.map((l) => `<option value="${l}" ${a.reasoning === l ? "selected" : ""}>${levelLabel(l)}</option>`).join("")}</select>`;
  bar.innerHTML = `<div class="active-bar-who">
      <span class="dot" style="--c:${a.color}"></span>
      <b>${esc(a.name)}</b>
      <span>${STATUS_TEXT[a.status]}</span>
    </div>
    <div class="active-bar-controls">${modelSel}${rSel}</div>`;
}

$("#activeBar").addEventListener("change", (e) => {
  const modelSel = e.target.closest("[data-model-for]");
  if (modelSel) {
    const id = modelSel.dataset.modelFor;
    const a = agentById(id);
    if (a) void quickUpdateAgent(id, modelPatchFor(a, modelSel.value), modelSel);
    return;
  }
  const rSel = e.target.closest("[data-reasoning-for]");
  if (rSel) {
    void quickUpdateAgent(rSel.dataset.reasoningFor, { reasoning: rSel.value }, rSel);
  }
});

$("#targets").addEventListener("click", (e) => {
  const b = e.target.closest("[data-target]");
  if (!b) return;
  focusAgent(b.dataset.target);
});

const COMMANDS = [
  ["/doctor", "check every connection & safety lock"],
  ["/agents", "models, reasoning, usage"],
  ["/status", "what's running now"],
  ["/board", "who did the most work"],
  ["/team ", "give the crew a goal"],
  ["/model ", "<agent> <model-id>"],
  ["/reasoning ", "<agent> auto|off|low|medium|high|max"],
  ["/lead ", "<agent> plans team goals"],
  ["/inbox", "recent email (read-only)"],
  ["/inbox summary", "what needs your attention"],
  ["/approvals", "what's waiting for your OK"],
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

function quotaBoxLine(pq) {
  if (!pq) return "";
  if (!pq.live) return pq.note ? `<br><span class="small">${esc(pq.note)}</span>` : "";
  const parts = [];
  if (typeof pq.creditsRemainingUsd === "number") parts.push(`<b>${fmtUsd(pq.creditsRemainingUsd)}</b> credits left`);
  if (typeof pq.periodSpendUsd === "number" && pq.periodSpendUsd > 0) parts.push(`${fmtUsd(pq.periodSpendUsd)} spent`);
  if (pq.windows?.length) parts.push(pq.windows.map((w) => `${esc(w.label)} <b>${Math.round(w.usedPercent)}%</b>`).join(" · "));
  return parts.length ? `<br><span class="small">Live ${esc(pq.provider)}: ${parts.join(" · ")}</span>` : "";
}

// ------------------------------------------------------------------ editor drawer
function openEditor(id) {
  const a = agentById(id);
  if (!a) return;
  S.editing = id;
  const d = $("#drawer");
  d.style.setProperty("--c", a.color);
  const opts = Array.from(new Set([a.model, ...(a.modelOptions ?? [])]));
  d.innerHTML = `
    <div class="drawer-head">
      <div class="avatar lg ${a.status === "working" ? "working" : a.live ? "online" : ""}" id="drawerAvatar" style="--c:${a.color}">
        <span class="aura" aria-hidden="true"></span>
        <span class="avatar-stage">${renderPortraitContent(a, a.status === "working")}</span>
      </div>
      <div>
        <h3>${esc(a.name)}</h3>
        <div class="muted small">${esc(a.tagline)}</div>
        <div class="preview-row">
          <div class="preview-toggle" id="avatarPreviewToggle" role="group" aria-label="Preview avatar state">
            <button type="button" data-av-mode="idle" class="${a.status === "working" ? "" : "on"}">Ready</button>
            <button type="button" data-av-mode="working" class="${a.status === "working" ? "on" : ""}">Working</button>
          </div>
        </div>
      </div>
      <button class="icon-btn x" data-close aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </div>
    <form class="drawer-body" id="editForm">
      <div class="conn-box">${a.live ? (a.online === false ? `<span class="err-text">●</span> <b>${esc(a.connectorLabel)}</b> is ${esc(a.healthDetail || "offline")}. Start it, and Relay picks it up within 30s.` : `● Connected via <b>${esc(a.connectorLabel)}</b>${a.lastServed ? ` · last answer from <b>${esc(a.lastServed)}</b>` : ""}${a.billing ? `<br><span class="small">${esc(BILL_HELP[a.billing])}</span>` : ""}${quotaBoxLine(a.providerQuota)}`) : (a.connectorLabel.startsWith("Off") ? `◌ <b>Off.</b> ${esc(a.connectorLabel.replace(/^Off · /, ""))}. Relay won't use paid APIs unless you set <code>RELAY_ALLOW_METERED=true</code>.` : `◌ <b>Demo mode.</b> ${esc(a.connectorLabel.replace(/^Demo · /, "To go live: "))}, then restart the hub. Demo agents never join real team work.`)}</div>
      <div class="field">
        <label for="fModelPick">Quick pick model</label>
        <select class="inline-select" id="fModelPick">${modelOptionsMarkup(a)}</select>
        <label for="fModel" style="margin-top:6px">Model ID</label>
        <input class="input mono" id="fModel" list="modelList" value="${esc(a.model)}" spellcheck="false" />
        <datalist id="modelList">${opts.map((m) => `<option value="${esc(m)}"></option>`).join("")}</datalist>
        <span class="help">${a.supportsProvider ? `With a provider below, this is the model ${esc(a.name)} runs. Without one, ${esc(a.name)} uses its own default model.` : "Pick from the dropdown above or enter any allowed model ID."}</span>
      </div>
      ${a.supportsProvider ? `<div class="field">
        <label for="fProv">Provider</label>
        <input class="input mono" id="fProv" value="${esc(a.provider)}" placeholder="${esc(a.discoveredProvider ? `blank = default (${a.discoveredProvider})` : "blank = Hermes default")}" spellcheck="false" />
        <span class="help">Provider slug configured inside Hermes (active: ${esc(a.discoveredProvider || "default")}).</span>
      </div>` : ""}
      <div class="field">
        <span class="lbl">Thinking / reasoning</span>
        <div class="levels" id="fLevels">${LEVELS.map((l) => `<button type="button" data-level="${l}" class="${a.reasoning === l ? "on" : ""}">${think(l)}${l}</button>`).join("")}</div>
        <span class="help">${a.sendsReasoning ? "Sent with every request to this assistant." : "Shown as a label. This connection doesn't send a reasoning parameter."}</span>
      </div>
      <div class="field">
        <span class="lbl">Usage limits <span class="help">(0 = no limit)</span></span>
        <div class="grid3">
          <div class="field"><label for="fReq">Requests/day</label><input class="input mono" id="fReq" type="number" min="0" step="1" value="${a.limits.dailyRequests}"/></div>
          <div class="field"><label for="fTok">Tokens/day</label><input class="input mono" id="fTok" type="number" min="0" step="1000" value="${a.limits.dailyTokens}"/></div>
          <div class="field"><label for="fBud">Budget $/mo</label><input class="input mono" id="fBud" type="number" min="0" step="1" value="${a.limits.monthlyBudgetUsd}"/></div>
        </div>
        <span class="help">When an assistant hits a limit, auto-routed and team work moves to a teammate. Direct asks stop and tell you.</span>
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
      <label class="switch"><span><b>Active</b><br><span class="muted small">Paused assistants get no new work.</span></span><input type="checkbox" id="fOn" ${a.enabled ? "checked" : ""}/></label>
    </form>
    <div class="drawer-foot">
      <button class="btn ghost" id="makeLead" ${a.isLead ? "disabled" : ""}>${a.isLead ? "★ Team lead" : "Make team lead"}</button>
      <div style="display:flex;gap:8px"><button class="btn" data-close>Cancel</button><button class="btn primary" id="saveAgent">Save</button></div>
    </div>`;
  $("#scrim").hidden = false;
  d.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => d.classList.add("open"));
  setTimeout(() => $("#fModelPick")?.focus(), 220);
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
$("#drawer").addEventListener("change", (e) => {
  const pick = e.target.closest("#fModelPick");
  if (!pick) return;
  const a = agentById(S.editing);
  const fModel = $("#fModel");
  if (fModel) fModel.value = pick.value;
  const fProv = $("#fProv");
  if (fProv && a?.discoveredProvider) {
    fProv.value = pick.value === "hermes-agent" ? "" : a.discoveredProvider;
  }
});
$("#drawer").addEventListener("click", async (e) => {
  if (e.target.closest("[data-close]")) return closeEditor();
  const avMode = e.target.closest("[data-av-mode]");
  if (avMode) {
    const a = agentById(S.editing);
    if (!a) return;
    const working = avMode.dataset.avMode === "working";
    $$("#avatarPreviewToggle button").forEach((b) => b.classList.toggle("on", b === avMode));
    const av = $("#drawerAvatar");
    if (av) {
      av.classList.toggle("working", working);
      av.classList.toggle("online", !working && a.live);
      const stage = av.querySelector(".avatar-stage");
      if (stage) stage.innerHTML = renderPortraitContent(a, working);
    }
    return;
  }
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
      ...($("#fProv") ? { provider: $("#fProv").value.trim() } : {}),
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
      toast(`Saved. ${a.name} runs ${shortModel(a.model, a)} · ${a.reasoning}`);
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

// ------------------------------------------------------------------ approvals
function pendingApprovals() {
  return S.approvals.filter((a) => a.status === "pending");
}

function untilText(iso) {
  const s = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
  return s >= 60 ? `${Math.ceil(s / 60)}m` : `${s}s`;
}

function renderApprovals() {
  const open = pendingApprovals();
  const el = $("#approvals");
  const drafts = Object.fromEntries($$("#approvals [data-answer-for]").map((i) => [i.dataset.answerFor, i.value]));
  el.innerHTML = open
    .map((a) => a.kind === "question" ? `<form class="ask-card" style="--c:${colorOf(a.agentId)}" data-question="${a.id}">
      <div class="ask-head"><span class="dot"></span><b>${esc(a.agentName)} has a question</b></div>
      <div class="ask-detail">${esc(a.detail)}</div>
      <input class="input" data-answer-for="${a.id}" placeholder="Your answer" value="${esc(drafts[a.id] ?? "")}" autocomplete="off" />
      <div class="ask-foot">
        <span class="muted small">No answer in <span data-until="${a.expiresAt}">${untilText(a.expiresAt)}</span> stops the task</span>
        <span class="ask-btns"><button type="button" class="btn" data-decide="${a.id}" data-approve="0">Skip</button><button type="submit" class="btn primary">Send</button></span>
      </div>
    </form>` : `<div class="ask-card" style="--c:${colorOf(a.agentId)}">
      <div class="ask-head"><span class="dot"></span><b>${esc(a.title)}</b></div>
      <div class="ask-detail">${esc(a.detail)}</div>
      <div class="ask-foot">
        <span class="muted small">${a.source === "agent" ? "Asked mid-task" : "Relay checks before risky tasks"} · auto-deny in <span data-until="${a.expiresAt}">${untilText(a.expiresAt)}</span></span>
        <span class="ask-btns"><button class="btn" data-decide="${a.id}" data-approve="0">Deny</button><button class="btn primary" data-decide="${a.id}" data-approve="1">Approve</button></span>
      </div>
    </div>`)
    .join("");
  const tab = $('#tabbar [data-go="thread"]');
  if (tab) tab.dataset.badge = open.length ? String(open.length) : "";
}

$("#approvals").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-decide]");
  if (!b) return;
  b.disabled = true;
  try {
    const a = await api(`/api/approvals/${b.dataset.decide}`, { method: "POST", body: JSON.stringify({ approve: b.dataset.approve === "1" }) });
    toast(a.status === "approved" ? "Approved" : a.status === "denied" ? "Denied" : `Already ${a.status}`);
  } catch (err) {
    b.disabled = false;
    toast(err.message);
  }
});

$("#approvals").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target.closest("[data-question]");
  if (!form) return;
  const input = form.querySelector("[data-answer-for]");
  const answer = input.value.trim();
  if (!answer) return input.focus();
  try {
    const a = await api(`/api/approvals/${form.dataset.question}`, { method: "POST", body: JSON.stringify({ answer }) });
    toast(a.status === "approved" ? `Sent to ${a.agentName}` : `Already ${a.status}`);
  } catch (err) {
    toast(err.message);
  }
});

$("#kpis").addEventListener("click", (e) => {
  if (!e.target.closest("[data-go-approvals]")) return;
  setTab("thread");
  $("#approvals").scrollIntoView({ behavior: "smooth", block: "start" });
  if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission().catch(() => {});
});

setInterval(() => {
  $$("[data-until]").forEach((el) => (el.textContent = untilText(el.dataset.until)));
}, 1000);

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
