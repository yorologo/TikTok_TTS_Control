import test from "node:test";
import assert from "node:assert/strict";

import { createTikTokModule } from "../modules/tiktok.js";
import { getSafeError, normalizeTikTokUsername } from "../modules/common.js";

function createTikTokHarness(options = {}) {
  const emissions = [];
  const logs = [];
  const instances = [];
  const connectError = options.connectError || new Error("network_down");

  class FakeConnection {
    constructor(username) {
      this.username = username;
      this.listeners = new Map();
      this.disconnected = false;
      this.listenersCleared = false;
      instances.push(this);
    }

    async connect() {
      throw connectError;
    }

    on(event, handler) {
      this.listeners.set(event, handler);
    }

    removeAllListeners() {
      this.listenersCleared = true;
      this.listeners.clear();
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  const state = {
    settings: { tiktokUsername: options.username || "@demo_user" },
    tiktokConn: null,
    tiktokStatus: { status: "idle", live: false, lastError: null, roomId: null },
    nextMsgId: 1
  };

  const tiktok = createTikTokModule({
    state,
    settingsRef: () => state.settings,
    safeEmit: (event, payload) => emissions.push({ event, payload }),
    pushLog: (entry) => logs.push(entry),
    WebcastPushConnection: FakeConnection,
    WebcastEvent: { CHAT: "chat" },
    helpers: { normalizeTikTokUsername, getSafeError },
    moderation: {},
    tts: {},
    nowMs: () => 123
  });

  return { tiktok, state, emissions, logs, instances };
}

test("TikTok connection failures preserve error status and lastError after cleanup", async () => {
  const { tiktok, state, emissions, logs, instances } = createTikTokHarness({
    connectError: new Error("socket exploded")
  });

  const result = await tiktok.connectTikTok();

  assert.equal(result.ok, false);
  assert.match(result.error, /socket exploded/);
  assert.equal(state.tiktokConn, null);
  assert.equal(state.tiktokStatus.status, "error");
  assert.match(state.tiktokStatus.lastError, /socket exploded/);
  assert.equal(instances[0].disconnected, true);
  assert.equal(instances[0].listenersCleared, true);
  assert.equal(emissions.at(-1).event, "tiktokStatus");
  assert.equal(emissions.at(-1).payload.status, "error");
  assert.match(emissions.at(-1).payload.lastError, /socket exploded/);
  assert.equal(logs.at(-1).type, "tiktok_connect_failed");
});

test("manual TikTok disconnect keeps legacy idle behavior", () => {
  const { tiktok, state } = createTikTokHarness();
  state.tiktokConn = {
    removeAllListeners() {},
    disconnect() {}
  };
  state.tiktokStatus = { status: "connected", live: true, lastError: "old_error", roomId: "room-1" };

  tiktok.disconnectTikTok("manual");

  assert.deepEqual(state.tiktokStatus, {
    status: "idle",
    live: false,
    lastError: null,
    roomId: null
  });
});
