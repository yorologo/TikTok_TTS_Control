const socket = io();

const statusEl = document.getElementById("status");
const liveStatus = document.getElementById("liveStatus");
const darkToggle = document.getElementById("darkToggle");
const openOptions = document.getElementById("openOptions");
const closeOptions = document.getElementById("closeOptions");
const optionsPanel = document.getElementById("optionsPanel");
const optionsOverlay = document.getElementById("optionsOverlay");
const contentRoot = document.getElementById("contentRoot");
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
const optGlobalCooldown = document.getElementById("optGlobalCooldown");
const optUserCooldown = document.getElementById("optUserCooldown");
const optMaxQueue = document.getElementById("optMaxQueue");
const optMaxChars = document.getElementById("optMaxChars");
const optMaxWords = document.getElementById("optMaxWords");
const optTtsRate = document.getElementById("optTtsRate");
const optTtsVoice = document.getElementById("optTtsVoice");
const refreshVoices = document.getElementById("refreshVoices");
const voicesStatus = document.getElementById("voicesStatus");
const optAutoBanEnabled = document.getElementById("optAutoBanEnabled");
const optAutoBanStrikes = document.getElementById("optAutoBanStrikes");
const optAutoBanMinutes = document.getElementById("optAutoBanMinutes");
const saveSettings = document.getElementById("saveSettings");
const reloadSettings = document.getElementById("reloadSettings");
const settingsStatus = document.getElementById("settingsStatus");
const testUser = document.getElementById("testUser");
const testText = document.getElementById("testText");
const testCount = document.getElementById("testCount");
const testBtn = document.getElementById("testBtn");
const testStatus = document.getElementById("testStatus");

const THEME_KEY = "theme";
const OPTIONS_KEY = "optionsOpen";
const PUSH_CLASSES = ["lg:-translate-x-48", "xl:-translate-x-64"];
const LIVE_PILL_BASE = "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold shadow-sm transition";
const LIVE_STYLES = {
  online: "border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  offline: "border-slate-200/80 bg-white/70 text-slate-700 dark:border-slate-800/80 dark:bg-slate-900/70 dark:text-slate-200",
  connecting: "border-amber-200/80 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
  error: "border-rose-200/80 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200"
};
const BTN_BAN = "inline-flex items-center rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200 dark:hover:bg-rose-900/40";
const BTN_NEUTRAL = "inline-flex items-center rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";
const TEST_STATUS_BASE = "mt-2 text-xs";
const TEST_STATUS_STYLES = {
  ok: "text-emerald-600 dark:text-emerald-400",
  error: "text-rose-600 dark:text-rose-400",
  info: "text-slate-500 dark:text-slate-400"
};
const SETTINGS_STATUS_BASE = "text-xs";
const SETTINGS_STATUS_STYLES = {
  ok: "text-emerald-600 dark:text-emerald-400",
  error: "text-rose-600 dark:text-rose-400",
  info: "text-slate-500 dark:text-slate-400"
};
const VOICE_STATUS_BASE = "text-xs";
const VOICE_STATUS_STYLES = {
  ok: "text-emerald-600 dark:text-emerald-400",
  error: "text-rose-600 dark:text-rose-400",
  info: "text-slate-500 dark:text-slate-400"
};

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

function setOptionsOpen(isOpen) {
  if (!optionsPanel || !optionsOverlay) return;
  optionsPanel.classList.toggle("translate-x-full", !isOpen);
  optionsOverlay.classList.toggle("opacity-0", !isOpen);
  optionsOverlay.classList.toggle("pointer-events-none", !isOpen);
  optionsPanel.setAttribute("aria-hidden", String(!isOpen));
  if (openOptions) {
    openOptions.setAttribute("aria-expanded", String(isOpen));
  }
  if (contentRoot) {
    for (const cls of PUSH_CLASSES) {
      contentRoot.classList.toggle(cls, isOpen);
    }
  }
  document.body.classList.toggle("overflow-hidden", isOpen);
  localStorage.setItem(OPTIONS_KEY, isOpen ? "open" : "closed");
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

function setTestStatus(message, variant) {
  if (!testStatus) return;
  const style = TEST_STATUS_STYLES[variant] || TEST_STATUS_STYLES.info;
  testStatus.className = `${TEST_STATUS_BASE} ${style}`;
  testStatus.textContent = message;
}

function setSettingsStatus(message, variant) {
  if (!settingsStatus) return;
  const style = SETTINGS_STATUS_STYLES[variant] || SETTINGS_STATUS_STYLES.info;
  settingsStatus.className = `${SETTINGS_STATUS_BASE} ${style}`;
  settingsStatus.textContent = message;
}

function setVoicesStatus(message, variant) {
  if (!voicesStatus) return;
  const style = VOICE_STATUS_STYLES[variant] || VOICE_STATUS_STYLES.info;
  voicesStatus.className = `${VOICE_STATUS_BASE} ${style}`;
  voicesStatus.textContent = message;
}

let pendingVoice = "";
function applySettingsToForm(s) {
  if (!s) return;
  if (optGlobalCooldown) optGlobalCooldown.value = s.globalCooldownMs ?? "";
  if (optUserCooldown) optUserCooldown.value = s.perUserCooldownMs ?? "";
  if (optMaxQueue) optMaxQueue.value = s.maxQueue ?? "";
  if (optMaxChars) optMaxChars.value = s.maxChars ?? "";
  if (optMaxWords) optMaxWords.value = s.maxWords ?? "";
  if (optTtsRate) optTtsRate.value = s.ttsRate ?? "";
  if (optAutoBanEnabled) optAutoBanEnabled.checked = !!s.autoBanEnabled;
  if (optAutoBanStrikes) optAutoBanStrikes.value = s.autoBanStrikeThreshold ?? "";
  if (optAutoBanMinutes) optAutoBanMinutes.value = s.autoBanBanMinutes ?? "";
  pendingVoice = s.ttsVoice ?? "";
  if (optTtsVoice) optTtsVoice.value = pendingVoice;
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
const savedOptions = localStorage.getItem(OPTIONS_KEY);
if (savedOptions === "open") {
  setOptionsOpen(true);
}

if (openOptions) {
  openOptions.addEventListener("click", () => setOptionsOpen(true));
}
if (closeOptions) {
  closeOptions.addEventListener("click", () => setOptionsOpen(false));
}
if (optionsOverlay) {
  optionsOverlay.addEventListener("click", () => setOptionsOpen(false));
}
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setOptionsOpen(false);
});

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

function populateVoices(voices) {
  if (!optTtsVoice) return;
  const current = pendingVoice || optTtsVoice.value || "";
  const unique = Array.isArray(voices) ? Array.from(new Set(voices)) : [];
  unique.sort((a, b) => a.localeCompare(b));
  optTtsVoice.innerHTML = "<option value=\"\">Predeterminada</option>";
  if (current && !unique.includes(current)) {
    const option = document.createElement("option");
    option.value = current;
    option.textContent = `${current} (custom)`;
    optTtsVoice.appendChild(option);
  }
  for (const voice of unique) {
    const option = document.createElement("option");
    option.value = voice;
    option.textContent = voice;
    optTtsVoice.appendChild(option);
  }
  optTtsVoice.value = current;
}

socket.on("queue", (q) => {
  queueBody.innerHTML = "";
  (q.items || []).forEach(m => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="py-2 pr-2 align-top">${m.id}</td>
      <td class="py-2 pr-2 align-top">@${m.uniqueId}</td>
      <td class="py-2 pr-2 align-top cursor-pointer hover:text-rose-600 dark:hover:text-rose-300" data-skip="${m.id}" title="Omitir">${m.text}</td>
      <td class="py-2 align-top">
        <div class="flex flex-wrap gap-2">
          <button class="${BTN_BAN}" data-ban="${m.uniqueId}">Ban</button>
          <button class="${BTN_NEUTRAL}" data-skip="${m.id}">Omitir</button>
        </div>
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

  queueBody.querySelectorAll("button[data-skip]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = Number(btn.getAttribute("data-skip"));
      await fetch("/api/queue/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
      });
    });
  });

  queueBody.querySelectorAll("td[data-skip]").forEach(cell => {
    cell.addEventListener("click", async () => {
      const id = Number(cell.getAttribute("data-skip"));
      await fetch("/api/queue/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id })
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

socket.on("settings", (s) => {
  applySettingsToForm(s);
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

if (testBtn) {
  testBtn.addEventListener("click", async () => {
    const uid = (testUser?.value || "").trim().replace(/^@/, "");
    const text = (testText?.value || "").trim();
    const repeat = Number(testCount?.value || 1);
    const count = Number.isFinite(repeat) ? Math.max(1, Math.min(50, Math.trunc(repeat))) : 1;
    if (!text) {
      setTestStatus("Ingresa un texto de prueba.", "error");
      return;
    }
    setTestStatus("Enviando...", "info");
    try {
      const r = await fetch("/api/queue/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uniqueId: uid || "local",
          nickname: uid || "local",
          text,
          count
        })
      });
      const j = await r.json();
      if (j.ok) {
        const dropped = j.dropped ? `, drop: ${j.dropped}` : "";
        setTestStatus(`Agregado: ${j.added ?? 1}${dropped}`, "ok");
        if (testText) testText.value = "";
      } else {
        setTestStatus(`Bloqueado: ${j.reason || "error"}`, "error");
      }
    } catch (err) {
      setTestStatus("Error enviando el mensaje.", "error");
    }
  });
}

// cargar listas para edicion
async function loadLists() {
  const r = await fetch("/api/lists");
  const j = await r.json();
  exactTxt.value = (j.exact || []).join("\n");
  subTxt.value = (j.sub || []).join("\n");
}

async function loadSettings() {
  const r = await fetch("/api/settings");
  const j = await r.json();
  applySettingsToForm(j);
}

async function loadVoices() {
  if (!optTtsVoice) return;
  setVoicesStatus("Cargando voces...", "info");
  try {
    const r = await fetch("/api/tts/voices");
    const j = await r.json();
    populateVoices(j.voices || []);
    const count = Array.isArray(j.voices) ? j.voices.length : 0;
    if (count === 0) {
      setVoicesStatus("Error cargando voces.", "error");
    } else if (j.error) {
      setVoicesStatus(`Voces: ${count} (fallback)`, "ok");
    } else {
      setVoicesStatus(`Voces: ${count}`, "ok");
    }
  } catch (err) {
    setVoicesStatus("Error cargando voces.", "error");
  }
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

if (saveSettings) {
  saveSettings.addEventListener("click", async () => {
    const fields = [
      { el: optGlobalCooldown, key: "globalCooldownMs", min: 0 },
      { el: optUserCooldown, key: "perUserCooldownMs", min: 0 },
      { el: optMaxQueue, key: "maxQueue", min: 1 },
      { el: optMaxChars, key: "maxChars", min: 1 },
      { el: optMaxWords, key: "maxWords", min: 1 },
      { el: optAutoBanStrikes, key: "autoBanStrikeThreshold", min: 1 },
      { el: optAutoBanMinutes, key: "autoBanBanMinutes", min: 1 }
    ];
    const payload = {};
    for (const field of fields) {
      if (!field.el) continue;
      const value = Number(field.el.value);
      if (!Number.isFinite(value)) {
        setSettingsStatus(`Valor invalido: ${field.key}`, "error");
        return;
      }
      payload[field.key] = Math.max(field.min, Math.trunc(value));
    }
    if (optAutoBanEnabled) payload.autoBanEnabled = !!optAutoBanEnabled.checked;
    if (optTtsRate) {
      const rate = Number(optTtsRate.value);
      if (!Number.isFinite(rate)) {
        setSettingsStatus("Valor invalido: ttsRate", "error");
        return;
      }
      payload.ttsRate = Math.min(2, Math.max(0.5, rate));
    }
    if (optTtsVoice) payload.ttsVoice = optTtsVoice.value || "";

    setSettingsStatus("Guardando...", "info");
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const j = await r.json();
      if (j.ok) {
        applySettingsToForm(j.settings);
        setSettingsStatus("Opciones guardadas.", "ok");
      } else {
        setSettingsStatus("No se pudo guardar.", "error");
      }
    } catch (err) {
      setSettingsStatus("Error guardando opciones.", "error");
    }
  });
}

if (reloadSettings) {
  reloadSettings.addEventListener("click", async () => {
    setSettingsStatus("Recargando...", "info");
    await loadSettings();
    setSettingsStatus("Opciones recargadas.", "ok");
  });
}

if (refreshVoices) {
  refreshVoices.addEventListener("click", async () => {
    await loadVoices();
  });
}

loadLists();
loadSettings();
loadVoices();
loadTikTokStatus();
