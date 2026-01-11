const socket = io();

const statusEl = document.getElementById("status");
const liveStatus = document.getElementById("liveStatus");
const darkToggle = document.getElementById("darkToggle");
const queueBody = document.getElementById("queueBody");
const bansBody = document.getElementById("bansBody");
const logEl = document.getElementById("log");

const ttsToggle = document.getElementById("ttsToggle");
const clearQueue = document.getElementById("clearQueue");
const connectTikTok = document.getElementById("connectTikTok");
const disconnectTikTok = document.getElementById("disconnectTikTok");
const tiktokInfo = document.getElementById("tiktokInfo");
const tiktokError = document.getElementById("tiktokError");

const exactTxt = document.getElementById("exactTxt");
const subTxt = document.getElementById("subTxt");
const saveLists = document.getElementById("saveLists");

const banUser = document.getElementById("banUser");
const banMinutes = document.getElementById("banMinutes");
const banReason = document.getElementById("banReason");
const banBtn = document.getElementById("banBtn");

const THEME_KEY = "theme";
const LIVE_PILL_BASE = "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold shadow-sm transition";
const LIVE_STYLES = {
  online: "border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  offline: "border-slate-200/80 bg-white/70 text-slate-700 dark:border-slate-800/80 dark:bg-slate-900/70 dark:text-slate-200",
  connecting: "border-amber-200/80 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
  error: "border-rose-200/80 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200"
};
const BTN_BAN = "inline-flex items-center rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200 dark:hover:bg-rose-900/40";
const BTN_NEUTRAL = "inline-flex items-center rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";

let ttsEnabled = true;

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
  if (darkToggle) {
    darkToggle.textContent = mode === "dark" ? "Modo claro" : "Modo oscuro";
  }
  localStorage.setItem(THEME_KEY, mode);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "dark" || saved === "light") {
    applyTheme(saved);
    return;
  }
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(prefersDark ? "dark" : "light");
}

function fmtUntil(ms) {
  if (!ms || ms === 0) return "inf";
  const d = new Date(ms);
  return d.toLocaleString();
}

function setLivePill(variant, label) {
  if (!liveStatus) return;
  const style = LIVE_STYLES[variant] || LIVE_STYLES.offline;
  liveStatus.className = `${LIVE_PILL_BASE} ${style}`;
  liveStatus.textContent = label;
}

function addLogLine(obj) {
  const line = JSON.stringify(obj);
  const div = document.createElement("div");
  div.textContent = line;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
}

if (darkToggle) {
  darkToggle.addEventListener("click", () => {
    const isDark = document.documentElement.classList.contains("dark");
    applyTheme(isDark ? "light" : "dark");
  });
}
initTheme();

socket.on("status", (s) => {
  ttsEnabled = !!s.ttsEnabled;
  statusEl.textContent = `TTS: ${ttsEnabled ? "ON" : "OFF"} | cola: ${s.queueSize}`;
});

function renderTikTokStatus(s) {
  if (!s) return;
  const statusMap = {
    idle: "idle",
    connecting: "conectando",
    connected: "conectado",
    error: "error"
  };
  const statusLabel = statusMap[s.status] || s.status || "idle";
  const liveLabel = s.live ? "ON LIVE" : "offline";
  const variant = s.status === "connecting"
    ? "connecting"
    : s.status === "error"
      ? "error"
      : s.live
        ? "online"
        : "offline";

  setLivePill(variant, `TikTok: ${liveLabel}`);
  tiktokInfo.textContent = `Estado: ${statusLabel}${s.roomId ? ` | roomId: ${s.roomId}` : ""}`;
  tiktokError.textContent = s.lastError ? `Error: ${s.lastError}` : "";
}

socket.on("queue", (q) => {
  queueBody.innerHTML = "";
  (q.items || []).forEach(m => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="py-2 pr-2 align-top">${m.id}</td>
      <td class="py-2 pr-2 align-top">@${m.uniqueId}</td>
      <td class="py-2 pr-2 align-top">${m.text}</td>
      <td class="py-2 align-top">
        <button class="${BTN_BAN}" data-ban="${m.uniqueId}">Ban</button>
      </td>
    `;
    queueBody.appendChild(tr);
  });

  queueBody.querySelectorAll("button[data-ban]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const uid = btn.getAttribute("data-ban");
      await fetch("/api/ban", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uniqueId: uid, minutes: 60, reason: "manual (desde cola)" })
      });
    });
  });
});

socket.on("bansUpdated", (db) => {
  bansBody.innerHTML = "";
  const users = db.users || {};
  Object.keys(users).sort().forEach(uid => {
    const e = users[uid];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="py-2 pr-2 align-top">@${uid}</td>
      <td class="py-2 pr-2 align-top">${e.reason || ""}</td>
      <td class="py-2 pr-2 align-top">${fmtUntil(e.untilMs)}</td>
      <td class="py-2 align-top"><button class="${BTN_NEUTRAL}" data-unban="${uid}">Unban</button></td>
    `;
    bansBody.appendChild(tr);
  });

  bansBody.querySelectorAll("button[data-unban]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const uid = btn.getAttribute("data-unban");
      await fetch("/api/unban", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uniqueId: uid })
      });
    });
  });
});

socket.on("listsUpdated", () => {
  // opcional: refrescar UI
});

socket.on("tiktokStatus", (s) => {
  renderTikTokStatus(s);
});

socket.on("logBulk", (items) => {
  logEl.innerHTML = "";
  (items || []).forEach(addLogLine);
});

socket.on("log", (evt) => addLogLine(evt));

// botones
if (ttsToggle) {
  ttsToggle.addEventListener("click", async () => {
    await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !ttsEnabled })
    });
  });
}

if (clearQueue) {
  clearQueue.addEventListener("click", async () => {
    await fetch("/api/queue/clear", { method: "POST" });
  });
}

if (connectTikTok) {
  connectTikTok.addEventListener("click", async () => {
    const r = await fetch("/api/tiktok/connect", { method: "POST" });
    const j = await r.json();
    renderTikTokStatus(j.status);
  });
}

if (disconnectTikTok) {
  disconnectTikTok.addEventListener("click", async () => {
    const r = await fetch("/api/tiktok/disconnect", { method: "POST" });
    const j = await r.json();
    renderTikTokStatus(j.status);
  });
}

if (banBtn) {
  banBtn.addEventListener("click", async () => {
    const uid = (banUser.value || "").trim().replace(/^@/, "");
    if (!uid) return;
    await fetch("/api/ban", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uniqueId: uid,
        minutes: Number(banMinutes.value || 30),
        reason: banReason.value || "manual"
      })
    });
  });
}

// cargar listas para edicion
async function loadLists() {
  const r = await fetch("/api/lists");
  const j = await r.json();
  exactTxt.value = (j.exact || []).join("\n");
  subTxt.value = (j.sub || []).join("\n");
}

async function loadTikTokStatus() {
  const r = await fetch("/api/tiktok/status");
  const j = await r.json();
  renderTikTokStatus(j);
}

if (saveLists) {
  saveLists.addEventListener("click", async () => {
    await fetch("/api/lists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exact: exactTxt.value, sub: subTxt.value })
    });
  });
}

loadLists();
loadTikTokStatus();
