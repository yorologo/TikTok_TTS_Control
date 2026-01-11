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

const { TikTokLiveConnection, WebcastEvent } = TikTokLive;

// ---------- Helpers ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}
function readJson(filePath, fallback) {
  try { return JSON.parse(readText(filePath)); }
  catch { return fallback; }
}
function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
}
function readLines(filePath) {
  try {
    return readText(filePath)
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);
  } catch { return []; }
}

function getInstalledVoicesWin() {
  return new Promise((resolve) => {
    const command = "Add-Type -AssemblyName System.Speech; $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }";
    execFile("powershell", ["-NoProfile", "-Command", command], { windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ voices: [], error: String(err) });
        return;
      }
      const voices = String(stdout || "")
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
      resolve({ voices });
    });
  });
}

async function getInstalledVoices() {
  const sayResult = await new Promise((resolve) => {
    say.getInstalledVoices((err, voices) => {
      if (err) {
        resolve({ voices: [], error: String(err) });
        return;
      }
      resolve({ voices: Array.isArray(voices) ? voices : [] });
    });
  });

  if (sayResult.voices.length > 0) {
    return sayResult;
  }

  if (process.platform === "win32") {
    const winResult = await getInstalledVoicesWin();
    if (winResult.voices.length > 0) {
      return winResult;
    }
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

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${cmd} exited ${code}: ${stderr}`));
    });
  });
}

async function speakWithPiper(text, options) {
  const modelPath = options?.modelPath || "";
  if (!modelPath) {
    throw new Error("piper_model_missing");
  }

  const lengthScaleRaw = Number(options?.lengthScale ?? 1.0);
  const lengthScale = Number.isFinite(lengthScaleRaw) ? lengthScaleRaw : 1.0;
  const volumeRaw = Number(options?.volume ?? 1.0);
  const volume = Number.isFinite(volumeRaw) ? volumeRaw : 1.0;
  const pythonCmd = options?.pythonCmd || "py";

  const wavPath = path.join(os.tmpdir(), `piper-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);

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
    const safePath = wavPath.replace(/'/g, "''");
    const psCmd = `(New-Object System.Media.SoundPlayer '${safePath}').PlaySync()`;
    await runProcess("powershell", ["-NoProfile", "-Command", psCmd]);
  } finally {
    await fs.promises.unlink(wavPath).catch(() => {});
  }
}

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
  ttsEngine: "say",
  ttsVoice: "",
  ttsRate: 1.0,
  piper: {
    modelPath: "",
    lengthScale: 1.0,
    volume: 1.0,
    pythonCmd: "py"
  },
  autoBan: {
    enabled: true,
    strikeThreshold: 2,
    banMinutes: 30
  }
};

let settings = readJson(SETTINGS_PATH, null);
if (!settings) {
  settings = { ...DEFAULT_SETTINGS };
  writeJson(SETTINGS_PATH, settings);
}
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

let bannedDb = readJson(BANNED_PATH, { users: {} });
let bannedExact = new Set(readLines(BAD_EXACT_PATH).map(s => s.toLowerCase()));
let bannedSub = readLines(BAD_SUB_PATH).map(s => s.toLowerCase()).filter(s => s.length >= 5);

// Hot reload de listas
fs.watchFile(BAD_EXACT_PATH, { interval: 1500 }, () => {
  bannedExact = new Set(readLines(BAD_EXACT_PATH).map(s => s.toLowerCase()));
  io.emit("listsUpdated", getListsSnapshot());
});
fs.watchFile(BAD_SUB_PATH, { interval: 1500 }, () => {
  bannedSub = readLines(BAD_SUB_PATH).map(s => s.toLowerCase()).filter(s => s.length >= 5);
  io.emit("listsUpdated", getListsSnapshot());
});
fs.watchFile(BANNED_PATH, { interval: 1500 }, () => {
  bannedDb = readJson(BANNED_PATH, { users: {} });
  io.emit("bansUpdated", getBansSnapshot());
});

// ---------- Normalización ----------
function stripDiacritics(s) {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}
function normalizeForModeration(s) {
  let t = s.toLowerCase();
  t = stripDiacritics(t);

  // leetspeak básico
  t = t
    .replace(/0/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/\$/g, "s")
    .replace(/@/g, "a");

  t = t.replace(/[^\p{L}\p{N}\s]+/gu, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}
function tokenize(norm) {
  return norm.split(" ").filter(Boolean);
}

// ---------- Filtros rápidos ----------
const RE_URL = /(https?:\/\/|www\.|\.com|\.net|\.gg|\.ru|\.mx|\.xyz)/i;
const RE_MENTION = /@\w+/u;
const RE_SPAM_REPEAT = /(.)\1{4,}/u;
const RE_PUNCT_SPAM = /[!?¿¡]{4,}/u;
const RE_ALLOWED = /^[\p{Script=Latin}\p{N}\s.,!?¿¡'":;()\-\+]{1,200}$/u;

// ---------- Ban logic ----------
function nowMs() { return Date.now(); }

function isBanned(uniqueId) {
  const entry = bannedDb.users[uniqueId];
  if (!entry) return { banned: false };

  if (entry.untilMs && entry.untilMs > 0 && nowMs() > entry.untilMs) {
    // expiró
    delete bannedDb.users[uniqueId];
    writeJson(BANNED_PATH, bannedDb);
    return { banned: false };
  }
  return { banned: true, entry };
}

function banUser(uniqueId, reason, minutes = 30) {
  const untilMs = minutes > 0 ? nowMs() + minutes * 60 * 1000 : 0;
  bannedDb.users[uniqueId] = {
    reason,
    addedAtMs: nowMs(),
    untilMs
  };
  writeJson(BANNED_PATH, bannedDb);
  io.emit("bansUpdated", getBansSnapshot());
}

function unbanUser(uniqueId) {
  delete bannedDb.users[uniqueId];
  writeJson(BANNED_PATH, bannedDb);
  io.emit("bansUpdated", getBansSnapshot());
}

// strikes en memoria (persistencia no obligatoria)
const strikes = new Map(); // uniqueId -> count

function addStrike(uniqueId) {
  const c = (strikes.get(uniqueId) ?? 0) + 1;
  strikes.set(uniqueId, c);

  if (settings.autoBan?.enabled && c >= settings.autoBan.strikeThreshold) {
    banUser(uniqueId, `Auto-ban: ${c} infracciones`, settings.autoBan.banMinutes);
    strikes.set(uniqueId, 0);
  }
  return c;
}

// ---------- Cola TTS ----------
let ttsEnabled = !!settings.ttsEnabled;
let speaking = false;
let lastGlobalSpeak = 0;
const lastUserSpeak = new Map(); // uniqueId -> ts
const queue = []; // {id, uniqueId, nickname, text, ts}
const recentLog = []; // últimos 200 eventos para UI

function pushLog(evt) {
  recentLog.push({ ...evt, ts: nowMs() });
  while (recentLog.length > 200) recentLog.shift();
  io.emit("log", evt);
}

let nextMsgId = 1;

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
  io.emit("queue", getQueueSnapshot());
  if (!speaking) speakNext();
  return true;
}

function skipQueueMessage(id) {
  const idx = queue.findIndex(m => m.id === id);
  if (idx === -1) return false;
  const [removed] = queue.splice(idx, 1);
  io.emit("queue", getQueueSnapshot());
  pushLog({ type: "queue_skip", msg: removed });
  return true;
}

function speakWithSay(text) {
  return new Promise((resolve, reject) => {
    const voice = settings.ttsVoice || null;
    const rate = Number.isFinite(Number(settings.ttsRate)) ? Number(settings.ttsRate) : 1.0;
    try {
      say.speak(text, voice, rate, () => resolve());
    } catch (err) {
      reject(err);
    }
  });
}

async function speakMessage(text) {
  if (settings.ttsEngine === "piper") {
    try {
      await speakWithPiper(text, settings.piper);
      return;
    } catch (err) {
      pushLog({ type: "tts_error", error: String(err), engine: "piper" });
    }
  }

  await speakWithSay(text);
}

async function speakNext() {
  if (!ttsEnabled) { speaking = false; return; }
  if (queue.length === 0) { speaking = false; return; }

  speaking = true;
  const m = queue.shift();
  io.emit("queue", getQueueSnapshot());

  pushLog({ type: "tts_speak", msg: m });

  try {
    await speakMessage(m.text);
  } catch (err) {
    pushLog({ type: "tts_error", error: String(err), msg: m });
  } finally {
    setTimeout(() => speakNext(), 120);
  }
}

// ---------- Moderación por palabras ----------
function hasBannedExact(tokens) {
  for (const w of tokens) {
    if (bannedExact.has(w)) return true;
  }
  return false;
}
function hasBannedJoined(norm) {
  const joined = norm.replace(/\s+/g, "");
  for (const bad of bannedSub) {
    if (joined.includes(bad)) return true;
  }
  return false;
}

// Devuelve null si se bloquea, o texto final si pasa
function filterChatText(raw) {
  if (!raw) return { ok: false, reason: "empty" };

  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  // recorte duro
  const clipped = trimmed.slice(0, settings.maxChars);

  // bloqueos rápidos
  if (RE_URL.test(clipped)) return { ok: false, reason: "url" };
  if (RE_MENTION.test(clipped)) return { ok: false, reason: "mention" };
  if (RE_SPAM_REPEAT.test(clipped)) return { ok: false, reason: "repeat_spam" };
  if (RE_PUNCT_SPAM.test(clipped)) return { ok: false, reason: "punct_spam" };

  // allowlist (si quieres permitir emojis, habría que ajustarla)
  if (!RE_ALLOWED.test(clipped)) return { ok: false, reason: "chars" };

  const norm = normalizeForModeration(clipped);
  const tokens = tokenize(norm);

  if (tokens.length === 0) return { ok: false, reason: "empty_norm" };
  if (tokens.length > settings.maxWords) return { ok: false, reason: "too_many_words" };

  if (hasBannedExact(tokens)) return { ok: false, reason: "badword_exact" };
  if (hasBannedJoined(norm)) return { ok: false, reason: "badword_joined" };

  return { ok: true, text: clipped };
}

// ---------- Web server + sockets ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer);

// Snapshots para UI
function getQueueSnapshot() {
  return { ttsEnabled, speaking, size: queue.length, items: queue.slice(0, 20) };
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
function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
function applySettingsUpdate(update) {
  if (!update || typeof update !== "object") return { ok: false, error: "invalid" };

  const next = {
    ...settings,
    autoBan: {
      ...settings.autoBan
    },
    piper: {
      ...settings.piper
    }
  };
  if ("globalCooldownMs" in update) {
    const n = toInt(update.globalCooldownMs, settings.globalCooldownMs);
    next.globalCooldownMs = Math.max(0, n);
  }
  if ("perUserCooldownMs" in update) {
    const n = toInt(update.perUserCooldownMs, settings.perUserCooldownMs);
    next.perUserCooldownMs = Math.max(0, n);
  }
  if ("maxQueue" in update) {
    const n = toInt(update.maxQueue, settings.maxQueue);
    next.maxQueue = Math.max(1, n);
  }
  if ("maxChars" in update) {
    const n = toInt(update.maxChars, settings.maxChars);
    next.maxChars = Math.max(1, n);
  }
  if ("maxWords" in update) {
    const n = toInt(update.maxWords, settings.maxWords);
    next.maxWords = Math.max(1, n);
  }
  if ("ttsEngine" in update) {
    const v = String(update.ttsEngine ?? "").trim();
    if (v === "say" || v === "piper") {
      next.ttsEngine = v;
    }
  }
  if ("piperModelPath" in update) {
    const v = String(update.piperModelPath ?? "").trim();
    next.piper.modelPath = v;
  }
  if ("piperLengthScale" in update) {
    const n = Number(update.piperLengthScale);
    if (Number.isFinite(n)) {
      next.piper.lengthScale = Math.min(2, Math.max(0.5, n));
    }
  }
  if ("piperVolume" in update) {
    const n = Number(update.piperVolume);
    if (Number.isFinite(n)) {
      next.piper.volume = Math.min(2, Math.max(0, n));
    }
  }
  if ("piperPythonCmd" in update) {
    const v = String(update.piperPythonCmd ?? "").trim();
    next.piper.pythonCmd = v || "py";
  }
  if ("ttsRate" in update) {
    const n = Number(update.ttsRate);
    if (Number.isFinite(n)) {
      next.ttsRate = Math.min(2, Math.max(0.5, n));
    }
  }
  if ("ttsVoice" in update) {
    const v = String(update.ttsVoice ?? "").trim();
    next.ttsVoice = v;
  }
  if ("autoBanEnabled" in update) {
    next.autoBan.enabled = !!update.autoBanEnabled;
  }
  if ("autoBanStrikeThreshold" in update) {
    const n = toInt(update.autoBanStrikeThreshold, settings.autoBan?.strikeThreshold ?? 2);
    next.autoBan.strikeThreshold = Math.max(1, n);
  }
  if ("autoBanBanMinutes" in update) {
    const n = toInt(update.autoBanBanMinutes, settings.autoBan?.banMinutes ?? 30);
    next.autoBan.banMinutes = Math.max(1, n);
  }

  settings = next;
  writeJson(SETTINGS_PATH, settings);

  while (queue.length > settings.maxQueue) {
    const removed = queue.pop();
    pushLog({ type: "queue_drop", reason: "queue_resize", msg: removed });
  }

  io.emit("settings", getSettingsSnapshot());
  io.emit("queue", getQueueSnapshot());
  io.emit("status", getStatusSnapshot());
  return { ok: true };
}
function getTikTokStatusSnapshot() {
  return {
    status: tiktokStatus.status,
    live: tiktokStatus.live,
    lastError: tiktokStatus.lastError,
    roomId: tiktokStatus.roomId
  };
}

// API: bans
app.get("/api/bans", (_, res) => res.json(getBansSnapshot()));
app.post("/api/ban", (req, res) => {
  const { uniqueId, minutes, reason } = req.body ?? {};
  if (!uniqueId) return res.status(400).json({ error: "uniqueId requerido" });
  banUser(uniqueId, reason ?? "manual", Number(minutes ?? 30));
  res.json({ ok: true });
});
app.post("/api/unban", (req, res) => {
  const { uniqueId } = req.body ?? {};
  if (!uniqueId) return res.status(400).json({ error: "uniqueId requerido" });
  unbanUser(uniqueId);
  res.json({ ok: true });
});

// API: tts control
app.get("/api/status", (_, res) => res.json(getStatusSnapshot()));
app.post("/api/tts", (req, res) => {
  const { enabled } = req.body ?? {};
  ttsEnabled = !!enabled;
  io.emit("status", getStatusSnapshot());
  if (ttsEnabled && !speaking) speakNext();
  res.json({ ok: true, ttsEnabled });
});
app.get("/api/tts/voices", async (_, res) => {
  const result = await getInstalledVoices();
  res.json(result);
});
app.post("/api/queue/clear", (_, res) => {
  queue.length = 0;
  io.emit("queue", getQueueSnapshot());
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
  const uid = typeof uniqueId === "string" && uniqueId.trim()
    ? uniqueId.trim().replace(/^@/, "")
    : "local";
  const name = typeof nickname === "string" && nickname.trim()
    ? nickname.trim()
    : uid;
  const repeat = Number.isFinite(Number(count))
    ? Math.max(1, Math.min(50, Math.trunc(Number(count))))
    : 1;

  const b = isBanned(uid);
  if (b.banned) {
    pushLog({ type: "blocked_banned_user", source: "local", uniqueId: uid, nickname: name, comment: rawText, reason: b.entry?.reason });
    return res.json({ ok: false, reason: "banned" });
  }

  const f = filterChatText(rawText);
  if (!f.ok) {
    pushLog({ type: "blocked_filter", source: "local", uniqueId: uid, nickname: name, comment: rawText, reason: f.reason, strikes: 0 });
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
      source: "local"
    };
    const ok = enqueueMessage(msg);
    if (ok) {
      added += 1;
    } else {
      dropped += 1;
      break;
    }
  }

  if (added === 0) {
    return res.json({ ok: false, reason: "queue_full" });
  }
  res.json({ ok: true, added, dropped });
});

// API: settings
app.get("/api/settings", (_, res) => res.json(getSettingsSnapshot()));
app.post("/api/settings", (req, res) => {
  const result = applySettingsUpdate(req.body);
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true, settings: getSettingsSnapshot() });
});

// API: TikTok connection
app.get("/api/tiktok/status", (_, res) => res.json(getTikTokStatusSnapshot()));
app.post("/api/tiktok/connect", async (_, res) => {
  const result = await connectTikTok();
  res.json({ ...result, status: getTikTokStatusSnapshot() });
});
app.post("/api/tiktok/disconnect", (_, res) => {
  disconnectTikTok("manual");
  res.json({ ok: true, status: getTikTokStatusSnapshot() });
});

// API: edit lists (texto completo)
app.get("/api/lists", (_, res) => {
  res.json({
    exact: readLines(BAD_EXACT_PATH),
    sub: readLines(BAD_SUB_PATH)
  });
});
app.post("/api/lists", (req, res) => {
  const { exact, sub } = req.body ?? {};
  if (typeof exact === "string") fs.writeFileSync(BAD_EXACT_PATH, exact.replace(/\r/g, ""), "utf8");
  if (typeof sub === "string") fs.writeFileSync(BAD_SUB_PATH, sub.replace(/\r/g, ""), "utf8");
  res.json({ ok: true });
});

// Sockets
io.on("connection", (socket) => {
  socket.emit("status", getStatusSnapshot());
  socket.emit("queue", getQueueSnapshot());
  socket.emit("bansUpdated", getBansSnapshot());
  socket.emit("listsUpdated", getListsSnapshot());
  socket.emit("settings", getSettingsSnapshot());
  socket.emit("tiktokStatus", getTikTokStatusSnapshot());
  socket.emit("logBulk", recentLog);
});

// ---------- TikTok Connection ----------
let tiktokConn = null;
let tiktokStatus = {
  status: "idle",
  live: false,
  lastError: null,
  roomId: null
};

function updateTikTokStatus(update) {
  tiktokStatus = { ...tiktokStatus, ...update };
  io.emit("tiktokStatus", getTikTokStatusSnapshot());
}

async function connectTikTok() {
  if (!settings.tiktokUsername || settings.tiktokUsername === "TU_USUARIO_SIN_ARROBA") {
    const error = "missing_username";
    updateTikTokStatus({ status: "error", live: false, lastError: error, roomId: null });
    return { ok: false, error };
  }

  if (tiktokStatus.status === "connecting") {
    return { ok: false, error: "already_connecting" };
  }

  if (tiktokConn?.disconnect) {
    try { tiktokConn.disconnect(); } catch {}
  }

  tiktokConn = new TikTokLiveConnection(settings.tiktokUsername);
  updateTikTokStatus({ status: "connecting", live: false, lastError: null, roomId: null });
  try {
    const state = await tiktokConn.connect();
    updateTikTokStatus({ status: "connected", live: true, roomId: state.roomId ?? null });
    pushLog({ type: "tiktok_connected", roomId: state.roomId });
  } catch (err) {
    const error = String(err);
    updateTikTokStatus({ status: "error", live: false, lastError: error, roomId: null });
    pushLog({ type: "tiktok_connect_failed", error });
    return { ok: false, error };
  }

  tiktokConn.on(WebcastEvent.CHAT, (data) => {
    const uniqueId = data.uniqueId || "unknown";
    const nickname = data.nickname || uniqueId;
    const comment = data.comment || "";

    // ban check
    const b = isBanned(uniqueId);
    if (b.banned) {
      pushLog({ type: "blocked_banned_user", uniqueId, nickname, comment, reason: b.entry?.reason });
      return;
    }

    // filter check
    const f = filterChatText(comment);
    if (!f.ok) {
      const strikeCount = addStrike(uniqueId);
      pushLog({ type: "blocked_filter", uniqueId, nickname, comment, reason: f.reason, strikes: strikeCount });
      return;
    }

    // cooldown
    if (!canSpeak(uniqueId)) {
      pushLog({ type: "blocked_cooldown", uniqueId, nickname, comment, reason: "cooldown" });
      return;
    }

    const msg = {
      id: nextMsgId++,
      uniqueId,
      nickname,
      text: f.text,
      ts: nowMs()
    };
    enqueueMessage(msg);
  });

  tiktokConn.on("disconnected", () => {
    updateTikTokStatus({ status: "idle", live: false, lastError: null, roomId: null });
    pushLog({ type: "tiktok_disconnected" });
  });

  return { ok: true };
}

function disconnectTikTok(reason) {
  if (tiktokConn?.disconnect) {
    try { tiktokConn.disconnect(); } catch {}
  }
  tiktokConn = null;
  updateTikTokStatus({ status: "idle", live: false, lastError: null, roomId: null });
  if (reason) pushLog({ type: "tiktok_disconnected", reason });
}

// ---------- Start ----------
httpServer.listen(settings.port, settings.bindHost, () => {
  console.log(`Dashboard: http://${settings.bindHost}:${settings.port}`);
});
