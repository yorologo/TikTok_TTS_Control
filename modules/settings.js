export function createSettingsModule({
  crypto,
  state,
  refs,
  runtimeCaps,
  activeRuntimeConfig,
  defaults,
  constants,
  helpers,
  persistence,
  paths,
  safeEmit,
  pushLog
}) {
  const { DEFAULT_SETTINGS, DEFAULT_PIPER_PYTHON_CMD } = defaults;
  const {
    SUPPORTED_TTS_ENGINES,
    ALLOWED_BIND_HOSTS,
    PERSIST_SCOPES,
    MIN_TTS_RATE,
    MAX_TTS_RATE
  } = constants;
  const {
    normalizeTikTokUsername,
    normalizeAdminToken,
    isLoopbackBindHost,
    extractTermuxConfigInput
  } = helpers;

  function adminTokenDigest(value) {
    return crypto.createHash("sha256").update(String(value || ""), "utf8").digest();
  }

  function adminTokensEqual(expected, provided) {
    try {
      return crypto.timingSafeEqual(adminTokenDigest(expected), adminTokenDigest(provided));
    } catch {
      return false;
    }
  }

  function isAdminAuthRequired() {
    return !isLoopbackBindHost(activeRuntimeConfig.bindHost);
  }

  function validateAdminAccessToken(rawToken) {
    if (!isAdminAuthRequired()) {
      return { ok: true };
    }

    const expected = normalizeAdminToken(state.settings.adminToken);
    if (!expected) {
      return {
        ok: false,
        status: 401,
        error: "admin_token_not_configured",
        message: "El servidor requiere admin token, pero no tiene uno configurado. Configuralo primero en loopback."
      };
    }

    const provided = normalizeAdminToken(rawToken);
    if (!provided) {
      return {
        ok: false,
        status: 401,
        error: "admin_token_required",
        message: "Se requiere x-admin-token para esta interfaz administrativa."
      };
    }

    if (!adminTokensEqual(expected, provided)) {
      return {
        ok: false,
        status: 403,
        error: "admin_token_invalid",
        message: "El admin token proporcionado no es válido."
      };
    }

    return { ok: true };
  }

  function buildAdminAuthError(validation) {
    return {
      ok: false,
      error: validation.error || "admin_auth_failed",
      message: validation.message || "Autenticación administrativa requerida."
    };
  }

  function requireAdmin(req, res, next) {
    const validation = validateAdminAccessToken(req.get("x-admin-token"));
    if (validation.ok) return next();

    pushLog({
      type: "admin_auth_failed",
      scope: "http",
      path: req.originalUrl || req.url,
      error: validation.error,
      ip: req.socket?.remoteAddress || "unknown"
    });

    res.status(validation.status || 401).json(buildAdminAuthError(validation));
  }

  function getRuntimeBindingInfo(config = state.settings) {
    const restartFields = [];
    if (config.bindHost !== activeRuntimeConfig.bindHost) restartFields.push("bindHost");
    if (config.port !== activeRuntimeConfig.port) restartFields.push("port");

    return {
      activeBindHost: activeRuntimeConfig.bindHost,
      activePort: activeRuntimeConfig.port,
      restartRequired: restartFields.length > 0,
      restartFields,
      adminAuthRequired: isAdminAuthRequired()
    };
  }

  function validateRuntimeSettingsInput(update = {}) {
    const errors = [];
    const normalized = {};

    if (Object.prototype.hasOwnProperty.call(update, "tiktokUsername")) {
      const raw = String(update.tiktokUsername ?? "").trim();
      const username = normalizeTikTokUsername(raw);
      if (raw && !username) {
        errors.push({ field: "tiktokUsername", message: "username_invalido" });
      } else if (username && !/^[A-Za-z0-9._-]{2,64}$/.test(username)) {
        errors.push({ field: "tiktokUsername", message: "username_invalido" });
      } else {
        normalized.tiktokUsername = username;
      }
    }

    if (Object.prototype.hasOwnProperty.call(update, "bindHost")) {
      const raw = String(update.bindHost ?? "").trim().toLowerCase();
      if (!ALLOWED_BIND_HOSTS.has(raw)) {
        errors.push({ field: "bindHost", message: "bindHost_invalido" });
      } else {
        normalized.bindHost = raw;
      }
    }

    if (Object.prototype.hasOwnProperty.call(update, "port")) {
      const port = Number(update.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors.push({ field: "port", message: "port_fuera_de_rango_1_65535" });
      } else {
        normalized.port = port;
      }
    }

    if (Object.prototype.hasOwnProperty.call(update, "adminToken")) {
      normalized.adminToken = normalizeAdminToken(update.adminToken);
    }

    return { ok: errors.length === 0, normalized, errors };
  }

  function validateIntegerSetting(update, key, minValue, errors, normalized) {
    if (!Object.prototype.hasOwnProperty.call(update, key)) return;
    const value = Number(update[key]);
    if (!Number.isInteger(value) || value < minValue) {
      errors.push({ field: key, message: `fuera_de_rango_min_${minValue}` });
      return;
    }
    normalized[key] = value;
  }

  function validateNumberSetting(update, key, minValue, maxValue, errors, normalized) {
    if (!Object.prototype.hasOwnProperty.call(update, key)) return;
    const value = Number(update[key]);
    if (!Number.isFinite(value) || value < minValue || value > maxValue) {
      errors.push({ field: key, message: `fuera_de_rango_${minValue}_${maxValue}` });
      return;
    }
    normalized[key] = value;
  }

  function validatePersistScopeValue(update, errors, normalized) {
    const hasTermuxPersistScope = Object.prototype.hasOwnProperty.call(update, "termuxPersistScope");
    const hasPersistScope = Object.prototype.hasOwnProperty.call(update, "persistScope");
    if (!hasTermuxPersistScope && !hasPersistScope) return null;

    const raw = String(hasTermuxPersistScope ? update.termuxPersistScope : update.persistScope || "").trim().toLowerCase();
    if (!PERSIST_SCOPES.has(raw)) {
      errors.push({ field: "termuxPersistScope", message: "persist_scope_invalido" });
      return null;
    }

    normalized.termuxPersistScope = raw;
    return raw;
  }

  async function validateSettingsUpdateInput(update = {}) {
    const runtimeValidation = validateRuntimeSettingsInput(update);
    const errors = [...runtimeValidation.errors];
    const normalized = { ...runtimeValidation.normalized };

    validateIntegerSetting(update, "globalCooldownMs", 0, errors, normalized);
    validateIntegerSetting(update, "perUserCooldownMs", 0, errors, normalized);
    validateIntegerSetting(update, "maxQueue", 1, errors, normalized);
    validateIntegerSetting(update, "maxChars", 1, errors, normalized);
    validateIntegerSetting(update, "maxWords", 1, errors, normalized);
    validateIntegerSetting(update, "historySize", 5, errors, normalized);
    validateIntegerSetting(update, "autoBanStrikeThreshold", 1, errors, normalized);
    validateIntegerSetting(update, "autoBanBanMinutes", 1, errors, normalized);

    if (Object.prototype.hasOwnProperty.call(update, "autoBanEnabled")) {
      normalized.autoBanEnabled = !!update.autoBanEnabled;
    }

    if (Object.prototype.hasOwnProperty.call(update, "ttsEngine")) {
      const engine = String(update.ttsEngine || "").trim();
      if (!SUPPORTED_TTS_ENGINES.has(engine)) {
        errors.push({ field: "ttsEngine", message: "tts_engine_invalido" });
      } else {
        normalized.ttsEngine = engine;
      }
    }

    validateNumberSetting(update, "ttsRate", MIN_TTS_RATE, MAX_TTS_RATE, errors, normalized);
    validateNumberSetting(update, "piperLengthScale", 0.5, 2.5, errors, normalized);
    validateNumberSetting(update, "piperVolume", 0.0, 2.0, errors, normalized);

    if (Object.prototype.hasOwnProperty.call(update, "ttsVoice")) {
      normalized.ttsVoice = String(update.ttsVoice ?? "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(update, "piperModelPath")) {
      normalized.piperModelPath = String(update.piperModelPath ?? "").trim();
    }
    if (Object.prototype.hasOwnProperty.call(update, "piperPythonCmd")) {
      normalized.piperPythonCmd = String(update.piperPythonCmd || "").trim() || DEFAULT_PIPER_PYTHON_CMD;
    }

    const termuxInput = extractTermuxConfigInput(update);
    const persistScope = validatePersistScopeValue(update, errors, normalized);
    const shouldValidateTermux = Object.keys(termuxInput).length > 0 || persistScope !== null;

    let termuxValidation = null;
    if (shouldValidateTermux) {
      termuxValidation = await refs.tts.validateTermuxConfig(update, { baseConfig: refs.tts.getEffectiveTermuxConfig() });
      if (!termuxValidation.ok) {
        errors.push(...termuxValidation.errors);
      } else {
        normalized.termux = termuxValidation.normalized;
      }
    }

    return {
      ok: errors.length === 0,
      normalized,
      errors,
      warnings: termuxValidation?.warnings || [],
      termuxValidation
    };
  }

  function getSettingsSnapshot() {
    const persistedTermux = refs.tts.getPersistedTermuxConfig();
    const effectiveTermux = refs.tts.getResolvedTermuxSpeakConfig();
    const hasSessionOverrides = Object.keys(state.sessionTermuxOverrides || {}).length > 0;
    const runtimeBinding = getRuntimeBindingInfo();

    return {
      tiktokUsername: state.settings.tiktokUsername,
      bindHost: state.settings.bindHost,
      port: state.settings.port,
      adminTokenConfigured: !!state.settings.adminToken,
      adminAuthRequired: runtimeBinding.adminAuthRequired,
      activeBindHost: runtimeBinding.activeBindHost,
      activePort: runtimeBinding.activePort,
      restartRequired: runtimeBinding.restartRequired,
      restartFields: runtimeBinding.restartFields,

      globalCooldownMs: state.settings.globalCooldownMs,
      perUserCooldownMs: state.settings.perUserCooldownMs,
      maxQueue: state.settings.maxQueue,
      maxChars: state.settings.maxChars,
      maxWords: state.settings.maxWords,
      historySize: state.settings.historySize,

      ttsEngine: state.settings.ttsEngine,
      ttsRate: state.settings.ttsRate,
      ttsVoice: state.settings.ttsVoice,

      piperModelPath: state.settings.piper?.modelPath ?? "",
      piperLengthScale: state.settings.piper?.lengthScale ?? 1.0,
      piperVolume: state.settings.piper?.volume ?? 1.0,
      piperPythonCmd: state.settings.piper?.pythonCmd ?? DEFAULT_PIPER_PYTHON_CMD,

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

      autoBanEnabled: state.settings.autoBan?.enabled ?? true,
      autoBanStrikeThreshold: state.settings.autoBan?.strikeThreshold ?? 2,
      autoBanBanMinutes: state.settings.autoBan?.banMinutes ?? 30,

      runtime: refs.getRuntimeSnapshot()
    };
  }

  async function persistSettingsSnapshot(snapshot, meta = {}, options = {}) {
    try {
      await persistence.writeJsonAtomic(paths.SETTINGS_PATH, snapshot, options);
      return snapshot;
    } catch (err) {
      persistence.reportPersistenceIssue("settings_persist_failed", paths.SETTINGS_PATH, err, meta);
      throw err;
    }
  }

  async function applySettingsUpdate(update) {
    if (!update || typeof update !== "object") return { ok: false, error: "invalid" };

    return persistence.withResourceLock(paths.SETTINGS_PATH, async () => {
      const validation = await validateSettingsUpdateInput(update);
      if (!validation.ok) {
        return {
          ok: false,
          error: "validation_failed",
          errors: validation.errors,
          warnings: validation.warnings,
          termuxValidation: validation.termuxValidation
        };
      }

      const prevSettings = {
        tiktokUsername: state.settings.tiktokUsername,
        bindHost: state.settings.bindHost,
        port: state.settings.port,
        adminToken: state.settings.adminToken
      };

      const next = {
        ...state.settings,
        autoBan: { ...state.settings.autoBan },
        piper: { ...state.settings.piper },
        termux: { ...state.settings.termux }
      };

      if ("tiktokUsername" in validation.normalized) next.tiktokUsername = validation.normalized.tiktokUsername;
      if ("bindHost" in validation.normalized) next.bindHost = validation.normalized.bindHost;
      if ("port" in validation.normalized) next.port = validation.normalized.port;
      if ("adminToken" in validation.normalized) next.adminToken = validation.normalized.adminToken;
      if ("globalCooldownMs" in validation.normalized) next.globalCooldownMs = validation.normalized.globalCooldownMs;
      if ("perUserCooldownMs" in validation.normalized) next.perUserCooldownMs = validation.normalized.perUserCooldownMs;
      if ("maxQueue" in validation.normalized) next.maxQueue = validation.normalized.maxQueue;
      if ("maxChars" in validation.normalized) next.maxChars = validation.normalized.maxChars;
      if ("maxWords" in validation.normalized) next.maxWords = validation.normalized.maxWords;
      if ("historySize" in validation.normalized) next.historySize = validation.normalized.historySize;
      if ("ttsEngine" in validation.normalized) next.ttsEngine = validation.normalized.ttsEngine;
      if ("ttsRate" in validation.normalized) next.ttsRate = validation.normalized.ttsRate;
      if ("ttsVoice" in validation.normalized) next.ttsVoice = validation.normalized.ttsVoice;
      if ("piperModelPath" in validation.normalized) next.piper.modelPath = validation.normalized.piperModelPath;
      if ("piperLengthScale" in validation.normalized) next.piper.lengthScale = validation.normalized.piperLengthScale;
      if ("piperVolume" in validation.normalized) next.piper.volume = validation.normalized.piperVolume;
      if ("piperPythonCmd" in validation.normalized) next.piper.pythonCmd = validation.normalized.piperPythonCmd;
      if ("autoBanEnabled" in validation.normalized) next.autoBan.enabled = validation.normalized.autoBanEnabled;
      if ("autoBanStrikeThreshold" in validation.normalized) next.autoBan.strikeThreshold = validation.normalized.autoBanStrikeThreshold;
      if ("autoBanBanMinutes" in validation.normalized) next.autoBan.banMinutes = validation.normalized.autoBanBanMinutes;

      const hasTermuxUpdate = !!validation.termuxValidation && !!validation.normalized.termux;
      const termuxPersistScope = validation.normalized.termuxPersistScope || null;
      if (hasTermuxUpdate && termuxPersistScope === "global") {
        next.termux = refs.tts.normalizeTermux(validation.normalized.termux, DEFAULT_SETTINGS.termux);
      } else {
        next.termux = refs.tts.normalizeTermux(next.termux, DEFAULT_SETTINGS.termux);
      }

      await persistSettingsSnapshot(next, { reason: "settings_update" }, { skipQueue: true });
      state.settings = next;

      if (hasTermuxUpdate) {
        if (termuxPersistScope === "session") {
          state.sessionTermuxOverrides = { ...validation.normalized.termux };
        } else {
          state.sessionTermuxOverrides = {};
        }
      }

      while (state.queue.length > state.settings.maxQueue) {
        const removed = state.queue.pop();
        pushLog({ type: "queue_drop", reason: "queue_resize", msg: removed });
      }
      while (state.recentHistory.length > (state.settings.historySize ?? 25)) {
        state.recentHistory.shift();
      }

      const settingsSnapshot = getSettingsSnapshot();
      const termuxConfig = refs.tts.getTermuxConfigSnapshot();
      const runtimeFieldsChanged = [];
      if (prevSettings.tiktokUsername !== state.settings.tiktokUsername) runtimeFieldsChanged.push("tiktokUsername");
      if (prevSettings.bindHost !== state.settings.bindHost) runtimeFieldsChanged.push("bindHost");
      if (prevSettings.port !== state.settings.port) runtimeFieldsChanged.push("port");
      if ((prevSettings.adminToken || "") !== (state.settings.adminToken || "")) runtimeFieldsChanged.push("adminToken");

      safeEmit("settings", settingsSnapshot);
      safeEmit("queue", refs.tts.getQueueSnapshot());
      safeEmit("historyBulk", refs.moderation.getHistorySnapshot());
      safeEmit("status", refs.tts.getStatusSnapshot());

      if (runtimeFieldsChanged.length > 0) {
        pushLog({
          type: "config_runtime_updated",
          fields: runtimeFieldsChanged,
          tiktokUsername: state.settings.tiktokUsername,
          bindHost: state.settings.bindHost,
          port: state.settings.port,
          restartRequired: settingsSnapshot.restartRequired,
          activeBindHost: settingsSnapshot.activeBindHost,
          activePort: settingsSnapshot.activePort,
          adminTokenConfigured: settingsSnapshot.adminTokenConfigured
        });
      }

      if (state.settings.ttsEngine === "termux" && !runtimeCaps.hasTermuxTts) {
        pushLog({ type: "config_warning", warning: "termux_tts_missing" });
      }

      return {
        ok: true,
        settings: settingsSnapshot,
        restartRequired: settingsSnapshot.restartRequired,
        restartFields: settingsSnapshot.restartFields,
        termuxValidation: validation.termuxValidation,
        termuxConfig,
        audioBehavior: refs.tts.describeTermuxAudioBehavior(termuxConfig.effective)
      };
    });
  }

  return {
    validateAdminAccessToken,
    buildAdminAuthError,
    requireAdmin,
    getRuntimeBindingInfo,
    getSettingsSnapshot,
    applySettingsUpdate,
    validateRuntimeSettingsInput,
    validateSettingsUpdateInput,
    isAdminAuthRequired
  };
}
