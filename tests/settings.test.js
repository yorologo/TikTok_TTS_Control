import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import { createSettingsModule } from "../modules/settings.js";
import {
  normalizeTikTokUsername,
  normalizeAdminToken,
  isLoopbackBindHost,
  extractTermuxConfigInput
} from "../modules/common.js";

function createSettingsHarness() {
  const DEFAULT_SETTINGS = {
    tiktokUsername: "",
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
    ttsEngine: "termux",
    ttsVoice: "",
    ttsRate: 1,
    piper: {
      modelPath: "",
      lengthScale: 1,
      volume: 1,
      pythonCmd: "python"
    },
    termux: {
      engine: "",
      language: "es",
      region: "MX",
      variant: "",
      pitch: 1,
      rate: 1,
      stream: "MUSIC",
      outputMode: "media",
      coexistenceMode: "duck"
    },
    autoBan: {
      enabled: true,
      strikeThreshold: 2,
      banMinutes: 30
    }
  };

  const state = {
    settings: structuredClone(DEFAULT_SETTINGS),
    sessionTermuxOverrides: {},
    queue: [],
    recentHistory: []
  };

  const refs = {
    getRuntimeSnapshot: () => ({ platform: "android", isTermux: true }),
    moderation: {
      getHistorySnapshot: () => ({ size: 0, items: [] })
    },
    tts: {
      validateTermuxConfig: async () => ({ ok: true, normalized: {}, warnings: [] }),
      getEffectiveTermuxConfig: () => structuredClone(DEFAULT_SETTINGS.termux),
      normalizeTermux: (raw, fallback) => ({ ...(fallback || {}), ...(raw || {}) }),
      getPersistedTermuxConfig: () => structuredClone(DEFAULT_SETTINGS.termux),
      getResolvedTermuxSpeakConfig: () => ({ ...structuredClone(DEFAULT_SETTINGS.termux), effectiveStream: "MUSIC" }),
      getTermuxConfigSnapshot: () => ({ effective: { ...structuredClone(DEFAULT_SETTINGS.termux), effectiveStream: "MUSIC" } }),
      describeTermuxAudioBehavior: () => ({ outputMode: "media", coexistenceMode: "duck", effectiveStream: "MUSIC", notes: [] }),
      getQueueSnapshot: () => ({ size: 0, items: [] }),
      getStatusSnapshot: () => ({ ttsEnabled: true, speaking: false, queueSize: 0, ttsEngine: "termux" })
    }
  };

  return createSettingsModule({
    crypto,
    state,
    refs,
    runtimeCaps: { hasTermuxTts: true },
    activeRuntimeConfig: { bindHost: "127.0.0.1", port: 8787 },
    defaults: { DEFAULT_SETTINGS, DEFAULT_PIPER_PYTHON_CMD: "python" },
    constants: {
      SUPPORTED_TTS_ENGINES: new Set(["say", "piper", "termux"]),
      ALLOWED_BIND_HOSTS: new Set(["127.0.0.1", "0.0.0.0", "localhost"]),
      PERSIST_SCOPES: new Set(["global", "session"]),
      MIN_TTS_RATE: 0.5,
      MAX_TTS_RATE: 2.0
    },
    helpers: {
      normalizeTikTokUsername,
      normalizeAdminToken,
      isLoopbackBindHost,
      extractTermuxConfigInput
    },
    persistence: {
      withResourceLock: async (_resource, task) => task(),
      writeJsonAtomic: async () => {},
      reportPersistenceIssue() {}
    },
    paths: { SETTINGS_PATH: "/tmp/settings.json" },
    safeEmit() {},
    pushLog() {}
  });
}

test("settings runtime validation normalizes username, bind host, port and admin token", () => {
  const settingsModule = createSettingsHarness();
  const result = settingsModule.validateRuntimeSettingsInput({
    tiktokUsername: " @Mi_User ",
    bindHost: "LOCALHOST",
    port: 9000,
    adminToken: " secret\n"
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.normalized, {
    tiktokUsername: "Mi_User",
    bindHost: "localhost",
    port: 9000,
    adminToken: "secret"
  });
});

test("settings update validation rejects invalid runtime and TTS values", async () => {
  const settingsModule = createSettingsHarness();
  const result = await settingsModule.validateSettingsUpdateInput({
    tiktokUsername: "@??",
    bindHost: "192.168.1.20",
    port: 70000,
    ttsEngine: "broken",
    ttsRate: 9
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((entry) => entry.field).sort(),
    ["bindHost", "port", "tiktokUsername", "ttsEngine", "ttsRate"].sort()
  );
});
