/* global io */
"use strict";

const ADMIN_TOKEN_STORAGE_KEY = "adminToken";

function normalizeAdminTokenInput(value) {
  return String(value ?? "").trim().replace(/[\r\n\t]+/g, "").slice(0, 256);
}

function getClientAdminToken() {
  try {
    return normalizeAdminTokenInput(localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || "");
  } catch {
    return "";
  }
}

function setClientAdminToken(token) {
  const normalized = normalizeAdminTokenInput(token);
  try {
    if (normalized) localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, normalized);
    else localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  } catch {}
  return normalized;
}

const socket = io({
  autoConnect: false,
  auth: { adminToken: getClientAdminToken() }
});

let reportAuthFailure = () => {};

// -------------------- DOM helpers --------------------
const qs = (id) => document.getElementById(id);
const on = (el, evt, fn, opts) => el && el.addEventListener(evt, fn, opts);

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Fetch helper con timeout + JSON safe
async function apiFetch(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 12000;
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(getClientAdminToken() ? { "x-admin-token": getClientAdminToken() } : {}),
        ...(options.headers || {})
      },
      signal: controller.signal
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      const msg = json?.message || json?.error || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        reportAuthFailure(msg, json?.error || "admin_auth_failed", res.status);
      }
      const err = new Error(msg);
      err.status = res.status;
      err.body = json;
      throw err;
    }

    return json;
  } finally {
    clearTimeout(t);
  }
}

// -------------------- Elements --------------------
const statusEl = qs("status");
const liveStatus = qs("liveStatus");
const darkToggle = qs("darkToggle");
const openOptions = qs("openOptions");
const closeOptions = qs("closeOptions");
const optionsPanel = qs("optionsPanel");
const optionsOverlay = qs("optionsOverlay");
const contentRoot = qs("contentRoot");

const queueBody = qs("queueBody");
const bansBody = qs("bansBody");
const logEl = qs("log");
const historyList = qs("historyList");
const historyStatus = qs("historyStatus");

const ttsToggle = qs("ttsToggle");
const clearQueue = qs("clearQueue");
const connectTikTokBtn = qs("connectTikTok");
const disconnectTikTokBtn = qs("disconnectTikTok");
const tiktokInfo = qs("tiktokInfo");
const tiktokError = qs("tiktokError");

const exactTxt = qs("exactTxt");
const subTxt = qs("subTxt");
const saveLists = qs("saveLists");

const banUser = qs("banUser");
const banMinutes = qs("banMinutes");
const banReason = qs("banReason");
const banBtn = qs("banBtn");

const optTikTokUsername = qs("optTikTokUsername");
const optBindHost = qs("optBindHost");
const optPort = qs("optPort");
const optAdminToken = qs("optAdminToken");
const saveAdminTokenLocal = qs("saveAdminTokenLocal");
const clearAdminTokenLocal = qs("clearAdminTokenLocal");
const authStatus = qs("authStatus");

const optGlobalCooldown = qs("optGlobalCooldown");
const optUserCooldown = qs("optUserCooldown");
const optMaxQueue = qs("optMaxQueue");
const optMaxChars = qs("optMaxChars");
const optMaxWords = qs("optMaxWords");
const optHistorySize = qs("optHistorySize");

const optTtsEngine = qs("optTtsEngine");
const optTtsRate = qs("optTtsRate");
const optTtsVoice = qs("optTtsVoice");

const saySettings = qs("saySettings");
const piperSettings = qs("piperSettings");

const optPiperModelPath = qs("optPiperModelPath");
const optPiperLengthScale = qs("optPiperLengthScale");
const optPiperVolume = qs("optPiperVolume");
const optPiperPythonCmd = qs("optPiperPythonCmd");

const optTermuxEngine = qs("optTermuxEngine");
const optTermuxLanguage = qs("optTermuxLanguage");
const optTermuxRegion = qs("optTermuxRegion");
const optTermuxVariant = qs("optTermuxVariant");
const optTermuxStream = qs("optTermuxStream");
const optTermuxPitch = qs("optTermuxPitch");
const optTermuxRate = qs("optTermuxRate");
const optTermuxOutputMode = qs("optTermuxOutputMode");
const optTermuxCoexistenceMode = qs("optTermuxCoexistenceMode");
const optTermuxPersistScope = qs("optTermuxPersistScope");
const optTermuxTestText = qs("optTermuxTestText");
const optTermuxTestBtn = qs("optTermuxTestBtn");
const optTermuxRestore = qs("optTermuxRestore");
const optTermuxValidation = qs("optTermuxValidation");
const optTermuxAudioNote = qs("optTermuxAudioNote");

const refreshVoices = qs("refreshVoices");
const voicesStatus = qs("voicesStatus");

const optAutoBanEnabled = qs("optAutoBanEnabled");
const optAutoBanStrikes = qs("optAutoBanStrikes");
const optAutoBanMinutes = qs("optAutoBanMinutes");

const saveSettings = qs("saveSettings");
const reloadSettings = qs("reloadSettings");
const settingsStatus = qs("settingsStatus");
const runtimeStatus = qs("runtimeStatus");
const runtimeRestartNotice = qs("runtimeRestartNotice");

const testUser = qs("testUser");
const testText = qs("testText");
const testCount = qs("testCount");
const testBtn = qs("testBtn");
const testStatus = qs("testStatus");

// -------------------- UI constants --------------------
const THEME_KEY = "theme";
const OPTIONS_KEY = "optionsOpen";
const PUSH_CLASSES = ["lg:-translate-x-48", "xl:-translate-x-64"];
const RUNTIME_BIND_HOSTS = ["127.0.0.1", "0.0.0.0", "localhost"];

const LIVE_PILL_BASE = "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold shadow-sm transition";
const LIVE_STYLES = {
  online: "border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-200",
  offline: "border-slate-200/80 bg-white/70 text-slate-700 dark:border-slate-800/80 dark:bg-slate-900/70 dark:text-slate-200",
  connecting: "border-amber-200/80 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
  error: "border-rose-200/80 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200"
};

const BTN_BAN =
  "inline-flex items-center rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-rose-100 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200 dark:hover:bg-rose-900/40";
const BTN_NEUTRAL =
  "inline-flex items-center rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800";

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
  info: "text-slate-500 dark:text-slate-400",
  warn: "text-amber-600 dark:text-amber-400"
};

const AUTH_STATUS_BASE = "text-xs";
const AUTH_STATUS_STYLES = {
  ok: "text-emerald-600 dark:text-emerald-400",
  error: "text-rose-600 dark:text-rose-400",
  info: "text-slate-500 dark:text-slate-400",
  warn: "text-amber-600 dark:text-amber-400"
};

const RESTART_NOTICE_BASE = "text-xs";
const RESTART_NOTICE_STYLES = {
  info: "text-slate-500 dark:text-slate-400",
  warn: "text-amber-600 dark:text-amber-400"
};

const VOICE_STATUS_BASE = "text-xs";
const VOICE_STATUS_STYLES = {
  ok: "text-emerald-600 dark:text-emerald-400",
  error: "text-rose-600 dark:text-rose-400",
  info: "text-slate-500 dark:text-slate-400"
};

const HISTORY_CARD = "rounded-xl border border-slate-200/80 bg-white/80 p-3 text-sm shadow-sm dark:border-slate-800/80 dark:bg-slate-900/70";
const HISTORY_STATUS_PILL = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold";
const HISTORY_STATUS_STYLES = {
  queued: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200",
  blocked: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200",
  dropped: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200"
};
const HISTORY_CHIP =
  "inline-flex items-center rounded-full border border-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-600 hover:text-rose-600 dark:border-slate-800 dark:text-slate-300 dark:hover:text-rose-300";

// -------------------- State --------------------
let ttsEnabled = true;
let historyItems = [];
let historyMax = 25;
let pendingVoice = "";
let ttsConfigDefaults = null;
let ttsConfigEffective = null;
let termuxValidateDebounceTimer = null;
let latestSettingsSnapshot = null;

// -------------------- UI setters --------------------
function applyTheme(mode) {
  const root = document.documentElement;
  const isDark = mode === "dark";
  root.classList.toggle("dark", isDark);
  if (darkToggle) darkToggle.textContent = isDark ? "Modo claro" : "Modo oscuro";
  localStorage.setItem(THEME_KEY, mode);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "dark" || saved === "light") {
    applyTheme(saved);
    return;
  }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  applyTheme(prefersDark ? "dark" : "light");
}

function setOptionsOpen(isOpen) {
  if (!optionsPanel || !optionsOverlay) return;
  optionsPanel.classList.toggle("translate-x-full", !isOpen);
  optionsOverlay.classList.toggle("opacity-0", !isOpen);
  optionsOverlay.classList.toggle("pointer-events-none", !isOpen);
  optionsPanel.setAttribute("aria-hidden", String(!isOpen));
  openOptions?.setAttribute("aria-expanded", String(isOpen));

  if (contentRoot) {
    for (const cls of PUSH_CLASSES) contentRoot.classList.toggle(cls, isOpen);
  }
  document.body.classList.toggle("overflow-hidden", isOpen);
  localStorage.setItem(OPTIONS_KEY, isOpen ? "open" : "closed");
}

function fmtUntil(ms) {
  if (!ms || ms === 0) return "inf";
  return new Date(ms).toLocaleString();
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

function setRuntimeRestartNotice(message, variant = "info") {
  if (!runtimeRestartNotice) return;
  const style = RESTART_NOTICE_STYLES[variant] || RESTART_NOTICE_STYLES.info;
  runtimeRestartNotice.className = `${RESTART_NOTICE_BASE} ${style}`;
  runtimeRestartNotice.textContent = message || "";
}

function setAuthStatus(message, variant = "info") {
  if (!authStatus) return;
  const style = AUTH_STATUS_STYLES[variant] || AUTH_STATUS_STYLES.info;
  authStatus.className = `${AUTH_STATUS_BASE} ${style}`;
  authStatus.textContent = message || "";
}

function syncSocketAuth(reconnect = false) {
  socket.auth = { adminToken: getClientAdminToken() };
  if (!reconnect) return;
  if (socket.connected) socket.disconnect();
  socket.connect();
}

function refreshAuthStatus(snapshot = latestSettingsSnapshot) {
  const storedToken = getClientAdminToken();
  const serverConfigured = !!snapshot?.adminTokenConfigured;
  const authRequired = !!snapshot?.adminAuthRequired;
  const pendingExposedBind = !!snapshot?.bindHost && !["127.0.0.1", "localhost"].includes(String(snapshot.bindHost).trim().toLowerCase());

  if (!authRequired) {
    if (pendingExposedBind && !serverConfigured) {
      setAuthStatus("Antes de reiniciar con bind público, configura un admin token en el servidor.", "warn");
    } else if (pendingExposedBind && serverConfigured && !storedToken) {
      setAuthStatus("Antes de reiniciar con bind público, guarda también el token local en este navegador.", "warn");
    } else if (serverConfigured && storedToken) {
      setAuthStatus("Modo loopback: token opcional. Hay token local y token configurado en servidor.", "info");
    } else if (serverConfigured) {
      setAuthStatus("Modo loopback: token opcional. El servidor ya tiene admin token configurado.", "info");
    } else if (storedToken) {
      setAuthStatus("Modo loopback: token opcional. Hay token local guardado en este navegador.", "info");
    } else {
      setAuthStatus("Modo loopback: no se requiere token administrativo.", "info");
    }
    return;
  }

  if (!serverConfigured) {
    setAuthStatus("Protección admin activa, pero el servidor no tiene token configurado. Configúralo en loopback antes de exponer la interfaz.", "warn");
    return;
  }

  if (storedToken) {
    setAuthStatus("Protección admin activa. El navegador enviará el token guardado en x-admin-token.", "ok");
  } else {
    setAuthStatus("Protección admin activa. Guarda un token local para administrar esta interfaz.", "warn");
  }
}

function persistLocalAdminToken(token, options = {}) {
  const normalized = setClientAdminToken(token);
  if (optAdminToken && (!optAdminToken.value || options.syncInput)) {
    optAdminToken.value = normalized;
  }
  syncSocketAuth(options.reconnect !== false);
  refreshAuthStatus();
  return normalized;
}

reportAuthFailure = (message, errorCode) => {
  const detail = errorCode ? `${errorCode}: ${message}` : message;
  setAuthStatus(`Auth: ${detail}`, "error");
};

function setVoicesStatus(message, variant) {
  if (!voicesStatus) return;
  const style = VOICE_STATUS_STYLES[variant] || VOICE_STATUS_STYLES.info;
  voicesStatus.className = `${VOICE_STATUS_BASE} ${style}`;
  voicesStatus.textContent = message;
}

function setTermuxValidation(message, variant = "info") {
  if (!optTermuxValidation) return;
  const styles = {
    ok: "text-emerald-600 dark:text-emerald-400",
    error: "text-rose-600 dark:text-rose-400",
    info: "text-slate-500 dark:text-slate-400"
  };
  optTermuxValidation.className = `mt-2 text-xs ${styles[variant] || styles.info}`;
  optTermuxValidation.textContent = message;
}

function setTermuxAudioNote(message) {
  if (!optTermuxAudioNote) return;
  optTermuxAudioNote.textContent = message || "";
}

function normalizeTikTokUsernameInput(value) {
  return String(value ?? "").trim().replace(/@+/g, "").replace(/\s+/g, "");
}

function getTermuxFormPayload() {
  return {
    engine: optTermuxEngine?.value?.trim() || "",
    language: optTermuxLanguage?.value?.trim() || "",
    region: optTermuxRegion?.value?.trim() || "",
    variant: optTermuxVariant?.value?.trim() || "",
    stream: optTermuxStream?.value || "MUSIC",
    pitch: Number(optTermuxPitch?.value || 1),
    rate: Number(optTermuxRate?.value || 1),
    outputMode: optTermuxOutputMode?.value || "media",
    coexistenceMode: optTermuxCoexistenceMode?.value || "duck"
  };
}

function applyTermuxForm(config, scope = null) {
  if (!config || typeof config !== "object") return;

  if (optTermuxEngine) optTermuxEngine.value = config.engine || "";
  if (optTermuxLanguage) optTermuxLanguage.value = config.language || "";
  if (optTermuxRegion) optTermuxRegion.value = config.region || "";
  if (optTermuxVariant) optTermuxVariant.value = config.variant || "";
  if (optTermuxStream) optTermuxStream.value = config.stream || "MUSIC";
  if (optTermuxPitch) optTermuxPitch.value = String(config.pitch ?? 1);
  if (optTermuxRate) optTermuxRate.value = String(config.rate ?? 1);
  if (optTermuxOutputMode) optTermuxOutputMode.value = config.outputMode || "media";
  if (optTermuxCoexistenceMode) optTermuxCoexistenceMode.value = config.coexistenceMode || "duck";
  if (scope && optTermuxPersistScope) optTermuxPersistScope.value = scope;

  ttsConfigEffective = { ...config };
}

function renderTermuxValidationResult(result) {
  if (!result) return;

  const errors = Array.isArray(result.errors) ? result.errors : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];

  if (errors.length > 0) {
    const first = errors[0];
    setTermuxValidation(`Error ${first.field || "config"}: ${first.message || "inválido"}`, "error");
    return;
  }

  if (warnings.length > 0) {
    const first = warnings[0];
    setTermuxValidation(`Aviso ${first.field || "config"}: ${first.message || "revisa soporte"}`, "info");
  } else {
    setTermuxValidation("Configuración válida.", "ok");
  }
}

function formatValidationErrors(errors, maxItems = 3) {
  const items = Array.isArray(errors) ? errors.filter(Boolean) : [];
  if (items.length === 0) return "";
  return items
    .slice(0, maxItems)
    .map((item) => `${item.field || "config"}: ${item.message || "inválido"}`)
    .join(" | ");
}

async function validateTermuxForm() {
  const payload = getTermuxFormPayload();
  try {
    const result = await apiFetch("/api/tts/config/validate", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    renderTermuxValidationResult(result);
    return result;
  } catch {
    setTermuxValidation("No se pudo validar con backend.", "error");
    return null;
  }
}

function scheduleTermuxValidation() {
  if (termuxValidateDebounceTimer) clearTimeout(termuxValidateDebounceTimer);
  termuxValidateDebounceTimer = setTimeout(() => {
    void validateTermuxForm();
  }, 280);
}

async function loadTtsConfig() {
  try {
    const j = await apiFetch("/api/tts/config", { method: "GET", headers: {} });
    ttsConfigDefaults = j?.defaults || null;

    if (j?.effective) {
      applyTermuxForm(j.effective, j.persistScope || "global");
    }

    if (j?.audioBehavior?.effectiveStream) {
      const notes = Array.isArray(j.audioBehavior.notes) ? j.audioBehavior.notes : [];
      const info = `Stream efectivo: ${j.audioBehavior.effectiveStream}${notes.length ? ` | ${notes[0]}` : ""}`;
      setTermuxAudioNote(info);
    }

    renderTermuxValidationResult(j?.validation);
  } catch {
    setTermuxValidation("Error cargando configuración TTS de Termux.", "error");
  }
}

function renderRuntime(runtime) {
  if (!runtimeStatus || !runtime) return;

  const engines = Array.isArray(runtime.availableTtsEngines)
    ? runtime.availableTtsEngines.join(", ")
    : "-";

  const activeBindHost = latestSettingsSnapshot?.activeBindHost;
  const activePort = latestSettingsSnapshot?.activePort;
  const bindingText = activeBindHost && Number.isFinite(Number(activePort))
    ? ` | Bind activo: ${activeBindHost}:${activePort}`
    : "";

  runtimeStatus.textContent = `Runtime: ${runtime.platform}${runtime.isTermux ? " (Termux)" : ""} | Motores: ${engines} | Recomendado: ${runtime.recommendedTtsEngine || "-"}${bindingText}`;
}

function setTtsEngineState(engine) {
  const usePiper = engine === "piper";
  const useTermux = engine === "termux";

  piperSettings?.classList.toggle("hidden", !usePiper);
  saySettings?.classList.toggle("hidden", usePiper || useTermux);

  if (useTermux) {
    setVoicesStatus("Termux API activo.", "info");
  }
}

function formatHistoryTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString() : "";
}

// -------------------- History rendering (batched) --------------------
const renderHistoryDebounced = debounce(renderHistory, 50);

function renderHistory() {
  if (!historyList) return;

  const items = historyItems.slice(-historyMax);
  historyList.textContent = "";

  if (historyStatus) historyStatus.textContent = `Mostrando ${items.length} / ${historyMax}`;

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "text-xs text-slate-500 dark:text-slate-400";
    empty.textContent = "Sin mensajes recientes.";
    historyList.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();

  for (const item of items) {
    const card = document.createElement("div");
    card.className = HISTORY_CARD;

    const header = document.createElement("div");
    header.className = "flex flex-wrap items-center justify-between gap-2";

    const meta = document.createElement("div");
    meta.className = "flex flex-wrap items-center gap-2";

    const status = document.createElement("span");
    const statusStyle = HISTORY_STATUS_STYLES[item.status] || HISTORY_STATUS_STYLES.queued;
    status.className = `${HISTORY_STATUS_PILL} ${statusStyle}`;
    status.textContent = item.status || "queued";

    const user = document.createElement("span");
    user.className = "text-xs text-slate-500 dark:text-slate-400";
    user.textContent = `@${item.uniqueId || "unknown"}`;

    const time = document.createElement("span");
    time.className = "text-xs text-slate-400 dark:text-slate-500";
    time.textContent = formatHistoryTime(item.ts);

    meta.append(status, user, time);

    const actions = document.createElement("div");
    actions.className = "flex flex-wrap items-center gap-2";

    const banUserBtn = document.createElement("button");
    banUserBtn.className = BTN_BAN;
    banUserBtn.textContent = "Ban usuario";
    banUserBtn.dataset.action = "ban-user";
    banUserBtn.dataset.uid = item.uniqueId || "";
    actions.appendChild(banUserBtn);

    header.append(meta, actions);

    const body = document.createElement("div");
    body.className = "mt-2 break-words text-sm text-slate-700 dark:text-slate-200";
    body.textContent = item.comment || "";

    card.appendChild(header);
    card.appendChild(body);

    if (item.reason) {
      const reason = document.createElement("div");
      reason.className = "mt-1 text-xs text-slate-500 dark:text-slate-400";
      reason.textContent = `Motivo: ${item.reason}`;
      card.appendChild(reason);
    }

    const tokens = Array.isArray(item.tokens) ? item.tokens : [];
    const uniqueTokens = Array.from(new Set(tokens.filter((t) => t.length >= 3))).slice(0, 10);
    if (uniqueTokens.length > 0) {
      const tokensWrap = document.createElement("div");
      tokensWrap.className = "mt-2 flex flex-wrap gap-2";
      for (const token of uniqueTokens) {
        const tokenBtn = document.createElement("button");
        tokenBtn.className = HISTORY_CHIP;
        tokenBtn.textContent = token;
        tokenBtn.dataset.action = "ban-word";
        tokenBtn.dataset.word = token;
        tokensWrap.appendChild(tokenBtn);
      }
      card.appendChild(tokensWrap);
    }

    frag.appendChild(card);
  }

  historyList.appendChild(frag);
}

// -------------------- Logs (bounded) --------------------
function addLogLine(obj) {
  if (!logEl) return;
  const div = document.createElement("div");
  div.textContent = JSON.stringify(obj);
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
}

// -------------------- TikTok status --------------------
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
  const variant =
    s.status === "connecting" ? "connecting" :
    s.status === "error" ? "error" :
    s.live ? "online" : "offline";

  setLivePill(variant, `TikTok: ${liveLabel}`);

  if (tiktokInfo) {
    tiktokInfo.textContent = `Estado: ${statusLabel}${s.roomId ? ` | roomId: ${s.roomId}` : ""}`;
  }
  if (tiktokError) {
    tiktokError.textContent = s.lastError ? `Error: ${s.lastError}` : "";
  }
}

// -------------------- Voices --------------------
function populateVoices(voices) {
  if (!optTtsVoice) return;

  const current = pendingVoice || optTtsVoice.value || "";
  const unique = Array.isArray(voices) ? Array.from(new Set(voices)) : [];
  unique.sort((a, b) => a.localeCompare(b));

  optTtsVoice.textContent = "";
  const baseOpt = document.createElement("option");
  baseOpt.value = "";
  baseOpt.textContent = "Predeterminada";
  optTtsVoice.appendChild(baseOpt);

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

// -------------------- Apply settings to form --------------------
function applySettingsToForm(s) {
  if (!s) return;

  latestSettingsSnapshot = s;

  if (optAdminToken && !optAdminToken.value) {
    const storedToken = getClientAdminToken();
    if (storedToken) optAdminToken.value = storedToken;
  }
  if (optTikTokUsername) optTikTokUsername.value = s.tiktokUsername ?? "";
  if (optBindHost) optBindHost.value = s.bindHost || "127.0.0.1";
  if (optPort) optPort.value = s.port ?? "";

  if (optGlobalCooldown) optGlobalCooldown.value = s.globalCooldownMs ?? "";
  if (optUserCooldown) optUserCooldown.value = s.perUserCooldownMs ?? "";
  if (optMaxQueue) optMaxQueue.value = s.maxQueue ?? "";
  if (optMaxChars) optMaxChars.value = s.maxChars ?? "";
  if (optMaxWords) optMaxWords.value = s.maxWords ?? "";
  if (optHistorySize) optHistorySize.value = s.historySize ?? "";

  if (Number.isFinite(Number(s.historySize))) historyMax = Number(s.historySize);

  if (optTtsEngine) optTtsEngine.value = s.ttsEngine || "say";
  if (optTtsRate) optTtsRate.value = s.ttsRate ?? "";

  if (optPiperModelPath) optPiperModelPath.value = s.piperModelPath ?? "";
  if (optPiperLengthScale) optPiperLengthScale.value = s.piperLengthScale ?? "";
  if (optPiperVolume) optPiperVolume.value = s.piperVolume ?? "";
  if (optPiperPythonCmd) optPiperPythonCmd.value = s.piperPythonCmd ?? "py";

  if (optAutoBanEnabled) optAutoBanEnabled.checked = !!s.autoBanEnabled;
  if (optAutoBanStrikes) optAutoBanStrikes.value = s.autoBanStrikeThreshold ?? "";
  if (optAutoBanMinutes) optAutoBanMinutes.value = s.autoBanBanMinutes ?? "";

  setTtsEngineState(optTtsEngine ? optTtsEngine.value : s.ttsEngine);
  pendingVoice = s.ttsVoice ?? "";
  if (optTtsVoice) optTtsVoice.value = pendingVoice;

  applyTermuxForm({
    engine: s.termuxEngine ?? "",
    language: s.termuxLanguage ?? "",
    region: s.termuxRegion ?? "",
    variant: s.termuxVariant ?? "",
    stream: s.termuxStream ?? "MUSIC",
    pitch: s.termuxPitch ?? 1,
    rate: s.termuxRate ?? 1,
    outputMode: s.termuxOutputMode ?? "media",
    coexistenceMode: s.termuxCoexistenceMode ?? "duck"
  }, s.termuxPersistScope || "global");

  if (s.termuxEffectiveStream) {
    setTermuxAudioNote(`Stream efectivo: ${s.termuxEffectiveStream}`);
  }

  renderRuntime(s.runtime);

  const activeBindHost = s.activeBindHost || s.bindHost || "127.0.0.1";
  const activePort = Number.isFinite(Number(s.activePort)) ? Number(s.activePort) : (s.port ?? "");
  if (s.restartRequired) {
    const fields = Array.isArray(s.restartFields) && s.restartFields.length > 0
      ? s.restartFields.join(", ")
      : "bindHost, port";
    setRuntimeRestartNotice(
      `Reinicio requerido: el servidor sigue usando ${activeBindHost}:${activePort}. Cambios pendientes en ${fields}: ${s.bindHost}:${s.port}.`,
      "warn"
    );
  } else {
    setRuntimeRestartNotice(`Servidor activo en ${activeBindHost}:${activePort}.`, "info");
  }

  refreshAuthStatus(s);
  renderHistoryDebounced();
}

// -------------------- Queue & bans rendering (NO per-row listeners) --------------------
function renderQueue(q) {
  if (!queueBody) return;

  const items = Array.isArray(q?.items) ? q.items : [];
  const frag = document.createDocumentFragment();

  for (const m of items) {
    const tr = document.createElement("tr");
    // Usamos escapeHtml para evitar inyección si llega algo raro
    tr.innerHTML = `
      <td class="py-2 pr-2 align-top">${escapeHtml(m.id)}</td>
      <td class="py-2 pr-2 align-top">@${escapeHtml(m.uniqueId)}</td>
      <td class="py-2 pr-2 align-top cursor-pointer hover:text-rose-600 dark:hover:text-rose-300"
          data-action="skip" data-id="${escapeHtml(m.id)}" title="Omitir">${escapeHtml(m.text)}</td>
      <td class="py-2 align-top">
        <div class="flex flex-wrap gap-2">
          <button class="${BTN_BAN}" data-action="ban" data-uid="${escapeHtml(m.uniqueId)}">Ban</button>
          <button class="${BTN_NEUTRAL}" data-action="skip" data-id="${escapeHtml(m.id)}">Omitir</button>
        </div>
      </td>
    `;
    frag.appendChild(tr);
  }

  queueBody.textContent = "";
  queueBody.appendChild(frag);
}

function renderBans(db) {
  if (!bansBody) return;

  const users = db?.users || {};
  const uids = Object.keys(users).sort();
  const frag = document.createDocumentFragment();

  for (const uid of uids) {
    const e = users[uid];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="py-2 pr-2 align-top">@${escapeHtml(uid)}</td>
      <td class="py-2 pr-2 align-top">${escapeHtml(e.reason || "")}</td>
      <td class="py-2 pr-2 align-top">${escapeHtml(fmtUntil(e.untilMs))}</td>
      <td class="py-2 align-top">
        <button class="${BTN_NEUTRAL}" data-action="unban" data-uid="${escapeHtml(uid)}">Unban</button>
      </td>
    `;
    frag.appendChild(tr);
  }

  bansBody.textContent = "";
  bansBody.appendChild(frag);
}

// Event delegation: cola
on(queueBody, "click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;
  if (action === "ban") {
    const uid = (target.dataset.uid || "").trim();
    if (!uid) return;
    try {
      await apiFetch("/api/ban", {
        method: "POST",
        body: JSON.stringify({ uniqueId: uid, minutes: 60, reason: "manual (desde cola)" })
      });
    } catch (e) {
      addLogLine({ type: "ui_error", where: "queue_ban", error: String(e.message || e) });
    }
  }

  if (action === "skip") {
    const id = Number(target.dataset.id);
    if (!Number.isFinite(id)) return;
    try {
      await apiFetch("/api/queue/skip", {
        method: "POST",
        body: JSON.stringify({ id })
      });
    } catch (e) {
      addLogLine({ type: "ui_error", where: "queue_skip", error: String(e.message || e) });
    }
  }
});

// Event delegation: bans
on(bansBody, "click", async (event) => {
  const btn = event.target.closest("[data-action='unban']");
  if (!btn) return;
  const uid = (btn.dataset.uid || "").trim();
  if (!uid) return;

  try {
    await apiFetch("/api/unban", {
      method: "POST",
      body: JSON.stringify({ uniqueId: uid })
    });
  } catch (e) {
    addLogLine({ type: "ui_error", where: "bans_unban", error: String(e.message || e) });
  }
});

// Event delegation: history (ya lo tenías bien, lo dejo más robusto)
on(historyList, "click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;

  if (action === "ban-user") {
    const uid = (target.dataset.uid || "").trim();
    if (!uid) return;

    try {
      await apiFetch("/api/ban", {
        method: "POST",
        body: JSON.stringify({ uniqueId: uid, minutes: 60, reason: "manual (historial)" })
      });
      if (historyStatus) historyStatus.textContent = `Baneado: @${uid}`;
    } catch (e) {
      if (historyStatus) historyStatus.textContent = `Error baneando: @${uid}`;
      addLogLine({ type: "ui_error", where: "history_ban_user", error: String(e.message || e) });
    }
  }

  if (action === "ban-word") {
    const word = (target.dataset.word || "").trim();
    if (!word) return;

    try {
      await apiFetch("/api/badwords/add", {
        method: "POST",
        body: JSON.stringify({ word, mode: "exact" })
      });
      if (historyStatus) historyStatus.textContent = `Palabra agregada: ${word}`;
    } catch (e) {
      if (historyStatus) historyStatus.textContent = `Error agregando palabra: ${word}`;
      addLogLine({ type: "ui_error", where: "history_ban_word", error: String(e.message || e) });
    }
  }
});

// -------------------- Socket handlers --------------------
socket.on("status", (s) => {
  ttsEnabled = !!s?.ttsEnabled;
  if (statusEl) statusEl.textContent = `TTS: ${ttsEnabled ? "ON" : "OFF"} | cola: ${s?.queueSize ?? 0}`;
});

socket.on("queue", (q) => renderQueue(q));

socket.on("historyBulk", (payload) => {
  historyItems = payload?.items || [];
  renderHistoryDebounced();
});

socket.on("history", (item) => {
  historyItems.push(item);
  if (historyItems.length > historyMax * 2) {
    // no crece infinito aunque historyMax cambie
    historyItems = historyItems.slice(-historyMax);
  }
  renderHistoryDebounced();
});

socket.on("bansUpdated", (db) => renderBans(db));

socket.on("listsUpdated", () => {
  // opcional: refrescar UI o mostrar toast
});

socket.on("settings", (s) => applySettingsToForm(s));

socket.on("runtime", (runtime) => renderRuntime(runtime));

socket.on("tiktokStatus", (s) => renderTikTokStatus(s));

socket.on("logBulk", (items) => {
  if (!logEl) return;
  logEl.textContent = "";
  (items || []).forEach(addLogLine);
});

socket.on("log", (evt) => addLogLine(evt));
socket.on("connect", () => {
  refreshAuthStatus();
});
socket.on("connect_error", (err) => {
  const message = err?.data?.message || err?.message || "No se pudo autenticar el socket.";
  const code = err?.data?.error || "socket_auth_failed";
  setAuthStatus(`Auth: ${code}: ${message}`, "error");
});

// -------------------- Buttons / Inputs --------------------
on(darkToggle, "click", () => {
  const isDark = document.documentElement.classList.contains("dark");
  applyTheme(isDark ? "light" : "dark");
});

initTheme();

const savedOptions = localStorage.getItem(OPTIONS_KEY);
if (savedOptions === "open") setOptionsOpen(true);

on(openOptions, "click", () => setOptionsOpen(true));
on(closeOptions, "click", () => setOptionsOpen(false));
on(optionsOverlay, "click", () => setOptionsOpen(false));
on(window, "keydown", (event) => {
  if (event.key === "Escape") setOptionsOpen(false);
});

on(optTtsEngine, "change", () => {
  setTtsEngineState(optTtsEngine.value);
  void loadVoices();
});


[
  optTermuxEngine,
  optTermuxLanguage,
  optTermuxRegion,
  optTermuxVariant,
  optTermuxStream,
  optTermuxPitch,
  optTermuxRate,
  optTermuxOutputMode,
  optTermuxCoexistenceMode
].forEach((el) => {
  on(el, "input", scheduleTermuxValidation);
  on(el, "change", scheduleTermuxValidation);
});

on(optTermuxRestore, "click", () => {
  const defaults = ttsConfigDefaults || {
    engine: "",
    language: "",
    region: "",
    variant: "",
    stream: "MUSIC",
    pitch: 1,
    rate: 1,
    outputMode: "media",
    coexistenceMode: "duck"
  };

  applyTermuxForm(defaults, optTermuxPersistScope?.value || "global");
  setTermuxValidation("Restaurado a valores por defecto (pendiente de guardar).", "info");
  scheduleTermuxValidation();
});

on(optTermuxTestBtn, "click", async () => {
  const testPhrase = (optTermuxTestText?.value || "").trim();
  if (!testPhrase) {
    setTermuxValidation("Ingresa un texto corto para probar voz.", "error");
    return;
  }

  const validation = await validateTermuxForm();
  if (!validation?.ok) return;

  setTermuxValidation("Probando voz...", "info");
  try {
    const payload = {
      ...getTermuxFormPayload(),
      text: testPhrase,
      enqueueIfBusy: true
    };

    const j = await apiFetch("/api/tts/test", {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 20000
    });

    if (j?.queued) {
      setTermuxValidation("TTS ocupado: prueba encolada.", "info");
    } else {
      setTermuxValidation("Prueba de voz enviada correctamente.", "ok");
    }

    if (j?.audioBehavior?.effectiveStream) {
      const notes = Array.isArray(j.audioBehavior.notes) ? j.audioBehavior.notes : [];
      setTermuxAudioNote(`Stream efectivo: ${j.audioBehavior.effectiveStream}${notes.length ? ` | ${notes[0]}` : ""}`);
    }
  } catch (e) {
    setTermuxValidation(`Error en prueba: ${String(e.message || e)}`, "error");
  }
});
on(ttsToggle, "click", async () => {
  try {
    await apiFetch("/api/tts", {
      method: "POST",
      body: JSON.stringify({ enabled: !ttsEnabled })
    });
  } catch (e) {
    addLogLine({ type: "ui_error", where: "tts_toggle", error: String(e.message || e) });
  }
});

on(clearQueue, "click", async () => {
  try {
    await apiFetch("/api/queue/clear", { method: "POST", headers: {} });
  } catch (e) {
    addLogLine({ type: "ui_error", where: "queue_clear", error: String(e.message || e) });
  }
});

on(connectTikTokBtn, "click", async () => {
  try {
    const j = await apiFetch("/api/tiktok/connect", { method: "POST", headers: {} });
    renderTikTokStatus(j?.status);
  } catch (e) {
    renderTikTokStatus({ status: "error", live: false, lastError: String(e.message || e) });
  }
});

on(disconnectTikTokBtn, "click", async () => {
  try {
    const j = await apiFetch("/api/tiktok/disconnect", { method: "POST", headers: {} });
    renderTikTokStatus(j?.status);
  } catch (e) {
    renderTikTokStatus({ status: "error", live: false, lastError: String(e.message || e) });
  }
});

on(banBtn, "click", async () => {
  const uid = (banUser?.value || "").trim().replace(/^@/, "");
  if (!uid) return;

  const mins = Number(banMinutes?.value || 30);
  const minutes = Number.isFinite(mins) ? Math.max(1, Math.min(24 * 60, Math.trunc(mins))) : 30;
  const reason = (banReason?.value || "manual").trim();

  try {
    await apiFetch("/api/ban", {
      method: "POST",
      body: JSON.stringify({ uniqueId: uid, minutes, reason })
    });
  } catch (e) {
    addLogLine({ type: "ui_error", where: "ban_manual", error: String(e.message || e) });
  }
});

on(testBtn, "click", async () => {
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
    const j = await apiFetch("/api/queue/test", {
      method: "POST",
      body: JSON.stringify({
        uniqueId: uid || "local",
        nickname: uid || "local",
        text,
        count
      })
    });

    if (j?.ok) {
      const dropped = j.dropped ? `, drop: ${j.dropped}` : "";
      setTestStatus(`Agregado: ${j.added ?? 1}${dropped}`, "ok");
      if (testText) testText.value = "";
    } else {
      setTestStatus(`Bloqueado: ${j?.reason || "error"}`, "error");
    }
  } catch (e) {
    setTestStatus("Error enviando el mensaje.", "error");
  }
});

// -------------------- Lists/settings/voices loading --------------------
async function loadLists() {
  if (!exactTxt || !subTxt) return;
  try {
    const j = await apiFetch("/api/lists", { method: "GET", headers: {} });
    exactTxt.value = (j?.exact || []).join("\n");
    subTxt.value = (j?.sub || []).join("\n");
  } catch (e) {
    addLogLine({ type: "ui_error", where: "loadLists", error: String(e.message || e) });
  }
}

async function loadSettings() {
  try {
    const j = await apiFetch("/api/settings", { method: "GET", headers: {} });
    applySettingsToForm(j);
    await loadTtsConfig();
    void loadVoices();
  } catch (e) {
    if (e?.status === 401 || e?.status === 403) {
      setSettingsStatus("Acceso administrativo requerido para cargar opciones.", "warn");
    } else {
      setSettingsStatus("Error cargando opciones.", "error");
    }
  }
}

async function loadVoices() {
  if (!optTtsVoice) return;

  const selectedEngine = optTtsEngine?.value || "say";

  if (selectedEngine === "termux") {
    setVoicesStatus("Consultando motores Termux...", "info");
    try {
      const j = await apiFetch("/api/tts/voices", { method: "GET", headers: {} });
      const engines = Array.isArray(j?.voices) ? j.voices : [];
      const count = engines.length;

      if (count > 0) setVoicesStatus(`Motores termux: ${count}`, "ok");
      else if (j?.error) setVoicesStatus(`Termux: ${j.error}`, "error");
      else setVoicesStatus("Sin motores termux detectados.", "error");
    } catch (e) {
      setVoicesStatus("Error consultando termux.", "error");
    }
    return;
  }

  setVoicesStatus("Cargando voces...", "info");
  try {
    const j = await apiFetch("/api/tts/voices", { method: "GET", headers: {} });
    const voices = j?.voices || [];
    populateVoices(voices);

    const count = Array.isArray(voices) ? voices.length : 0;
    if (count === 0) setVoicesStatus("Error cargando voces.", "error");
    else if (j?.error) setVoicesStatus(`Voces: ${count} (fallback)`, "ok");
    else setVoicesStatus(`Voces: ${count}`, "ok");
  } catch (e) {
    setVoicesStatus("Error cargando voces.", "error");
  }
}

async function loadTikTokStatus() {
  try {
    const j = await apiFetch("/api/tiktok/status", { method: "GET", headers: {} });
    renderTikTokStatus(j);
  } catch (e) {
    renderTikTokStatus({ status: "error", live: false, lastError: String(e.message || e) });
  }
}

on(saveLists, "click", async () => {
  try {
    await apiFetch("/api/lists", {
      method: "POST",
      body: JSON.stringify({ exact: exactTxt?.value || "", sub: subTxt?.value || "" })
    });
  } catch (e) {
    addLogLine({ type: "ui_error", where: "saveLists", error: String(e.message || e) });
  }
});

on(saveSettings, "click", async () => {
  const fields = [
    { el: optGlobalCooldown, key: "globalCooldownMs", min: 0 },
    { el: optUserCooldown, key: "perUserCooldownMs", min: 0 },
    { el: optMaxQueue, key: "maxQueue", min: 1 },
    { el: optMaxChars, key: "maxChars", min: 1 },
    { el: optMaxWords, key: "maxWords", min: 1 },
    { el: optHistorySize, key: "historySize", min: 5 },
    { el: optAutoBanStrikes, key: "autoBanStrikeThreshold", min: 1 },
    { el: optAutoBanMinutes, key: "autoBanBanMinutes", min: 1 }
  ];

  const payload = {};

  if (optTikTokUsername) {
    const tiktokUsername = normalizeTikTokUsernameInput(optTikTokUsername.value || "");
    if (tiktokUsername && !/^[A-Za-z0-9._-]{2,64}$/.test(tiktokUsername)) {
      setSettingsStatus("Valor inválido: tiktokUsername", "error");
      return;
    }
    payload.tiktokUsername = tiktokUsername;
    optTikTokUsername.value = tiktokUsername;
  }

  if (optBindHost) {
    const bindHost = String(optBindHost.value || "").trim().toLowerCase();
    if (!RUNTIME_BIND_HOSTS.includes(bindHost)) {
      setSettingsStatus("Valor inválido: bindHost", "error");
      return;
    }
    payload.bindHost = bindHost;
  }

  if (optPort) {
    const port = Number(optPort.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setSettingsStatus("Valor inválido: port", "error");
      return;
    }
    payload.port = port;
  }

  const nextAdminToken = normalizeAdminTokenInput(optAdminToken?.value || "");
  if (optAdminToken) optAdminToken.value = nextAdminToken;
  if (nextAdminToken) payload.adminToken = nextAdminToken;

  for (const field of fields) {
    if (!field.el) continue;
    const value = Number(field.el.value);
    if (!Number.isFinite(value)) {
      setSettingsStatus(`Valor inválido: ${field.key}`, "error");
      return;
    }
    payload[field.key] = Math.max(field.min, Math.trunc(value));
  }

  if (optAutoBanEnabled) payload.autoBanEnabled = !!optAutoBanEnabled.checked;

  if (optTtsEngine) {
    const engine = optTtsEngine.value;
    if (engine !== "say" && engine !== "piper" && engine !== "termux") {
      setSettingsStatus("Valor inválido: ttsEngine", "error");
      return;
    }
    payload.ttsEngine = engine;
  }

  if (optTtsRate) {
    const rate = Number(optTtsRate.value);
    if (!Number.isFinite(rate)) {
      setSettingsStatus("Valor inválido: ttsRate", "error");
      return;
    }
    payload.ttsRate = Math.min(2, Math.max(0.5, rate));
  }

  if (optTtsVoice) payload.ttsVoice = optTtsVoice.value || "";
  if (optPiperModelPath) payload.piperModelPath = optPiperModelPath.value || "";

  if (optPiperLengthScale) {
    const n = Number(optPiperLengthScale.value);
    if (!Number.isFinite(n)) {
      setSettingsStatus("Valor inválido: piperLengthScale", "error");
      return;
    }
    payload.piperLengthScale = Math.min(2.5, Math.max(0.5, n));
  }

  if (optPiperVolume) {
    const n = Number(optPiperVolume.value);
    if (!Number.isFinite(n)) {
      setSettingsStatus("Valor inválido: piperVolume", "error");
      return;
    }
    payload.piperVolume = Math.min(2, Math.max(0, n));
  }

  if (optPiperPythonCmd) payload.piperPythonCmd = optPiperPythonCmd.value || "py";

  const termuxPayload = getTermuxFormPayload();
  const persistScope = optTermuxPersistScope?.value || "global";
  payload.termuxPersistScope = persistScope;
  Object.assign(payload, termuxPayload);

  setSettingsStatus("Guardando opciones...", "info");
  try {
    const settingsRes = await apiFetch("/api/settings", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    if (settingsRes?.ok) {
      applySettingsToForm(settingsRes.settings);
      if (nextAdminToken) {
        persistLocalAdminToken(nextAdminToken, { reconnect: true, syncInput: true });
      }
    }

    if (settingsRes?.termuxConfig?.effective) {
      applyTermuxForm(settingsRes.termuxConfig.effective, settingsRes.termuxConfig.persistScope || persistScope);
    }

    renderTermuxValidationResult(settingsRes?.termuxValidation);

    if (settingsRes?.audioBehavior?.effectiveStream) {
      const notes = Array.isArray(settingsRes.audioBehavior.notes) ? settingsRes.audioBehavior.notes : [];
      setTermuxAudioNote(`Stream efectivo: ${settingsRes.audioBehavior.effectiveStream}${notes.length ? ` | ${notes[0]}` : ""}`);
    }

    const restartFields = Array.isArray(settingsRes?.restartFields) && settingsRes.restartFields.length > 0
      ? settingsRes.restartFields
      : (Array.isArray(settingsRes?.settings?.restartFields) ? settingsRes.settings.restartFields : []);

    if (settingsRes?.restartRequired || settingsRes?.settings?.restartRequired) {
      setSettingsStatus(`Opciones guardadas. Reinicia el servidor para aplicar ${restartFields.join(", ") || "bindHost/port"}.`, "warn");
    } else {
      setSettingsStatus("Opciones guardadas.", "ok");
    }
  } catch (e) {
    if (e?.body?.termuxValidation) {
      renderTermuxValidationResult(e.body.termuxValidation);
    }
    const detail = formatValidationErrors(e?.body?.errors) || String(e.message || e);
    setSettingsStatus(`Error guardando opciones: ${detail}`, "error");
  }
});

on(saveAdminTokenLocal, "click", async () => {
  const token = normalizeAdminTokenInput(optAdminToken?.value || "");
  if (!token) {
    setAuthStatus("Ingresa un admin token antes de guardarlo localmente.", "warn");
    return;
  }

  persistLocalAdminToken(token, { reconnect: true, syncInput: true });
  setAuthStatus("Token local guardado. Reintentando cargar datos protegidos.", "ok");
  await loadSettings();
  await loadLists();
  await loadTikTokStatus();
});

on(clearAdminTokenLocal, "click", async () => {
  persistLocalAdminToken("", { reconnect: true, syncInput: false });
  if (optAdminToken) optAdminToken.value = "";
  setAuthStatus("Token local borrado.", "info");
  await loadSettings();
});

on(reloadSettings, "click", async () => {
  setSettingsStatus("Recargando...", "info");
  await loadSettings();
  setSettingsStatus("Opciones recargadas.", "ok");
});

on(refreshVoices, "click", async () => {
  await loadVoices();
});

// -------------------- init --------------------
if (optAdminToken) {
  const storedToken = getClientAdminToken();
  if (storedToken) optAdminToken.value = storedToken;
}
refreshAuthStatus();
syncSocketAuth(false);
socket.connect();
loadLists();
loadSettings();
loadTikTokStatus();
