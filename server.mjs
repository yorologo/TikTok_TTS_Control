import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import { execFile, spawn } from "child_process";
import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import say from "say";
import TikTokLive from "tiktok-live-connector";

const { WebcastPushConnection } = TikTokLive;

const WebcastEvent = {
  CHAT: "chat"
};

// -------------------- Paths & Defaults --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const BANNED_PATH = path.join(DATA_DIR, "banned_users.json");
const BAD_EXACT_PATH = path.join(DATA_DIR, "badwords_exact_es.txt");
const BAD_SUB_PATH = path.join(DATA_DIR, "badwords_substring_es.txt");

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

  ttsEngine: "say", // "say" | "piper"
  ttsVoice: "",
  ttsRate: 1.0,

  piper: {
    modelPath: "",
    lengthScale: 1.0,
    volume: 1.0,
    pythonCmd: "py" // o "python"
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
ensureFileIfMissing(BAD_EXACT_PATH, ""); // lista vacía
ensureFileIfMissing(BAD_SUB_PATH, "");   // lista vacía

let settings = readJson(SETTINGS_PATH, null) ?? { ...DEFAULT_SETTINGS };
settings = {
  ...DEFAULT_SETTINGS,
  ...settings,
  autoBan: {
    ...DEFAULT_SETTINGS.autoBan,
    ...(settings.autoBan || {})
  },
  piper: {
    ...DEFAULT_SETTINGS.piper,
    ...(settings.piper || {})
  }
};
writeJsonAtomicSync(SETTINGS_PATH, settings);

// -------------------- Server + Socket.IO (init early for safe emit) --------------------
const app = express();
app.use(express.json({ limit: "128kb" }));
app.use(express.static(path.join(__dirname, "public")));

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  // Puedes ajustar CORS si lo necesitas:
  // cors: { origin: "http://localhost:8787" }
});

function safeEmit(evt, payload) {
  try {
    io.emit(evt, payload);
  } catch {
    // no-op
  }
}

// -------------------- State --------------------
let bannedDb = readJson(BANNED_PATH, { users: {} });

let bannedExact = new Set(readLines(BAD_EXACT_PATH).map((s) => s.toLowerCase()));
// Nota: substring muy corto genera falsos positivos; 4+ suele ser un buen mínimo
let bannedSub = readLines(BAD_SUB_PATH).map((s) => s.toLowerCase()).filter((s) => s.length >= 4);

const strikes = new Map(); // uniqueId -> count

let ttsEnabled = !!settings.ttsEnabled;
let speaking = false;
let lastGlobalSpeak = 0;
const lastUserSpeak = new Map(); // uniqueId -> ts
const queue = []; // {id, uniqueId, nickname, text, ts, source}
const recentLog = []; // últimos 200 eventos para UI
const recentHistory = []; // últimos N mensajes para UI
let nextHistoryId = 1;
let nextMsgId = 1;

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
  return { ttsEnabled, speaking, queueSize: queue.length };
}
function getSettingsSnapshot() {
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
    piperPythonCmd: settings.piper?.pythonCmd ?? "py",
    autoBanEnabled: settings.autoBan?.enabled ?? true,
    autoBanStrikeThreshold: settings.autoBan?.strikeThreshold ?? 2,
    autoBanBanMinutes: settings.autoBan?.banMinutes ?? 30
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

  // leetspeak básico
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
  t = t.replace(/([a-z])\1{2,}/g, "$1$1"); // reduce spam de letras
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

// watchFile es polling (estable en Windows). Si quieres fs.watch, se puede cambiar.
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

// Devuelve {ok:true,text} si pasa
function filterChatText(raw) {
  if (!raw) return { ok: false, reason: "empty" };

  const trimmed = String(raw).trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  const clipped = trimmed.slice(0, settings.maxChars);

  // bloqueos rápidos
  if (RE_URL.test(clipped)) return { ok: false, reason: "url" };
  if (RE_EMAIL.test(clipped)) return { ok: false, reason: "email" };
  if (RE_PHONE.test(clipped)) return { ok: false, reason: "phone" };
  if (RE_MENTION.test(clipped)) return { ok: false, reason: "mention" };
  if (RE_SPAM_REPEAT.test(clipped)) return { ok: false, reason: "repeat_spam" };
  if (RE_PUNCT_SPAM.test(clipped)) return { ok: false, reason: "punct_spam" };

  // quitar chars no soportados (emoji etc) pero conservar texto
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
function canSpeak(uniqueId) {
  const now = nowMs();

  if (now - lastGlobalSpeak < settings.globalCooldownMs) return false;

  const last = lastUserSpeak.get(uniqueId) ?? 0;
  if (now - last < settings.perUserCooldownMs) return false;

  lastGlobalSpeak = now;
  lastUserSpeak.set(uniqueId, now);
  return true;
}

function enqueueMessage(msg) {
  if (queue.length >= settings.maxQueue) {
    pushLog({ type: "queue_drop", reason: "queue_full", msg });
    return false;
  }
  queue.push(msg);
  safeEmit("queue", getQueueSnapshot());
  startQueueWorker(); // asegura worker corriendo
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
function getInstalledVoicesWin() {
  return new Promise((resolve) => {
    const command =
      "Add-Type -AssemblyName System.Speech; " +
      "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
      "$synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }";
    execFile("powershell", ["-NoProfile", "-Command", command], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ voices: [], error: String(err) });
      const voices = String(stdout || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      resolve({ voices });
    });
  });
}

async function getInstalledVoices() {
  const sayResult = await new Promise((resolve) => {
    say.getInstalledVoices((err, voices) => {
      if (err) return resolve({ voices: [], error: String(err) });
      resolve({ voices: Array.isArray(voices) ? voices : [] });
    });
  });

  if (sayResult.voices.length > 0) return sayResult;

  if (process.platform === "win32") {
    const winResult = await getInstalledVoicesWin();
    if (winResult.voices.length > 0) return winResult;
    return { voices: [], error: sayResult.error || winResult.error || "no_voices" };
  }

  return sayResult;
}

function runProcess(cmd, args, inputText) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let stderr = "";

    if (inputText !== null && inputText !== undefined) {
      proc.stdin.write(inputText);
      proc.stdin.end();
    }

    proc.stderr.on("data", (data) => (stderr += data.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} exited ${code}: ${stderr}`));
    });
  });
}

async function speakWithPiper(text, options) {
  const modelPath = options?.modelPath || "";
  if (!modelPath) throw new Error("piper_model_missing");

  const lengthScale = clampNumber(options?.lengthScale, 0.5, 2.5, 1.0);
  const volume = clampNumber(options?.volume, 0.0, 2.0, 1.0);
  const pythonCmd = String(options?.pythonCmd || "py").trim() || "py";

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
    `${text}\n`
  );

  try {
    if (process.platform === "win32") {
      const safePath = wavPath.replace(/'/g, "''");
      const psCmd = `(New-Object System.Media.SoundPlayer '${safePath}').PlaySync()`;
      await runProcess("powershell", ["-NoProfile", "-Command", psCmd]);
    } else if (process.platform === "darwin") {
      await runProcess("afplay", [wavPath]);
    } else {
      // linux: intenta aplay; si no existe, caerá al catch de speakMessage
      await runProcess("aplay", ["-q", wavPath]);
    }
  } finally {
    await fs.promises.unlink(wavPath).catch(() => {});
  }
}

function speakWithSay(text) {
  return new Promise((resolve, reject) => {
    const voice = settings.ttsVoice || null;
    const rate = clampNumber(settings.ttsRate, 0.5, 2.0, 1.0);
    try {
      // say.speak(text, voice?, speed?, cb?)
      say.speak(text, voice, rate, (err) => {
        if (err) return reject(err);
        resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function speakMessage(text) {
  const ttsText = normalizeForTts(text);
  if (!ttsText) return;

  if (settings.ttsEngine === "piper") {
    try {
      await speakWithPiper(ttsText, settings.piper);
      return;
    } catch (err) {
      pushLog({ type: "tts_error", error: String(err), engine: "piper" });
      // fallback a say
    }
  }

  await speakWithSay(ttsText);
}

// Worker único (evita recursión y estados raros)
let queueWorkerRunning = false;

async function queueWorkerLoop() {
  queueWorkerRunning = true;
  speaking = true;
  safeEmit("status", getStatusSnapshot());

  try {
    while (ttsEnabled) {
      const m = queue.shift();
      safeEmit("queue", getQueueSnapshot());

      if (!m) break;

      pushLog({ type: "tts_speak", msg: m });

      try {
        await speakMessage(m.text);
      } catch (err) {
        pushLog({ type: "tts_error", error: String(err), msg: m });
      }

      // pequeña pausa para que no “trabe” UI/CPU
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
    pushLog({ type: "worker_error", error: String(err) });
  });
}

// -------------------- Settings update --------------------
function applySettingsUpdate(update) {
  if (!update || typeof update !== "object") return { ok: false, error: "invalid" };

  const next = {
    ...settings,
    autoBan: { ...settings.autoBan },
    piper: { ...settings.piper }
  };

  if ("globalCooldownMs" in update) next.globalCooldownMs = Math.max(0, toInt(update.globalCooldownMs, settings.globalCooldownMs));
  if ("perUserCooldownMs" in update) next.perUserCooldownMs = Math.max(0, toInt(update.perUserCooldownMs, settings.perUserCooldownMs));

  if ("maxQueue" in update) next.maxQueue = Math.max(1, toInt(update.maxQueue, settings.maxQueue));
  if ("maxChars" in update) next.maxChars = Math.max(1, toInt(update.maxChars, settings.maxChars));
  if ("maxWords" in update) next.maxWords = Math.max(1, toInt(update.maxWords, settings.maxWords));
  if ("historySize" in update) next.historySize = Math.max(5, toInt(update.historySize, settings.historySize ?? 25));

  if ("ttsEngine" in update) {
    const v = String(update.ttsEngine ?? "").trim();
    if (v === "say" || v === "piper") next.ttsEngine = v;
  }

  if ("ttsRate" in update) next.ttsRate = clampNumber(update.ttsRate, 0.5, 2.0, settings.ttsRate);
  if ("ttsVoice" in update) next.ttsVoice = String(update.ttsVoice ?? "").trim();

  if ("piperModelPath" in update) next.piper.modelPath = String(update.piperModelPath ?? "").trim();
  if ("piperLengthScale" in update) next.piper.lengthScale = clampNumber(update.piperLengthScale, 0.5, 2.5, next.piper.lengthScale);
  if ("piperVolume" in update) next.piper.volume = clampNumber(update.piperVolume, 0.0, 2.0, next.piper.volume);
  if ("piperPythonCmd" in update) next.piper.pythonCmd = String(update.piperPythonCmd ?? "").trim() || "py";

  if ("autoBanEnabled" in update) next.autoBan.enabled = !!update.autoBanEnabled;
  if ("autoBanStrikeThreshold" in update) next.autoBan.strikeThreshold = Math.max(1, toInt(update.autoBanStrikeThreshold, next.autoBan.strikeThreshold ?? 2));
  if ("autoBanBanMinutes" in update) next.autoBan.banMinutes = Math.max(1, toInt(update.autoBanBanMinutes, next.autoBan.banMinutes ?? 30));

  settings = next;
  writeJsonAtomicSync(SETTINGS_PATH, settings);

  // Ajustes post-update
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

  // limpia conexión anterior si existía
  disconnectTikTok("reconnect");

  tiktokConn = new WebcastPushConnection(username);
  updateTikTokStatus({ status: "connecting", live: false, lastError: null, roomId: null });

  try {
    const state = await tiktokConn.connect();
    updateTikTokStatus({ status: "connected", live: true, roomId: state.roomId ?? null });
    pushLog({ type: "tiktok_connected", roomId: state.roomId });

    // listeners
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

      if (!canSpeak(uniqueId)) {
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
      if (ok) pushHistory({ uniqueId, nickname, comment, status: "queued", reason: "" });
      else pushHistory({ uniqueId, nickname, comment, status: "dropped", reason: "queue_full" });
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

// -------------------- API --------------------
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
    const msg = { id: nextMsgId++, uniqueId: uid, nickname: name, text: f.text, ts: nowMs(), source: "local" };
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

// lists (texto completo)
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
  socket.emit("logBulk", recentLog);
});

// -------------------- Start --------------------
httpServer.listen(settings.port, settings.bindHost, () => {
  console.log(`Dashboard: http://${settings.bindHost}:${settings.port}`);
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
