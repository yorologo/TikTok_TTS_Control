import test from "node:test";
import assert from "node:assert/strict";

import { createModerationModule } from "../modules/moderation.js";
import { debounce, normalizeForModeration, stripDiacritics, tokenize } from "../modules/common.js";

function createModerationHarness(options = {}) {
  let currentTime = options.now ?? 10_000;
  const settings = {
    maxChars: 80,
    maxWords: 14,
    historySize: 25,
    globalCooldownMs: 1_000,
    perUserCooldownMs: 3_000,
    autoBan: { enabled: true, strikeThreshold: 2, banMinutes: 30 },
    ...(options.settings || {})
  };

  const state = {
    recentHistory: [],
    recentLog: [],
    nextHistoryId: 1,
    bannedDb: { users: {} },
    bannedExact: new Set(options.badwordsExact || ["puta"]),
    bannedSub: options.badwordsSub || ["ching"],
    strikes: new Map(),
    lastGlobalSpeak: 0,
    lastUserSpeak: new Map()
  };

  const moderation = createModerationModule({
    fs: { watchFile() {} },
    state,
    settingsRef: () => settings,
    paths: {
      BAD_EXACT_PATH: "/tmp/badwords_exact_es.txt",
      BAD_SUB_PATH: "/tmp/badwords_substring_es.txt",
      BANNED_PATH: "/tmp/banned_users.json",
      DATA_DIR: "/tmp"
    },
    persistence: {
      readLinesSafe: async () => [],
      readJsonSafe: async () => ({ users: {} }),
      writeJsonAtomic: async () => {},
      writeTextAtomic: async () => {},
      withResourceLock: async (_resource, task) => task(),
      parseTextLines(text) {
        return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      },
      serializeWordLines(lines) {
        const clean = Array.isArray(lines) ? lines.filter(Boolean) : [];
        return clean.length > 0 ? `${clean.join("\n")}\n` : "";
      },
      reportPersistenceIssue() {}
    },
    safeEmit() {},
    nowMs: () => currentTime,
    debounce,
    stripDiacritics,
    normalizeForModeration,
    tokenize
  });

  return {
    moderation,
    state,
    advance(ms) {
      currentTime += ms;
    }
  };
}

test("moderation blocks obvious URLs and banned words but keeps clean text", () => {
  const { moderation } = createModerationHarness();

  assert.equal(moderation.filterChatText("visita https://example.com").reason, "url");
  assert.equal(moderation.filterChatText("eres puta").reason, "badword_exact");
  assert.deepEqual(moderation.filterChatText("hola mundo"), { ok: true, text: "hola mundo" });
});

test("moderation enforces global cooldown and per-user cooldown independently", () => {
  const { moderation, advance } = createModerationHarness({
    settings: { globalCooldownMs: 1_000, perUserCooldownMs: 3_000 }
  });

  assert.equal(moderation.canSpeakNow("alice"), true);
  moderation.markSpeak("alice");

  assert.equal(moderation.canSpeakNow("alice"), false);
  assert.equal(moderation.canSpeakNow("bob"), false);

  advance(1_001);

  assert.equal(moderation.canSpeakNow("bob"), true);
  assert.equal(moderation.canSpeakNow("alice"), false);

  advance(2_000);

  assert.equal(moderation.canSpeakNow("alice"), true);
});
