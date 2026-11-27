// Relay studio dashboard. Zero framework: clean state, action-first views, one resilient SSE stream.
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const safeColor = (c) => (typeof c === "string" && /^(#[0-9a-f]{3,8}|var\(--[\w-]+\))$/i.test(c.trim()) ? c.trim() : "var(--accent)");
const safeJson = (raw) => { try { return JSON.parse(raw); } catch { return null; } };

const LEVELS = ["auto", "off", "low", "medium", "high", "max"];
const DEPTH_LABEL = { auto: "Auto", off: "Off", low: "Light", medium: "Balanced", high: "Deep", max: "Max" };

const DEFAULT_PERSONA = {
  hermes: {
    role: "Chief Operator",
    vibe: "Calm, decisive coach. Leads with the next move and skips the lecture.",
    traits: ["Decisive", "Systems-first", "Calm coach"],
    motto: "Answer first, clear next move.",
    thinking: "Mapping the move",
    placeholder: "Ask Hermes to plan, build, or automate…",
    quick: { label: "Plan a task", prompt: "Turn this into a crisp, step-by-step action plan: " },
    quips: [
      "Ready when you are. Give me the target and I'll map the clean path.",
      "Systems over effort. What are we automating next?",
      "Crew's standing by—drop a goal and I'll split the work.",
    ],
    traitPrompts: {
      Decisive: "Give me your one clear recommendation and next move on: ",
      "Systems-first": "Turn this into a repeatable checklist or lightweight system: ",
      "Calm coach": "Help me untangle this and pick the top 2 priorities right now: ",
    },
  },
  grok: {
    role: "Live Scout",
    vibe: "Sharp, plugged-in reporter. Brings receipts and cuts straight through hype.",
    traits: ["Real-time X", "Receipts", "Dry wit"],
    motto: "Signal over noise—always with receipts.",
    thinking: "Scanning the wire",
    placeholder: "Ask Grok what's moving on X or in the news…",
    quick: { label: "What's trending", prompt: "What's actually moving on X and in AI news today? Top 3 takeaways with sources.", run: true },
    quips: [
      "Wire's humming. Want the real signal on X right now?",
      "Skip the hype thread—I'll bring the actual receipts.",
      "Name the topic and I'll check who's actually shipping today.",
    ],
    traitPrompts: {
      "Real-time X": "What are people actually saying on X right now about: ",
      Receipts: "Fact-check this with concrete sources and links: ",
      "Dry wit": "Give me the blunt, no-hype hot take on: ",
    },
  },
  muse: {
    role: "Creative Director",
    vibe: "Bold creative spark. Thinks in hooks, rhythm, and ready-to-use copy.",
    traits: ["Bold hooks", "Story craft", "Zero fluff"],
    motto: "Hooks that stop the scroll on frame one.",
    thinking: "Sketching angles",
    placeholder: "Ask Muse for hooks, scripts, names, or copy…",
    quick: { label: "Pitch 3 hooks", prompt: "Give me 3 sharp, distinct hooks for: " },
    quips: [
      "Got a rough idea? I'll turn it into three scroll-stopping hooks.",
      "Frame one decides everything—what are we pitching today?",
      "Drop the topic and I'll bring copy with real rhythm.",
    ],
    traitPrompts: {
      "Bold hooks": "Pitch 3 bold, scroll-stopping opening hooks for: ",
      "Story craft": "Outline a tight 45-second story arc for: ",
      "Zero fluff": "Tighten this copy so every word earns its spot: ",
    },
  },
  cline: {
    role: "Pragmatic Builder",
    vibe: "No-nonsense senior engineer. Ships clean working code without the lecture.",
    traits: ["Clean code", "Fast fixes", "Direct"],
    motto: "Working code first, lecture never.",
    thinking: "Writing clean code",
    placeholder: "Ask Cline to write, debug, or clean up code…",
    quick: { label: "Write a fix", prompt: "Write clean, working code to: " },
    quips: [
      "Show me the bug or spec—I'll ship the cleanest fix.",
      "Less talk, tighter diffs. What are we building?",
      "Paste the stack trace and let's squash it.",
    ],
    traitPrompts: {
      "Clean code": "Write clean, production-ready code for: ",
      "Fast fixes": "Find the root cause and fix this bug cleanly: ",
      Direct: "Give me the shortest working script or command to: ",
    },
  },
  zen: {
    role: "Calm Critic",
    vibe: "Quietly ruthless reviewer. Spots hidden flaws and simplifies hard tradeoffs.",
    traits: ["Tradeoffs", "Blind spots", "Composed"],
    motto: "Find the flaw before it costs you.",
    thinking: "Weighing tradeoffs",
    placeholder: "Ask Zen to review, compare, or pressure-test an idea…",
    quick: { label: "Pressure-test", prompt: "Review this and tell me the biggest flaw and cleanest fix: " },
    quips: [
      "Bring me your plan—I'll find the hidden weak link before launch.",
      "Every choice has a tradeoff. Let's put them side by side.",
      "Ready to pressure-test whenever you want an honest audit.",
    ],
    traitPrompts: {
      Tradeoffs: "Compare these options cleanly and rank the tradeoffs: ",
      "Blind spots": "Audit this and name the top 3 blind spots I'm missing: ",
      Composed: "Simplify this design down to the cleanest, lowest-risk move: ",
    },
  },
  chatgpt: {
    role: "Executive Advisor",
    vibe: "Steady second opinion. Zooms out for high-stakes calls and blind spots.",
    traits: ["Big picture", "Candid", "Steady"],
    motto: "Zoom out before you commit.",
    thinking: "Thinking it through",
    placeholder: "Ask ChatGPT for a candid second opinion…",
    quick: { label: "Second opinion", prompt: "Give me a candid second opinion and the biggest blind spot on: " },
    quips: [
      "High-stakes call? Let's zoom out before you commit.",
      "I'll give you the candid second opinion—no sugarcoating.",
      "Save me for the big decisions; I'm ready when you need perspective.",
    ],
    traitPrompts: {
      "Big picture": "Zoom out and give me the strategic big picture on: ",
      Candid: "Give me a candid, no-fluff second opinion on: ",
      Steady: "Walk me through the risk vs. upside before I decide on: ",
    },
  },
};

const MOTION_SEED = [
  { phase: "0s", dur: "5.4s" },
  { phase: "-1.3s", dur: "6.1s" },
  { phase: "-2.7s", dur: "5.7s" },
  { phase: "-0.8s", dur: "6.4s" },
  { phase: "-3.4s", dur: "5.5s" },
  { phase: "-2.0s", dur: "6.0s" },
];

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
  view: store.get("relay-view") || "studio",
  target: store.get("relay-target") || "auto",
  notes: [],
  handoffs: [],
  approvals: [],
  pos: {},
  token: store.get("relay-token") || "",
  editing: null,
  previewWork: new Set(),
  previewTimers: {},
  openHandoffs: new Set(),
  openSteps: new Set(),
  expandedMsgs: new Set(),
  detailMsgs: new Set(),
  connected: true,
  soundOn: store.get("relay-sound") === "1",
  focusMode: store.get("relay-focus") === "1",
  mapMode: "explore",
  chain: [],
  selectedMissionId: null,
  activityAgent: "all",
  activityQuery: "",
  statMetric: "done",
  selectedStatAgent: null,
  openHandoffMsg: null,
  activeQuips: {},
  quipIdx: {},
};

// ------------------------------------------------------------------ subtle synth soundscape
const SFX = (() => {
  let ctx = null;
  const ensure = () => {
    if (!S.soundOn || typeof AudioContext === "undefined") return null;
    try {
      ctx ??= new AudioContext();
      if (ctx.state === "suspended") void ctx.resume();
      return ctx;
    } catch {
      return null;
    }
  };
  const tone = (c, freq, start, dur, gain, type = "sine") => {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(gain, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g).connect(c.destination);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  };
  return {
    play(kind) {
      const c = ensure();
      if (!c) return;
      const t = c.currentTime;
      if (kind === "dispatch") {
        tone(c, 340, t, 0.06, 0.032, "triangle");
        tone(c, 460, t + 0.03, 0.065, 0.028, "sine");
      } else if (kind === "baton") {
        tone(c, 523.25, t, 0.08, 0.038, "sine");
        tone(c, 659.25, t + 0.055, 0.11, 0.04, "sine");
      } else if (kind === "done") {
        tone(c, 523.25, t, 0.18, 0.035, "sine");
        tone(c, 659.25, t + 0.05, 0.2, 0.035, "sine");
        tone(c, 783.99, t + 0.1, 0.26, 0.038, "sine");
      } else if (kind === "ask") {
        tone(c, 698.46, t, 0.12, 0.05, "triangle");
        tone(c, 880, t + 0.14, 0.18, 0.055, "triangle");
      }
    },
  };
})();

function pingChannel(name) {
  const el = $(`#channels [data-chan="${name}"]`);
  if (!el) return;
  el.classList.remove("ping");
  void el.offsetWidth;
  el.classList.add("ping");
  setTimeout(() => el.classList.remove("ping"), 1800);
}

// ------------------------------------------------------------------ personas & avatars
function personaOf(a) {
  const def = DEFAULT_PERSONA[a?.id] || {};
  return {
    role: a?.role || def.role || "Assistant",
    vibe: a?.personality || def.vibe || a?.tagline || "",
    traits: (Array.isArray(a?.traits) && a.traits.length ? a.traits : def.traits) || [],
    motto: a?.motto || def.motto || a?.personality || def.vibe || "",
    thinking: a?.thinkingLabel || def.thinking || "Working on it",
    placeholder: def.placeholder || `Message ${a?.name || "assistant"}…`,
    quick: a?.quickAction || def.quick || null,
    quips: def.quips || [`${a?.name || "Assistant"} is ready when you are.`],
    traitPrompts: def.traitPrompts || {},
  };
}

function brandBadgeMarkup(a, size = "") {
  const url = a?.brandLogo;
  if (!url) return "";
  return `<span class="brand-badge ${size}" title="${esc(a.name)} official logo"><img src="${esc(url)}" alt="${esc(a.name)} logo" loading="lazy"/></span>`;
}

function fallbackAvatarSvg(name = "?", color = "var(--accent)", working = false) {
  const col = safeColor(color);
  return `<svg class="portrait ${working ? "is-working" : "is-idle"}" viewBox="0 0 80 80" aria-hidden="true">
    <rect width="80" height="80" fill="#14141a"/>
    <circle cx="40" cy="40" r="24" fill="${col}" fill-opacity="0.16" stroke="${col}" stroke-width="1.8"/>
    <text x="40" y="42" text-anchor="middle" dominant-baseline="central" fill="${col}" style="font:800 28px var(--font-display)">${esc(name[0] || "?")}</text>
  </svg>`;
}

/** single=true ensures compact thumbnails never stack dual idle/working <img> elements. */
function renderPortraitContent(agent, working = false, single = false) {
  const idleUrl = agent?.avatarIdle;
  const workUrl = agent?.avatarWorking;
  if (!single && idleUrl && workUrl && workUrl !== idleUrl) {
    return `<img class="portrait-img portrait-idle" src="${esc(idleUrl)}" alt="" loading="lazy"/>
      <img class="portrait-img portrait-work" src="${esc(workUrl)}" alt="" loading="lazy"/>`;
  }
  const chosen = working && workUrl ? workUrl : idleUrl;
  if (chosen) {
    return `<img class="portrait-img official-avatar" src="${esc(chosen)}" alt="" loading="lazy"/>`;
  }
  return fallbackAvatarSvg(agent?.name, agent?.color, working);
}

function mapPortraitMarkup(a, working) {
  const url = working ? (a.avatarWorking || a.avatarIdle) : a.avatarIdle;
  if (url) {
    return `<circle r="24" fill="#0b0d12"/><image href="${esc(url)}" x="-24" y="-24" width="48" height="48" preserveAspectRatio="xMidYMid slice" clip-path="url(#mapAvatarClip)"/>`;
  }
  return `<g clip-path="url(#mapAvatarClip)"><svg x="-24" y="-24" width="48" height="48" viewBox="0 0 80 80">${fallbackAvatarSvg(a.name, a.color, working).replace(/^<svg[^>]*>|<\/svg>$/g, "")}</svg></g>`;
}

// ------------------------------------------------------------------ helpers
const agentById = (id) => S.agents.find((a) => a.id === id);
const nameOf = (id) => (id === "you" ? "You" : agentById(id)?.name ?? id);
const colorOf = (id) => (id === "you" ? "var(--text)" : safeColor(agentById(id)?.color));
const fmtK = (n = 0) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
const fmtUsd = (n = 0) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
const fmtMs = (rawMs) => {
  const ms = Math.max(0, Number(rawMs) || 0);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
};
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 5 ? "now" : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const think = (level) => {
  if (level === "auto") return `<span class="think auto" aria-hidden="true"><s></s><s></s><s></s><s></s></span>`;
  const n = Math.max(0, ["off", "low", "medium", "high", "max"].indexOf(level));
  return `<span class="think" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<s class="${i <= n ? "on" : ""}"></s>`).join("")}</span>`;
};
const levelLabel = (lvl) => DEPTH_LABEL[lvl] ?? lvl;

function shortModel(id, a) {
  if (!id) return "";
  if (id === "auto") return "Auto";
  if (id === "hermes-agent") {
    const def = a?.discoveredDefaultModel;
    return def ? `Default (${def.split("/").pop()})` : "Default";
  }
  return id.replace(/^cline-pass\//, "");
}

function modelOptionsMarkup(a) {
  const opts = Array.from(new Set([a.model, ...(a.modelOptions ?? [])]));
  if (a.discoveredProvider && opts.includes("hermes-agent")) {
    const rest = opts.filter((m) => m !== "hermes-agent");
    const defLabel = a.discoveredDefaultModel
      ? `Default (${a.discoveredDefaultModel.split("/").pop()})`
      : "Default";
    const provLabel = `${a.discoveredProviderName || a.discoveredProvider}`;
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

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 2500);
}

async function copyText(str, okMsg = "Copied") {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(str);
      toast(okMsg);
      return;
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = str;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    toast(ok ? okMsg : "Copy failed");
  } catch {
    toast("Copy failed");
  }
}

// Safe markdown: extracts code spans first, handles [label](https://...), strips trailing punctuation, CRLF-safe.
function inline(s) {
  const codes = [];
  let text = String(s ?? "").replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = codes.push(`<code>${esc(code)}</code>`) - 1;
    return `\u0000CODE${idx}\u0000`;
  });
  text = esc(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[\s(])(https?:\/\/[^\s<)"]+)/g, (full, pre, rawUrl) => {
      const m = /^(.*?)([.,!?;:]+)$/.exec(rawUrl);
      const url = m ? m[1] : rawUrl;
      const trail = m ? m[2] : "";
      return `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
    });
  return text.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codes[Number(idx)] ?? "");
}

function md(src = "") {
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let list = null;
  let para = [];
  let inCode = false;
  let codeLines = [];
  const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join("")}</${list.tag}>`); list = null; };
  const flushCode = () => {
    out.push(`<div class="code-block"><button type="button" class="code-copy" data-copy-code>Copy</button><pre><code>${esc(codeLines.join("\n"))}</code></pre></div>`);
    codeLines = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (inCode) { flushCode(); inCode = false; }
      else { flushPara(); flushList(); inCode = true; codeLines = []; }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    const bq = /^>\s?(.*)$/.exec(line);
    if (/^\s*---+\s*$/.test(line)) {
      flushPara(); flushList(); out.push("<hr>");
    } else if (ul || ol) {
      flushPara();
      const tag = ul ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((ul || ol)[1]);
    } else if (h) {
      flushPara(); flushList(); out.push(`<h4>${inline(h[1])}</h4>`);
    } else if (bq) {
      flushPara(); flushList(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`);
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList(); para.push(line);
    }
  }
  if (inCode) flushCode();
  flushPara(); flushList();
  return out.join("");
}

function isLongReply(text = "") {
  const s = String(text);
  return s.length > 680 || s.split("\n").length > 9;
}

// ------------------------------------------------------------------ focus trapping for dialogs
function trapFocus(container, e) {
  if (e.key !== "Tab") return;
  const focusables = $$('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])', container)
    .filter((el) => el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

// ------------------------------------------------------------------ api
async function api(path, opts = {}) {
  const headers = { "content-type": "application/json" };
  if (S.token) headers.authorization = `Bearer ${S.token}`;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    showLock(opts._unlockAttempt ? "Invalid token. Check HUB_TOKEN in your .env file." : "");
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
    if (patch.model) toast(`${updated.name} → ${shortModel(updated.model, updated)}`);
    else if (patch.reasoning) toast(`${updated.name} depth → ${levelLabel(updated.reasoning)}`);
    else if (patch.enabled !== undefined) toast(`${updated.name} ${updated.enabled ? "active" : "paused"}`);
    requestAnimationFrame(() => {
      $$(`[data-model-for="${id}"], [data-reasoning-for="${id}"]`).forEach((el) => {
        el.classList.add("saved");
        setTimeout(() => el.classList.remove("saved"), 850);
      });
    });
  } catch (err) {
    if (selectEl) selectEl.value = patch.model !== undefined ? a.model : a.reasoning;
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

function focusAgent(id, { switchTab = false, prompt = "", run = false } = {}) {
  S.target = id;
  store.set("relay-target", id);
  renderTargets();
  renderCrewStrip();
  renderActiveBar();
  renderCrew();
  renderMap();
  if (switchTab && matchMedia("(max-width: 960px)").matches) setTab("thread");
  const inp = $("#input");
  if (prompt && inp) {
    inp.value = prompt;
    autosize();
    if (run) { $("#composer").requestSubmit(); return; }
  }
  inp?.focus();
  if (prompt && inp) inp.setSelectionRange(inp.value.length, inp.value.length);
}

function setView(view, { keepFocus = false, syncMobile = true } = {}) {
  const valid = ["studio", "map", "activity", "stats"];
  S.view = valid.includes(view) ? view : "studio";
  store.set("relay-view", S.view);
  document.body.dataset.view = S.view;
  if (!keepFocus && S.focusMode) applyFocus(false, { persist: true });
  $$("#viewNav button").forEach((b) => b.classList.toggle("on", b.dataset.view === S.view));
  if (syncMobile && matchMedia("(max-width: 960px)").matches) {
    document.body.dataset.tab = S.view;
    $$("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.go === S.view));
  }
}

$("#viewNav")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-view]");
  if (b) setView(b.dataset.view);
});
$("#brandLink")?.addEventListener("click", (e) => {
  e.preventDefault();
  setView("studio");
});

function showLock(errMsg = "") {
  source?.close();
  source = null;
  if (cmdk.open) closeCmdk();
  if (S.editing) closeEditor();
  $("#lock").hidden = false;
  const errEl = $("#lockErr");
  if (errEl) {
    errEl.textContent = errMsg;
    errEl.hidden = !errMsg;
  }
  setTimeout(() => $("#lockInput")?.focus(), 50);
}

$("#lockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  S.token = $("#lockInput").value.trim();
  store.set("relay-token", S.token);
  const errEl = $("#lockErr");
  if (errEl) errEl.hidden = true;
  try {
    applySnapshot(await api("/api/state", { _unlockAttempt: true }));
    $("#lock").hidden = true;
    connect();
  } catch (err) {
    if (err.message !== "locked" && errEl) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  }
});

// ------------------------------------------------------------------ live state & resilient SSE
function applySnapshot(snap) {
  S.connected = true;
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
let reconnectTimer = null;

function connect() {
  source?.close();
  clearTimeout(reconnectTimer);
  const qs = S.token ? `?token=${encodeURIComponent(S.token)}` : "";
  source = new EventSource(`/api/events${qs}`);
  let first = true;

  source.addEventListener("hello", (e) => {
    const data = safeJson(e.data) || {};
    if (data.uiVersion) {
      if (uiVersion && uiVersion !== data.uiVersion) return location.reload();
      uiVersion = data.uiVersion;
    }
    if (!S.connected) { S.connected = true; renderKpis(); }
    if (!first) api("/api/state").then(applySnapshot).catch(() => {});
    first = false;
  });

  source.onerror = () => {
    if (S.connected) { S.connected = false; renderKpis(); }
    // Probe /api/state to distinguish 401 token lock from transient disconnect.
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
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
    if (booted) {
      if (!prev && (t.channel === "telegram" || t.channel === "imessage")) {
        pingChannel(t.channel);
        SFX.play("dispatch");
      } else if (prev && prev.status !== "done" && t.status === "done" && (t.kind === "direct" || t.kind === "goal")) {
        SFX.play("done");
      }
    }
    dirty.add("tasks");
    flush();
  });

  source.addEventListener("agents", (e) => {
    const d = safeJson(e.data);
    if (!d?.agents) return;
    S.agents = d.agents;
    S.lb = d.leaderboard;
    S.kpis = d.kpis;
    S.lead = d.lead;
    dirty.add("agents");
    flush();
  });

  source.addEventListener("channels", (e) => {
    const c = safeJson(e.data);
    if (!Array.isArray(c)) return;
    S.channels = c;
    dirty.add("channels");
    flush();
  });

  source.addEventListener("approval", (e) => {
    const a = safeJson(e.data);
    if (!a?.id) return;
    const i = S.approvals.findIndex((x) => x.id === a.id);
    const isNew = i < 0;
    if (i >= 0) S.approvals[i] = a;
    else S.approvals.push(a);
    if (isNew && a.status === "pending" && booted) SFX.play("ask");
    if (a.status === "pending" && typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
      try { new Notification("Relay needs your OK", { body: a.title }); } catch {}
    }
    dirty.add("approvals");
    flush();
  });

  source.addEventListener("baton", (e) => {
    const b = safeJson(e.data);
    if (!b || b.from === b.to) return;
    S.handoffs.unshift({ ...b, at: Date.now() });
    S.handoffs.length = Math.min(S.handoffs.length, 30);
    animateBaton(b);
    if (booted) SFX.play(b.from === "you" ? "dispatch" : "baton");
    dirty.add("handoffs");
    flush();
  });
}

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
    if (agents) {
      renderKpis();
      renderQuickActions();
      renderCrew();
      renderActivityFilters();
      renderRanks();
      renderTargets();
      renderCrewStrip();
      renderActiveBar();
      renderMap();
    }
    if (all || dirty.has("channels")) { renderChannels(); renderThreadFilter(); }
    if (tasks) {
      renderStudioLive();
      renderLanes();
      renderThread();
      if (!agents) { renderCrew(); renderMap(); renderCrewStrip(); renderActiveBar(); }
    }
    if (agents || tasks || dirty.has("handoffs")) renderHandoffs();
    if (all || dirty.has("approvals")) { renderApprovals(); renderKpis(); renderStudioLive(); if (!agents && !tasks) renderCrew(); }
    if (dirty.has("approvals") && !tasks) renderThread();
    dirty.clear();
    booted = true;
  });
}

// ------------------------------------------------------------------ top bar
function renderKpis() {
  if (!S.connected) {
    $("#kpis").innerHTML = `<div class="kpi offline"><i class="kpi-dot" aria-hidden="true"></i><b>Reconnecting…</b></div>`;
    $("#topPulse")?.classList.remove("active");
    return;
  }
  const running = S.kpis.running ?? 0;
  const readyCount = S.agents.filter((a) => a.live && a.enabled && a.status !== "offline").length;
  const openAsks = pendingApprovals().length;
  $("#kpis").innerHTML = [
    ...(openAsks ? [`<button type="button" class="kpi ask" data-go-approvals><b>${openAsks}</b> needs OK</button>`] : []),
    `<div class="kpi live ${running > 0 ? "hot" : ""}"><i class="kpi-dot" aria-hidden="true"></i><b>${running > 0 ? running : readyCount}</b>${running > 0 ? "working" : "ready"}</div>`,
  ].join("");
  $("#topPulse")?.classList.toggle("active", running > 0);
}

function renderChannels() {
  const active = S.channels.filter((c) => c.enabled || c.connected);
  const label = { telegram: "Telegram", imessage: "iMessage" };
  $("#channels").innerHTML = active
    .map((c) => `<span class="chan ${c.connected ? "on" : "err"}" data-chan="${esc(c.name)}" title="${esc(label[c.name] || c.name)}: ${esc(c.detail)}"><i></i><span class="lbl">${esc(label[c.name] || c.name)}</span></span>`)
    .join("");
}

function renderThreadFilter() {
  const el = $("#threadFilter");
  if (!el) return;
  const chans = S.channels.filter((c) => c.enabled || c.connected).map((c) => c.name);
  const valid = new Set(["all", "web", ...chans]);
  if (!valid.has(S.filter)) {
    S.filter = "all";
    renderThread();
  }
  if (!chans.length) { el.hidden = true; return; }
  el.hidden = false;
  const opts = [["all", "All"], ["web", "App"], ...chans.map((c) => [c, c === "telegram" ? "Telegram" : "iMessage"])];
  el.innerHTML = opts.map(([f, lbl]) => `<button type="button" data-f="${esc(f)}" class="${S.filter === f ? "on" : ""}">${esc(lbl)}</button>`).join("");
}

// ------------------------------------------------------------------ quick launch & studio live
function renderQuickActions() {
  const ids = new Set(S.agents.map((a) => a.id));
  const actions = [
    { label: "Team mission", sub: "Split across crew", cls: "team", color: "var(--accent)", target: "team", prompt: "", run: false },
    ...(ids.has("grok") ? [{ label: "Live pulse", sub: "Grok", color: colorOf("grok"), target: "grok", prompt: "What's actually moving on X and in AI news today? Top 3 takeaways with sources.", run: true }] : []),
    ...(ids.has("muse") ? [{ label: "Draft hooks", sub: "Muse", color: colorOf("muse"), target: "muse", prompt: "Give me 3 sharp, distinct hooks for: ", run: false }] : []),
    ...(ids.has("hermes") ? [{ label: "Plan & execute", sub: "Hermes", color: colorOf("hermes"), target: "hermes", prompt: "Turn this into a clear step-by-step plan: ", run: false }] : []),
    ...(ids.has("zen") || ids.has("chatgpt")
      ? [{ label: "Second opinion", sub: ids.has("zen") ? "Zen" : "ChatGPT", color: colorOf(ids.has("zen") ? "zen" : "chatgpt"), target: ids.has("zen") ? "zen" : "chatgpt", prompt: "Pressure-test this and call out the biggest blind spot: ", run: false }]
      : []),
    { label: "Health check", sub: "/doctor", color: "var(--ok)", target: "auto", prompt: "/doctor", run: true },
  ];
  $("#quickActions").innerHTML = actions
    .map((a) => `<button type="button" class="qa-btn ${a.cls || ""}" style="--c:${safeColor(a.color)}" data-qa-target="${esc(a.target)}" data-qa-prompt="${esc(a.prompt)}" data-qa-run="${a.run ? "1" : "0"}">
      <span class="qa-dot" aria-hidden="true"></span>
      <span>${esc(a.label)}</span>
      <span class="qa-sub">${esc(a.sub)}</span>
    </button>`)
    .join("");

  const todayCount = S.kpis.tasksToday ?? 0;
  $("#studioSub").textContent = todayCount ? `${todayCount} today` : "One click to start";
}

$("#quickActions")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-qa-target]");
  if (!b) return;
  const target = b.dataset.qaTarget;
  const prompt = b.dataset.qaPrompt || "";
  const run = b.dataset.qaRun === "1";
  if (prompt.startsWith("/")) {
    $("#input").value = prompt;
    $("#composer").requestSubmit();
    if (matchMedia("(max-width: 960px)").matches) setTab("thread");
    return;
  }
  focusAgent(target, { switchTab: true, prompt, run });
});

function renderStudioLive() {
  const el = $("#studioLive");
  if (!el) return;
  const running = [...S.tasks.values()].filter((t) => t.status === "running" && t.kind !== "goal");
  const mission = latestTeamMission();
  const activeMission = mission && (mission.goal.status === "running" || mission.goal.status === "queued");
  if (!running.length && !activeMission) { el.hidden = true; return; }
  el.hidden = false;
  if (activeMission) {
    const done = mission.subtasks.filter((s) => s.status === "done").length;
    el.innerHTML = `<div class="studio-live-left">
        <span class="eq" style="--c:var(--accent)" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="studio-live-title"><b>Team mission:</b> ${esc(mission.goal.title)} · ${done}/${mission.subtasks.length} steps</span>
      </div>
      <button type="button" class="studio-live-btn" data-open-map>Watch map →</button>`;
  } else {
    const first = running[0];
    const p = personaOf(agentById(first.agentId));
    el.innerHTML = `<div class="studio-live-left">
        <span class="eq" style="--c:${colorOf(first.agentId)}" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="studio-live-title"><b>${esc(nameOf(first.agentId))}</b> · ${esc(p.thinking.toLowerCase())} — ${esc(first.title)}</span>
      </div>
      <button type="button" class="studio-live-btn" data-jump-task="${esc(first.id)}">View →</button>`;
  }
}

$("#studioLive")?.addEventListener("click", (e) => {
  if (e.target.closest("[data-open-map]")) return setView("map");
  const j = e.target.closest("[data-jump-task]");
  if (j) jumpToTask(j.dataset.jumpTask);
});

// ------------------------------------------------------------------ crew map & mission graph
const MAP = { cx: 170, cy: 166, r: 102 };

function arcPathData(fromId, toId) {
  const a = S.pos[fromId];
  const z = S.pos[toId];
  if (!a || !z) return null;
  const mx = (a.x + z.x) / 2, my = (a.y + z.y) / 2;
  const dx = mx - MAP.cx, dy = my - MAP.cy;
  const d = Math.hypot(dx, dy) || 1;
  const bend = fromId === "you" || toId === "you" ? 18 : 34;
  const cx = mx + (dx / d) * bend + (d < 2 ? 20 : 0), cy = my + (dy / d) * bend;
  return { d: `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${z.x.toFixed(1)} ${z.y.toFixed(1)}`, a, z, cx, cy };
}

function buildMissionData(goal) {
  const kids = [...S.tasks.values()]
    .filter((c) => c.parentId === goal.id)
    .sort((a, b) => (a.step ?? (a.kind === "plan" ? 0 : 999)) - (b.step ?? (b.kind === "plan" ? 0 : 999)) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const subtasks = kids.filter((c) => c.kind === "subtask");
  const byStep = new Map(subtasks.map((s) => [s.step, s]));
  const edges = [];
  const leadId = goal.agentId;

  for (const sub of subtasks) {
    const state = sub.status === "running" ? "active" : sub.status === "done" ? "done" : "queued";
    if (sub.reroutedFrom && sub.reroutedFrom !== sub.agentId) {
      edges.push({ from: sub.reroutedFrom, to: sub.agentId, kind: "reroute", state, taskId: sub.id });
    }
    const deps = (sub.after ?? []).map((n) => byStep.get(n)).filter(Boolean);
    if (deps.length) {
      for (const dep of deps) {
        if (dep.agentId !== sub.agentId) edges.push({ from: dep.agentId, to: sub.agentId, kind: "handoff", state, taskId: sub.id });
      }
    } else if (leadId !== sub.agentId) {
      edges.push({ from: leadId, to: sub.agentId, kind: "delegate", state, taskId: sub.id });
    }
  }
  const synth = kids.find((c) => c.kind === "synthesis");
  if (synth) {
    const usedLater = new Set(subtasks.flatMap((s) => s.after ?? []));
    const leafSubs = subtasks.filter((s) => !usedLater.has(s.step));
    const sState = synth.status === "running" ? "active" : synth.status === "done" ? "done" : "queued";
    for (const leaf of leafSubs) {
      if (leaf.agentId !== synth.agentId) edges.push({ from: leaf.agentId, to: synth.agentId, kind: "return", state: sState, taskId: synth.id });
    }
  }
  return { goal, kids, subtasks, edges };
}

function recentTeamMissions() {
  return [...S.tasks.values()]
    .filter((t) => t.kind === "goal")
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 12)
    .map(buildMissionData);
}

function latestTeamMission() {
  const list = recentTeamMissions();
  if (!list.length) return null;
  if (S.selectedMissionId) {
    const picked = list.find((m) => m.goal.id === S.selectedMissionId);
    if (picked) return picked;
  }
  const active = list.find((m) => m.goal.status === "running" || m.goal.status === "queued");
  if (active) return active;
  return list.find((m) => m.edges.length > 0) ?? list[0];
}

function renderChainBar() {
  const bar = $("#mapChainBar");
  if (!bar) return;
  if (S.mapMode !== "chain") { bar.hidden = true; return; }
  bar.hidden = false;
  const prevGoal = $("#chainGoal")?.value ?? "";
  const stepsHtml = S.chain.length
    ? S.chain
        .map((id, i) => `${i > 0 ? '<span class="chain-arrow">→</span>' : ""}<span class="chain-pill" style="--c:${colorOf(id)}"><span>${i + 1}. ${esc(nameOf(id))}</span><button type="button" data-chain-rm="${i}" aria-label="Remove ${esc(nameOf(id))}">×</button></span>`)
        .join("")
    : `<span class="muted small">Click 2+ assistants on the map in handoff order (e.g. Grok → Muse → Zen)</span>`;
  bar.innerHTML = `
    <div class="chain-steps">${stepsHtml}</div>
    <form class="chain-form" id="chainForm">
      <input type="text" id="chainGoal" placeholder="What should this relay build or answer?" value="${esc(prevGoal)}" autocomplete="off" />
      <button type="button" class="btn ghost" id="chainClear" ${S.chain.length ? "" : "disabled"}>Clear</button>
      <button type="submit" class="btn primary" ${S.chain.length ? "" : "disabled"}>Launch</button>
    </form>`;
}

function setMapMode(mode) {
  S.mapMode = mode === "chain" ? "chain" : "explore";
  $$("#mapModeSeg button").forEach((b) => {
    const on = b.dataset.mapMode === S.mapMode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  });
  renderMap();
  renderChainBar();
}

function setHoverAgent(id) {
  $$("#map .map-node").forEach((n) => n.classList.toggle("hi", Boolean(id) && n.dataset.mapTarget === id));
  $$("#map .arc-path").forEach((p) => {
    const match = Boolean(id) && (p.dataset.from === id || p.dataset.to === id);
    p.classList.toggle("hi", match);
    p.classList.toggle("dim", Boolean(id) && !match);
  });
  $$("#crew .agent").forEach((c) => c.classList.toggle("is-hovered", Boolean(id) && c.dataset.agentCard === id));
}

function renderMap() {
  const svg = $("#map");
  const n = S.agents.length;
  S.pos = { you: { x: MAP.cx, y: MAP.cy } };
  S.agents.forEach((a, i) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    S.pos[a.id] = { x: MAP.cx + MAP.r * Math.cos(ang), y: MAP.cy + MAP.r * Math.sin(ang), ang };
  });
  let lines = `<circle class="ring-orbit" cx="${MAP.cx}" cy="${MAP.cy}" r="${MAP.r}"/>`;
  for (const a of S.agents) {
    const p = S.pos[a.id];
    const col = safeColor(a.color);
    const active = a.status === "working";
    lines += `<line class="spoke ${active ? "active" : ""}" style="${active ? `stroke:${col}` : ""}" x1="${MAP.cx}" y1="${MAP.cy}" x2="${p.x}" y2="${p.y}"/>`;
  }
  $("#mapLines", svg).innerHTML = lines;

  const mission = latestTeamMission();
  let arcsHtml = "";
  if (S.mapMode === "chain" && S.chain.length > 0) {
    const pairs = [["you", S.chain[0]]];
    for (let i = 0; i < S.chain.length - 1; i++) pairs.push([S.chain[i], S.chain[i + 1]]);
    for (const [fromId, toId] of pairs) {
      if (fromId === toId) continue;
      const geo = arcPathData(fromId, toId);
      if (!geo) continue;
      const col = fromId === "you" ? colorOf(toId) : colorOf(fromId);
      arcsHtml += `<path class="arc-glow" d="${geo.d}" stroke="${col}"/>`;
      arcsHtml += `<path class="arc-path chain" d="${geo.d}" stroke="${col}" data-from="${esc(fromId)}" data-to="${esc(toId)}"/>`;
    }
  } else if (mission) {
    const dedup = new Map();
    for (const e of mission.edges) {
      const k = `${e.from}>${e.to}:${e.kind}`;
      const prev = dedup.get(k);
      if (!prev || e.state === "active") dedup.set(k, e);
    }
    for (const e of dedup.values()) {
      if (e.state === "queued" && mission.goal.status !== "running") continue;
      const geo = arcPathData(e.from, e.to);
      if (!geo) continue;
      const color = e.kind === "reroute" ? "var(--warn)" : e.kind === "return" || e.kind === "handoff" ? colorOf(e.from) : colorOf(e.to);
      const cls = e.kind === "reroute" ? "reroute" : e.state === "active" ? "active" : "done";
      if (e.state === "active") arcsHtml += `<path class="arc-glow" d="${geo.d}" stroke="${color}"/>`;
      arcsHtml += `<path class="arc-path ${cls}" d="${geo.d}" stroke="${color}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"/>`;
    }
  }
  $("#mapArcs", svg).innerHTML = arcsHtml;

  let nodes = `<g class="you-node" data-map-target="team" role="button" tabindex="0" aria-label="Message whole team">
    <circle class="you" cx="${MAP.cx}" cy="${MAP.cy}" r="22"/>
    <text class="you-text" x="${MAP.cx}" y="${MAP.cy + 4}">YOU</text>
  </g>`;

  for (const a of S.agents) {
    const p = S.pos[a.id];
    const col = safeColor(a.color);
    const persona = personaOf(a);
    const up = Math.sin(p.ang) < -0.3;
    const ly = up ? -50 : 41;
    const active = activeTaskFor(a.id);
    const isAsk = Boolean(active?.awaitingApproval);
    const isWorking = !isAsk && (a.status === "working" || S.previewWork.has(a.id));
    const isOnline = a.live && a.enabled && a.status === "idle" && !isWorking && !isAsk;
    const chainPos = S.mapMode === "chain" ? S.chain.indexOf(a.id) : -1;
    const isSelected = S.mapMode === "chain" ? chainPos >= 0 : S.target === a.id;
    const subText = isAsk ? "Needs OK" : active ? persona.thinking : persona.role;
    nodes += `<g class="map-node ${isSelected ? "selected" : ""}" data-map-target="${esc(a.id)}" role="button" tabindex="0" aria-label="${S.mapMode === "chain" ? `Add ${esc(a.name)} to relay chain` : `Chat with ${esc(a.name)}`}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" opacity="${a.enabled ? 1 : 0.42}">
      ${isWorking ? `<circle class="pulse" r="26" fill="none" stroke="${col}" stroke-width="2"/>
        <circle class="orbit-spin" r="30" fill="none" stroke="${col}" stroke-width="1.6" stroke-dasharray="14 28" stroke-linecap="round"/>` : ""}
      ${isOnline ? `<circle class="breathe" r="28" fill="none" stroke="${col}" stroke-width="1.1"/>` : ""}
      <g class="node-core">
        ${mapPortraitMarkup(a, isWorking)}
        <circle class="node-ring" r="24" fill="none" stroke="${col}" stroke-width="${isSelected || isWorking ? 2.4 : 1.7}"/>
      </g>
      <circle cx="17" cy="17" r="4.8" fill="${isAsk ? "var(--warn)" : isWorking ? col : isOnline ? "var(--ok)" : a.status === "offline" ? "var(--danger)" : "var(--faint)"}" stroke="var(--panel)" stroke-width="2"/>
      ${chainPos >= 0 ? `<circle class="chain-badge-bg" cx="-18" cy="-18" r="10"/><text class="chain-badge-txt" x="-18" y="-18">${chainPos + 1}</text>` : ""}
      ${a.isLead ? `<text class="crown" y="${up ? 37 : -32}" fill="var(--accent-text)">LEAD</text>` : ""}
      <text class="node-label" y="${ly}">${esc(a.name)}</text>
      <text class="${active ? "node-phase" : "node-sub"}" y="${ly + 13}" ${active ? `fill="${isAsk ? "var(--warn)" : col}"` : ""}>${esc(subText)}</text>
    </g>`;
  }
  $("#mapNodes", svg).innerHTML = nodes;
  setHoverAgent(null);

  const lead = agentById(S.lead);
  $("#leadLabel").textContent = lead ? `${lead.name} leads` : "";

  const busy = S.agents.filter((a) => a.status === "working");
  const ready = S.agents.filter((a) => a.live && a.enabled && a.status !== "offline").length;
  const cap = $("#mapCaption");
  cap.classList.toggle("busy", busy.length > 0);
  if (S.mapMode === "chain") {
    cap.innerHTML = `<i class="live-dot" aria-hidden="true"></i><span>${S.chain.length ? `${S.chain.length} step${S.chain.length === 1 ? "" : "s"} wired · click more or Launch below` : "Click assistants in order to build a custom relay"}</span>`;
  } else if (busy.length) {
    const first = busy[0];
    cap.innerHTML = `<i class="live-dot" aria-hidden="true"></i><span><b>${esc(first.name)}</b> · ${esc(personaOf(first).thinking.toLowerCase())}…</span>`;
  } else {
    cap.innerHTML = `<i class="live-dot" aria-hidden="true"></i><span>${ready} of ${S.agents.length} ready · click to chat · double-click to set Lead</span>`;
  }
  renderChainBar();
}

$("#mapModeSeg")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-map-mode]");
  if (b) setMapMode(b.dataset.mapMode);
});

$("#mapPulseBtn")?.addEventListener("click", () => {
  const live = S.agents.filter((a) => a.enabled);
  if (!live.length) return;
  SFX.play("dispatch");
  live.forEach((a, i) => {
    setTimeout(() => {
      animateBaton({ from: i === 0 ? "you" : live[i - 1].id, to: a.id, kind: i === 0 ? "delegate" : "handoff" });
      if (i > 0) SFX.play("baton");
    }, i * 240);
  });
  setTimeout(() => {
    animateBaton({ from: live[live.length - 1].id, to: "you", kind: "return" });
    SFX.play("done");
  }, live.length * 240 + 120);
});

$("#map").addEventListener("mouseover", (e) => {
  const node = e.target.closest("[data-map-target]");
  setHoverAgent(node && node.dataset.mapTarget !== "team" ? node.dataset.mapTarget : null);
});
$("#map").addEventListener("mouseleave", () => setHoverAgent(null));
$("#map").addEventListener("click", (e) => {
  const node = e.target.closest("[data-map-target]");
  if (!node) return;
  const id = node.dataset.mapTarget;
  if (S.mapMode === "chain") {
    if (id === "team") return;
    const prev = S.chain.length ? S.chain[S.chain.length - 1] : "you";
    if (S.chain.includes(id)) {
      S.chain = S.chain.filter((x) => x !== id);
    } else if (S.chain.length >= 6) {
      toast("Up to 6 steps in a custom relay");
      return;
    } else {
      S.chain.push(id);
      animateBaton({ from: prev, to: id, kind: prev === "you" ? "delegate" : "handoff" });
      SFX.play(prev === "you" ? "dispatch" : "baton");
    }
    renderMap();
    return;
  }
  focusAgent(id, { switchTab: true });
});
$("#map").addEventListener("dblclick", async (e) => {
  if (S.mapMode !== "explore") return;
  const node = e.target.closest("[data-map-target]");
  const id = node?.dataset.mapTarget;
  if (!id || id === "team" || id === S.lead) return;
  try {
    await api("/api/lead", { method: "POST", body: JSON.stringify({ agentId: id }) });
    toast(`★ ${nameOf(id)} now leads team missions`);
  } catch (err) {
    toast(err.message);
  }
});
$("#map").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const node = e.target.closest("[data-map-target]");
  if (!node) return;
  e.preventDefault();
  node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});

$("#mapChainBar")?.addEventListener("click", (e) => {
  const rm = e.target.closest("[data-chain-rm]");
  if (rm) {
    const idx = Number(rm.dataset.chainRm);
    if (Number.isInteger(idx)) S.chain.splice(idx, 1);
    renderMap();
    return;
  }
  if (e.target.closest("#chainClear")) {
    S.chain = [];
    renderMap();
  }
});
$("#mapChainBar")?.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!S.chain.length) return;
  const goal = $("#chainGoal")?.value.trim();
  if (!goal) { toast("Type a goal for this relay first"); $("#chainGoal")?.focus(); return; }
  const chainNames = S.chain.map((id, i) => `Step ${i + 1}: ${nameOf(id)}`).join(" -> ");
  const prompt = S.chain.length === 1
    ? `@${S.chain[0]} ${goal}`
    : `@team Use this handoff sequence (${chainNames}): ${goal}`;
  S.chain = [];
  setMapMode("explore");
  $("#input").value = prompt;
  autosize();
  $("#composer").requestSubmit();
  if (matchMedia("(max-width: 960px)").matches) setTab("thread");
});

let replayTimers = [];
function replayLastMission() {
  const mission = latestTeamMission();
  if (!mission) return toast("No team mission yet — start one with Team");
  replayTimers.forEach((t) => clearTimeout(t));
  replayTimers = [];
  const seq = [
    { from: "you", to: mission.goal.agentId, kind: "delegate", taskId: mission.goal.id },
    ...mission.edges,
  ];
  if (mission.goal.status === "done") seq.push({ from: mission.goal.agentId, to: "you", kind: "return", taskId: mission.goal.id });
  seq.forEach((b, i) => {
    const handle = setTimeout(() => {
      animateBaton(b);
      if (i === 0) SFX.play("dispatch");
      else if (i === seq.length - 1 && b.to === "you") SFX.play("done");
      else SFX.play("baton");
    }, i * 420);
    replayTimers.push(handle);
  });
}
$("#replayBtn")?.addEventListener("click", replayLastMission);

function jumpToTask(taskId) {
  const t = S.tasks.get(taskId);
  const topId = t?.parentId || taskId;
  const top = S.tasks.get(topId);
  if (top && S.filter !== "all" && top.channel !== S.filter) {
    S.filter = "all";
    renderThreadFilter();
    renderThread();
  }
  if (matchMedia("(max-width: 960px)").matches) setTab("thread", { scrollBottom: false });
  if (t?.parentId) S.openSteps.add(t.id);
  const el = $(`#thread [data-task-id="${topId}"]`);
  if (!el) return toast("Task is older than visible history");
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const bubble = el.querySelector(".bubble") || el;
  bubble.classList.remove("flash");
  void bubble.offsetWidth;
  bubble.classList.add("flash");
  if (t?.parentId) {
    const det = el.querySelector(`details[data-step-id="${t.id}"]`);
    if (det) det.open = true;
  }
}

function renderMissionPipeline() {
  const wrap = $("#missionPipeline");
  const replayBtn = $("#replayBtn");
  const select = $("#missionSelect");
  const missions = recentTeamMissions();
  const mission = latestTeamMission();
  if (select) {
    if (missions.length > 1) {
      select.hidden = false;
      const activeId = mission?.goal.id ?? "";
      select.innerHTML = missions
        .map((m) => `<option value="${esc(m.goal.id)}" ${m.goal.id === activeId ? "selected" : ""}>${esc(m.goal.title.slice(0, 36))}</option>`)
        .join("");
    } else {
      select.hidden = true;
    }
  }
  if (!wrap) return;
  if (!mission || !mission.kids.length) {
    wrap.hidden = true;
    if (replayBtn) replayBtn.hidden = true;
    return;
  }
  wrap.hidden = false;
  if (replayBtn) replayBtn.hidden = false;

  const { goal, kids, subtasks } = mission;
  const plan = kids.find((c) => c.kind === "plan");
  const synth = kids.find((c) => c.kind === "synthesis");
  const doneCount = subtasks.filter((s) => s.status === "done").length;

  const depthOf = new Map();
  const getDepth = (s, seenSet = new Set()) => {
    if (depthOf.has(s.step)) return depthOf.get(s.step);
    if (seenSet.has(s.step)) return 0;
    seenSet.add(s.step);
    const deps = (s.after ?? []).map((n) => subtasks.find((x) => x.step === n)).filter(Boolean);
    const d = deps.length ? Math.max(...deps.map((x) => getDepth(x, seenSet))) + 1 : 0;
    depthOf.set(s.step, d);
    return d;
  };
  const cols = [];
  if (plan) cols.push([plan]);
  const byDepth = new Map();
  for (const s of subtasks) {
    const d = getDepth(s);
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d).push(s);
  }
  [...byDepth.keys()].sort((a, b) => a - b).forEach((d) => cols.push(byDepth.get(d)));
  if (synth) cols.push([synth]);

  const isLive = goal.status === "running" || goal.status === "queued";
  const elapsed = goal.startedAt
    ? goal.finishedAt
      ? fmtMs(Date.parse(goal.finishedAt) - Date.parse(goal.startedAt))
      : `<span data-since="${esc(goal.startedAt)}">${fmtMs(Date.now() - Date.parse(goal.startedAt))}</span>`
    : "";
  const statText = isLive ? `${doneCount}/${subtasks.length} steps · ${elapsed}` : `${goal.status === "done" ? "Done" : stateLabel(goal)} · ${elapsed}`;

  const chip = (c) => {
    const a = agentById(c.agentId);
    const role = c.kind === "plan" ? "Plan" : c.kind === "synthesis" ? "Wrap" : `#${c.step ?? ""}`;
    const mark = c.status === "done" ? "✓" : c.status === "running" ? "◉" : c.status === "failed" || c.status === "blocked" ? "!" : "○";
    return `<button type="button" class="pipe-chip ${esc(c.status)}" style="--c:${colorOf(c.agentId)}" data-jump-task="${esc(c.id)}" data-hover-agent="${esc(c.agentId)}" title="${esc(c.title)}">
      <span class="pipe-av">${renderPortraitContent(a ?? { id: c.agentId, name: c.agentId }, c.status === "running", true)}</span>
      <span>${esc(nameOf(c.agentId))}</span>
      <span class="pipe-role">${esc(role)}</span>
      <span class="pipe-mark">${mark}</span>
    </button>`;
  };

  wrap.innerHTML = `
    <div class="pipe-top">
      <span class="pipe-goal" title="${esc(goal.title)}">${esc(goal.title)}</span>
      <span class="pipe-stat ${isLive ? "live" : ""}">${statText}</span>
    </div>
    <div class="pipe-track">
      ${cols.map((col, idx) => `${idx > 0 ? '<svg class="pipe-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M9 4.5 12.5 8 9 11.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ""}<div class="pipe-col">${col.map(chip).join("")}</div>`).join("")}
    </div>`;
}

$("#missionSelect")?.addEventListener("change", (e) => {
  S.selectedMissionId = e.target.value || null;
  renderMap();
  renderMissionPipeline();
});
$("#missionPipeline")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-jump-task]");
  if (btn) jumpToTask(btn.dataset.jumpTask);
});
$("#missionPipeline")?.addEventListener("mouseover", (e) => {
  const btn = e.target.closest("[data-hover-agent]");
  setHoverAgent(btn ? btn.dataset.hoverAgent : null);
});
$("#missionPipeline")?.addEventListener("mouseleave", () => setHoverAgent(null));

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
  renderMissionPipeline();
  const list = S.handoffs.slice(0, 12);
  $("#handoffs").innerHTML = list.length
    ? list
        .map((h) => {
          const t = S.tasks.get(h.taskId);
          const key = `${h.taskId}:${h.kind}:${h.from}`;
          const isOpen = S.openHandoffs.has(key);
          const verb = h.kind === "return" ? "returned" : h.kind === "reroute" ? "handed off" : h.kind === "handoff" ? "passed to" : "";
          const snippet = (t?.result || t?.error || t?.prompt || "").replace(/\s+/g, " ").trim();
          const preview = snippet.length > 200 ? `${snippet.slice(0, 197)}…` : snippet;
          return `<li class="${enter("handoffs", key).trim()}${isOpen ? " open" : ""}" data-handoff-key="${esc(key)}" data-hover-agent="${esc(h.to)}">
            <button type="button" class="hrow" aria-expanded="${isOpen ? "true" : "false"}">
              <span class="route"><span class="dot" style="--c:${colorOf(h.from)}"></span>${esc(nameOf(h.from))}
                <svg viewBox="0 0 16 16"><path d="M3 8h9M9 4.5 12.5 8 9 11.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <span class="dot" style="--c:${colorOf(h.to)}"></span>${esc(nameOf(h.to))}</span>
              <span class="what">${verb ? `<b>${esc(verb)}</b> · ` : ""}${esc(t?.title ?? "")}</span>
              <time data-ago="${esc(h.at)}">${ago(h.at)}</time>
            </button>
            <div class="hpreview">
              <div>${esc(preview || "Working…")}</div>
              ${t ? `<button type="button" class="hjump" data-jump-task="${esc(t.id)}">Open in chat →</button>` : ""}
            </div>
          </li>`;
        })
        .join("")
    : `<li class="empty" style="display:block">Start a <b>Team mission</b> to watch your crew pass work live.</li>`;
}

$("#handoffs").addEventListener("click", (e) => {
  const jump = e.target.closest("[data-jump-task]");
  if (jump) { e.stopPropagation(); jumpToTask(jump.dataset.jumpTask); return; }
  const li = e.target.closest("[data-handoff-key]");
  if (!li) return;
  const key = li.dataset.handoffKey;
  const next = !S.openHandoffs.has(key);
  if (next) S.openHandoffs.add(key);
  else S.openHandoffs.delete(key);
  li.classList.toggle("open", next);
  li.querySelector(".hrow")?.setAttribute("aria-expanded", String(next));
});
$("#handoffs").addEventListener("mouseover", (e) => {
  const li = e.target.closest("[data-hover-agent]");
  setHoverAgent(li && li.dataset.hoverAgent !== "you" ? li.dataset.hoverAgent : null);
});
$("#handoffs").addEventListener("mouseleave", () => setHoverAgent(null));

// ------------------------------------------------------------------ crew cards (clean, living, action-first)
const STATUS_TEXT = { idle: "Ready", working: "Working", limited: "At limit", paused: "Paused", offline: "Offline" };
const BILL_HELP = {
  subscription: "Included with your existing subscription.",
  local: "Runs locally on your Mac.",
  metered: "Pay-per-use API.",
  prepaid: "Spends prepaid credit per use, capped by its monthly budget.",
};

function renderCompactMeter(a) {
  const pq = a.providerQuota;
  if (pq?.live && pq.windows?.length) {
    return `<div class="meter-row">
      <div class="meter-bars">
        ${pq.windows.slice(0, 2).map((w) => {
          const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
          const cls = pct >= 92 ? "full" : pct >= 75 ? "warn" : "";
          const scale = pct > 0 ? Math.max(0.04, pct / 100).toFixed(3) : "0";
          return `<div class="meter-item" title="${esc(w.label)}: ${pct}% used">
            <div class="meter-top"><span>${esc(w.label)}</span><b>${pct}%</b></div>
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
    return `<div class="meter-row">
      <div class="meter-bars">
        <div class="meter-item">
          <div class="meter-top"><span>Credits left</span><b>${fmtUsd(rem)}</b></div>
          <div class="bar ${rem < 2 ? "full" : rem < 10 ? "warn" : ""}"><span style="transform:scaleX(${share.toFixed(3)})"></span></div>
        </div>
      </div>
    </div>`;
  }
  return "";
}

function renderCrew() {
  const ready = S.agents.filter((a) => a.live && a.enabled && a.status !== "offline").length;
  const summary = $("#crewSummary");
  if (summary) summary.textContent = `${ready} of ${S.agents.length} ready`;

  $("#crew").innerHTML = S.agents
    .map((a, idx) => {
      const p = personaOf(a);
      const col = safeColor(a.color);
      const seed = MOTION_SEED[idx % MOTION_SEED.length];
      const activeTask = activeTaskFor(a.id);
      const isAsk = Boolean(activeTask?.awaitingApproval);
      const isPreview = !isAsk && S.previewWork.has(a.id);
      const isWorking = (!isAsk && a.status === "working") || isPreview;
      const avatarState = isAsk ? "ask" : isWorking ? "working" : a.status === "idle" && a.live ? "online" : a.status;
      const statusCls = isAsk ? "ask" : isWorking ? "working" : a.status;
      const statusLabel = isAsk
        ? "Needs OK"
        : isWorking
          ? `<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span><span>${esc(p.thinking)}</span>`
          : esc(STATUS_TEXT[a.status] ?? a.status ?? "");

      let midHtml = "";
      if (isAsk && activeTask) {
        midHtml = `<button type="button" class="agent-activity ask" data-go-approvals>
          <span class="act-text">Needs your OK: ${esc(activeTask.title)}</span>
          <span class="act-meta">Review →</span>
        </button>`;
      } else if (activeTask) {
        const since = activeTask.startedAt ?? activeTask.createdAt;
        midHtml = `<div class="agent-activity live">
          <span class="act-text" title="${esc(activeTask.title)}">${esc(activeTask.title)}</span>
          <span class="act-meta"><span data-since="${esc(since)}">${fmtMs(Date.now() - Date.parse(since))}</span><button type="button" class="act-cancel" data-cancel="${esc(activeTask.id)}">Stop</button></span>
        </div>`;
      } else {
        const meter = renderCompactMeter(a);
        if (meter) midHtml = meter;
      }

      const quickBtn = p.quick
        ? `<button type="button" class="btn ghost quick-go" data-card-quick="${esc(a.id)}" title="${esc(p.quick.prompt)}"><span>${esc(p.quick.label)}</span></button>`
        : "";

      const traitsHtml = p.traits.length
        ? `<div class="trait-row">${p.traits.slice(0, 4).map((t) => `<button type="button" class="trait-chip" data-trait-agent="${esc(a.id)}" data-trait="${esc(t)}" title="Try ${esc(a.name)}'s ${esc(t)} mode">${esc(t)}</button>`).join("")}</div>`
        : "";
      const quipHtml = S.activeQuips[a.id] ? `<div class="quip-bubble">${esc(S.activeQuips[a.id])}</div>` : "";
      const canToggleStatus = !isAsk && !isWorking && (a.status === "idle" || a.status === "paused") && !a.blocked;
      const statusHtml = canToggleStatus
        ? `<button type="button" class="status-pill toggleable ${esc(statusCls)}" data-toggle-enabled="${esc(a.id)}" title="${a.enabled ? `Click to pause ${esc(a.name)}` : `Click to resume ${esc(a.name)}`}">${statusLabel}</button>`
        : `<span class="status-pill ${esc(statusCls)}" title="${esc(isWorking ? p.thinking : STATUS_TEXT[a.status] ?? a.status ?? "")}">${statusLabel}</span>`;

      return `<article class="agent ${a.enabled ? "" : "paused"} ${isWorking ? "is-working" : ""} ${isAsk ? "is-ask" : ""} ${S.target === a.id ? "is-target" : ""}" style="--c:${col};--phase:${seed.phase};--dur:${seed.dur}" data-agent-card="${esc(a.id)}" draggable="true">
        <div class="agent-top">
          <button type="button" class="avatar ${esc(avatarState)}" data-preview-avatar="${esc(a.id)}" title="Poke ${esc(a.name)} · ${esc(shortModel(a.model, a))}" aria-label="Wake ${esc(a.name)}">
            <span class="aura" aria-hidden="true"></span>
            <span class="sparks" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="avatar-stage">${renderPortraitContent(a, isWorking)}</span>
            <i class="presence-dot" aria-hidden="true"></i>
          </button>
          <div class="agent-id">
            <div class="agent-name-row">
              ${brandBadgeMarkup(a)}
              <span class="agent-name">${esc(a.name)}</span>
              ${a.isLead ? '<span class="lead-star">Lead</span>' : ""}
            </div>
            <div class="agent-role">${esc(p.role)}</div>
          </div>
          ${statusHtml}
        </div>

        ${quipHtml}
        ${traitsHtml}
        <p class="agent-motto">“${esc(p.motto)}”</p>
        ${a.tagline ? `<p class="agent-best"><b>Best for</b>${esc(a.tagline)}</p>` : ""}

        ${midHtml}

        <div class="agent-foot">
          <button type="button" class="btn agent-go" data-ask="${esc(a.id)}">Chat</button>
          ${quickBtn}
          <button type="button" class="gear-btn" data-edit="${esc(a.id)}" title="Settings · ${esc(shortModel(a.model, a))} (${esc(levelLabel(a.reasoning))})" aria-label="Settings for ${esc(a.name)}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </article>`;
    })
    .join("");
}

// Smooth mouse/pen-only cursor parallax without firing on child boundaries
$("#crew").addEventListener("pointermove", (e) => {
  if (e.pointerType && e.pointerType !== "mouse" && e.pointerType !== "pen") return;
  const card = e.target.closest(".agent");
  if (!card) return;
  const r = card.getBoundingClientRect();
  const px = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
  const py = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
  card.style.setProperty("--px", px.toFixed(3));
  card.style.setProperty("--py", py.toFixed(3));
});
$("#crew").addEventListener("pointerleave", (e) => {
  if (e.target instanceof Element && e.target.classList.contains("agent")) {
    e.target.style.setProperty("--px", "0");
    e.target.style.setProperty("--py", "0");
  }
}, true);
$("#crew").addEventListener("pointerleave", () => {
  $$("#crew .agent").forEach((c) => {
    c.style.setProperty("--px", "0");
    c.style.setProperty("--py", "0");
  });
});

// Drag a crew card straight onto the Chat composer to target that assistant
$("#crew").addEventListener("dragstart", (e) => {
  const card = e.target.closest(".agent[data-agent-card]");
  if (!card) return;
  const id = card.dataset.agentCard;
  e.dataTransfer?.setData("text/relay-agent", id);
  e.dataTransfer?.setData("text/plain", `@${id} `);
  card.classList.add("dragging");
});
$("#crew").addEventListener("dragend", (e) => {
  const card = e.target.closest(".agent[data-agent-card]");
  if (card) card.classList.remove("dragging");
  const comp = $("#composer");
  comp?.classList.remove("drag-over");
  comp?.querySelector(".drop-hint")?.remove();
});

const composerEl = $("#composer");
composerEl?.addEventListener("dragover", (e) => {
  if (!e.dataTransfer?.types.includes("text/relay-agent")) return;
  e.preventDefault();
  if (!composerEl.classList.contains("drag-over")) {
    composerEl.classList.add("drag-over");
    const hint = document.createElement("div");
    hint.className = "drop-hint";
    hint.textContent = "Drop to chat with this assistant";
    composerEl.appendChild(hint);
  }
});
composerEl?.addEventListener("dragleave", (e) => {
  if (composerEl.contains(e.relatedTarget)) return;
  composerEl.classList.remove("drag-over");
  composerEl.querySelector(".drop-hint")?.remove();
});
composerEl?.addEventListener("drop", (e) => {
  const id = e.dataTransfer?.getData("text/relay-agent");
  composerEl.classList.remove("drag-over");
  composerEl.querySelector(".drop-hint")?.remove();
  if (!id || !agentById(id)) return;
  e.preventDefault();
  focusAgent(id, { switchTab: true });
  SFX.play("dispatch");
  toast(`Talking to ${nameOf(id)}`);
});

$("#crew").addEventListener("click", async (e) => {
  const previewBtn = e.target.closest("[data-preview-avatar]");
  if (previewBtn) {
    const id = previewBtn.dataset.previewAvatar;
    if (activeTaskFor(id)?.awaitingApproval) return;
    clearTimeout(S.previewTimers[id]);
    const p = personaOf(agentById(id));
    if (S.previewWork.has(id)) {
      S.previewWork.delete(id);
      delete S.activeQuips[id];
    } else {
      const nextIdx = (S.quipIdx[id] ?? 0) % p.quips.length;
      S.quipIdx[id] = nextIdx + 1;
      S.activeQuips[id] = p.quips[nextIdx];
      S.previewWork.add(id);
      SFX.play("baton");
      S.previewTimers[id] = setTimeout(() => {
        S.previewWork.delete(id);
        delete S.activeQuips[id];
        renderCrew(); renderMap(); renderCrewStrip();
      }, 4200);
    }
    renderCrew(); renderMap(); renderCrewStrip();
    $(`#crew [data-preview-avatar="${id}"]`)?.focus();
    return;
  }
  const toggleBtn = e.target.closest("[data-toggle-enabled]");
  if (toggleBtn) {
    const id = toggleBtn.dataset.toggleEnabled;
    const a = agentById(id);
    if (a) await quickUpdateAgent(id, { enabled: !a.enabled }, toggleBtn);
    return;
  }
  const traitBtn = e.target.closest("[data-trait]");
  if (traitBtn) {
    const id = traitBtn.dataset.traitAgent;
    const trait = traitBtn.dataset.trait;
    const a = agentById(id);
    const p = personaOf(a);
    const prompt = p.traitPrompts[trait] || `Use your ${trait.toLowerCase()} strength to help with: `;
    focusAgent(id, { switchTab: true, prompt });
    SFX.play("dispatch");
    return;
  }
  const cancelBtn = e.target.closest("[data-cancel]");
  if (cancelBtn) {
    try {
      await api(`/api/tasks/${cancelBtn.dataset.cancel}/cancel`, { method: "POST" });
      toast("Stopping…");
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (e.target.closest("[data-go-approvals]")) {
    if (matchMedia("(max-width: 960px)").matches) setTab("thread");
    $("#approvals").scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const quickBtn = e.target.closest("[data-card-quick]");
  if (quickBtn) {
    const a = agentById(quickBtn.dataset.cardQuick);
    const q = personaOf(a).quick;
    if (a && q) focusAgent(a.id, { switchTab: true, prompt: q.prompt, run: Boolean(q.run) });
    return;
  }
  const askBtn = e.target.closest("[data-ask]");
  if (askBtn) { focusAgent(askBtn.dataset.ask, { switchTab: true }); return; }
  const editBtn = e.target.closest("[data-edit]");
  if (editBtn) { openEditor(editBtn.dataset.edit, editBtn); return; }
  const card = e.target.closest(".agent[data-agent-card]");
  if (card && !e.target.closest("button, a, input, select")) {
    focusAgent(card.dataset.agentCard);
  }
});

// ------------------------------------------------------------------ activity board (interactive filters + actions)
function renderActivityFilters() {
  const el = $("#activityFilters");
  if (!el) return;
  const pills = [
    { id: "all", name: "All crew", color: "var(--accent)" },
    ...S.agents.map((a) => ({ id: a.id, name: a.name, color: safeColor(a.color) })),
  ];
  el.innerHTML = pills
    .map((p) => `<button type="button" class="af-pill ${S.activityAgent === p.id ? "on" : ""}" style="--c:${p.color}" data-af="${esc(p.id)}"><span class="dot"></span>${esc(p.name)}</button>`)
    .join("");
}

function tcard(t) {
  const a = agentById(t.agentId);
  const secs = t.startedAt
    ? t.finishedAt
      ? fmtMs(Date.parse(t.finishedAt) - Date.parse(t.startedAt))
      : `<span data-since="${esc(t.startedAt)}">${fmtMs(Date.now() - Date.parse(t.startedAt))}</span>`
    : ago(Date.parse(t.createdAt));
  const bad = t.status === "failed" || t.status === "blocked" || t.status === "cancelled";
  const isLive = t.status === "running" || t.status === "queued";
  const canRetry = !isLive && t.kind !== "plan" && t.kind !== "synthesis" && Boolean(t.display || t.prompt);
  const actHtml = isLive
    ? `<div class="tcard-actions"><button type="button" class="tcard-act stop" data-cancel="${esc(t.id)}">Stop</button></div>`
    : canRetry
      ? `<div class="tcard-actions"><button type="button" class="tcard-act" data-jump-task="${esc(t.id)}">Open</button><button type="button" class="tcard-act" data-retry-task="${esc(t.id)}">Re-run</button></div>`
      : "";
  return `<div class="tcard ${bad ? "err" : ""}${enter("lanes", `${t.id}:${t.status}`)}" style="--c:${safeColor(a?.color)}" data-jump-task="${esc(t.id)}" role="button" tabindex="0">
    <div class="t">${esc(t.title)}</div>
    ${bad && t.error ? `<div class="e">${esc(t.error.slice(0, 140))}</div>` : ""}
    <div class="m"><span class="who"><span class="dot"></span>${esc(a?.name ?? t.agentId)}</span><span>${t.awaitingApproval ? "Needs OK" : secs}</span></div>
    ${actHtml}
  </div>`;
}

function renderLanes() {
  renderActivityFilters();
  const q = S.activityQuery.trim().toLowerCase();
  const work = [...S.tasks.values()].filter((t) => {
    if (t.kind === "goal") return false;
    if (S.activityAgent !== "all" && t.agentId !== S.activityAgent) return false;
    if (q) {
      const hay = `${t.title || ""} ${t.prompt || ""} ${t.error || ""} ${nameOf(t.agentId)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const by = (st) => work.filter((t) => st.includes(t.status));
  const recent = (arr, n) => arr.sort((x, y) => Date.parse(y.finishedAt ?? y.createdAt) - Date.parse(x.finishedAt ?? x.createdAt)).slice(0, n);
  const lanes = [
    ["Active", by(["running", "queued"]), q || S.activityAgent !== "all" ? "No matching active tasks" : "Nothing running right now"],
    ["Completed", recent(by(["done"]), 18), q || S.activityAgent !== "all" ? "No matching finished tasks" : "Finished work shows up here"],
    ["Needs attention", recent(by(["failed", "blocked", "cancelled"]), 10), "All clear"],
  ];
  $("#lanes").innerHTML = lanes
    .map(([name, items, emptyText]) => `<div class="lane"><div class="lane-head">${esc(name)}<b>${items.length}</b></div>
      <div class="lane-list">${items.length ? items.map(tcard).join("") : `<div class="empty">${esc(emptyText)}</div>`}</div></div>`)
    .join("");
  const done = work.filter((t) => t.status === "done").length;
  $("#boardCount").textContent = S.activityAgent !== "all" || q ? `${work.length} matching · ${done} completed` : `${done} completed`;
}

$("#activitySearch")?.addEventListener("input", (e) => {
  S.activityQuery = e.target.value || "";
  renderLanes();
});
$("#activityFilters")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-af]");
  if (!b) return;
  S.activityAgent = b.dataset.af;
  renderLanes();
});

function retryTask(taskId) {
  const t = S.tasks.get(taskId);
  if (!t) return;
  const raw = (t.display ?? t.prompt ?? "").trim();
  if (!raw) return;
  const cmd = raw.startsWith("@") || raw.startsWith("/")
    ? raw
    : t.kind === "goal"
      ? `@team ${raw}`
      : `@${t.agentId} ${raw}`;
  $("#input").value = cmd;
  autosize();
  $("#composer").requestSubmit();
  if (matchMedia("(max-width: 960px)").matches) setTab("thread");
  toast(`Re-running with ${t.kind === "goal" ? "Team" : nameOf(t.agentId)}…`);
}

$("#lanes")?.addEventListener("click", async (e) => {
  const stopBtn = e.target.closest("[data-cancel]");
  if (stopBtn) {
    e.stopPropagation();
    try {
      await api(`/api/tasks/${stopBtn.dataset.cancel}/cancel`, { method: "POST" });
      toast("Stopping…");
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  const retryBtn = e.target.closest("[data-retry-task]");
  if (retryBtn) {
    e.stopPropagation();
    retryTask(retryBtn.dataset.retryTask);
    return;
  }
  const c = e.target.closest("[data-jump-task]");
  if (c) jumpToTask(c.dataset.jumpTask);
});
$("#lanes")?.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const c = e.target.closest(".tcard[data-jump-task]");
  if (!c || e.target !== c) return;
  e.preventDefault();
  jumpToTask(c.dataset.jumpTask);
});

// ------------------------------------------------------------------ interactive stats
function metricValue(r, metric) {
  if (metric === "tokens") return r.tokens || 0;
  if (metric === "speed") return r.avgMs > 0 ? 1 / r.avgMs : 0;
  if (metric === "reliability") return r.done + r.failed > 0 ? r.successRate * 100 : 0;
  return r.done || 0;
}

function metricLabel(r, metric) {
  if (metric === "tokens") return `${fmtK(r.tokens)} tok`;
  if (metric === "speed") return r.avgMs ? fmtMs(r.avgMs) : "—";
  if (metric === "reliability") return r.done + r.failed ? `${Math.round(r.successRate * 100)}% ok` : "—";
  return `${r.done} done`;
}

function renderStatsDetail() {
  const el = $("#statsDetail");
  if (!el) return;
  const id = S.selectedStatAgent;
  const a = id ? agentById(id) : null;
  if (!a) { el.hidden = true; return; }
  const p = personaOf(a);
  const col = safeColor(a.color);
  const recent = [...S.tasks.values()]
    .filter((t) => t.agentId === id && t.status === "done" && t.kind !== "goal")
    .sort((x, y) => Date.parse(y.finishedAt ?? y.createdAt) - Date.parse(x.finishedAt ?? x.createdAt))
    .slice(0, 4);
  el.hidden = false;
  el.style.setProperty("--c", col);
  el.innerHTML = `
    <div class="stats-detail-head">
      <div class="stats-detail-who">
        <span class="mini-av" style="--c:${col};width:32px;height:32px;border-radius:9px;overflow:hidden;display:grid;place-items:center">${renderPortraitContent(a, false, true)}</span>
        <div>
          <div style="font-weight:700">${esc(a.name)} <span class="muted small" style="font-weight:400">· ${esc(p.role)}</span></div>
          <div class="muted small">${esc(shortModel(a.model, a))} · ${esc(levelLabel(a.reasoning))} depth</div>
        </div>
      </div>
      <div style="display:flex;gap:6px">
        <button type="button" class="btn agent-go" style="--c:${col}" data-stat-chat="${esc(a.id)}">Chat with ${esc(a.name)}</button>
        <button type="button" class="btn ghost" data-stat-close>Close</button>
      </div>
    </div>
    <div class="stats-detail-list">
      ${recent.length
        ? recent.map((t) => `<button type="button" class="stats-detail-task" data-jump-task="${esc(t.id)}"><span>${esc(t.title)}</span><span class="muted small mono">${t.startedAt && t.finishedAt ? fmtMs(Date.parse(t.finishedAt) - Date.parse(t.startedAt)) : ago(Date.parse(t.createdAt))}</span></button>`).join("")
        : `<div class="muted small">No recent finished tasks for ${esc(a.name)} yet.</div>`}
    </div>`;
}

function renderRanks() {
  const baseRows = [...(S.lb[S.period] ?? [])];
  const rows = baseRows.sort((a, b) => metricValue(b, S.statMetric) - metricValue(a, S.statMetric) || b.done - a.done);
  const totalDone = rows.reduce((s, r) => s + r.done, 0);
  const totalTok = rows.reduce((s, r) => s + r.tokens, 0);
  const cost = S.kpis.costMonth ?? 0;
  const totalFailed = rows.reduce((s, r) => s + (r.failed ?? 0), 0);
  const timed = rows.filter((r) => r.avgMs > 0 && r.done > 0);
  const timedDone = timed.reduce((s, r) => s + r.done, 0);
  const avgMs = timedDone ? timed.reduce((s, r) => s + r.avgMs * r.done, 0) / timedDone : 0;
  const success = totalDone + totalFailed ? Math.round((totalDone / (totalDone + totalFailed)) * 100) : null;
  const tile = (value, label, tone = "") => `<div class="stat-box ${tone}"><span>${label}</span><b>${value}</b></div>`;
  $("#statsSummary").innerHTML = [
    tile(totalDone, "Completed", "t-a"),
    tile(fmtK(totalTok), "Tokens used", "t-b"),
    tile(avgMs ? fmtMs(avgMs) : "—", "Avg speed", "t-c"),
    tile(success === null ? "—" : `${success}%`, "Success rate", "t-d"),
    ...(cost > 0 ? [tile(fmtUsd(cost), "Month spend", "t-e")] : []),
  ].join("");

  const podiumEl = $("#podium");
  const eligible = rows.filter((r) => metricValue(r, S.statMetric) > 0);
  if (!eligible.length) {
    podiumEl.hidden = true;
  } else {
    podiumEl.hidden = false;
    const top = eligible.slice(0, 3);
    const max = Math.max(1e-9, ...top.map((r) => metricValue(r, S.statMetric)));
    const order = [top[1], top[0], top[2]];
    podiumEl.innerHTML = order
      .map((r, i) => {
        if (!r) return `<div></div>`;
        const a = agentById(r.agentId);
        const place = i === 1 ? 1 : i === 0 ? 2 : 3;
        // Podium steps always read 1st > 2nd > 3rd; the value nudges height within each step.
        const base = place === 1 ? 62 : place === 2 ? 48 : 38;
        const h = base * (0.82 + 0.18 * (Math.max(0, metricValue(r, S.statMetric)) / max));
        const av = a ? `<span class="pod-av">${renderPortraitContent(a, false, true)}</span>` : "";
        return `<button type="button" class="step place-${place} ${S.selectedStatAgent === r.agentId ? "selected" : ""}" style="--c:${safeColor(a?.color)}" data-stat-agent="${esc(r.agentId)}" title="Inspect ${esc(a?.name ?? r.agentId)}'s recent work">
          <div class="who">${av}<b>${esc(a?.name ?? r.agentId)}</b></div>
          <div class="col" style="height:${h.toFixed(1)}%"><span class="medal" aria-label="Place ${place}">${place}</span><span class="val">${esc(metricLabel(r, S.statMetric))}</span></div></button>`;
      })
      .join("");
  }

  $("#rankTable").innerHTML =
    `<div class="rrow head"><span>#</span><span>Assistant</span><span class="num">${S.statMetric === "tokens" ? "Tokens" : '<span class="lbl-full">Completed</span><span class="lbl-short">Done</span>'}</span><span class="num"><span class="lbl-full">Reliability</span><span class="lbl-short">OK</span></span><span class="num"><span class="lbl-full">Avg speed</span><span class="lbl-short">Speed</span></span></div>` +
    rows
      .map((r, i) => {
        const a = agentById(r.agentId);
        const p = personaOf(a);
        const sel = S.selectedStatAgent === r.agentId;
        return `<button type="button" class="rrow clickable ${sel ? "selected" : ""}" style="--c:${safeColor(a?.color)}" data-stat-agent="${esc(r.agentId)}"><span class="n">${i + 1}</span>
          <span class="a"><span class="dot" style="--c:${safeColor(a?.color)}"></span><span>${esc(a?.name ?? r.agentId)} <span class="role-sub">· ${esc(p.role)}</span></span></span>
          <span class="num">${S.statMetric === "tokens" ? fmtK(r.tokens) : r.done}</span>
          <span class="num">${r.done + r.failed ? Math.round(r.successRate * 100) + "%" : "—"}</span>
          <span class="num">${r.avgMs ? fmtMs(r.avgMs) : "—"}</span></button>`;
      })
      .join("");
  renderStatsDetail();
}

$("#rankSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-p]");
  if (!b) return;
  S.period = b.dataset.p;
  $$("#rankSeg button").forEach((x) => {
    const on = x === b;
    x.classList.toggle("on", on);
    x.setAttribute("aria-selected", String(on));
  });
  renderRanks();
});
$("#rankMetricSeg")?.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-m]");
  if (!b) return;
  S.statMetric = b.dataset.m;
  $$("#rankMetricSeg button").forEach((x) => {
    const on = x === b;
    x.classList.toggle("on", on);
    x.setAttribute("aria-selected", String(on));
  });
  renderRanks();
});
const onStatSelect = (e) => {
  const b = e.target.closest("[data-stat-agent]");
  if (!b) return;
  const id = b.dataset.statAgent;
  S.selectedStatAgent = S.selectedStatAgent === id ? null : id;
  renderRanks();
};
$("#podium")?.addEventListener("click", onStatSelect);
$("#rankTable")?.addEventListener("click", onStatSelect);
$("#statsDetail")?.addEventListener("click", (e) => {
  if (e.target.closest("[data-stat-close]")) { S.selectedStatAgent = null; renderRanks(); return; }
  const chatBtn = e.target.closest("[data-stat-chat]");
  if (chatBtn) { focusAgent(chatBtn.dataset.statChat, { switchTab: true }); return; }
  const jump = e.target.closest("[data-jump-task]");
  if (jump) jumpToTask(jump.dataset.jumpTask);
});

// ------------------------------------------------------------------ thread header crew strip
function renderCrewStrip() {
  const el = $("#crewStrip");
  if (!el) return;
  el.innerHTML = S.agents
    .map((a) => {
      const p = personaOf(a);
      const working = !activeTaskFor(a.id)?.awaitingApproval && (a.status === "working" || S.previewWork.has(a.id));
      const cls = working ? "working" : a.status === "idle" && a.live ? "online" : a.status;
      return `<button type="button" class="strip-pip ${esc(cls)} ${S.target === a.id ? "on" : ""}" style="--c:${safeColor(a.color)}" data-strip-target="${esc(a.id)}" title="${esc(a.name)} · ${esc(p.role)}" aria-label="Chat with ${esc(a.name)}">
        <span class="pip-stage">${renderPortraitContent(a, working, true)}</span>
        <i aria-hidden="true"></i>
      </button>`;
    })
    .join("");
}
$("#crewStrip").addEventListener("click", (e) => {
  const b = e.target.closest("[data-strip-target]");
  if (b) focusAgent(b.dataset.stripTarget);
});

// ------------------------------------------------------------------ thread / chat
function stateLabel(t) {
  return { queued: "waiting", running: "working", done: "done", failed: "failed", blocked: "blocked", cancelled: "stopped" }[t.status] ?? t.status;
}

function thinking(t, label) {
  const since = t.startedAt ?? t.createdAt;
  return `<div class="thinking"><span class="bars"><i></i><i></i><i></i></span>${esc(label)}… <span class="mono small" data-since="${esc(since)}">${fmtMs(Date.now() - Date.parse(since))}</span></div>`;
}

function detailTextFor(t, a) {
  const modelText = t.servedModel || shortModel(t.model ?? a?.model ?? "", a);
  const tok = t.usage ? `${fmtK(t.usage.input + t.usage.output)} tokens` : "";
  const cost = t.costUsd ? fmtUsd(t.costUsd) : "";
  return [modelText, t.reasoning ? `depth: ${levelLabel(t.reasoning)}` : "", tok, cost].filter(Boolean).join(" · ");
}

function handoffOptionsFor(t) {
  const fromName = t.kind === "goal" ? "the team" : nameOf(t.agentId);
  const enabled = new Set(S.agents.filter((a) => a.enabled).map((a) => a.id));
  const opts = [];
  if (enabled.has("zen") && t.agentId !== "zen") {
    opts.push({ agent: "zen", label: "→ Zen review", prompt: `@zen Pressure-test and critique the reply above from ${fromName}. Call out the biggest flaw and cleanest fix.` });
  }
  if (enabled.has("muse") && t.agentId !== "muse") {
    opts.push({ agent: "muse", label: "→ Muse polish", prompt: `@muse Rewrite the reply above from ${fromName} to be sharper, punchier, and more memorable.` });
  }
  if (enabled.has("cline") && t.agentId !== "cline") {
    opts.push({ agent: "cline", label: "→ Cline build", prompt: `@cline Turn the reply above from ${fromName} into clean, working code or commands.` });
  }
  if (enabled.has("hermes") && t.agentId !== "hermes") {
    opts.push({ agent: "hermes", label: "→ Hermes plan", prompt: `@hermes Turn the reply above from ${fromName} into a crisp step-by-step action plan.` });
  }
  opts.push({
    agent: t.kind === "goal" ? "muse" : t.agentId,
    label: "Shorter",
    prompt: `@${t.kind === "goal" ? (enabled.has("muse") ? "muse" : S.lead) : t.agentId} Condense the reply above into 3 crisp bullet points.`,
  });
  return opts.slice(0, 5);
}

function footer(t, a) {
  const dur = t.startedAt && t.finishedAt ? fmtMs(Date.parse(t.finishedAt) - Date.parse(t.startedAt)) : "";
  const cancel = t.status === "running" || t.status === "queued" ? `<button type="button" data-cancel="${esc(t.id)}">Stop</button>` : "";
  const copy = t.status === "done" && t.result ? `<button type="button" data-copy="${esc(t.id)}">Copy</button>` : "";
  const rerun = t.status === "done" || t.status === "failed" || t.status === "blocked" || t.status === "cancelled"
    ? `<button type="button" data-rerun="${esc(t.id)}">Re-run</button>`
    : "";
  const handoffOpen = S.openHandoffMsg === t.id;
  const handoffBtn = t.status === "done" && t.result
    ? `<button type="button" data-toggle-handoff="${esc(t.id)}">${handoffOpen ? "Close handoff" : "Hand off ▾"}</button>`
    : "";
  const detailText = detailTextFor(t, a);
  const showDetails = S.detailMsgs.has(t.id);
  const detailsBtn = detailText && t.status === "done"
    ? `<button type="button" data-toggle-detail="${esc(t.id)}">${showDetails ? "Hide details" : "Details"}</button>`
    : "";
  const detailLine = detailText ? `<div class="afoot-detail" ${showDetails ? "" : "hidden"}>${esc(detailText)}</div>` : "";
  const handoffTray = t.status === "done" && t.result
    ? `<div class="handoff-tray" ${handoffOpen ? "" : "hidden"}>${handoffOptionsFor(t)
        .map((o) => `<button type="button" class="handoff-chip" style="--c:${colorOf(o.agent)}" data-handoff-cmd="${esc(o.prompt)}"><span class="dot"></span>${esc(o.label)}</button>`)
        .join("")}</div>`
    : "";
  return `<div class="afoot">${dur ? `<span>${dur}</span>` : ""}${copy}${handoffBtn}${rerun}${detailsBtn}${cancel}${handoffTray}${detailLine}</div>`;
}

function collapsibleBody(id, html, rawText) {
  const long = isLongReply(rawText);
  const open = S.expandedMsgs.has(id);
  if (!long) return `<div class="body">${html}</div>`;
  return `<div class="body-wrap ${open ? "" : "clamped"}"><div class="body">${html}</div></div>
    <button type="button" class="expand-btn" data-expand-msg="${esc(id)}">${open ? "Show less" : "Read full reply"}</button>`;
}

function agentBubble(t) {
  const a = agentById(t.agentId);
  const p = personaOf(a);
  const col = safeColor(a?.color);
  const working = t.status === "running" || t.status === "queued";
  const head = `<div class="ahead">
    <span class="mini-av" style="--c:${col}">${renderPortraitContent(a ?? { id: t.agentId, name: t.agentId }, working, true)}</span>
    ${brandBadgeMarkup(a, "sm")}
    <span class="nm">${esc(a?.name ?? t.agentId)}</span>
    <span class="role-pill">${esc(p.role)}</span>
  </div>`;
  const reroute = t.reroutedFrom ? `<div class="reroute">↪ Picked up from ${esc(nameOf(t.reroutedFrom))}</div>` : "";
  let body;
  if (t.status === "done") body = collapsibleBody(t.id, md(t.result), t.result);
  else if (t.awaitingApproval) body = `<div class="needs-ok">Waiting for your OK above (or in Telegram)</div>`;
  else if (t.status === "running" || t.status === "queued") body = thinking(t, t.status === "queued" ? "In line" : `${a?.name ?? "Assistant"} is ${p.thinking.toLowerCase()}`);
  else body = `<div class="err-text">${esc(stateLabel(t))}: ${esc(t.error ?? "")}</div>`;
  return `<div class="msg bot" data-task-id="${esc(t.id)}"><div class="bubble" style="--c:${col}">${head}${reroute}${body}${footer(t, a)}</div></div>`;
}

function goalBubble(t) {
  const lead = agentById(t.agentId);
  const kids = [...S.tasks.values()].filter((c) => c.parentId === t.id).sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
  const subtasks = kids.filter((c) => c.kind === "subtask");
  const doneSteps = subtasks.filter((c) => c.status === "done").length;
  const label = (c) => (c.kind === "plan" ? "Plan" : c.kind === "synthesis" ? "Summary" : nameOf(c.agentId));
  const stepState = (c) => (c.awaitingApproval ? "Needs OK" : c.status === "queued" && c.after?.length ? "Waiting" : stateLabel(c));
  const progressLine = subtasks.length
    ? `<div class="team-progress"><span class="muted small">${doneSteps} of ${subtasks.length} steps done</span>${subtasks.some((c) => c.reroutedFrom) ? '<span class="reroute" style="margin:0">↪ teammate stepped in</span>' : ""}</div>`
    : "";
  const steps = kids.length
    ? `<div class="steps">${progressLine}${kids
        .map((c) => {
          const ca = agentById(c.agentId);
          const cWorking = c.status === "running";
          const isOpen = S.openSteps.has(c.id) || c.status === "failed" || c.status === "blocked";
          return `<details data-step-id="${esc(c.id)}"${isOpen ? " open" : ""}><summary><span class="mini-av step-av" style="--c:${colorOf(c.agentId)}">${renderPortraitContent(ca ?? { id: c.agentId, name: c.agentId }, cWorking, true)}</span><span class="sname">${esc(label(c))}</span>
            <span class="stitle">${esc(c.kind === "subtask" ? c.title : nameOf(c.agentId))}</span><span class="sstate ${c.awaitingApproval ? "ask" : esc(c.status)}">${esc(stepState(c))}</span></summary>
            <div class="sbody body">${c.status === "done" ? (c.kind === "plan" ? `<pre><code>${esc(c.result)}</code></pre>` : md(c.result)) : c.error ? `<span class="err-text">${esc(c.error)}</span>` : "Working…"}</div></details>`;
        })
        .join("")}</div>`
    : "";
  let body;
  if (t.status === "done") body = collapsibleBody(t.id, md(t.result), t.result);
  else if (t.status === "running" || t.status === "queued") {
    const activeSub = subtasks.find((c) => c.status === "running");
    const stage = kids.some((c) => c.kind === "synthesis")
      ? `${lead?.name ?? "Lead"} wrapping up`
      : activeSub
        ? `${nameOf(activeSub.agentId)} is ${personaOf(agentById(activeSub.agentId)).thinking.toLowerCase()}`
        : `${lead?.name ?? "Lead"} planning the steps`;
    body = thinking(t, stage);
  } else body = `<div class="err-text">${esc(stateLabel(t))}: ${esc(t.error ?? "")}</div>`;
  return `<div class="msg bot" data-task-id="${esc(t.id)}"><div class="bubble" style="--c:var(--accent)">
    <div class="ahead"><span class="dot" style="--c:var(--accent);background:conic-gradient(var(--a1) 0 33%,var(--a2) 0 66%,var(--a3) 0)"></span><span class="nm">Team</span><span class="role-pill">Led by ${esc(lead?.name ?? "")}</span></div>
    ${steps}${body}${footer(t, lead)}</div></div>`;
}

function userBubble(text, meta, cls = "") {
  return `<div class="msg user${cls}"><div class="meta">${meta}</div><div class="bubble">${esc(text)}</div></div>`;
}

const TRIES = [
  ["@team", "Team mission", "Research what's new in AI today, pitch 3 video hooks, and pick the strongest one"],
  ["@grok", "Live scout", "What's actually moving on X right now?"],
  ["@muse", "Creative", "Give me 3 punchy hooks for a short video"],
  ["@hermes", "Operator", "Help me organize my top 3 priorities today"],
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
    el.innerHTML = `<div class="welcome"><h3>Your crew is <em>ready.</em></h3>
      <p>Pick an assistant, drop a goal for the whole team, or click a starter below.</p>
      <div class="tries">${TRIES.filter(([who]) => who === "@team" || ids.has(who.slice(1)))
        .map(([who, tag, text]) => `<button type="button" class="try" data-try="${esc(`${who} ${text}`)}"><span><b>${esc(tag)}</b> ${esc(text)}</span><span class="muted">→</span></button>`)
        .join("")}</div></div>`;
    return;
  }
  el.innerHTML = items
    .map(({ t, n, at }) => {
      if (n) {
        const cls = enter("thread", `note:${at}`);
        return userBubble(n.text, clock(new Date(at).toISOString()), cls) + `<div class="msg sys${cls}"><div class="bubble">${esc(n.reply)}</div></div>`;
      }
      const chan = t.channel === "telegram" ? "Telegram · " : t.channel === "imessage" ? "iMessage · " : "";
      const to = t.kind === "goal" ? "Team" : nameOf(t.reroutedFrom ?? t.agentId);
      const meta = `${chan}${clock(t.createdAt)} · To ${esc(to)}`;
      const cls = enter("thread", t.id);
      const reply = (t.kind === "goal" ? goalBubble(t) : agentBubble(t)).replace('<div class="msg bot"', `<div class="msg bot${cls}"`);
      return userBubble(t.display ?? t.prompt, meta, cls) + reply;
    })
    .join("");
  if (nearBottom || renderThread.forceBottom) {
    el.scrollTop = el.scrollHeight;
    renderThread.forceBottom = false;
  }
}

// Persist user-toggled team steps across SSE re-renders
$("#thread").addEventListener("toggle", (e) => {
  const det = e.target;
  if (!(det instanceof HTMLDetailsElement) || !det.dataset.stepId) return;
  if (det.open) S.openSteps.add(det.dataset.stepId);
  else S.openSteps.delete(det.dataset.stepId);
}, true);

$("#thread").addEventListener("click", async (e) => {
  const tryBtn = e.target.closest("[data-try]");
  if (tryBtn) { $("#input").value = tryBtn.dataset.try; autosize(); $("#input").focus(); return; }
  // Toggle long replies in-place (no scroll jump!)
  const exp = e.target.closest("[data-expand-msg]");
  if (exp) {
    const id = exp.dataset.expandMsg;
    const next = !S.expandedMsgs.has(id);
    if (next) S.expandedMsgs.add(id);
    else S.expandedMsgs.delete(id);
    exp.previousElementSibling?.classList.toggle("clamped", !next);
    exp.textContent = next ? "Show less" : "Read full reply";
    return;
  }
  // Toggle inline handoff tray without scroll jump
  const ho = e.target.closest("[data-toggle-handoff]");
  if (ho) {
    const id = ho.dataset.toggleHandoff;
    const next = S.openHandoffMsg !== id;
    S.openHandoffMsg = next ? id : null;
    $$("#thread .handoff-tray").forEach((el) => { el.hidden = true; });
    $$("#thread [data-toggle-handoff]").forEach((el) => { el.textContent = "Hand off ▾"; });
    if (next) {
      ho.textContent = "Close handoff";
      const tray = ho.closest(".afoot")?.querySelector(".handoff-tray");
      if (tray) tray.hidden = false;
    }
    return;
  }
  const hoCmd = e.target.closest("[data-handoff-cmd]");
  if (hoCmd) {
    S.openHandoffMsg = null;
    $("#input").value = hoCmd.dataset.handoffCmd;
    autosize();
    $("#composer").requestSubmit();
    SFX.play("baton");
    return;
  }
  const rerunBtn = e.target.closest("[data-rerun]");
  if (rerunBtn) {
    retryTask(rerunBtn.dataset.rerun);
    return;
  }
  // Toggle footer details in-place
  const det = e.target.closest("[data-toggle-detail]");
  if (det) {
    const id = det.dataset.toggleDetail;
    const next = !S.detailMsgs.has(id);
    if (next) S.detailMsgs.add(id);
    else S.detailMsgs.delete(id);
    det.textContent = next ? "Hide details" : "Details";
    const box = det.closest(".afoot")?.querySelector(".afoot-detail");
    if (box) box.hidden = !next;
    return;
  }
  const codeBtn = e.target.closest("[data-copy-code]");
  if (codeBtn) {
    const pre = codeBtn.parentElement?.querySelector("code");
    if (pre) await copyText(pre.textContent || "", "Code copied");
    return;
  }
  const c = e.target.closest("[data-cancel]");
  if (c) {
    try {
      await api(`/api/tasks/${c.dataset.cancel}/cancel`, { method: "POST" });
      toast("Stopping…");
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  const cp = e.target.closest("[data-copy]");
  if (cp) {
    const t = S.tasks.get(cp.dataset.copy);
    await copyText(t?.result ?? "", "Copied");
  }
});

$("#threadFilter")?.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-f]");
  if (!b) return;
  S.filter = b.dataset.f;
  renderThreadFilter();
  renderThread.forceBottom = true;
  renderThread();
});

// ------------------------------------------------------------------ composer + keyboard slash menu
function renderTargets() {
  if (S.target !== "auto" && S.target !== "team" && !agentById(S.target)) S.target = "auto";
  const chips = [
    { id: "auto", name: "Auto", cls: "", color: "var(--muted)" },
    { id: "team", name: "Team", cls: "team", color: "var(--accent)" },
    ...S.agents.map((a) => ({ id: a.id, name: a.name, cls: a.status === "working" ? "busy" : "", color: safeColor(a.color), off: !a.enabled })),
  ];
  $("#targets").innerHTML = chips
    .map((c) => `<button type="button" class="target ${c.cls} ${S.target === c.id ? "on" : ""}" data-target="${esc(c.id)}" style="--c:${c.color}${c.off ? ";opacity:.45" : ""}"><span class="dot"></span>${esc(c.name)}</button>`)
    .join("");
  const a = agentById(S.target);
  $("#input").placeholder = S.target === "auto"
    ? "Ask anything — auto-picks the best fit…"
    : S.target === "team"
      ? "Give the team a multi-step goal…"
      : personaOf(a).placeholder;
}

function renderActiveBar() {
  const bar = $("#activeBar");
  if (!bar) return;
  const activeEl = document.activeElement;
  if (activeEl && activeEl.matches("#activeBar select")) return;

  if (S.target === "auto" || S.target === "team") { bar.hidden = true; return; }
  const a = agentById(S.target);
  if (!a) { bar.hidden = true; return; }
  bar.hidden = false;
  const p = personaOf(a);
  const col = safeColor(a.color);
  const opts = Array.from(new Set([a.model, ...(a.modelOptions ?? [])]));
  const modelSel = opts.length > 1
    ? `<select class="inline-select" data-model-for="${esc(a.id)}" style="--c:${col}" aria-label="Model for ${esc(a.name)}">${modelOptionsMarkup(a)}</select>`
    : `<span class="chip">${esc(shortModel(a.model, a))}</span>`;
  const rSel = `<select class="inline-select reasoning" data-reasoning-for="${esc(a.id)}" style="--c:${col}" aria-label="Depth for ${esc(a.name)}">${LEVELS.map((l) => `<option value="${l}" ${a.reasoning === l ? "selected" : ""}>${levelLabel(l)}</option>`).join("")}</select>`;
  bar.innerHTML = `<div class="active-bar-who">
      <span class="dot" style="--c:${col}"></span>
      <b>${esc(a.name)}</b>
      <span>${esc(p.role)}</span>
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
  if (rSel) void quickUpdateAgent(rSel.dataset.reasoningFor, { reasoning: rSel.value }, rSel);
});

$("#targets").addEventListener("click", (e) => {
  const b = e.target.closest("[data-target]");
  if (b) focusAgent(b.dataset.target);
});

const COMMANDS = [
  ["/doctor", "Run a full health check"],
  ["/agents", "See models and usage"],
  ["/status", "What's running right now"],
  ["/team ", "Start a team mission"],
  ["/inbox", "Check recent email (read-only)"],
  ["/inbox summary", "Summarize urgent email"],
  ["/approvals", "Pending approvals"],
  ["/help", "Show all commands"],
];

let slashIdx = 0;
let slashHits = [];

function autosize() {
  const t = $("#input");
  t.style.height = "auto";
  t.style.height = Math.min(160, t.scrollHeight) + "px";
}

function renderSlash() {
  const v = $("#input").value;
  const box = $("#slash");
  const lower = v.toLowerCase();
  if (lower.startsWith("@") && !/\s/.test(lower)) {
    const q = lower.slice(1);
    const mentions = [
      { cmd: "@team ", label: "@team", sub: "Split a goal across the crew", avatar: null, color: "var(--accent)" },
      ...S.agents.map((a) => ({
        cmd: `@${a.id} `,
        label: `@${a.id}`,
        sub: `${a.name} · ${personaOf(a).role}`,
        agent: a,
        color: safeColor(a.color),
      })),
    ].filter((m) => m.label.slice(1).includes(q) || m.sub.toLowerCase().includes(q));
    slashHits = mentions.map((m) => [m.cmd, m.sub, m]);
    if (!slashHits.length) { box.hidden = true; return; }
    slashIdx = Math.max(0, Math.min(slashIdx, slashHits.length - 1));
    box.hidden = false;
    box.innerHTML = slashHits
      .map(([c, d, m], i) => `<button type="button" role="option" aria-selected="${i === slashIdx}" class="mention-opt ${i === slashIdx ? "on" : ""}" data-cmd="${esc(c)}">
        <span class="mention-av" style="--c:${m.color}">${m.agent ? renderPortraitContent(m.agent, false, true) : '<span class="dot" style="background:conic-gradient(var(--a1) 0 33%,var(--a2) 0 66%,var(--a3) 0)"></span>'}</span>
        <code>${esc(m.label)}</code><span>${esc(d)}</span></button>`)
      .join("");
    return;
  }
  if (!lower.startsWith("/")) { box.hidden = true; slashHits = []; return; }
  slashHits = COMMANDS.filter(([c]) => c.toLowerCase().startsWith(lower));
  if (!slashHits.length || (slashHits.length === 1 && slashHits[0][0].toLowerCase() === lower)) {
    box.hidden = true;
    return;
  }
  slashIdx = Math.max(0, Math.min(slashIdx, slashHits.length - 1));
  box.hidden = false;
  box.innerHTML = slashHits
    .map(([c, d], i) => `<button type="button" role="option" aria-selected="${i === slashIdx}" class="${i === slashIdx ? "on" : ""}" data-cmd="${esc(c)}"><code>${esc(c.trim())}</code><span>${esc(d)}</span></button>`)
    .join("");
}

function pickSlash(cmd) {
  $("#input").value = cmd;
  $("#slash").hidden = true;
  slashHits = [];
  autosize();
  $("#input").focus();
  if (!cmd.endsWith(" ")) $("#composer").requestSubmit();
}

$("#slash").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cmd]");
  if (b) pickSlash(b.dataset.cmd);
});
document.addEventListener("click", (e) => {
  if (!$("#slash").hidden && !e.target.closest("#composer")) $("#slash").hidden = true;
});
$("#input").addEventListener("input", () => { slashIdx = 0; autosize(); renderSlash(); });
$("#input").addEventListener("keydown", (e) => {
  const slashOpen = !$("#slash").hidden && slashHits.length > 0;
  if (slashOpen) {
    if (e.key === "ArrowDown") { e.preventDefault(); slashIdx = (slashIdx + 1) % slashHits.length; renderSlash(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); slashIdx = (slashIdx - 1 + slashHits.length) % slashHits.length; renderSlash(); return; }
    if (e.key === "Tab") { e.preventDefault(); pickSlash(slashHits[slashIdx][0]); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      pickSlash(slashHits[slashIdx][0]);
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
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
  if (S.filter !== "all" && S.filter !== "web") {
    S.filter = "all";
    renderThreadFilter();
  }
  $("#input").value = "";
  autosize();
  $("#slash").hidden = true;
  renderThread.forceBottom = true;

  const isSlowCmd = /^\/(doctor|health|check|inbox|email|mail)\b/i.test(text);
  const pendingNote = isSlowCmd ? { at: Date.now(), text: raw, reply: "Checking…" } : null;
  if (pendingNote) { S.notes.push(pendingNote); renderThread(); }

  try {
    const res = await api("/api/command", { method: "POST", body: JSON.stringify({ text }) });
    if (pendingNote) {
      pendingNote.reply = res.reply;
      renderThread();
    } else if (!res.taskId) {
      S.notes.push({ at: Date.now(), text: raw, reply: res.reply });
      renderThread();
    }
  } catch (err) {
    if (pendingNote) {
      S.notes = S.notes.filter((n) => n !== pendingNote);
      renderThread();
    }
    if (err.message !== "locked") {
      if (!$("#input").value.trim()) { $("#input").value = raw; autosize(); }
      toast(err.message);
    }
  }
});

// ------------------------------------------------------------------ clean settings drawer
function quotaBoxLine(pq) {
  if (!pq) return "";
  if (!pq.live) return pq.note ? `<br><span class="small">${esc(pq.note)}</span>` : "";
  const parts = [];
  if (typeof pq.creditsRemainingUsd === "number") parts.push(`<b>${fmtUsd(pq.creditsRemainingUsd)}</b> left`);
  if (pq.windows?.length) parts.push(pq.windows.map((w) => `${esc(w.label)} <b>${Math.round(w.usedPercent)}%</b>`).join(" · "));
  return parts.length ? `<br><span class="small">${esc(pq.provider)}: ${parts.join(" · ")}</span>` : "";
}

let drawerTrigger = null;

function openEditor(id, triggerEl = null) {
  const a = agentById(id);
  if (!a) return;
  const p = personaOf(a);
  const col = safeColor(a.color);
  S.editing = id;
  drawerTrigger = triggerEl || document.activeElement;
  const d = $("#drawer");
  d.style.setProperty("--c", col);
  const opts = Array.from(new Set([a.model, ...(a.modelOptions ?? [])]));
  const avState = a.status === "working" ? "working" : a.status === "idle" && a.live ? "online" : a.status;
  d.innerHTML = `
    <div class="drawer-head">
      <div class="avatar lg ${esc(avState)}" id="drawerAvatar" style="--c:${col}">
        <span class="aura" aria-hidden="true"></span>
        <span class="sparks" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="avatar-stage">${renderPortraitContent(a, a.status === "working")}</span>
        <i class="presence-dot" aria-hidden="true"></i>
      </div>
      <div>
        <div class="agent-name-row">${brandBadgeMarkup(a)}<h3>${esc(a.name)}</h3></div>
        <div class="muted small">${esc(p.role)}</div>
        <div class="preview-row">
          <div class="preview-toggle" id="avatarPreviewToggle" role="group" aria-label="Preview avatar state">
            <button type="button" data-av-mode="idle" class="${a.status === "working" ? "" : "on"}">Ready</button>
            <button type="button" data-av-mode="working" class="${a.status === "working" ? "on" : ""}">Working</button>
          </div>
        </div>
      </div>
      <button type="button" class="icon-btn x" data-close aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </div>
    <form class="drawer-body" id="editForm">
      <div class="grid2">
        <div class="field"><label for="fRole">Role</label><input class="input" id="fRole" value="${esc(p.role)}" maxlength="60" /></div>
        <div class="field">
          <label for="fModelPick">Model</label>
          <select class="input" id="fModelPick">${modelOptionsMarkup(a)}</select>
        </div>
      </div>

      <div class="field">
        <label for="fMotto">Signature motto</label>
        <input class="input" id="fMotto" value="${esc(p.motto)}" maxlength="140" />
      </div>

      <div class="field">
        <label for="fTraits">Character traits (up to 4, comma-separated)</label>
        <input class="input" id="fTraits" value="${esc(p.traits.join(", "))}" />
      </div>

      <div class="field">
        <label for="fPersonality">Personality summary</label>
        <textarea class="input short" id="fPersonality" rows="2" maxlength="220">${esc(p.vibe)}</textarea>
      </div>

      <div class="field">
        <label for="fSystem">Voice &amp; instructions</label>
        <textarea class="input" id="fSystem" required maxlength="2400">${esc(a.system || "")}</textarea>
      </div>

      <div class="field">
        <span class="lbl">Thinking depth</span>
        <div class="levels" id="fLevels">${LEVELS.map((l) => `<button type="button" data-level="${l}" class="${a.reasoning === l ? "on" : ""}">${think(l)}${levelLabel(l)}</button>`).join("")}</div>
      </div>

      <label class="switch"><span><b>Active</b><br><span class="muted small">Paused assistants sit out of rotation.</span></span><input type="checkbox" id="fOn" ${a.enabled ? "checked" : ""}/></label>

      <details class="adv-box">
        <summary>Advanced · limits, skills &amp; connection</summary>
        <div class="adv-inner">
          <div class="conn-box">${a.live ? (a.online === false ? `<span class="err-text">●</span> <b>${esc(a.connectorLabel)}</b> is offline.` : `● Connected via <b>${esc(a.connectorLabel)}</b>${a.billing ? ` · ${esc(BILL_HELP[a.billing])}` : ""}${quotaBoxLine(a.providerQuota)}`) : `◌ <b>${esc(a.connectorLabel)}</b>`}</div>
          <div class="field">
            <label for="fModel">Custom model ID</label>
            <input class="input mono" id="fModel" list="modelList" value="${esc(a.model)}" required spellcheck="false" />
            <datalist id="modelList">${opts.map((m) => `<option value="${esc(m)}"></option>`).join("")}</datalist>
          </div>
          ${a.supportsProvider ? `<div class="field"><label for="fProv">Provider</label><input class="input mono" id="fProv" value="${esc(a.provider)}" placeholder="${esc(a.discoveredProvider || "default")}" spellcheck="false" /></div>` : ""}
          <div class="grid3">
            <div class="field"><label for="fReq">Daily asks</label><input class="input mono" id="fReq" type="number" min="0" step="1" value="${a.limits.dailyRequests}"/></div>
            <div class="field"><label for="fTok">Daily tokens</label><input class="input mono" id="fTok" type="number" min="0" step="1000" value="${a.limits.dailyTokens}"/></div>
            <div class="field"><label for="fBud">Budget $/mo</label><input class="input mono" id="fBud" type="number" min="0" step="1" value="${a.limits.monthlyBudgetUsd}"/></div>
          </div>
          <div class="grid2">
            <div class="field"><label for="fIn">Input $/1M</label><input class="input mono" id="fIn" type="number" min="0" step="0.01" value="${a.pricing.inputPerMTok}"/></div>
            <div class="field"><label for="fOut">Output $/1M</label><input class="input mono" id="fOut" type="number" min="0" step="0.01" value="${a.pricing.outputPerMTok}"/></div>
          </div>
          <div class="field"><label for="fSkills">Auto-routing keywords</label><input class="input" id="fSkills" value="${esc(a.skills.join(", "))}" /></div>
          <div class="grid2">
            <div class="field"><label for="fPar">Parallel tasks</label><input class="input mono" id="fPar" type="number" min="1" max="8" value="${a.maxConcurrent}"/></div>
            <div class="field"><label for="fTag">Best for</label><input class="input" id="fTag" value="${esc(a.tagline)}" maxlength="120"/></div>
          </div>
        </div>
      </details>
    </form>
    <div class="drawer-foot">
      <button type="button" class="btn ghost" id="makeLead" ${a.isLead ? "disabled" : ""}>${a.isLead ? "★ Team lead" : "Make lead"}</button>
      <div style="display:flex;gap:8px"><button type="button" class="btn" data-close>Cancel</button><button type="submit" form="editForm" class="btn primary" id="saveAgent">Save</button></div>
    </div>`;
  $("#scrim").hidden = false;
  d.inert = false;
  d.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => { d.classList.add("open"); $("#fRole")?.focus(); });
}

function closeEditor() {
  const d = $("#drawer");
  d.classList.remove("open");
  d.setAttribute("aria-hidden", "true");
  d.inert = true;
  $("#scrim").hidden = true;
  S.editing = null;
  if (drawerTrigger instanceof HTMLElement && drawerTrigger.isConnected) drawerTrigger.focus();
  drawerTrigger = null;
}
$("#scrim").addEventListener("click", closeEditor);

$("#drawer").addEventListener("keydown", (e) => trapFocus($("#drawer"), e));

$("#drawer").addEventListener("change", (e) => {
  const pick = e.target.closest("#fModelPick");
  if (pick) {
    const a = agentById(S.editing);
    const fModel = $("#fModel");
    if (fModel) fModel.value = pick.value;
    const fProv = $("#fProv");
    if (fProv && a?.discoveredProvider) fProv.value = pick.value === "hermes-agent" ? "" : a.discoveredProvider;
    return;
  }
  const fModel = e.target.closest("#fModel");
  if (fModel) {
    const pickEl = $("#fModelPick");
    if (pickEl && [...pickEl.options].some((o) => o.value === fModel.value.trim())) pickEl.value = fModel.value.trim();
  }
});

async function saveEditor() {
  const form = $("#editForm");
  if (!form || !S.editing) return;
  if (!form.reportValidity()) return;
  const model = $("#fModel").value.trim();
  const system = $("#fSystem").value.trim();
  if (!model) { toast("Model ID is required"); $("#fModel").focus(); return; }
  if (!system) { toast("Voice & instructions cannot be empty"); $("#fSystem").focus(); return; }

  const saveBtn = $("#saveAgent");
  if (saveBtn) saveBtn.disabled = true;
  const n = (sel) => Number($(sel).value || 0);
  const patch = {
    role: $("#fRole").value.trim(),
    motto: $("#fMotto").value.trim(),
    traits: $("#fTraits").value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 4),
    personality: $("#fPersonality").value.trim(),
    system,
    model,
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
    const updated = await api(`/api/agents/${S.editing}`, { method: "PATCH", body: JSON.stringify(patch) });
    const idx = S.agents.findIndex((x) => x.id === updated.id);
    if (idx >= 0) S.agents[idx] = updated;
    dirty.add("agents");
    flush();
    toast(`Saved ${updated.name}`);
    closeEditor();
  } catch (err) {
    toast(err.message);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

$("#drawer").addEventListener("submit", (e) => {
  e.preventDefault();
  void saveEditor();
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
      av.classList.toggle("online", !working && a.status === "idle" && a.live);
    }
    return;
  }
  const lvl = e.target.closest("[data-level]");
  if (lvl) { $$("#fLevels button").forEach((b) => b.classList.toggle("on", b === lvl)); return; }
  const leadBtn = e.target.closest("#makeLead");
  if (leadBtn && S.editing) {
    leadBtn.disabled = true;
    const id = S.editing;
    try {
      await api("/api/lead", { method: "POST", body: JSON.stringify({ agentId: id }) });
      toast(`${nameOf(id)} now leads team missions`);
      closeEditor();
    } catch (err) {
      leadBtn.disabled = false;
      toast(err.message);
    }
  }
});

// ------------------------------------------------------------------ tabs, theme, focus, sound
function setTab(tab, { scrollBottom = true } = {}) {
  document.body.dataset.tab = tab;
  if (tab !== "thread") setView(tab, { syncMobile: false });
  $$("#tabbar button").forEach((b) => b.classList.toggle("on", b.dataset.go === tab));
  if (tab === "thread" && scrollBottom) {
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
  document.querySelector('meta[name="theme-color"]').content = theme === "light" ? "#f4f2eb" : "#0b0c10";
}
applyTheme(store.get("relay-theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"));
$("#themeBtn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  store.set("relay-theme", next);
  applyTheme(next);
});

function applyFocus(on, { persist = false } = {}) {
  S.focusMode = Boolean(on);
  if (persist) store.set("relay-focus", S.focusMode ? "1" : "0");
  document.body.classList.toggle("focus-mode", S.focusMode);
  const btn = $("#focusBtn");
  if (btn) {
    btn.classList.toggle("on", S.focusMode);
    btn.setAttribute("aria-pressed", String(S.focusMode));
  }
}
applyFocus(S.focusMode);
$("#focusBtn")?.addEventListener("click", () => {
  const next = !S.focusMode;
  applyFocus(next, { persist: true });
  const viewName = S.view[0].toUpperCase() + S.view.slice(1);
  toast(next ? "Wide chat on" : `${viewName} view on`);
});

function applySound(on) {
  S.soundOn = Boolean(on);
  const btn = $("#soundBtn");
  if (btn) {
    btn.classList.toggle("on", S.soundOn);
    btn.setAttribute("aria-pressed", String(S.soundOn));
  }
}
applySound(S.soundOn);
$("#soundBtn")?.addEventListener("click", () => {
  const next = !S.soundOn;
  store.set("relay-sound", next ? "1" : "0");
  applySound(next);
  if (next) SFX.play("baton");
  toast(next ? "Sound cues on" : "Sound cues muted");
});

// ------------------------------------------------------------------ Cmd+K palette + unified Escape
const cmdk = { open: false, idx: 0, items: [], trigger: null };

function cmdkCatalog() {
  const out = [
    { group: "Crew", id: "ask-team", title: "Start a Team mission", sub: `${nameOf(S.lead)} coordinates across your crew`, tag: "@team", color: "var(--accent)", iconHtml: "★", run: () => focusAgent("team", { switchTab: true }) },
  ];
  for (const a of S.agents) {
    const p = personaOf(a);
    out.push({
      group: "Crew",
      id: `ask-${a.id}`,
      title: `Chat with ${a.name}`,
      sub: `${p.role} · ${p.vibe}`,
      tag: `@${a.id}`,
      color: safeColor(a.color),
      iconHtml: renderPortraitContent(a, false, true),
      run: () => focusAgent(a.id, { switchTab: true }),
    });
  }
  out.push(
    { group: "Views", id: "v-studio", title: "Go to Studio", sub: "Quick launch and your crew", tag: "view", iconHtml: "⊞", run: () => setView("studio") },
    { group: "Views", id: "v-map", title: "Go to Map", sub: "Live handoffs and team relay", tag: "view", iconHtml: "◎", run: () => setView("map") },
    { group: "Views", id: "v-activity", title: "Go to Activity", sub: "Active, completed, and attention items", tag: "view", iconHtml: "☰", run: () => setView("activity") },
    { group: "Views", id: "v-stats", title: "Go to Stats", sub: "Crew leaderboard and speed", tag: "view", iconHtml: "▲", run: () => setView("stats") },
    { group: "Actions", id: "doctor", title: "Run health check", sub: "Check every assistant and channel", tag: "/doctor", iconHtml: "✓", run: () => { if (matchMedia("(max-width: 960px)").matches) setTab("thread"); $("#input").value = "/doctor"; $("#composer").requestSubmit(); } },
    { group: "Actions", id: "replay", title: "Replay last team relay", sub: "Watch handoffs on the Map", tag: "map", iconHtml: "▶", run: () => { setView("map"); setTimeout(replayLastMission, 120); } },
  );
  for (const a of S.agents) {
    out.push({
      group: "Settings",
      id: `settings-${a.id}`,
      title: `Customize ${a.name}`,
      sub: `Personality, model, depth (${a.enabled ? "active" : "paused"})`,
      tag: "edit",
      color: safeColor(a.color),
      iconHtml: renderPortraitContent(a, false, true),
      run: () => openEditor(a.id),
    });
  }
  out.push(
    { group: "Workspace", id: "toggle-focus", title: S.focusMode ? "Show Studio sidebar" : "Wide chat mode", sub: "Toggle focused full-width chat", tag: "view", iconHtml: "⛶", run: () => $("#focusBtn")?.click() },
    { group: "Workspace", id: "toggle-sound", title: S.soundOn ? "Mute sound cues" : "Enable sound cues", sub: "Subtle dispatch and completion chimes", tag: "audio", iconHtml: S.soundOn ? "🔇" : "🔊", run: () => $("#soundBtn")?.click() },
    { group: "Workspace", id: "toggle-theme", title: "Switch Dark / Light theme", sub: "Change appearance", tag: "theme", iconHtml: "◐", run: () => $("#themeBtn")?.click() },
  );
  return out;
}

function renderCmdk() {
  const q = ($("#cmdkInput")?.value || "").trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const all = cmdkCatalog();
  cmdk.items = terms.length
    ? all.filter((it) => terms.every((t) => `${it.title} ${it.sub} ${it.tag} ${it.group}`.toLowerCase().includes(t)))
    : all;
  cmdk.idx = Math.max(0, Math.min(cmdk.idx, Math.max(0, cmdk.items.length - 1)));
  const list = $("#cmdkList");
  if (!cmdk.items.length) { list.innerHTML = `<div class="cmdk-empty">No matches for “${esc(q)}”</div>`; return; }
  let lastGroup = "";
  list.innerHTML = cmdk.items
    .map((it, i) => {
      const hdr = it.group !== lastGroup ? `<div class="cmdk-group">${esc(it.group)}</div>` : "";
      lastGroup = it.group;
      return `${hdr}<button type="button" class="cmdk-item${i === cmdk.idx ? " on" : ""}" role="option" aria-selected="${i === cmdk.idx}" data-cmdk-i="${i}" style="--c:${safeColor(it.color)}">
        <span class="cmdk-icon">${it.iconHtml}</span>
        <span class="cmdk-main"><span class="cmdk-title">${esc(it.title)}</span><span class="cmdk-sub">${esc(it.sub)}</span></span>
        <span class="cmdk-tag">${esc(it.tag)}</span>
      </button>`;
    })
    .join("");
  list.querySelector(".cmdk-item.on")?.scrollIntoView({ block: "nearest" });
}

function openCmdk() {
  if (!$("#lock").hidden) return;
  cmdk.open = true; cmdk.idx = 0; cmdk.trigger = document.activeElement;
  $("#cmdkWrap").hidden = false;
  $("#cmdkInput").value = "";
  renderCmdk();
  requestAnimationFrame(() => $("#cmdkInput").focus());
}
function closeCmdk({ restoreFocus = true } = {}) {
  cmdk.open = false;
  $("#cmdkWrap").hidden = true;
  if (restoreFocus && cmdk.trigger instanceof HTMLElement && cmdk.trigger.isConnected) cmdk.trigger.focus();
  cmdk.trigger = null;
}
function runCmdk(i) {
  const it = cmdk.items[i];
  if (!it) return;
  closeCmdk({ restoreFocus: false });
  it.run();
}

$("#cmdBtn")?.addEventListener("click", openCmdk);
$("#cmdkWrap")?.addEventListener("click", (e) => {
  if (e.target === $("#cmdkWrap")) return closeCmdk();
  const btn = e.target.closest("[data-cmdk-i]");
  if (btn) runCmdk(Number(btn.dataset.cmdkI));
});
$("#cmdkWrap")?.addEventListener("keydown", (e) => trapFocus($("#cmdkWrap"), e));
$("#cmdkInput")?.addEventListener("input", () => { cmdk.idx = 0; renderCmdk(); });

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    if (!$("#lock").hidden) return;
    e.preventDefault();
    cmdk.open ? closeCmdk() : openCmdk();
    return;
  }
  if (e.key === "Escape") {
    if (cmdk.open) { e.preventDefault(); closeCmdk(); return; }
    if (S.editing) { e.preventDefault(); closeEditor(); return; }
    if (!$("#slash").hidden) { e.preventDefault(); $("#slash").hidden = true; return; }
  }
  if (!cmdk.open) return;
  if (e.key === "ArrowDown") { e.preventDefault(); cmdk.idx = Math.min(cmdk.items.length - 1, cmdk.idx + 1); renderCmdk(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); cmdk.idx = Math.max(0, cmdk.idx - 1); renderCmdk(); }
  else if (e.key === "Enter") { e.preventDefault(); runCmdk(cmdk.idx); }
});

// ------------------------------------------------------------------ approvals
function pendingApprovals() { return S.approvals.filter((a) => a.status === "pending"); }
function untilText(iso) {
  const s = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000));
  return s >= 60 ? `${Math.ceil(s / 60)}m` : `${s}s`;
}

let lastApprovalKey = "";
function renderApprovals() {
  const open = pendingApprovals();
  const key = open.map((a) => `${a.id}:${a.status}:${a.kind}`).join("|");
  const el = $("#approvals");
  const tab = $('#tabbar [data-go="thread"]');
  if (tab) tab.dataset.badge = open.length ? String(open.length) : "";
  // Avoid wiping a focused question input if the pending approval set hasn't changed.
  if (key === lastApprovalKey && el.contains(document.activeElement)) return;
  lastApprovalKey = key;

  const drafts = Object.fromEntries($$("#approvals [data-answer-for]").map((i) => [i.dataset.answerFor, i.value]));
  el.innerHTML = open
    .map((a) => a.kind === "question" ? `<form class="ask-card" style="--c:${colorOf(a.agentId)}" data-question="${esc(a.id)}">
      <div class="ask-head"><span class="dot"></span><b>${esc(a.agentName)} has a question</b></div>
      <div class="ask-detail">${esc(a.detail)}</div>
      <input class="input" data-answer-for="${esc(a.id)}" placeholder="Type your answer…" value="${esc(drafts[a.id] ?? "")}" autocomplete="off" />
      <div class="ask-foot">
        <span class="muted small">Expires in <span data-until="${esc(a.expiresAt)}">${untilText(a.expiresAt)}</span></span>
        <span class="ask-btns"><button type="button" class="btn" data-decide="${esc(a.id)}" data-approve="0">Skip</button><button type="submit" class="btn primary">Send</button></span>
      </div>
    </form>` : `<div class="ask-card" style="--c:${colorOf(a.agentId)}">
      <div class="ask-head"><span class="dot"></span><b>${esc(a.title)}</b></div>
      <div class="ask-detail">${esc(a.detail)}</div>
      <div class="ask-foot">
        <span class="muted small">Auto-denies in <span data-until="${esc(a.expiresAt)}">${untilText(a.expiresAt)}</span></span>
        <span class="ask-btns"><button type="button" class="btn" data-decide="${esc(a.id)}" data-approve="0">Deny</button><button type="button" class="btn primary" data-decide="${esc(a.id)}" data-approve="1">Approve</button></span>
      </div>
    </div>`)
    .join("");
}

$("#approvals").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-decide]");
  if (!b) return;
  b.disabled = true;
  try {
    const a = await api(`/api/approvals/${b.dataset.decide}`, { method: "POST", body: JSON.stringify({ approve: b.dataset.approve === "1" }) });
    toast(a.status === "approved" ? "Approved" : a.status === "denied" ? "Denied" : `Already ${a.status}`);
  } catch (err) {
    b.disabled = false; toast(err.message);
  }
});
$("#approvals").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target.closest("[data-question]");
  if (!form) return;
  const input = form.querySelector("[data-answer-for]");
  const submitBtn = form.querySelector('button[type="submit"]');
  const answer = input.value.trim();
  if (!answer) return input.focus();
  if (submitBtn) submitBtn.disabled = true;
  try {
    const a = await api(`/api/approvals/${form.dataset.question}`, { method: "POST", body: JSON.stringify({ answer }) });
    toast(a.status === "approved" ? `Sent to ${a.agentName}` : `Already ${a.status}`);
  } catch (err) {
    if (submitBtn) submitBtn.disabled = false;
    toast(err.message);
  }
});

$("#kpis").addEventListener("click", (e) => {
  if (!e.target.closest("[data-go-approvals]")) return;
  if (matchMedia("(max-width: 960px)").matches) setTab("thread");
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

async function boot(retryDelay = 2000) {
  try {
    applySnapshot(await api("/api/state"));
    connect();
  } catch (err) {
    if (err.message !== "locked") {
      S.connected = false;
      renderKpis();
      toast(`Can't reach Relay — retrying…`);
      setTimeout(() => void boot(Math.min(10000, retryDelay * 1.5)), retryDelay);
    }
  }
}

setView(S.view, { keepFocus: true, syncMobile: false });
setTab("thread", { scrollBottom: false });
void boot();
