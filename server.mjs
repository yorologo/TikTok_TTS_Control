import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { execFile, spawn } from "child_process";
import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import TikTokLive from "tiktok-live-connector";

const { WebcastPushConnection } = TikTokLive;

const WebcastEvent = {
  CHAT: "chat"
};

// -------------------- Paths & Runtime --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const BANNED_PATH = path.join(DATA_DIR, "banned_users.json");
const BAD_EXACT_PATH = path.join(DATA_DIR, "badwords_exact_es.txt");
const BAD_SUB_PATH = path.join(DATA_DIR, "badwords_substring_es.txt");

const SUPPORTED_TTS_ENGINES = new Set(["say", "piper", "termux"]);
const TERMUX_STREAMS = new Set(["ALARM", "MUSIC", "NOTIFICATION", "RING", "SYSTEM", "VOICE_CALL"]);
const OUTPUT_MODES = new Set(["media", "notification", "auto"]);
const COEXISTENCE_MODES = new Set(["duck", "pause", "best-effort"]);
const PERSIST_SCOPES = new Set(["global", "session"]);

const MIN_TTS_RATE = 0.5;
const MAX_TTS_RATE = 2.0;
const MIN_TTS_PITCH = 0.5;
const MAX_TTS_PITCH = 2.0;
const MAX_TERMUX_TEXT_LEN = 240;
const TTS_TEST_MAX_LEN = 220;
const TERMUX_DEFAULT_STREAM = "MUSIC";
const TTS_CMD_TIMEOUT_MS = 90000;

function commandExistsSync(cmd) {
  if (!cmd) return false;
  const pathValue = process.env.PATH || "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

const RUNTIME_CAPS = Object.freeze({
  platform: process.platform,
  isTermux: process.platform === "android" || String(process.env.PREFIX || "").includes("com.termux"),
  hasTermuxTts: commandExistsSync("termux-tts-speak"),
  hasTermuxTtsEngines: commandExistsSync("termux-tts-engines"),
  hasTermuxMediaPlayer: commandExistsSync("termux-media-player"),
  hasAplay: commandExistsSync("aplay"),
  hasPaplay: commandExistsSync("paplay"),
  hasAfplay: commandExistsSync("afplay"),
  hasPowerShell: commandExistsSync("powershell")
});

function getRecommendedEngine() {
  if (RUNTIME_CAPS.hasTermuxTts) return "termux";
  if (RUNTIME_CAPS.platform === "win32" || RUNTIME_CAPS.platform === "darwin" || RUNTIME_CAPS.platform === "linux") {
    return "say";
  }
  return "piper";
}

function getAvailableEngines() {
  const out = ["piper"];
  if (RUNTIME_CAPS.hasTermuxTts) out.push("termux");
  if (RUNTIME_CAPS.platform !== "android") out.push("say");
  return out;
}

function getRuntimeSnapshot() {
  return {
    platform: RUNTIME_CAPS.platform,
    isTermux: !!RUNTIME_CAPS.isTermux,
    hasTermuxTts: !!RUNTIME_CAPS.hasTermuxTts,
    hasTermuxTtsEngines: !!RUNTIME_CAPS.hasTermuxTtsEngines,
    availableTtsEngines: getAvailableEngines(),
    recommendedTtsEngine: getRecommendedEngine()
  };
}

const DEFAULT_TTS_ENGINE = getRecommendedEngine();
const DEFAULT_PIPER_PYTHON_CMD = process.platform === "win32" ? "py" : "python";

const DEFAULT_SETTINGS = {
  tiktokUsername: "TU_USUARIO_SIN_ARROBA",
  bindHost: "127.0.0.1",
  port: 8787,

  ttsEnabled: true,
  globalCooldownMs: 9000,
  perUserCooldownMs: 30000,
  maxQueue: 6,
  maxChars: 80,
  maxWords: 14,
  historySize: 25,

  ttsEngine: DEFAULT_TTS_ENGINE,
  ttsVoice: "",
  ttsRate: 1.0,

  piper: {
    modelPath: "",
    lengthScale: 1.0,
    volume: 1.0,
    pythonCmd: DEFAULT_PIPER_PYTHON_CMD
  },

  termux: {
    engine: "",
    language: "",
    region: "",
    variant: "",
    pitch: 1.0,
    rate: 1.0,
    stream: TERMUX_DEFAULT_STREAM,
    outputMode: "media",
    coexistenceMode: "duck"
  },

  autoBan: {
    enabled: true,
    strikeThreshold: 2,
    banMinutes: 30
  }
};

// -------------------- Small utils --------------------
function nowMs() {
  return Date.now();
}

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readTextSync(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

function readLines(filePath) {
  try {
    return readTextSync(filePath)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(readTextSync(filePath));
  } catch {
    return fallback;
  }
}

// Escritura atómica: escribe a tmp y renombra
function writeJsonAtomicSync(filePath, obj) {
  const dir = path.dirname(filePath);
  ensureDirSync(dir);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function ensureFileIfMissing(filePath, content) {
  if (!fs.existsSync(filePath)) {
    ensureDirSync(path.dirname(filePath));
    fs.writeFileSync(filePath, content, "utf8");
  }
}

function clampNumber(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(max, Math.max(min, x));
}

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function sanitizeTermuxStream(value, fallback = TERMUX_DEFAULT_STREAM) {
  const v = String(value || fallback || TERMUX_DEFAULT_STREAM).trim().toUpperCase();
  return TERMUX_STREAMS.has(v) ? v : TERMUX_DEFAULT_STREAM;
}

function sanitizeMode(value, allowed, fallback) {
  const raw = String(value || fallback || "").trim().toLowerCase();
  return allowed.has(raw) ? raw : fallback;
}

function sanitizeSimpleToken(value, maxLen = 64) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const clean = raw.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, maxLen);
  return clean;
}

function sanitizeLocaleToken(value, kind) {
  const token = sanitizeSimpleToken(value, 16);
  if (!token) return "";

  if (kind === "language") {
    const upper = token.toLowerCase();
    if (/^[a-z]{2,3}$/.test(upper)) return upper;
    return "";
  }

  if (kind === "region") {
    const upper = token.toUpperCase();
    if (/^[A-Z]{2,3}$/.test(upper)) return upper;
    return "";
  }

  return token;
}

function normalizeTermuxConfig(raw = {}, fallback = DEFAULT_SETTINGS.termux) {
  const merged = { ...(fallback || {}), ...(raw || {}) };

  return {
    engine: sanitizeSimpleToken(merged.engine, 96),
    language: sanitizeLocaleToken(merged.language, "language"),
    region: sanitizeLocaleToken(merged.region, "region"),
    variant: sanitizeSimpleToken(merged.variant, 64),
    stream: sanitizeTermuxStream(merged.stream, fallback?.stream || TERMUX_DEFAULT_STREAM),
    pitch: clampNumber(merged.pitch, MIN_TTS_PITCH, MAX_TTS_PITCH, fallback?.pitch ?? 1.0),
    rate: clampNumber(merged.rate, MIN_TTS_RATE, MAX_TTS_RATE, fallback?.rate ?? 1.0),
    outputMode: sanitizeMode(merged.outputMode, OUTPUT_MODES, fallback?.outputMode || "media"),
    coexistenceMode: sanitizeMode(merged.coexistenceMode, COEXISTENCE_MODES, fallback?.coexistenceMode || "duck")
  };
}

function resolveTermuxStream(config) {
  const outputMode = sanitizeMode(config?.outputMode, OUTPUT_MODES, "media");

  if (outputMode === "media") return "MUSIC";
  if (outputMode === "notification") return "NOTIFICATION";

  const fallback = sanitizeMode(config?.coexistenceMode, COEXISTENCE_MODES, "duck") === "pause"
    ? "NOTIFICATION"
    : TERMUX_DEFAULT_STREAM;

  return sanitizeTermuxStream(config?.stream, fallback);
}

function getSafeError(err, fallback = "unknown_error") {
  const text = String(err?.message || err || fallback).replace(/[\r\n\t]+/g, " ").trim();
  return text.slice(0, 280) || fallback;
}

function validateTextForSpeech(rawText, maxLen = MAX_TERMUX_TEXT_LEN) {
  return normalizeForTts(String(rawText || "")).slice(0, maxLen);
}

function normalizePiperModelPath(rawPath) {
  const raw = String(rawPath || "").trim();
  if (!raw) return "";

  if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(raw)) {
    return "";
  }

  const normalized = raw.replace(/\\/g, path.sep);
  return path.isAbsolute(normalized) ? normalized : path.resolve(__dirname, normalized);
}

// Debounce simple
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// -------------------- Bootstrapping data files --------------------
ensureDirSync(DATA_DIR);
ensureFileIfMissing(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2));
ensureFileIfMissing(BANNED_PATH, JSON.stringify({ users: {} }, null, 2));
ensureFileIfMissing(BAD_EXACT_PATH, "");
ensureFileIfMissing(BAD_SUB_PATH, "");

const rawSettings = readJson(SETTINGS_PATH, null) ?? { ...DEFAULT_SETTINGS };
let settings = {
  ...DEFAULT_SETTINGS,
  ...rawSettings,
  autoBan: {
    ...DEFAULT_SETTINGS.autoBan,
    ...(rawSettings.autoBan || {})
  },
  piper: {
    ...DEFAULT_SETTINGS.piper,
    ...(rawSettings.piper || {})
  },
  termux: {
    ...DEFAULT_SETTINGS.termux,
    ...(rawSettings.termux || {})
  }
};

if (!SUPPORTED_TTS_ENGINES.has(settings.ttsEngine)) {
  settings.ttsEngine = DEFAULT_TTS_ENGINE;
}

if (!settings.piper.pythonCmd) {
  settings.piper.pythonCmd = DEFAULT_PIPER_PYTHON_CMD;
}

settings.termux = normalizeTermuxConfig(settings.termux, DEFAULT_SETTINGS.termux);

// Migración automática: configuración legacy "say" no funciona en Android/Termux.
if (RUNTIME_CAPS.isTermux && settings.ttsEngine === "say") {
  settings.ttsEngine = RUNTIME_CAPS.hasTermuxTts ? "termux" : "piper";
}

writeJsonAtomicSync(SETTINGS_PATH, settings);

// -------------------- Server + Socket.IO (init early for safe emit) --------------------
const app = express();
app.use(express.json({ limit: "128kb" }));
app.use(express.static(path.join(__dirname, "public")));

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {});

function safeEmit(evt, payload) {
  try {
    io.emit(evt, payload);
  } catch {}
}

// -------------------- State --------------------
let bannedDb = readJson(BANNED_PATH, { users: {} });

let bannedExact = new Set(readLines(BAD_EXACT_PATH).map((s) => s.toLowerCase()));
let bannedSub = readLines(BAD_SUB_PATH).map((s) => s.toLowerCase()).filter((s) => s.length >= 4);

const strikes = new Map();

let ttsEnabled = !!settings.ttsEnabled;
let speaking = false;
let lastGlobalSpeak = 0;
const lastUserSpeak = new Map();
const queue = [];
const recentLog = [];
const recentHistory = [];
let nextHistoryId = 1;
let nextMsgId = 1;
let sessionTermuxOverrides = {};

function pickDefined(target, source, sourceKey, targetKey = sourceKey) {
  if (!source || typeof source !== "object") return;
  if (!Object.prototype.hasOwnProperty.call(source, sourceKey)) return;
  target[targetKey] = source[sourceKey];
}

function extractTermuxConfigInput(payload = {}) {
  const out = {};
  const root = payload && typeof payload === "object" ? payload : {};
  const nested = root.termux && typeof root.termux === "object" ? root.termux : {};

  pickDefined(out, root, "engine");
  pickDefined(out, root, "language");
  pickDefined(out, root, "region");
  pickDefined(out, root, "variant");
  pickDefined(out, root, "stream");
  pickDefined(out, root, "pitch");
  pickDefined(out, root, "rate");
  pickDefined(out, root, "outputMode");
  pickDefined(out, root, "coexistenceMode");

  pickDefined(out, root, "termuxEngine", "engine");
  pickDefined(out, root, "termuxLanguage", "language");
  pickDefined(out, root, "termuxRegion", "region");
  pickDefined(out, root, "termuxVariant", "variant");
  pickDefined(out, root, "termuxStream", "stream");
  pickDefined(out, root, "termuxPitch", "pitch");
  pickDefined(out, root, "termuxRate", "rate");
  pickDefined(out, root, "termuxOutputMode", "outputMode");
  pickDefined(out, root, "termuxCoexistenceMode", "coexistenceMode");

  pickDefined(out, nested, "engine");
  pickDefined(out, nested, "language");
  pickDefined(out, nested, "region");
  pickDefined(out, nested, "variant");
  pickDefined(out, nested, "stream");
  pickDefined(out, nested, "pitch");
  pickDefined(out, nested, "rate");
  pickDefined(out, nested, "outputMode");
  pickDefined(out, nested, "coexistenceMode");

  return out;
}

function getPersistedTermuxConfig() {
  return normalizeTermuxConfig(settings.termux, DEFAULT_SETTINGS.termux);
}

function getEffectiveTermuxConfig(overrides = null) {
  const persisted = getPersistedTermuxConfig();
  const session = normalizeTermuxConfig(sessionTermuxOverrides, persisted);

  if (!overrides || typeof overrides !== "object") {
    return session;
  }

  return normalizeTermuxConfig(extractTermuxConfigInput(overrides), session);
}

function getResolvedTermuxSpeakConfig(overrides = null) {
  const merged = getEffectiveTermuxConfig(overrides);
  return {
    ...merged,
    effectiveStream: resolveTermuxStream(merged)
  };
}

function getPersistScope(raw) {
  const scope = String(raw || "global").trim().toLowerCase();
  return PERSIST_SCOPES.has(scope) ? scope : "global";
}

// -------------------- Snapshots for UI --------------------
function getQueueSnapshot() {
  return { ttsEnabled, speaking, size: queue.length, items: queue.slice(0, 20) };
}

function getHistorySnapshot() {
  const limit = settings.historySize ?? 25;
  return { size: recentHistory.length, items: recentHistory.slice(-limit) };
}

function getBansSnapshot() {
  return bannedDb;
}

function getListsSnapshot() {
  return {
    badwordsExact: Array.from(bannedExact.values()).slice(0, 200),
    badwordsSub: bannedSub.slice(0, 200)
  };
}

function getStatusSnapshot() {
  const isSpeaking = speaking || directTtsInProgress || speechLockDepth > 0;
  return { ttsEnabled, speaking: isSpeaking, queueSize: queue.length, ttsEngine: settings.ttsEngine };
}

function getSettingsSnapshot() {
  const persistedTermux = getPersistedTermuxConfig();
  const effectiveTermux = getResolvedTermuxSpeakConfig();
  const hasSessionOverrides = Object.keys(sessionTermuxOverrides || {}).length > 0;

  return {
    globalCooldownMs: settings.globalCooldownMs,
    perUserCooldownMs: settings.perUserCooldownMs,
    maxQueue: settings.maxQueue,
    maxChars: settings.maxChars,
    maxWords: settings.maxWords,
    historySize: settings.historySize,

    ttsEngine: settings.ttsEngine,
    ttsRate: settings.ttsRate,
    ttsVoice: settings.ttsVoice,

    piperModelPath: settings.piper?.modelPath ?? "",
    piperLengthScale: settings.piper?.lengthScale ?? 1.0,
    piperVolume: settings.piper?.volume ?? 1.0,
    piperPythonCmd: settings.piper?.pythonCmd ?? DEFAULT_PIPER_PYTHON_CMD,

    termuxEngine: effectiveTermux.engine,
    termuxLanguage: effectiveTermux.language,
    termuxRegion: effectiveTermux.region,
    termuxVariant: effectiveTermux.variant,
    termuxPitch: effectiveTermux.pitch,
    termuxRate: effectiveTermux.rate,
    termuxStream: effectiveTermux.stream,
    termuxOutputMode: effectiveTermux.outputMode,
    termuxCoexistenceMode: effectiveTermux.coexistenceMode,
    termuxEffectiveStream: effectiveTermux.effectiveStream,
    termuxPersistScope: hasSessionOverrides ? "session" : "global",
    termuxPersistedConfig: persistedTermux,

    autoBanEnabled: settings.autoBan?.enabled ?? true,
    autoBanStrikeThreshold: settings.autoBan?.strikeThreshold ?? 2,
    autoBanBanMinutes: settings.autoBan?.banMinutes ?? 30,

    runtime: getRuntimeSnapshot()
  };
}

// -------------------- Logging/history --------------------
function pushLog(evt) {
  const item = { ...evt, ts: nowMs() };
  recentLog.push(item);
  while (recentLog.length > 200) recentLog.shift();
  safeEmit("log", item);
}

function stripDiacritics(s) {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function normalizeForTts(s) {
  if (!s) return "";
  let t = String(s);
  t = t.replace(/[\u200B-\u200D\uFEFF]/g, "");
  t = stripDiacritics(t);
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function normalizeForModeration(s) {
  let t = String(s).toLowerCase();
  t = t.replace(/[\u200B-\u200D\uFEFF]/g, "");
  t = stripDiacritics(t);

  t = t
    .replace(/0/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/8/g, "b")
    .replace(/\$/g, "s")
    .replace(/@/g, "a");

  t = t.replace(/[^\p{L}\p{N}\s]+/gu, " ");
  t = t.replace(/([a-z])\1{2,}/g, "$1$1");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function tokenize(norm) {
  return norm.split(" ").filter(Boolean);
}

function buildHistoryEntry(entry) {
  const comment = entry.comment || "";
  const norm = normalizeForModeration(comment);
  const tokens = tokenize(norm);
  return {
    id: nextHistoryId++,
    ts: nowMs(),
    uniqueId: entry.uniqueId,
    nickname: entry.nickname,
    comment,
    source: entry.source || "tiktok",
    status: entry.status,
    reason: entry.reason || "",
    tokens
  };
}

function pushHistory(entry) {
  const item = buildHistoryEntry(entry);
  recentHistory.push(item);
  while (recentHistory.length > (settings.historySize ?? 25)) recentHistory.shift();
  safeEmit("history", item);
}

// -------------------- Hot reload lists (debounced) --------------------
const reloadExact = debounce(() => {
  bannedExact = new Set(readLines(BAD_EXACT_PATH).map((s) => s.toLowerCase()));
  safeEmit("listsUpdated", getListsSnapshot());
}, 250);

const reloadSub = debounce(() => {
  bannedSub = readLines(BAD_SUB_PATH).map((s) => s.toLowerCase()).filter((s) => s.length >= 4);
  safeEmit("listsUpdated", getListsSnapshot());
}, 250);

const reloadBans = debounce(() => {
  bannedDb = readJson(BANNED_PATH, { users: {} });
  safeEmit("bansUpdated", getBansSnapshot());
}, 250);

fs.watchFile(BAD_EXACT_PATH, { interval: 1500 }, reloadExact);
fs.watchFile(BAD_SUB_PATH, { interval: 1500 }, reloadSub);
fs.watchFile(BANNED_PATH, { interval: 1500 }, reloadBans);

// -------------------- Moderation rules --------------------
const RE_URL = /(https?:\/\/|www\.|\.com|\.net|\.gg|\.ru|\.mx|\.xyz)/i;
const RE_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const RE_PHONE = /\b\d{10}\b/;
const RE_MENTION = /@\w+/u;
const RE_SPAM_REPEAT = /(.)\1{4,}/u;
const RE_PUNCT_SPAM = /[!?¿¡]{4,}/u;

const RE_ALLOWED = /^[\p{Script=Latin}\p{N}\s.,!?¿¡'":;()\-\+]{1,200}$/u;
const RE_DISALLOWED = /[^\p{Script=Latin}\p{N}\s.,!?¿¡'":;()\-\+]+/gu;

const BANNED_SPACED = new Set([
  "puta", "puto", "verga", "mierda", "pendejo", "pendeja",
  "chingada", "chingar", "cabron", "culero", "pinche",
  "mamada", "mamon", "ojete", "imbecil", "estupido",
  "hdp", "ptm", "alv", "vtlv"
]);

function hasBannedExact(tokens) {
  for (const w of tokens) if (bannedExact.has(w)) return true;
  return false;
}

function hasBannedJoined(norm) {
  const joined = norm.replace(/\s+/g, "");
  for (const bad of bannedSub) {
    if (joined.includes(bad)) return true;
  }
  return false;
}

function hasBannedSpaced(tokens) {
  if (tokens.length < 3) return false;
  if (!tokens.every((t) => t.length === 1)) return false;
  return BANNED_SPACED.has(tokens.join(""));
}

function filterChatText(raw) {
  if (!raw) return { ok: false, reason: "empty" };

  const trimmed = String(raw).trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  const clipped = trimmed.slice(0, settings.maxChars);

  if (RE_URL.test(clipped)) return { ok: false, reason: "url" };
  if (RE_EMAIL.test(clipped)) return { ok: false, reason: "email" };
  if (RE_PHONE.test(clipped)) return { ok: false, reason: "phone" };
  if (RE_MENTION.test(clipped)) return { ok: false, reason: "mention" };
  if (RE_SPAM_REPEAT.test(clipped)) return { ok: false, reason: "repeat_spam" };
  if (RE_PUNCT_SPAM.test(clipped)) return { ok: false, reason: "punct_spam" };

  const cleaned = clipped.replace(RE_DISALLOWED, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return { ok: false, reason: "empty_norm" };
  if (!RE_ALLOWED.test(cleaned)) return { ok: false, reason: "chars" };

  const norm = normalizeForModeration(cleaned);
  const tokens = tokenize(norm);

  if (tokens.length === 0) return { ok: false, reason: "empty_norm" };
  if (tokens.length > settings.maxWords) return { ok: false, reason: "too_many_words" };

  if (hasBannedSpaced(tokens)) return { ok: false, reason: "badword_spaced" };
  if (hasBannedExact(tokens)) return { ok: false, reason: "badword_exact" };
  if (hasBannedJoined(norm)) return { ok: false, reason: "badword_joined" };

  return { ok: true, text: cleaned };
}

// -------------------- Ban logic --------------------
function isBanned(uniqueId) {
  const entry = bannedDb.users[uniqueId];
  if (!entry) return { banned: false };

  if (entry.untilMs && entry.untilMs > 0 && nowMs() > entry.untilMs) {
    delete bannedDb.users[uniqueId];
    writeJsonAtomicSync(BANNED_PATH, bannedDb);
    return { banned: false };
  }
  return { banned: true, entry };
}

function banUser(uniqueId, reason, minutes = 30) {
  const m = clampNumber(minutes, 1, 24 * 60, 30);
  const untilMs = m > 0 ? nowMs() + m * 60 * 1000 : 0;
  bannedDb.users[uniqueId] = { reason, addedAtMs: nowMs(), untilMs };
  writeJsonAtomicSync(BANNED_PATH, bannedDb);
  safeEmit("bansUpdated", getBansSnapshot());
}

function unbanUser(uniqueId) {
  delete bannedDb.users[uniqueId];
  writeJsonAtomicSync(BANNED_PATH, bannedDb);
  safeEmit("bansUpdated", getBansSnapshot());
}

function addStrike(uniqueId) {
  const c = (strikes.get(uniqueId) ?? 0) + 1;
  strikes.set(uniqueId, c);

  if (settings.autoBan?.enabled && c >= settings.autoBan.strikeThreshold) {
    banUser(uniqueId, `Auto-ban: ${c} infracciones`, settings.autoBan.banMinutes);
    strikes.set(uniqueId, 0);
  }
  return c;
}

// -------------------- Cooldowns & Queue --------------------
function canSpeakNow(uniqueId) {
  const now = nowMs();

  if (now - lastGlobalSpeak < settings.globalCooldownMs) return false;

  const last = lastUserSpeak.get(uniqueId) ?? 0;
  if (now - last < settings.perUserCooldownMs) return false;

  return true;
}

function markSpeak(uniqueId) {
  const now = nowMs();
  lastGlobalSpeak = now;
  lastUserSpeak.set(uniqueId, now);
}

function enqueueMessage(msg) {
  if (queue.length >= settings.maxQueue) {
    pushLog({ type: "queue_drop", reason: "queue_full", msg });
    return false;
  }
  queue.push(msg);
  safeEmit("queue", getQueueSnapshot());
  startQueueWorker();
  return true;
}

function skipQueueMessage(id) {
  const idx = queue.findIndex((m) => m.id === id);
  if (idx === -1) return false;
  const [removed] = queue.splice(idx, 1);
  safeEmit("queue", getQueueSnapshot());
  pushLog({ type: "queue_skip", msg: removed });
  return true;
}

// -------------------- TTS engines --------------------
let sayApi = null;
let sayLoadError = null;

async function loadSayApi() {
  if (sayApi) return sayApi;
  if (sayLoadError) throw sayLoadError;

  if (process.platform === "android") {
    sayLoadError = new Error("say_unsupported_platform_android");
    throw sayLoadError;
  }

  try {
    const mod = await import("say");
    const api = mod?.default ?? mod;
    if (!api || typeof api.speak !== "function") {
      throw new Error("say_invalid_module");
    }
    sayApi = api;
    return sayApi;
  } catch (err) {
    sayLoadError = err instanceof Error ? err : new Error(String(err));
    throw sayLoadError;
  }
}

function getInstalledVoicesWin() {
  return new Promise((resolve) => {
    if (!RUNTIME_CAPS.hasPowerShell) {
      resolve({ voices: [], error: "powershell_not_found", source: "win32" });
      return;
    }

    const command =
      "Add-Type -AssemblyName System.Speech; " +
      "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
      "$synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }";

    execFile("powershell", ["-NoProfile", "-Command", command], { windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ voices: [], error: String(err), source: "win32" });
        return;
      }
      const voices = String(stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      resolve({ voices, source: "win32" });
    });
  });
}

async function runProcess(cmd, args = [], inputText = null, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  const onSpawn = typeof options.onSpawn === "function" ? options.onSpawn : null;

  return await new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    if (onSpawn) {
      try { onSpawn(proc); } catch {}
    }

    let stdout = "";
    let stderr = "";
    let finished = false;
    let timeout = null;

    const finalize = () => {
      if (timeout) clearTimeout(timeout);
      if (onSpawn) {
        try { onSpawn(null); } catch {}
      }
    };

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        try { proc.kill("SIGKILL"); } catch {}
        finalize();
        reject(new Error(`${cmd} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    if (inputText !== null && inputText !== undefined && proc.stdin) {
      try {
        proc.stdin.write(inputText);
      } catch {}
      try {
        proc.stdin.end();
      } catch {}
    } else if (proc.stdin) {
      try {
        proc.stdin.end();
      } catch {}
    }

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", (err) => {
      if (finished) return;
      finished = true;
      finalize();
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    proc.on("close", (code) => {
      if (finished) return;
      finished = true;
      finalize();

      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = String(stderr || stdout || "").trim();
        reject(new Error(`${cmd} exited ${code}${detail ? `: ${detail}` : ""}`));
      }
    });
  });
}

async function getInstalledVoicesSay() {
  try {
    const say = await loadSayApi();
    return await new Promise((resolve) => {
      say.getInstalledVoices((err, voices) => {
        if (err) {
          resolve({ voices: [], error: String(err), source: "say" });
          return;
        }
        resolve({ voices: Array.isArray(voices) ? voices : [], source: "say" });
      });
    });
  } catch (err) {
    return { voices: [], error: String(err), source: "say" };
  }
}

async function getInstalledTermuxEngines() {
  if (!RUNTIME_CAPS.hasTermuxTtsEngines) {
    return { voices: [], error: "termux_tts_engines_missing", source: "termux" };
  }

  try {
    const { stdout } = await runProcess("termux-tts-engines", [], null, { timeoutMs: 7000 });
    const parsed = JSON.parse(stdout || "[]");
    const engines = Array.isArray(parsed)
      ? parsed.map((e) => String(e?.name || "").trim()).filter(Boolean)
      : [];

    return {
      voices: engines,
      source: "termux",
      meta: {
        kind: "termux_engines",
        engines: Array.isArray(parsed) ? parsed : []
      }
    };
  } catch (err) {
    return { voices: [], error: String(err), source: "termux" };
  }
}

async function getInstalledVoices() {
  if (settings.ttsEngine === "termux") {
    const termuxResult = await getInstalledTermuxEngines();
    if (termuxResult.voices.length > 0 || !termuxResult.error) {
      return termuxResult;
    }
  }

  const sayResult = await getInstalledVoicesSay();
  if (sayResult.voices.length > 0) return sayResult;

  if (process.platform === "win32") {
    const winResult = await getInstalledVoicesWin();
    if (winResult.voices.length > 0) return winResult;
    return { voices: [], error: sayResult.error || winResult.error || "no_voices", source: "say" };
  }

  if (RUNTIME_CAPS.hasTermuxTtsEngines) {
    const termuxResult = await getInstalledTermuxEngines();
    if (termuxResult.voices.length > 0) {
      return {
        ...termuxResult,
        error: sayResult.error || termuxResult.error
      };
    }
  }

  return sayResult;
}

function validateEnumField(rawValue, allowed, fieldName, errors) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return;
  const v = String(rawValue).trim().toLowerCase();
  if (!allowed.has(v)) errors.push({ field: fieldName, message: `valor_invalido: ${v}` });
}

async function validateTermuxConfig(rawConfig = {}, options = {}) {
  const input = extractTermuxConfigInput(rawConfig);
  const base = options.baseConfig && typeof options.baseConfig === "object"
    ? normalizeTermuxConfig(options.baseConfig, DEFAULT_SETTINGS.termux)
    : getEffectiveTermuxConfig();

  const normalized = normalizeTermuxConfig(input, base);
  const errors = [];
  const warnings = [];

  if (Object.prototype.hasOwnProperty.call(input, "pitch")) {
    const n = Number(input.pitch);
    if (!Number.isFinite(n) || n < MIN_TTS_PITCH || n > MAX_TTS_PITCH) {
      errors.push({ field: "pitch", message: `fuera_de_rango_${MIN_TTS_PITCH}_${MAX_TTS_PITCH}` });
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, "rate")) {
    const n = Number(input.rate);
    if (!Number.isFinite(n) || n < MIN_TTS_RATE || n > MAX_TTS_RATE) {
      errors.push({ field: "rate", message: `fuera_de_rango_${MIN_TTS_RATE}_${MAX_TTS_RATE}` });
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, "engine") && String(input.engine || "").trim() && !normalized.engine) {
    errors.push({ field: "engine", message: "engine_invalido" });
  }
  if (Object.prototype.hasOwnProperty.call(input, "language") && String(input.language || "").trim() && !normalized.language) {
    errors.push({ field: "language", message: "language_invalido_formato_iso" });
  }
  if (Object.prototype.hasOwnProperty.call(input, "region") && String(input.region || "").trim() && !normalized.region) {
    errors.push({ field: "region", message: "region_invalida_formato_iso" });
  }
  if (Object.prototype.hasOwnProperty.call(input, "variant") && String(input.variant || "").trim() && !normalized.variant) {
    errors.push({ field: "variant", message: "variant_invalida" });
  }

  if (Object.prototype.hasOwnProperty.call(input, "stream")) {
    const raw = String(input.stream || "").trim().toUpperCase();
    if (raw && !TERMUX_STREAMS.has(raw)) {
      errors.push({ field: "stream", message: "stream_invalido" });
    }
  }

  validateEnumField(input.outputMode, OUTPUT_MODES, "outputMode", errors);
  validateEnumField(input.coexistenceMode, COEXISTENCE_MODES, "coexistenceMode", errors);

  if (!RUNTIME_CAPS.hasTermuxTts) {
    warnings.push({
      field: "runtime",
      message: "termux-tts-speak no detectado; la configuracion quedara guardada pero no se podra ejecutar en este runtime."
    });
  }

  let enginesDetected = [];
  let probeError = "";

  if (RUNTIME_CAPS.hasTermuxTtsEngines) {
    const probe = await getInstalledTermuxEngines();
    enginesDetected = Array.isArray(probe.voices) ? probe.voices : [];
    probeError = probe.error ? String(probe.error) : "";

    if (normalized.engine && enginesDetected.length > 0 && !enginesDetected.includes(normalized.engine)) {
      warnings.push({
        field: "engine",
        message: `engine_no_detectado: ${normalized.engine}`
      });
    }

    if (probeError) {
      warnings.push({
        field: "engine",
        message: "no_fue_posible_validar_engines_con_termux-tts-engines"
      });
    }
  } else {
    warnings.push({
      field: "engine",
      message: "termux-tts-engines no disponible; validacion de soporte real limitada."
    });
  }

  warnings.push({
    field: "language",
    message: "Termux no expone una API estable para verificar soporte language/region/variant por engine en tiempo real; se aplica validacion defensiva."
  });

  if (normalized.outputMode === "media" && normalized.stream !== "MUSIC") {
    warnings.push({
      field: "stream",
      message: "outputMode=media prioriza stream MUSIC durante la reproduccion."
    });
  }

  return {
    ok: errors.length === 0,
    normalized,
    errors,
    warnings,
    capabilities: {
      hasTermuxTts: RUNTIME_CAPS.hasTermuxTts,
      hasTermuxTtsEngines: RUNTIME_CAPS.hasTermuxTtsEngines,
      enginesDetected,
      probeError
    }
  };
}

function getTermuxConfigSnapshot() {
  const defaults = normalizeTermuxConfig(DEFAULT_SETTINGS.termux, DEFAULT_SETTINGS.termux);
  const persisted = getPersistedTermuxConfig();
  const session = normalizeTermuxConfig(sessionTermuxOverrides, persisted);
  const effective = getResolvedTermuxSpeakConfig();

  return {
    defaults,
    persisted,
    session,
    effective,
    persistScope: Object.keys(sessionTermuxOverrides || {}).length > 0 ? "session" : "global"
  };
}

function buildTermuxSpeakArgs(termuxOverrides = null) {
  const cfg = getResolvedTermuxSpeakConfig(termuxOverrides);
  const args = [];

  if (cfg.engine) args.push("-e", cfg.engine);
  if (cfg.language) args.push("-l", cfg.language);
  if (cfg.region) args.push("-n", cfg.region);
  if (cfg.variant) args.push("-v", cfg.variant);

  args.push("-p", String(cfg.pitch));
  args.push("-r", String(cfg.rate));
  args.push("-s", cfg.effectiveStream);

  return { args, cfg };
}

async function speakWithTermux(text, options = {}) {
  if (!RUNTIME_CAPS.hasTermuxTts) {
    throw new Error("termux_tts_missing");
  }

  const cleanText = validateTextForSpeech(text, MAX_TERMUX_TEXT_LEN);
  if (!cleanText) return;

  const { args } = buildTermuxSpeakArgs(options.termuxOverrides || null);
  await runProcess("termux-tts-speak", args, `${cleanText}\n`, {
    timeoutMs: TTS_CMD_TIMEOUT_MS,
    onSpawn: options.onSpawn
  });
}
async function speakWithPiper(text, options = {}) {
  const ttsText = validateTextForSpeech(text, MAX_TERMUX_TEXT_LEN);
  if (!ttsText) return;

  const modelPath = normalizePiperModelPath(options?.modelPath || "");
  if (!modelPath) throw new Error("piper_model_missing");
  if (!fs.existsSync(modelPath)) throw new Error(`piper_model_not_found: ${modelPath}`);

  const lengthScale = clampNumber(options?.lengthScale, 0.5, 2.5, 1.0);
  const volume = clampNumber(options?.volume, 0.0, 2.0, 1.0);
  const pythonCmd = String(options?.pythonCmd || DEFAULT_PIPER_PYTHON_CMD).trim() || DEFAULT_PIPER_PYTHON_CMD;

  const wavPath = path.join(
    os.tmpdir(),
    `piper-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`
  );

  await runProcess(
    pythonCmd,
    [
      "-m",
      "piper",
      "-m",
      modelPath,
      "--output_file",
      wavPath,
      "--length_scale",
      String(lengthScale),
      "--volume",
      String(volume)
    ],
    `${ttsText}\n`,
    { timeoutMs: 120000, onSpawn: options.onSpawn }
  );

  try {
    if (process.platform === "win32") {
      const safePath = wavPath.replace(/'/g, "''");
      const psCmd = `(New-Object System.Media.SoundPlayer '${safePath}').PlaySync()`;
      await runProcess("powershell", ["-NoProfile", "-Command", psCmd], null, { timeoutMs: 120000, onSpawn: options.onSpawn });
    } else if (process.platform === "darwin") {
      await runProcess("afplay", [wavPath], null, { timeoutMs: 120000, onSpawn: options.onSpawn });
    } else if (RUNTIME_CAPS.hasAplay) {
      await runProcess("aplay", ["-q", wavPath], null, { timeoutMs: 120000, onSpawn: options.onSpawn });
    } else if (RUNTIME_CAPS.hasPaplay) {
      await runProcess("paplay", [wavPath], null, { timeoutMs: 120000, onSpawn: options.onSpawn });
    } else if (RUNTIME_CAPS.hasTermuxMediaPlayer) {
      await runProcess("termux-media-player", ["play", wavPath], null, { timeoutMs: 8000, onSpawn: options.onSpawn });
      await new Promise((r) => setTimeout(r, Math.min(10000, Math.max(1200, ttsText.length * 65))));
      await runProcess("termux-media-player", ["stop"], null, { timeoutMs: 4000, onSpawn: options.onSpawn }).catch(() => {});
    } else {
      throw new Error("no_audio_player_for_piper");
    }
  } finally {
    await fs.promises.unlink(wavPath).catch(() => {});
  }
}
async function speakWithSay(text, options = {}) {
  const say = await loadSayApi();
  const voice = Object.prototype.hasOwnProperty.call(options, "voice")
    ? options.voice
    : (settings.ttsVoice || null);
  const rate = clampNumber(
    Object.prototype.hasOwnProperty.call(options, "rate") ? options.rate : settings.ttsRate,
    MIN_TTS_RATE,
    MAX_TTS_RATE,
    1.0
  );
  const timeoutMs = Number(options.timeoutMs || TTS_CMD_TIMEOUT_MS);

  const speakPromise = new Promise((resolve, reject) => {
    try {
      say.speak(text, voice, rate, (err) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve();
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    await speakPromise;
    return;
  }

  await Promise.race([
    speakPromise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`say timeout after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

function getEngineFallbackOrder(preferred) {
  const seen = new Set();
  const out = [];
  const candidates = [preferred, getRecommendedEngine(), "termux", "piper", "say"];

  for (const engine of candidates) {
    if (!SUPPORTED_TTS_ENGINES.has(engine)) continue;
    if (seen.has(engine)) continue;
    seen.add(engine);
    out.push(engine);
  }

  return out;
}

function isEngineRunnable(engine) {
  if (engine === "termux") return RUNTIME_CAPS.hasTermuxTts;
  if (engine === "say") return process.platform !== "android";
  return true;
}

async function speakByEngine(engine, text, options = {}) {
  if (engine === "termux") {
    await speakWithTermux(text, {
      termuxOverrides: options.termuxOverrides || null,
      onSpawn: options.onSpawn
    });
    return;
  }

  if (engine === "piper") {
    const piperOptions = options.piperOptions || settings.piper;
    await speakWithPiper(text, piperOptions);
    return;
  }

  await speakWithSay(text, options.sayOptions || {});
}

async function speakMessage(text, options = {}) {
  const ttsText = validateTextForSpeech(text, MAX_TERMUX_TEXT_LEN);
  if (!ttsText) return;

  const preferredCandidate = String(options.preferredEngine || settings.ttsEngine || "").trim();
  const preferred = SUPPORTED_TTS_ENGINES.has(preferredCandidate)
    ? preferredCandidate
    : getRecommendedEngine();

  const engines = options.strictEngine ? [preferred] : getEngineFallbackOrder(preferred);
  const errors = [];

  for (const engine of engines) {
    if (!isEngineRunnable(engine)) {
      errors.push(`${engine}:unavailable`);
      continue;
    }

    try {
      await speakByEngine(engine, ttsText, options);
      if (engine !== preferred && !options.strictEngine) {
        pushLog({ type: "tts_fallback", from: preferred, to: engine });
      }
      return;
    } catch (err) {
      const msg = getSafeError(err);
      errors.push(`${engine}:${msg}`);
      pushLog({ type: "tts_error", engine, error: msg });
    }
  }

  throw new Error(`tts_all_engines_failed: ${errors.join(" | ")}`);
}

let queueWorkerRunning = false;
let speechLockDepth = 0;
let directTtsInProgress = false;

function isTtsBusy() {
  return queueWorkerRunning || speechLockDepth > 0 || directTtsInProgress || queue.length > 0;
}

let speechSerial = Promise.resolve();
function enqueueSpeechTask(task) {
  const wrapped = async () => {
    speechLockDepth += 1;
    try {
      return await task();
    } finally {
      speechLockDepth = Math.max(0, speechLockDepth - 1);
    }
  };

  const run = speechSerial.then(wrapped, wrapped);
  speechSerial = run.catch(() => {});
  return run;
}

// Worker único
async function queueWorkerLoop() {
  queueWorkerRunning = true;
  speaking = true;
  safeEmit("status", getStatusSnapshot());

  try {
    while (ttsEnabled) {
      const m = queue.shift();
      safeEmit("queue", getQueueSnapshot());

      if (!m) break;

      pushLog({ type: "tts_speak", id: m.id, source: m.source || "queue", uid: m.uniqueId });

      try {
        await enqueueSpeechTask(() => speakMessage(m.text, {
          termuxOverrides: m.termuxOverrides || null,
          preferredEngine: m.ttsEngineOverride || null
        }));
      } catch (err) {
        pushLog({ type: "tts_error", error: getSafeError(err), id: m.id });
      }

      await new Promise((r) => setTimeout(r, 120));
    }
  } finally {
    speaking = false;
    queueWorkerRunning = false;
    safeEmit("status", getStatusSnapshot());
  }
}

function startQueueWorker() {
  if (!ttsEnabled) return;
  if (queueWorkerRunning) return;
  if (queue.length === 0) return;
  queueWorkerLoop().catch((err) => {
    pushLog({ type: "worker_error", error: getSafeError(err) });
  });
}

// -------------------- Settings update --------------------
function applySettingsUpdate(update) {
  if (!update || typeof update !== "object") return { ok: false, error: "invalid" };

  const next = {
    ...settings,
    autoBan: { ...settings.autoBan },
    piper: { ...settings.piper },
    termux: { ...settings.termux }
  };

  if ("globalCooldownMs" in update) next.globalCooldownMs = Math.max(0, toInt(update.globalCooldownMs, settings.globalCooldownMs));
  if ("perUserCooldownMs" in update) next.perUserCooldownMs = Math.max(0, toInt(update.perUserCooldownMs, settings.perUserCooldownMs));

  if ("maxQueue" in update) next.maxQueue = Math.max(1, toInt(update.maxQueue, settings.maxQueue));
  if ("maxChars" in update) next.maxChars = Math.max(1, toInt(update.maxChars, settings.maxChars));
  if ("maxWords" in update) next.maxWords = Math.max(1, toInt(update.maxWords, settings.maxWords));
  if ("historySize" in update) next.historySize = Math.max(5, toInt(update.historySize, settings.historySize ?? 25));

  if ("ttsEngine" in update) {
    const v = String(update.ttsEngine || "").trim();
    if (SUPPORTED_TTS_ENGINES.has(v)) next.ttsEngine = v;
  }

  if ("ttsRate" in update) next.ttsRate = clampNumber(update.ttsRate, MIN_TTS_RATE, MAX_TTS_RATE, settings.ttsRate);
  if ("ttsVoice" in update) next.ttsVoice = String(update.ttsVoice ?? "").trim();

  if ("piperModelPath" in update) next.piper.modelPath = String(update.piperModelPath ?? "").trim();
  if ("piperLengthScale" in update) next.piper.lengthScale = clampNumber(update.piperLengthScale, 0.5, 2.5, next.piper.lengthScale);
  if ("piperVolume" in update) next.piper.volume = clampNumber(update.piperVolume, 0.0, 2.0, next.piper.volume);
  if ("piperPythonCmd" in update) next.piper.pythonCmd = String(update.piperPythonCmd || "").trim() || DEFAULT_PIPER_PYTHON_CMD;

  const termuxInput = extractTermuxConfigInput(update);
  if (Object.keys(termuxInput).length > 0) {
    next.termux = normalizeTermuxConfig(termuxInput, next.termux);
  } else {
    next.termux = normalizeTermuxConfig(next.termux, DEFAULT_SETTINGS.termux);
  }

  if ("autoBanEnabled" in update) next.autoBan.enabled = !!update.autoBanEnabled;
  if ("autoBanStrikeThreshold" in update) next.autoBan.strikeThreshold = Math.max(1, toInt(update.autoBanStrikeThreshold, next.autoBan.strikeThreshold ?? 2));
  if ("autoBanBanMinutes" in update) next.autoBan.banMinutes = Math.max(1, toInt(update.autoBanBanMinutes, next.autoBan.banMinutes ?? 30));

  settings = next;
  writeJsonAtomicSync(SETTINGS_PATH, settings);

  while (queue.length > settings.maxQueue) {
    const removed = queue.pop();
    pushLog({ type: "queue_drop", reason: "queue_resize", msg: removed });
  }
  while (recentHistory.length > (settings.historySize ?? 25)) {
    recentHistory.shift();
  }

  safeEmit("settings", getSettingsSnapshot());
  safeEmit("queue", getQueueSnapshot());
  safeEmit("historyBulk", getHistorySnapshot());
  safeEmit("status", getStatusSnapshot());

  if (settings.ttsEngine === "termux" && !RUNTIME_CAPS.hasTermuxTts) {
    pushLog({ type: "config_warning", warning: "termux_tts_missing" });
  }

  return { ok: true };
}

// -------------------- TikTok connection --------------------
let tiktokConn = null;
let tiktokStatus = {
  status: "idle",
  live: false,
  lastError: null,
  roomId: null
};

function getTikTokStatusSnapshot() {
  return {
    status: tiktokStatus.status,
    live: tiktokStatus.live,
    lastError: tiktokStatus.lastError,
    roomId: tiktokStatus.roomId
  };
}

function updateTikTokStatus(update) {
  tiktokStatus = { ...tiktokStatus, ...update };
  safeEmit("tiktokStatus", getTikTokStatusSnapshot());
}

function disconnectTikTok(reason) {
  if (tiktokConn) {
    try {
      tiktokConn.removeAllListeners?.();
      tiktokConn.disconnect?.();
    } catch {}
  }
  tiktokConn = null;
  updateTikTokStatus({ status: "idle", live: false, lastError: null, roomId: null });
  if (reason) pushLog({ type: "tiktok_disconnected", reason });
}

async function connectTikTok() {
  const username = String(settings.tiktokUsername || "").trim().replace(/^@/, "");
  if (!username || username === "TU_USUARIO_SIN_ARROBA") {
    const error = "missing_username";
    updateTikTokStatus({ status: "error", live: false, lastError: error, roomId: null });
    return { ok: false, error };
  }

  if (tiktokStatus.status === "connecting") return { ok: false, error: "already_connecting" };

  disconnectTikTok("reconnect");

  tiktokConn = new WebcastPushConnection(username);
  updateTikTokStatus({ status: "connecting", live: false, lastError: null, roomId: null });

  try {
    const state = await tiktokConn.connect();
    updateTikTokStatus({ status: "connected", live: true, roomId: state.roomId ?? null });
    pushLog({ type: "tiktok_connected", roomId: state.roomId });

    tiktokConn.on(WebcastEvent.CHAT, (data) => {
      const uniqueId = data.uniqueId || "unknown";
      const nickname = data.nickname || uniqueId;
      const comment = data.comment || "";

      const b = isBanned(uniqueId);
      if (b.banned) {
        pushLog({ type: "blocked_banned_user", uniqueId, nickname, comment, reason: b.entry?.reason });
        pushHistory({ uniqueId, nickname, comment, status: "blocked", reason: b.entry?.reason || "banned" });
        return;
      }

      const f = filterChatText(comment);
      if (!f.ok) {
        const strikeCount = addStrike(uniqueId);
        pushLog({ type: "blocked_filter", uniqueId, nickname, comment, reason: f.reason, strikes: strikeCount });
        pushHistory({ uniqueId, nickname, comment, status: "blocked", reason: f.reason });
        return;
      }

      if (!canSpeakNow(uniqueId)) {
        pushLog({ type: "blocked_cooldown", uniqueId, nickname, comment, reason: "cooldown" });
        pushHistory({ uniqueId, nickname, comment, status: "blocked", reason: "cooldown" });
        return;
      }

      const msg = {
        id: nextMsgId++,
        uniqueId,
        nickname,
        text: f.text,
        ts: nowMs(),
        source: "tiktok"
      };

      const ok = enqueueMessage(msg);
      if (ok) {
        markSpeak(uniqueId);
        pushHistory({ uniqueId, nickname, comment, status: "queued", reason: "" });
      } else {
        pushHistory({ uniqueId, nickname, comment, status: "dropped", reason: "queue_full" });
      }
    });

    tiktokConn.on("disconnected", () => {
      disconnectTikTok("tiktok_disconnected_event");
      pushLog({ type: "tiktok_disconnected" });
    });

    return { ok: true };
  } catch (err) {
    const error = String(err);
    updateTikTokStatus({ status: "error", live: false, lastError: error, roomId: null });
    pushLog({ type: "tiktok_connect_failed", error });
    disconnectTikTok("connect_failed");
    return { ok: false, error };
  }
}

function persistGlobalSettings() {
  settings.termux = normalizeTermuxConfig(settings.termux, DEFAULT_SETTINGS.termux);
  writeJsonAtomicSync(SETTINGS_PATH, settings);
}

function applyTermuxConfig(normalizedConfig, persistScope = "global") {
  const safeConfig = normalizeTermuxConfig(normalizedConfig, getPersistedTermuxConfig());

  if (persistScope === "session") {
    sessionTermuxOverrides = { ...safeConfig };
  } else {
    settings.termux = safeConfig;
    sessionTermuxOverrides = {};
    persistGlobalSettings();
  }

  safeEmit("settings", getSettingsSnapshot());
  return getTermuxConfigSnapshot();
}

function describeTermuxAudioBehavior(termuxConfig) {
  const cfg = normalizeTermuxConfig(termuxConfig, DEFAULT_SETTINGS.termux);
  const effectiveStream = resolveTermuxStream(cfg);
  const notes = [];

  if (cfg.outputMode === "media") {
    notes.push("Se prioriza stream MUSIC para salida multimedia (no depende del canal de notificaciones).");
  }

  if (cfg.coexistenceMode === "duck") {
    notes.push("Sin capa nativa Android en este repo: se hace best-effort con stream de audio, no control total de AudioFocus.");
  }

  if (cfg.coexistenceMode === "pause") {
    notes.push("Modo pause es declarativo en arquitectura Termux/Web; pausar otras apps requiere integracion nativa Android.");
  }

  if (!RUNTIME_CAPS.isTermux || !RUNTIME_CAPS.hasTermuxTts) {
    notes.push("Runtime actual sin termux-tts-speak; configuracion aplicable pero no ejecutable aqui.");
  }

  return {
    outputMode: cfg.outputMode,
    coexistenceMode: cfg.coexistenceMode,
    effectiveStream,
    notes
  };
}

// -------------------- API --------------------
app.get("/api/runtime", (_, res) => res.json(getRuntimeSnapshot()));

// bans
app.get("/api/bans", (_, res) => res.json(getBansSnapshot()));
app.post("/api/ban", (req, res) => {
  const { uniqueId, minutes, reason } = req.body ?? {};
  const uid = String(uniqueId || "").trim().replace(/^@/, "");
  if (!uid) return res.status(400).json({ error: "uniqueId requerido" });
  banUser(uid, String(reason ?? "manual"), Number(minutes ?? 30));
  res.json({ ok: true });
});

app.post("/api/unban", (req, res) => {
  const uid = String(req.body?.uniqueId || "").trim().replace(/^@/, "");
  if (!uid) return res.status(400).json({ error: "uniqueId requerido" });
  unbanUser(uid);
  res.json({ ok: true });
});

// tts control
app.get("/api/status", (_, res) => res.json(getStatusSnapshot()));
app.post("/api/tts", (req, res) => {
  const { enabled } = req.body ?? {};
  ttsEnabled = !!enabled;
  safeEmit("status", getStatusSnapshot());
  if (ttsEnabled) startQueueWorker();
  res.json({ ok: true, ttsEnabled });
});

app.get("/api/tts/voices", async (_, res) => {
  const result = await getInstalledVoices();
  res.json(result);
});

app.get("/api/tts/config", async (_, res) => {
  const snapshot = getTermuxConfigSnapshot();
  const validation = await validateTermuxConfig(snapshot.effective, { baseConfig: snapshot.persisted });

  res.json({
    ok: true,
    ...snapshot,
    validation,
    runtime: getRuntimeSnapshot(),
    audioBehavior: describeTermuxAudioBehavior(snapshot.effective)
  });
});

app.post("/api/tts/config/validate", async (req, res) => {
  const base = req.body?.baseConfig && typeof req.body.baseConfig === "object"
    ? req.body.baseConfig
    : getEffectiveTermuxConfig();

  const result = await validateTermuxConfig(req.body || {}, { baseConfig: base });
  res.json(result);
});

app.post("/api/tts/config", async (req, res) => {
  const persistScope = getPersistScope(req.body?.persistScope);
  const validation = await validateTermuxConfig(req.body || {}, { baseConfig: getEffectiveTermuxConfig() });

  if (!validation.ok) {
    return res.status(400).json({ ok: false, errors: validation.errors, warnings: validation.warnings });
  }

  const snapshot = applyTermuxConfig(validation.normalized, persistScope);

  res.json({
    ok: true,
    persistScope,
    ...snapshot,
    validation,
    audioBehavior: describeTermuxAudioBehavior(snapshot.effective)
  });
});

app.post("/api/tts/test", async (req, res) => {
  const text = validateTextForSpeech(req.body?.text, TTS_TEST_MAX_LEN);
  const enqueueIfBusy = !!req.body?.enqueueIfBusy;

  if (!text) {
    return res.status(400).json({ ok: false, error: "text_requerido" });
  }

  const validation = await validateTermuxConfig(req.body || {}, { baseConfig: getEffectiveTermuxConfig() });
  if (!validation.ok) {
    return res.status(400).json({ ok: false, errors: validation.errors, warnings: validation.warnings });
  }

  if (isTtsBusy()) {
    if (!enqueueIfBusy) {
      return res.status(409).json({ ok: false, error: "tts_busy", queueSize: queue.length });
    }

    const queued = enqueueMessage({
      id: nextMsgId++,
      uniqueId: "local",
      nickname: "tts-test",
      text,
      ts: nowMs(),
      source: "local-test",
      termuxOverrides: validation.normalized,
      ttsEngineOverride: "termux"
    });

    if (!queued) {
      return res.status(409).json({ ok: false, error: "queue_full" });
    }

    return res.json({ ok: true, queued: true, queueSize: queue.length });
  }

  directTtsInProgress = true;
  safeEmit("status", getStatusSnapshot());

  try {
    await enqueueSpeechTask(() => speakMessage(text, {
      preferredEngine: "termux",
      strictEngine: true,
      termuxOverrides: validation.normalized
    }));

    return res.json({
      ok: true,
      played: true,
      effective: getResolvedTermuxSpeakConfig(validation.normalized),
      warnings: validation.warnings,
      audioBehavior: describeTermuxAudioBehavior(validation.normalized)
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: getSafeError(err), warnings: validation.warnings });
  } finally {
    directTtsInProgress = false;
    safeEmit("status", getStatusSnapshot());
  }
});

app.post("/api/queue/clear", (_, res) => {
  queue.length = 0;
  safeEmit("queue", getQueueSnapshot());
  res.json({ ok: true });
});

app.post("/api/queue/skip", (req, res) => {
  const id = Number(req.body?.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "id requerido" });
  const ok = skipQueueMessage(id);
  if (!ok) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

app.post("/api/queue/test", (req, res) => {
  const { uniqueId, nickname, text, count } = req.body ?? {};
  const rawText = typeof text === "string" ? text : "";
  const uid = typeof uniqueId === "string" && uniqueId.trim() ? uniqueId.trim().replace(/^@/, "") : "local";
  const name = typeof nickname === "string" && nickname.trim() ? nickname.trim() : uid;
  const repeat = Number.isFinite(Number(count)) ? Math.max(1, Math.min(50, Math.trunc(Number(count)))) : 1;

  const requestedEngine = String(req.body?.ttsEngine || req.body?.ttsEngineOverride || "").trim();
  const ttsEngineOverride = SUPPORTED_TTS_ENGINES.has(requestedEngine) ? requestedEngine : null;
  const termuxInput = extractTermuxConfigInput(req.body || {});
  const termuxOverrides = Object.keys(termuxInput).length > 0
    ? normalizeTermuxConfig(termuxInput, getEffectiveTermuxConfig())
    : null;

  const b = isBanned(uid);
  if (b.banned) {
    pushLog({ type: "blocked_banned_user", source: "local", uniqueId: uid, nickname: name, comment: rawText, reason: b.entry?.reason });
    pushHistory({ uniqueId: uid, nickname: name, comment: rawText, source: "local", status: "blocked", reason: b.entry?.reason || "banned" });
    return res.json({ ok: false, reason: "banned" });
  }

  const f = filterChatText(rawText);
  if (!f.ok) {
    pushLog({ type: "blocked_filter", source: "local", uniqueId: uid, nickname: name, comment: rawText, reason: f.reason, strikes: 0 });
    pushHistory({ uniqueId: uid, nickname: name, comment: rawText, source: "local", status: "blocked", reason: f.reason });
    return res.json({ ok: false, reason: f.reason });
  }

  let added = 0;
  let dropped = 0;
  for (let i = 0; i < repeat; i++) {
    const msg = {
      id: nextMsgId++,
      uniqueId: uid,
      nickname: name,
      text: f.text,
      ts: nowMs(),
      source: "local",
      termuxOverrides,
      ttsEngineOverride
    };

    const ok = enqueueMessage(msg);
    if (ok) {
      added++;
      pushHistory({ uniqueId: uid, nickname: name, comment: rawText, source: "local", status: "queued", reason: "" });
    } else {
      dropped++;
      pushHistory({ uniqueId: uid, nickname: name, comment: rawText, source: "local", status: "dropped", reason: "queue_full" });
      break;
    }
  }

  if (added === 0) return res.json({ ok: false, reason: "queue_full" });
  res.json({ ok: true, added, dropped });
});
// settings
app.get("/api/settings", (_, res) => res.json(getSettingsSnapshot()));
app.post("/api/settings", (req, res) => {
  const result = applySettingsUpdate(req.body);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true, settings: getSettingsSnapshot() });
});

// TikTok
app.get("/api/tiktok/status", (_, res) => res.json(getTikTokStatusSnapshot()));
app.post("/api/tiktok/connect", async (_, res) => {
  const result = await connectTikTok();
  res.json({ ...result, status: getTikTokStatusSnapshot() });
});

app.post("/api/tiktok/disconnect", (_, res) => {
  disconnectTikTok("manual");
  res.json({ ok: true, status: getTikTokStatusSnapshot() });
});

// lists
app.get("/api/lists", (_, res) => {
  res.json({ exact: readLines(BAD_EXACT_PATH), sub: readLines(BAD_SUB_PATH) });
});

app.post("/api/lists", (req, res) => {
  const { exact, sub } = req.body ?? {};
  if (typeof exact === "string") fs.writeFileSync(BAD_EXACT_PATH, exact.replace(/\r/g, ""), "utf8");
  if (typeof sub === "string") fs.writeFileSync(BAD_SUB_PATH, sub.replace(/\r/g, ""), "utf8");
  reloadExact();
  reloadSub();
  res.json({ ok: true });
});

function sanitizeBadword(word) {
  if (!word) return "";
  const ascii = stripDiacritics(String(word).toLowerCase());
  return ascii.replace(/[^a-z0-9]+/g, "").trim();
}

app.post("/api/badwords/add", (req, res) => {
  const { word, mode } = req.body ?? {};
  const cleaned = sanitizeBadword(word);
  if (!cleaned || cleaned.length < 3) return res.status(400).json({ error: "word_invalida" });

  const target = mode === "sub" ? "sub" : "exact";
  const filePath = target === "sub" ? BAD_SUB_PATH : BAD_EXACT_PATH;

  const lines = readLines(filePath);
  if (!lines.includes(cleaned)) {
    lines.push(cleaned);
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  }

  if (target === "sub") reloadSub();
  else reloadExact();

  res.json({ ok: true, word: cleaned, mode: target });
});

// -------------------- Sockets --------------------
io.on("connection", (socket) => {
  socket.emit("status", getStatusSnapshot());
  socket.emit("queue", getQueueSnapshot());
  socket.emit("historyBulk", getHistorySnapshot());
  socket.emit("bansUpdated", getBansSnapshot());
  socket.emit("listsUpdated", getListsSnapshot());
  socket.emit("settings", getSettingsSnapshot());
  socket.emit("tiktokStatus", getTikTokStatusSnapshot());
  socket.emit("runtime", getRuntimeSnapshot());
  socket.emit("logBulk", recentLog);
});

// -------------------- Start --------------------
httpServer.listen(settings.port, settings.bindHost, () => {
  const runtime = getRuntimeSnapshot();
  console.log(`Dashboard: http://${settings.bindHost}:${settings.port}`);
  console.log(`Runtime: platform=${runtime.platform} termux=${runtime.isTermux} engines=${runtime.availableTtsEngines.join(",")} recommended=${runtime.recommendedTtsEngine}`);
});

// Cierre limpio
process.on("SIGINT", () => {
  try { disconnectTikTok("SIGINT"); } catch {}
  process.exit(0);
});

process.on("SIGTERM", () => {
  try { disconnectTikTok("SIGTERM"); } catch {}
  process.exit(0);
});
