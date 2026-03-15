import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";
import crypto from "crypto";
import { execFile, spawn } from "child_process";
import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import TikTokLive from "tiktok-live-connector";

import {
  nowMs,
  clampNumber,
  normalizeTikTokUsername,
  sanitizeBindHost,
  sanitizePort,
  normalizeAdminToken,
  isLoopbackBindHost,
  normalizeTermuxConfig,
  resolveTermuxStream,
  getSafeError,
  validateTextForSpeech,
  debounce,
  stripDiacritics,
  normalizeForTts,
  normalizeForModeration,
  tokenize,
  validateEnumField,
  extractTermuxConfigInput,
  getPersistScope
} from "./modules/common.js";
import { createPersistenceModule } from "./modules/persistence.js";
import { createModerationModule } from "./modules/moderation.js";
import { createTtsModule } from "./modules/tts.js";
import { createSettingsModule } from "./modules/settings.js";
import { createTikTokModule } from "./modules/tiktok.js";
import { registerApiRoutes } from "./routes/api.js";

const { WebcastPushConnection } = TikTokLive;
const WebcastEvent = { CHAT: "chat" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const SETTINGS_EXAMPLE_PATH = path.join(DATA_DIR, "settings.example.json");
const BANNED_PATH = path.join(DATA_DIR, "banned_users.json");
const BANNED_EXAMPLE_PATH = path.join(DATA_DIR, "banned_users.example.json");
const BAD_EXACT_PATH = path.join(DATA_DIR, "badwords_exact_es.txt");
const BAD_SUB_PATH = path.join(DATA_DIR, "badwords_substring_es.txt");

const SUPPORTED_TTS_ENGINES = new Set(["say", "piper", "termux"]);
const ALLOWED_BIND_HOSTS = new Set(["127.0.0.1", "0.0.0.0", "localhost"]);
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
  adminToken: "",
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

const PATHS = {
  ROOT_DIR: __dirname,
  DATA_DIR,
  SETTINGS_PATH,
  BANNED_PATH,
  BAD_EXACT_PATH,
  BAD_SUB_PATH
};

const CONSTANTS = {
  SUPPORTED_TTS_ENGINES,
  ALLOWED_BIND_HOSTS,
  TERMUX_STREAMS,
  OUTPUT_MODES,
  COEXISTENCE_MODES,
  PERSIST_SCOPES,
  MIN_TTS_RATE,
  MAX_TTS_RATE,
  MIN_TTS_PITCH,
  MAX_TTS_PITCH,
  MAX_TERMUX_TEXT_LEN,
  TTS_TEST_MAX_LEN,
  TERMUX_DEFAULT_STREAM,
  TTS_CMD_TIMEOUT_MS
};

const DEFAULTS = {
  DEFAULT_SETTINGS,
  DEFAULT_PIPER_PYTHON_CMD
};

function getTermuxNormalizeOptions() {
  return {
    termuxStreams: TERMUX_STREAMS,
    outputModes: OUTPUT_MODES,
    coexistenceModes: COEXISTENCE_MODES,
    termuxDefaultStream: TERMUX_DEFAULT_STREAM,
    minPitch: MIN_TTS_PITCH,
    maxPitch: MAX_TTS_PITCH,
    minRate: MIN_TTS_RATE,
    maxRate: MAX_TTS_RATE,
    clampNumberFn: clampNumber
  };
}

function mergeSettings(rawSettings = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...(rawSettings || {}),
    autoBan: {
      ...DEFAULT_SETTINGS.autoBan,
      ...(rawSettings?.autoBan || {})
    },
    piper: {
      ...DEFAULT_SETTINGS.piper,
      ...(rawSettings?.piper || {})
    },
    termux: {
      ...DEFAULT_SETTINGS.termux,
      ...(rawSettings?.termux || {})
    }
  };
}

function normalizeStoredSettings(rawSettings = {}) {
  const settings = mergeSettings(rawSettings);

  if (!SUPPORTED_TTS_ENGINES.has(settings.ttsEngine)) {
    settings.ttsEngine = DEFAULT_TTS_ENGINE;
  }

  if (!settings.piper.pythonCmd) {
    settings.piper.pythonCmd = DEFAULT_PIPER_PYTHON_CMD;
  }

  settings.tiktokUsername = normalizeTikTokUsername(settings.tiktokUsername);
  settings.bindHost = sanitizeBindHost(settings.bindHost, ALLOWED_BIND_HOSTS, DEFAULT_SETTINGS.bindHost);
  settings.port = sanitizePort(settings.port, DEFAULT_SETTINGS.port);
  settings.adminToken = normalizeAdminToken(settings.adminToken);
  settings.termux = normalizeTermuxConfig(settings.termux, DEFAULT_SETTINGS.termux, getTermuxNormalizeOptions());

  if (RUNTIME_CAPS.isTermux && settings.ttsEngine === "say") {
    settings.ttsEngine = RUNTIME_CAPS.hasTermuxTts ? "termux" : "piper";
  }

  return settings;
}

let moderation = null;
const persistence = createPersistenceModule({
  fs,
  path,
  getLogger: () => moderation?.pushLog || null
});

await persistence.ensureDir(DATA_DIR);
const [settingsSeed, bannedSeed] = await Promise.all([
  persistence.readTextSafe(SETTINGS_EXAMPLE_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2)),
  persistence.readTextSafe(BANNED_EXAMPLE_PATH, JSON.stringify({ users: {} }, null, 2))
]);

await Promise.all([
  persistence.ensureFileIfMissing(SETTINGS_PATH, settingsSeed),
  persistence.ensureFileIfMissing(BANNED_PATH, bannedSeed),
  persistence.ensureFileIfMissing(BAD_EXACT_PATH, ""),
  persistence.ensureFileIfMissing(BAD_SUB_PATH, "")
]);

const rawSettings = await persistence.readJsonSafe(SETTINGS_PATH, null, { errorType: "settings_read_failed" }) ?? { ...DEFAULT_SETTINGS };
const settings = normalizeStoredSettings(rawSettings);
await persistence.writeJsonAtomic(SETTINGS_PATH, settings);

const bannedDb = await persistence.readJsonSafe(BANNED_PATH, { users: {} }, { errorType: "bans_read_failed" });
const bannedExact = new Set((await persistence.readLinesSafe(BAD_EXACT_PATH, [], { errorType: "badwords_exact_read_failed" })).map((line) => line.toLowerCase()));
const bannedSub = (await persistence.readLinesSafe(BAD_SUB_PATH, [], { errorType: "badwords_sub_read_failed" }))
  .map((line) => line.toLowerCase())
  .filter((line) => line.length >= 4);

const ACTIVE_RUNTIME_CONFIG = Object.freeze({
  bindHost: settings.bindHost,
  port: settings.port
});

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

// Shared mutable runtime state consumed by the feature modules.
const state = {
  settings,
  strikes: new Map(),
  ttsEnabled: !!settings.ttsEnabled,
  speaking: false,
  lastGlobalSpeak: 0,
  lastUserSpeak: new Map(),
  queue: [],
  recentLog: [],
  recentHistory: [],
  nextHistoryId: 1,
  nextMsgId: 1,
  sessionTermuxOverrides: {},
  tiktokConn: null,
  tiktokStatus: {
    status: "idle",
    live: false,
    lastError: null,
    roomId: null
  },
  bannedDb,
  bannedExact,
  bannedSub
};

const refs = {
  getRuntimeSnapshot
};

const sharedHelpers = {
  clampNumber,
  normalizeTikTokUsername,
  normalizeAdminToken,
  isLoopbackBindHost,
  normalizeTermuxConfig,
  resolveTermuxStream,
  getSafeError,
  validateTextForSpeech,
  debounce,
  stripDiacritics,
  normalizeForTts,
  normalizeForModeration,
  tokenize,
  validateEnumField,
  extractTermuxConfigInput,
  getPersistScope
};

moderation = createModerationModule({
  fs,
  state,
  settingsRef: () => state.settings,
  paths: PATHS,
  persistence,
  safeEmit,
  nowMs,
  debounce,
  stripDiacritics,
  normalizeForModeration,
  tokenize
});
refs.moderation = moderation;

const tts = createTtsModule({
  fs,
  path,
  os,
  execFile,
  spawn,
  state,
  settingsRef: () => state.settings,
  refs,
  runtimeCaps: RUNTIME_CAPS,
  runtimeSnapshot: getRuntimeSnapshot,
  defaults: DEFAULTS,
  constants: CONSTANTS,
  helpers: sharedHelpers,
  persistence,
  paths: PATHS,
  safeEmit,
  pushLog: moderation.pushLog
});
refs.tts = tts;

const settingsModule = createSettingsModule({
  crypto,
  state,
  refs,
  runtimeCaps: RUNTIME_CAPS,
  activeRuntimeConfig: ACTIVE_RUNTIME_CONFIG,
  defaults: DEFAULTS,
  constants: CONSTANTS,
  helpers: sharedHelpers,
  persistence,
  paths: PATHS,
  safeEmit,
  pushLog: moderation.pushLog
});
refs.getSettingsSnapshot = settingsModule.getSettingsSnapshot;

const tiktok = createTikTokModule({
  state,
  settingsRef: () => state.settings,
  safeEmit,
  pushLog: moderation.pushLog,
  WebcastPushConnection,
  WebcastEvent,
  helpers: sharedHelpers,
  moderation,
  tts,
  nowMs
});

registerApiRoutes({
  app,
  state,
  settingsModule,
  moderation,
  tts,
  tiktok,
  runtimeSnapshot: getRuntimeSnapshot,
  helpers: sharedHelpers,
  constants: CONSTANTS,
  safeEmit,
  nowMs
});

io.use((socket, next) => {
  const validation = settingsModule.validateAdminAccessToken(socket.handshake.auth?.adminToken);
  if (validation.ok) return next();

  moderation.pushLog({
    type: "admin_auth_failed",
    scope: "socket",
    error: validation.error,
    ip: socket.handshake.address || "unknown"
  });

  const err = new Error(validation.message || "admin_auth_failed");
  err.data = settingsModule.buildAdminAuthError(validation);
  next(err);
});

io.on("connection", (socket) => {
  socket.emit("status", tts.getStatusSnapshot());
  socket.emit("queue", tts.getQueueSnapshot());
  socket.emit("historyBulk", moderation.getHistorySnapshot());
  socket.emit("bansUpdated", moderation.getBansSnapshot());
  socket.emit("listsUpdated", {
    badwordsExact: Array.from(state.bannedExact.values()).slice(0, 200),
    badwordsSub: state.bannedSub.slice(0, 200)
  });
  socket.emit("settings", settingsModule.getSettingsSnapshot());
  socket.emit("tiktokStatus", tiktok.getTikTokStatusSnapshot());
  socket.emit("runtime", getRuntimeSnapshot());
  socket.emit("logBulk", state.recentLog);
});

moderation.startWatchers();

httpServer.listen(ACTIVE_RUNTIME_CONFIG.port, ACTIVE_RUNTIME_CONFIG.bindHost, () => {
  const runtime = getRuntimeSnapshot();
  console.log(`Dashboard: http://${ACTIVE_RUNTIME_CONFIG.bindHost}:${ACTIVE_RUNTIME_CONFIG.port}`);
  console.log(`Runtime: platform=${runtime.platform} termux=${runtime.isTermux} engines=${runtime.availableTtsEngines.join(",")} recommended=${runtime.recommendedTtsEngine}`);
});

process.on("SIGINT", () => {
  try { tiktok.disconnectTikTok("SIGINT"); } catch {}
  process.exit(0);
});

process.on("SIGTERM", () => {
  try { tiktok.disconnectTikTok("SIGTERM"); } catch {}
  process.exit(0);
});
