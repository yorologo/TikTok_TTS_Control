export function registerApiRoutes({
  app,
  state,
  settingsModule,
  moderation,
  tts,
  tiktok,
  runtimeSnapshot,
  helpers,
  constants,
  safeEmit,
  nowMs
}) {
  const { requireAdmin, getSettingsSnapshot, applySettingsUpdate } = settingsModule;
  const { getSafeError, extractTermuxConfigInput } = helpers;
  const { SUPPORTED_TTS_ENGINES } = constants;

  app.use("/api/tts", requireAdmin);
  app.use("/api/tiktok", requireAdmin);
  app.use("/api/settings", requireAdmin);
  app.use("/api/lists", requireAdmin);
  app.use("/api/bans", requireAdmin);
  app.use("/api/ban", requireAdmin);
  app.use("/api/unban", requireAdmin);
  app.use("/api/badwords/add", requireAdmin);
  app.use("/api/queue", requireAdmin);

  app.get("/api/runtime", (_, res) => res.json(runtimeSnapshot()));

  app.get("/api/bans", (_, res) => res.json(moderation.getBansSnapshot()));
  app.post("/api/ban", async (req, res) => {
    const { uniqueId, minutes, reason } = req.body ?? {};
    const uid = String(uniqueId || "").trim().replace(/^@/, "");
    if (!uid) return res.status(400).json({ error: "uniqueId requerido" });

    try {
      await moderation.banUser(uid, String(reason ?? "manual"), Number(minutes ?? 30), { awaitPersistence: true });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: "ban_persist_failed", detail: getSafeError(err) });
    }
  });

  app.post("/api/unban", async (req, res) => {
    const uid = String(req.body?.uniqueId || "").trim().replace(/^@/, "");
    if (!uid) return res.status(400).json({ error: "uniqueId requerido" });

    try {
      await moderation.unbanUser(uid, { awaitPersistence: true });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: "unban_persist_failed", detail: getSafeError(err) });
    }
  });

  app.get("/api/status", (_, res) => res.json(tts.getStatusSnapshot()));
  app.post("/api/tts", (req, res) => {
    const ttsEnabled = tts.setTtsEnabled(req.body?.enabled);
    res.json({ ok: true, ttsEnabled });
  });

  app.get("/api/tts/voices", async (_, res) => {
    const result = await tts.getInstalledVoices();
    res.json(result);
  });

  app.get("/api/tts/config", async (_, res) => {
    const snapshot = tts.getTermuxConfigSnapshot();
    const validation = await tts.validateTermuxConfig(snapshot.effective, { baseConfig: snapshot.persisted });

    res.json({
      ok: true,
      ...snapshot,
      validation,
      runtime: runtimeSnapshot(),
      audioBehavior: tts.describeTermuxAudioBehavior(snapshot.effective)
    });
  });

  app.post("/api/tts/config/validate", async (req, res) => {
    const base = req.body?.baseConfig && typeof req.body.baseConfig === "object"
      ? req.body.baseConfig
      : tts.getEffectiveTermuxConfig();

    const result = await tts.validateTermuxConfig(req.body || {}, { baseConfig: base });
    res.json(result);
  });

  app.post("/api/tts/config", async (req, res) => {
    const persistScope = tts.getPersistScope(req.body?.persistScope);
    const validation = await tts.validateTermuxConfig(req.body || {}, { baseConfig: tts.getEffectiveTermuxConfig() });

    if (!validation.ok) {
      return res.status(400).json({ ok: false, errors: validation.errors, warnings: validation.warnings });
    }

    try {
      const snapshot = await tts.applyTermuxConfig(validation.normalized, persistScope);
      res.json({
        ok: true,
        persistScope,
        ...snapshot,
        validation,
        audioBehavior: tts.describeTermuxAudioBehavior(snapshot.effective)
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: "tts_config_persist_failed", detail: getSafeError(err), warnings: validation.warnings });
    }
  });

  app.post("/api/tts/test", async (req, res) => {
    const result = await tts.runTtsTest(req.body || {});
    res.status(result.status).json(result.body);
  });

  app.post("/api/queue/clear", (_, res) => {
    state.queue.length = 0;
    safeEmit("queue", tts.getQueueSnapshot());
    res.json({ ok: true });
  });

  app.post("/api/queue/skip", (req, res) => {
    const id = Number(req.body?.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id requerido" });
    const ok = tts.skipQueueMessage(id);
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
      ? tts.normalizeTermux(termuxInput, tts.getEffectiveTermuxConfig())
      : null;

    const banned = moderation.isBanned(uid);
    if (banned.banned) {
      moderation.pushLog({ type: "blocked_banned_user", source: "local", uniqueId: uid, nickname: name, comment: rawText, reason: banned.entry?.reason });
      moderation.pushHistory({ uniqueId: uid, nickname: name, comment: rawText, source: "local", status: "blocked", reason: banned.entry?.reason || "banned" });
      return res.json({ ok: false, reason: "banned" });
    }

    const filtered = moderation.filterChatText(rawText);
    if (!filtered.ok) {
      moderation.pushLog({ type: "blocked_filter", source: "local", uniqueId: uid, nickname: name, comment: rawText, reason: filtered.reason, strikes: 0 });
      moderation.pushHistory({ uniqueId: uid, nickname: name, comment: rawText, source: "local", status: "blocked", reason: filtered.reason });
      return res.json({ ok: false, reason: filtered.reason });
    }

    let added = 0;
    let dropped = 0;
    for (let index = 0; index < repeat; index += 1) {
      const message = {
        id: state.nextMsgId++,
        uniqueId: uid,
        nickname: name,
        text: filtered.text,
        ts: nowMs(),
        source: "local",
        termuxOverrides,
        ttsEngineOverride
      };

      const ok = tts.enqueueMessage(message);
      if (ok) {
        added += 1;
        moderation.pushHistory({ uniqueId: uid, nickname: name, comment: rawText, source: "local", status: "queued", reason: "" });
      } else {
        dropped += 1;
        moderation.pushHistory({ uniqueId: uid, nickname: name, comment: rawText, source: "local", status: "dropped", reason: "queue_full" });
        break;
      }
    }

    if (added === 0) return res.json({ ok: false, reason: "queue_full" });
    res.json({ ok: true, added, dropped });
  });

  app.get("/api/settings", (_, res) => res.json(getSettingsSnapshot()));
  app.post("/api/settings", async (req, res) => {
    try {
      const result = await applySettingsUpdate(req.body);
      if (!result.ok) return res.status(400).json(result);
      res.json({
        ok: true,
        settings: result.settings ?? getSettingsSnapshot(),
        restartRequired: !!result.restartRequired,
        restartFields: Array.isArray(result.restartFields) ? result.restartFields : [],
        termuxValidation: result.termuxValidation || null,
        termuxConfig: result.termuxConfig || null,
        audioBehavior: result.audioBehavior || null
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: "settings_persist_failed", detail: getSafeError(err) });
    }
  });

  app.get("/api/tiktok/status", (_, res) => res.json(tiktok.getTikTokStatusSnapshot()));
  app.post("/api/tiktok/connect", async (_, res) => {
    const result = await tiktok.connectTikTok();
    res.json({ ...result, status: tiktok.getTikTokStatusSnapshot() });
  });

  app.post("/api/tiktok/disconnect", (_, res) => {
    tiktok.disconnectTikTok("manual");
    res.json({ ok: true, status: tiktok.getTikTokStatusSnapshot() });
  });

  app.get("/api/lists", (_, res) => {
    res.json({ exact: Array.from(state.bannedExact.values()), sub: state.bannedSub.slice() });
  });

  app.post("/api/lists", async (req, res) => {
    try {
      await moderation.replaceLists(req.body ?? {});
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: "lists_persist_failed", detail: getSafeError(err) });
    }
  });

  app.post("/api/badwords/add", async (req, res) => {
    try {
      const result = await moderation.addBadword(req.body?.word, req.body?.mode);
      if (!result.ok) {
        return res.status(result.status || 400).json({ error: result.error || "word_invalida" });
      }
      res.json({ ok: true, word: result.word, mode: result.mode });
    } catch (err) {
      res.status(500).json({ ok: false, error: "badword_add_persist_failed", detail: getSafeError(err) });
    }
  });
}
