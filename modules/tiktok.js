export function createTikTokModule({
  state,
  settingsRef,
  safeEmit,
  pushLog,
  WebcastPushConnection,
  WebcastEvent,
  helpers,
  moderation,
  tts,
  nowMs
}) {
  const { normalizeTikTokUsername, getSafeError } = helpers;

  function getSettings() {
    return settingsRef();
  }

  function getTikTokStatusSnapshot() {
    return {
      status: state.tiktokStatus.status,
      live: state.tiktokStatus.live,
      lastError: state.tiktokStatus.lastError,
      roomId: state.tiktokStatus.roomId
    };
  }

  function setTikTokStatus(update) {
    state.tiktokStatus = { ...state.tiktokStatus, ...update };
    safeEmit("tiktokStatus", getTikTokStatusSnapshot());
  }

  function cleanupTikTokConnection() {
    const conn = state.tiktokConn;
    state.tiktokConn = null;
    if (!conn) return false;

    try {
      conn.removeAllListeners?.();
      conn.disconnect?.();
    } catch {}

    return true;
  }

  function disconnectTikTok(reason, options = {}) {
    const { preserveStatus = false, nextStatus = null, suppressLog = false } = options;
    const hadConnection = cleanupTikTokConnection();

    if (nextStatus && typeof nextStatus === "object") {
      setTikTokStatus(nextStatus);
    } else if (!preserveStatus) {
      setTikTokStatus({ status: "idle", live: false, lastError: null, roomId: null });
    }

    if (reason && !suppressLog && (hadConnection || reason === "manual")) {
      pushLog({
        type: "tiktok_disconnected",
        reason,
        status: state.tiktokStatus.status,
        lastError: state.tiktokStatus.lastError
      });
    }

    return hadConnection;
  }

  async function connectTikTok() {
    const username = normalizeTikTokUsername(getSettings().tiktokUsername);
    if (!username || username === "TU_USUARIO_SIN_ARROBA") {
      const error = "missing_username";
      setTikTokStatus({ status: "error", live: false, lastError: error, roomId: null });
      return { ok: false, error };
    }

    if (state.tiktokStatus.status === "connecting") {
      return { ok: false, error: "already_connecting" };
    }

    pushLog({ type: "tiktok_connect_attempt", username });
    disconnectTikTok("reconnect");

    state.tiktokConn = new WebcastPushConnection(username);
    setTikTokStatus({ status: "connecting", live: false, lastError: null, roomId: null });

    try {
      const connectionState = await state.tiktokConn.connect();
      setTikTokStatus({ status: "connected", live: true, lastError: null, roomId: connectionState.roomId ?? null });
      pushLog({ type: "tiktok_connected", username, roomId: connectionState.roomId ?? null });

      state.tiktokConn.on(WebcastEvent.CHAT, (data) => {
        const uniqueId = data.uniqueId || "unknown";
        const nickname = data.nickname || uniqueId;
        const comment = data.comment || "";

        const banned = moderation.isBanned(uniqueId);
        if (banned.banned) {
          pushLog({ type: "blocked_banned_user", uniqueId, nickname, comment, reason: banned.entry?.reason });
          moderation.pushHistory({ uniqueId, nickname, comment, status: "blocked", reason: banned.entry?.reason || "banned" });
          return;
        }

        const filtered = moderation.filterChatText(comment);
        if (!filtered.ok) {
          const strikeCount = moderation.addStrike(uniqueId);
          pushLog({ type: "blocked_filter", uniqueId, nickname, comment, reason: filtered.reason, strikes: strikeCount });
          moderation.pushHistory({ uniqueId, nickname, comment, status: "blocked", reason: filtered.reason });
          return;
        }

        if (!moderation.canSpeakNow(uniqueId)) {
          pushLog({ type: "blocked_cooldown", uniqueId, nickname, comment, reason: "cooldown" });
          moderation.pushHistory({ uniqueId, nickname, comment, status: "blocked", reason: "cooldown" });
          return;
        }

        const msg = {
          id: state.nextMsgId++,
          uniqueId,
          nickname,
          text: filtered.text,
          ts: nowMs(),
          source: "tiktok"
        };

        const ok = tts.enqueueMessage(msg);
        if (ok) {
          moderation.markSpeak(uniqueId);
          moderation.pushHistory({ uniqueId, nickname, comment, status: "queued", reason: "" });
        } else {
          moderation.pushHistory({ uniqueId, nickname, comment, status: "dropped", reason: "queue_full" });
        }
      });

      state.tiktokConn.on("disconnected", () => {
        disconnectTikTok("tiktok_disconnected_event");
      });

      return { ok: true };
    } catch (err) {
      const error = getSafeError(err, "tiktok_connect_failed");
      disconnectTikTok("connect_failed", {
        preserveStatus: true,
        nextStatus: { status: "error", live: false, lastError: error, roomId: null },
        suppressLog: true
      });
      pushLog({ type: "tiktok_connect_failed", username, error });
      return { ok: false, error };
    }
  }

  return {
    getTikTokStatusSnapshot,
    connectTikTok,
    disconnectTikTok,
    cleanupTikTokConnection,
    setTikTokStatus
  };
}
