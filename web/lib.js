// Causeway shared helpers: escaping, formatting, safe markdown, the API client, and opt-in sound.
export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
export const safeColor = (c) => (typeof c === "string" && /^#[0-9a-f]{3,8}$/i.test(c.trim()) ? c.trim() : "#22e3d3");
export const safeJson = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
/** Only same-origin asset paths are used for images. */
export const safeAsset = (p) => (typeof p === "string" && /^\/(avatars|logos)\/[\w.-]+$/.test(p) ? p : "");

export const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

// ---------------------------------------------------------------- formatting
export const fmtK = (n = 0) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
export const fmtUsd = (n = 0) => (n > 0 && n < 0.01 ? "<$0.01" : `$${n.toFixed(2)}`);
export function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
export function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (ms < 45_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}
export const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
export function firstLine(text = "", max = 160) {
  const line = String(text).replace(/[#*_`>]/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
export function shortModel(id, a) {
  if (!id) return "";
  if (id === "auto") return "Auto";
  if (id === "hermes-agent") {
    const def = a?.discoveredDefaultModel;
    return def ? `Default (${def.split("/").pop()})` : "Default";
  }
  return id.replace(/^cline-pass\//, "");
}
export const DEPTH = { auto: "Auto", off: "Off", low: "Light", medium: "Balanced", high: "Deep", max: "Max" };
export const LEVELS = ["auto", "off", "low", "medium", "high", "max"];

// ---------------------------------------------------------------- safe markdown (escaped first, then a tiny subset)
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
export function md(src = "") {
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
      if (inCode) { flushCode(); inCode = false; } else { flushPara(); flushList(); inCode = true; codeLines = []; }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const h = /^#{1,4}\s+(.*)$/.exec(line);
    const bq = /^>\s?(.*)$/.exec(line);
    if (/^\s*---+\s*$/.test(line)) { flushPara(); flushList(); out.push("<hr>"); }
    else if (ul || ol) {
      flushPara();
      const tag = ul ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((ul || ol)[1]);
    } else if (h) { flushPara(); flushList(); out.push(`<h4>${inline(h[1])}</h4>`); }
    else if (bq) { flushPara(); flushList(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  if (inCode) flushCode();
  flushPara(); flushList();
  return out.join("");
}

/** The prompt a step received, without the fenced teammate output appended to it. */
export function ownAsk(prompt = "") {
  const i = prompt.indexOf("\n\nResults from earlier steps that you build on");
  const j = prompt.indexOf("\n\nRecent conversation");
  const cut = [i, j].filter((n) => n > 0);
  return cut.length ? prompt.slice(0, Math.min(...cut)) : prompt;
}

/** Parallel waves, same rule as the server: one wave after the latest dependency. */
export function planWaves(steps) {
  const waves = [];
  steps.forEach((s, i) => {
    const deps = (s.after ?? []).filter((d) => d < i);
    waves[i] = deps.length ? Math.max(...deps.map((d) => waves[d])) + 1 : 0;
  });
  return waves;
}

// ---------------------------------------------------------------- API
export function makeApi(getToken, onLocked) {
  return async function api(path, opts = {}) {
    const headers = { "content-type": "application/json" };
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(path, { method: opts.method ?? "GET", body: opts.body ? JSON.stringify(opts.body) : undefined, headers });
    if (res.status === 401) {
      onLocked(opts.unlockAttempt ? "That token didn't work. Check HUB_TOKEN in your .env file." : "");
      throw new Error("locked");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };
}

// ---------------------------------------------------------------- sound (opt-in, real moments only)
export function makeSound(isOn) {
  let ctx = null;
  const ensure = () => {
    if (!isOn() || typeof AudioContext === "undefined") return null;
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
    osc.stop(start + dur + 0.03);
  };
  return {
    play(kind) {
      const c = ensure();
      if (!c) return;
      const t = c.currentTime;
      if (kind === "done") {
        // A short rising sunset chord: run finished.
        tone(c, 392, t, 0.22, 0.03);
        tone(c, 523.25, t + 0.06, 0.26, 0.03);
        tone(c, 783.99, t + 0.12, 0.34, 0.032);
      } else if (kind === "ask") {
        // Two soft taps: something needs your call.
        tone(c, 880, t, 0.1, 0.045, "triangle");
        tone(c, 880, t + 0.16, 0.12, 0.045, "triangle");
      } else if (kind === "block") {
        tone(c, 311.13, t, 0.18, 0.035, "triangle");
      }
    },
  };
}
