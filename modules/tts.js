export function createTtsModule({
  fs,
  path,
  os,
  execFile,
  spawn,
  state,
  settingsRef,
  refs,
  runtimeCaps,
  runtimeSnapshot,
  defaults,
  constants,
  helpers,
  persistence,
  paths,
  safeEmit,
  pushLog
}) {
  const {
    SUPPORTED_TTS_ENGINES,
    TERMUX_STREAMS,
    OUTPUT_MODES,
    COEXISTENCE_MODES,
    MIN_TTS_RATE,
    MAX_TTS_RATE,
    MIN_TTS_PITCH,
    MAX_TTS_PITCH,
    MAX_TERMUX_TEXT_LEN,
    TTS_TEST_MAX_LEN,
    TERMUX_DEFAULT_STREAM,
    TTS_CMD_TIMEOUT_MS
  } = constants;
  const { DEFAULT_SETTINGS, DEFAULT_PIPER_PYTHON_CMD } = defaults;
  const {
    clampNumber,
    normalizeTermuxConfig,
    resolveTermuxStream,
    getSafeError,
    validateTextForSpeech,
    extractTermuxConfigInput,
    validateEnumField,
    getPersistScope
  } = helpers;

  let sayApi = null;
  let sayLoadError = null;
  let queueWorkerRunning = false;
  let speechLockDepth = 0;
  let directTtsInProgress = false;
  let speechSerial = Promise.resolve();

  function getSettings() {
    return settingsRef();
  }

  function getStatusSnapshot() {
    const settings = getSettings();
    const isSpeaking = state.speaking || directTtsInProgress || speechLockDepth > 0;
    return {
      ttsEnabled: state.ttsEnabled,
      speaking: isSpeaking,
      queueSize: state.queue.length,
      ttsEngine: settings.ttsEngine
    };
  }

  function getQueueSnapshot() {
    return {
      ttsEnabled: state.ttsEnabled,
      speaking: state.speaking,
      size: state.queue.length,
      items: state.queue.slice(0, 20)
    };
  }

  function getPersistedTermuxConfig() {
    return normalizeTermuxConfig(state.settings.termux, DEFAULT_SETTINGS.termux, {
      termuxStreams: TERMUX_STREAMS,
      outputModes: OUTPUT_MODES,
      coexistenceModes: COEXISTENCE_MODES,
      termuxDefaultStream: TERMUX_DEFAULT_STREAM,
      minPitch: MIN_TTS_PITCH,
      maxPitch: MAX_TTS_PITCH,
      minRate: MIN_TTS_RATE,
      maxRate: MAX_TTS_RATE,
      clampNumberFn: clampNumber
    });
  }

  function normalizeTermux(raw, fallback) {
    return normalizeTermuxConfig(raw, fallback, {
      termuxStreams: TERMUX_STREAMS,
      outputModes: OUTPUT_MODES,
      coexistenceModes: COEXISTENCE_MODES,
      termuxDefaultStream: TERMUX_DEFAULT_STREAM,
      minPitch: MIN_TTS_PITCH,
      maxPitch: MAX_TTS_PITCH,
      minRate: MIN_TTS_RATE,
      maxRate: MAX_TTS_RATE,
      clampNumberFn: clampNumber
    });
  }

  function resolveStream(config) {
    return resolveTermuxStream(config, {
      outputModes: OUTPUT_MODES,
      coexistenceModes: COEXISTENCE_MODES,
      termuxDefaultStream: TERMUX_DEFAULT_STREAM,
      termuxStreams: TERMUX_STREAMS
    });
  }

  function getEffectiveTermuxConfig(overrides = null) {
    const persisted = getPersistedTermuxConfig();
    const session = normalizeTermux(state.sessionTermuxOverrides, persisted);

    if (!overrides || typeof overrides !== "object") {
      return session;
    }

    return normalizeTermux(extractTermuxConfigInput(overrides), session);
  }

  function getResolvedTermuxSpeakConfig(overrides = null) {
    const merged = getEffectiveTermuxConfig(overrides);
    return {
      ...merged,
      effectiveStream: resolveStream(merged)
    };
  }

  function getTermuxConfigSnapshot() {
    const defaultsSnapshot = normalizeTermux(DEFAULT_SETTINGS.termux, DEFAULT_SETTINGS.termux);
    const persisted = getPersistedTermuxConfig();
    const session = normalizeTermux(state.sessionTermuxOverrides, persisted);
    const effective = getResolvedTermuxSpeakConfig();

    return {
      defaults: defaultsSnapshot,
      persisted,
      session,
      effective,
      persistScope: Object.keys(state.sessionTermuxOverrides || {}).length > 0 ? "session" : "global"
    };
  }

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
      if (!runtimeCaps.hasPowerShell) {
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
        const voices = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        resolve({ voices, source: "win32" });
      });
    });
  }

  async function runProcess(cmd, args = [], inputText = null, options = {}) {
    const timeoutMs = Number(options.timeoutMs || 0);
    const onSpawn = typeof options.onSpawn === "function" ? options.onSpawn : null;

    return new Promise((resolve, reject) => {
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
        try { proc.stdin.write(inputText); } catch {}
        try { proc.stdin.end(); } catch {}
      } else if (proc.stdin) {
        try { proc.stdin.end(); } catch {}
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
    if (!runtimeCaps.hasTermuxTtsEngines) {
      return { voices: [], error: "termux_tts_engines_missing", source: "termux" };
    }

    try {
      const { stdout } = await runProcess("termux-tts-engines", [], null, { timeoutMs: 7000 });
      const parsed = JSON.parse(stdout || "[]");
      const engines = Array.isArray(parsed)
        ? parsed.map((entry) => String(entry?.name || "").trim()).filter(Boolean)
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
    if (getSettings().ttsEngine === "termux") {
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

    if (runtimeCaps.hasTermuxTtsEngines) {
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

  async function validateTermuxConfig(rawConfig = {}, options = {}) {
    const input = extractTermuxConfigInput(rawConfig);
    const base = options.baseConfig && typeof options.baseConfig === "object"
      ? normalizeTermux(options.baseConfig, DEFAULT_SETTINGS.termux)
      : getEffectiveTermuxConfig();

    const normalized = normalizeTermux(input, base);
    const errors = [];
    const warnings = [];

    if (Object.prototype.hasOwnProperty.call(input, "pitch")) {
      const value = Number(input.pitch);
      if (!Number.isFinite(value) || value < MIN_TTS_PITCH || value > MAX_TTS_PITCH) {
        errors.push({ field: "pitch", message: `fuera_de_rango_${MIN_TTS_PITCH}_${MAX_TTS_PITCH}` });
      }
    }

    if (Object.prototype.hasOwnProperty.call(input, "rate")) {
      const value = Number(input.rate);
      if (!Number.isFinite(value) || value < MIN_TTS_RATE || value > MAX_TTS_RATE) {
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

    if (!runtimeCaps.hasTermuxTts) {
      warnings.push({
        field: "runtime",
        message: "termux-tts-speak no detectado; la configuracion quedara guardada pero no se podra ejecutar en este runtime."
      });
    }

    let enginesDetected = [];
    let probeError = "";

    if (runtimeCaps.hasTermuxTtsEngines) {
      const probe = await getInstalledTermuxEngines();
      enginesDetected = Array.isArray(probe.voices) ? probe.voices : [];
      probeError = probe.error ? String(probe.error) : "";

      if (normalized.engine && enginesDetected.length > 0 && !enginesDetected.includes(normalized.engine)) {
        warnings.push({ field: "engine", message: `engine_no_detectado: ${normalized.engine}` });
      }

      if (probeError) {
        warnings.push({ field: "engine", message: "no_fue_posible_validar_engines_con_termux-tts-engines" });
      }
    } else {
      warnings.push({ field: "engine", message: "termux-tts-engines no disponible; validacion de soporte real limitada." });
    }

    warnings.push({
      field: "language",
      message: "Termux no expone una API estable para verificar soporte language/region/variant por engine en tiempo real; se aplica validacion defensiva."
    });

    if (normalized.outputMode === "media" && normalized.stream !== "MUSIC") {
      warnings.push({ field: "stream", message: "outputMode=media prioriza stream MUSIC durante la reproduccion." });
    }

    return {
      ok: errors.length === 0,
      normalized,
      errors,
      warnings,
      capabilities: {
        hasTermuxTts: runtimeCaps.hasTermuxTts,
        hasTermuxTtsEngines: runtimeCaps.hasTermuxTtsEngines,
        enginesDetected,
        probeError
      }
    };
  }

  function buildTermuxSpeakArgs(termuxOverrides = null) {
    const config = getResolvedTermuxSpeakConfig(termuxOverrides);
    const args = [];

    if (config.engine) args.push("-e", config.engine);
    if (config.language) args.push("-l", config.language);
    if (config.region) args.push("-n", config.region);
    if (config.variant) args.push("-v", config.variant);

    args.push("-p", String(config.pitch));
    args.push("-r", String(config.rate));
    args.push("-s", config.effectiveStream);

    return { args, config };
  }

  async function speakWithTermux(text, options = {}) {
    if (!runtimeCaps.hasTermuxTts) {
      throw new Error("termux_tts_missing");
    }

    const cleanText = validateTextForSpeech(text, MAX_TERMUX_TEXT_LEN, helpers.normalizeForTts);
    if (!cleanText) return;

    const { args } = buildTermuxSpeakArgs(options.termuxOverrides || null);
    await runProcess("termux-tts-speak", args, `${cleanText}\n`, {
      timeoutMs: TTS_CMD_TIMEOUT_MS,
      onSpawn: options.onSpawn
    });
  }

  function normalizePiperModelPath(rawPath) {
    const raw = String(rawPath || "").trim();
    if (!raw) return "";

    if (process.platform !== "win32" && /^[A-Za-z]:[\/]/.test(raw)) {
      return "";
    }

    const normalized = raw.replace(/[\\/]/g, path.sep);
    return path.isAbsolute(normalized) ? normalized : path.resolve(paths.ROOT_DIR, normalized);
  }

  async function speakWithPiper(text, options = {}) {
    const ttsText = validateTextForSpeech(text, MAX_TERMUX_TEXT_LEN, helpers.normalizeForTts);
    if (!ttsText) return;

    const modelPath = normalizePiperModelPath(options?.modelPath || "");
    if (!modelPath) throw new Error("piper_model_missing");
    if (!(await persistence.pathExists(modelPath))) throw new Error(`piper_model_not_found: ${modelPath}`);

    const lengthScale = clampNumber(options?.lengthScale, 0.5, 2.5, 1.0);
    const volume = clampNumber(options?.volume, 0.0, 2.0, 1.0);
    const pythonCmd = String(options?.pythonCmd || DEFAULT_PIPER_PYTHON_CMD).trim() || DEFAULT_PIPER_PYTHON_CMD;

    const wavPath = path.join(os.tmpdir(), `piper-${Date.now()}-${Math.random().toString(16).slice(2)}.wav`);

    await runProcess(
      pythonCmd,
      [
        "-m", "piper",
        "-m", modelPath,
        "--output_file", wavPath,
        "--length_scale", String(lengthScale),
        "--volume", String(volume)
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
      } else if (runtimeCaps.hasAplay) {
        await runProcess("aplay", ["-q", wavPath], null, { timeoutMs: 120000, onSpawn: options.onSpawn });
      } else if (runtimeCaps.hasPaplay) {
        await runProcess("paplay", [wavPath], null, { timeoutMs: 120000, onSpawn: options.onSpawn });
      } else if (runtimeCaps.hasTermuxMediaPlayer) {
        await runProcess("termux-media-player", ["play", wavPath], null, { timeoutMs: 8000, onSpawn: options.onSpawn });
        await new Promise((resolve) => setTimeout(resolve, Math.min(10000, Math.max(1200, ttsText.length * 65))));
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
      : (getSettings().ttsVoice || null);
    const rate = clampNumber(
      Object.prototype.hasOwnProperty.call(options, "rate") ? options.rate : getSettings().ttsRate,
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

  function getRecommendedEngine() {
    if (runtimeCaps.hasTermuxTts) return "termux";
    if (runtimeCaps.platform === "win32" || runtimeCaps.platform === "darwin" || runtimeCaps.platform === "linux") {
      return "say";
    }
    return "piper";
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
    if (engine === "termux") return runtimeCaps.hasTermuxTts;
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
      const piperOptions = options.piperOptions || getSettings().piper;
      await speakWithPiper(text, piperOptions);
      return;
    }

    await speakWithSay(text, options.sayOptions || {});
  }

  async function speakMessage(text, options = {}) {
    const ttsText = validateTextForSpeech(text, MAX_TERMUX_TEXT_LEN, helpers.normalizeForTts);
    if (!ttsText) return;

    const preferredCandidate = String(options.preferredEngine || getSettings().ttsEngine || "").trim();
    const preferred = SUPPORTED_TTS_ENGINES.has(preferredCandidate) ? preferredCandidate : getRecommendedEngine();
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

  function isTtsBusy() {
    return queueWorkerRunning || speechLockDepth > 0 || directTtsInProgress || state.queue.length > 0;
  }

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

  async function queueWorkerLoop() {
    queueWorkerRunning = true;
    state.speaking = true;
    safeEmit("status", getStatusSnapshot());

    try {
      while (state.ttsEnabled) {
        const message = state.queue.shift();
        safeEmit("queue", getQueueSnapshot());

        if (!message) break;

        pushLog({ type: "tts_speak", id: message.id, source: message.source || "queue", uid: message.uniqueId });

        try {
          await enqueueSpeechTask(() => speakMessage(message.text, {
            termuxOverrides: message.termuxOverrides || null,
            preferredEngine: message.ttsEngineOverride || null
          }));
        } catch (err) {
          pushLog({ type: "tts_error", error: getSafeError(err), id: message.id });
        }

        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    } finally {
      state.speaking = false;
      queueWorkerRunning = false;
      safeEmit("status", getStatusSnapshot());
    }
  }

  function startQueueWorker() {
    if (!state.ttsEnabled) return;
    if (queueWorkerRunning) return;
    if (state.queue.length === 0) return;
    queueWorkerLoop().catch((err) => {
      pushLog({ type: "worker_error", error: getSafeError(err) });
    });
  }

  function enqueueMessage(message) {
    if (state.queue.length >= getSettings().maxQueue) {
      pushLog({ type: "queue_drop", reason: "queue_full", msg: message });
      return false;
    }

    state.queue.push(message);
    safeEmit("queue", getQueueSnapshot());
    startQueueWorker();
    return true;
  }

  function skipQueueMessage(id) {
    const index = state.queue.findIndex((message) => message.id === id);
    if (index === -1) return false;
    const [removed] = state.queue.splice(index, 1);
    safeEmit("queue", getQueueSnapshot());
    pushLog({ type: "queue_skip", msg: removed });
    return true;
  }

  async function applyTermuxConfig(normalizedConfig, persistScope = "global") {
    const safeConfig = normalizeTermux(normalizedConfig, getPersistedTermuxConfig());

    if (persistScope === "session") {
      state.sessionTermuxOverrides = { ...safeConfig };
      safeEmit("settings", refs.getSettingsSnapshot());
      return getTermuxConfigSnapshot();
    }

    return persistence.withResourceLock(paths.SETTINGS_PATH, async () => {
      const nextSettings = {
        ...state.settings,
        termux: normalizeTermux(safeConfig, DEFAULT_SETTINGS.termux)
      };

      try {
        await persistence.writeJsonAtomic(paths.SETTINGS_PATH, nextSettings, { skipQueue: true });
      } catch (err) {
        persistence.reportPersistenceIssue("settings_persist_failed", paths.SETTINGS_PATH, err, { reason: "termux_config_update" });
        throw err;
      }

      state.settings = nextSettings;
      state.sessionTermuxOverrides = {};

      safeEmit("settings", refs.getSettingsSnapshot());
      return getTermuxConfigSnapshot();
    });
  }

  function describeTermuxAudioBehavior(termuxConfig) {
    const config = normalizeTermux(termuxConfig, DEFAULT_SETTINGS.termux);
    const effectiveStream = resolveStream(config);
    const notes = [];

    if (config.outputMode === "media") {
      notes.push("Se prioriza stream MUSIC para salida multimedia (no depende del canal de notificaciones).");
    }

    if (config.coexistenceMode === "duck") {
      notes.push("Sin capa nativa Android en este repo: se hace best-effort con stream de audio, no control total de AudioFocus.");
    }

    if (config.coexistenceMode === "pause") {
      notes.push("Modo pause es declarativo en arquitectura Termux/Web; pausar otras apps requiere integracion nativa Android.");
    }

    if (!runtimeCaps.isTermux || !runtimeCaps.hasTermuxTts) {
      notes.push("Runtime actual sin termux-tts-speak; configuracion aplicable pero no ejecutable aqui.");
    }

    return {
      outputMode: config.outputMode,
      coexistenceMode: config.coexistenceMode,
      effectiveStream,
      notes
    };
  }

  function setTtsEnabled(enabled) {
    state.ttsEnabled = !!enabled;
    safeEmit("status", getStatusSnapshot());
    if (state.ttsEnabled) startQueueWorker();
    return state.ttsEnabled;
  }

  async function runTtsTest(body = {}) {
    const text = validateTextForSpeech(body?.text, TTS_TEST_MAX_LEN, helpers.normalizeForTts);
    const enqueueIfBusy = !!body?.enqueueIfBusy;

    if (!text) {
      return { status: 400, body: { ok: false, error: "text_requerido" } };
    }

    const validation = await validateTermuxConfig(body || {}, { baseConfig: getEffectiveTermuxConfig() });
    if (!validation.ok) {
      return { status: 400, body: { ok: false, errors: validation.errors, warnings: validation.warnings } };
    }

    if (isTtsBusy()) {
      if (!enqueueIfBusy) {
        return { status: 409, body: { ok: false, error: "tts_busy", queueSize: state.queue.length } };
      }

      const queued = enqueueMessage({
        id: state.nextMsgId++,
        uniqueId: "local",
        nickname: "tts-test",
        text,
        ts: Date.now(),
        source: "local-test",
        termuxOverrides: validation.normalized,
        ttsEngineOverride: "termux"
      });

      if (!queued) {
        return { status: 409, body: { ok: false, error: "queue_full" } };
      }

      return { status: 200, body: { ok: true, queued: true, queueSize: state.queue.length } };
    }

    directTtsInProgress = true;
    safeEmit("status", getStatusSnapshot());

    try {
      await enqueueSpeechTask(() => speakMessage(text, {
        preferredEngine: "termux",
        strictEngine: true,
        termuxOverrides: validation.normalized
      }));

      return {
        status: 200,
        body: {
          ok: true,
          played: true,
          effective: getResolvedTermuxSpeakConfig(validation.normalized),
          warnings: validation.warnings,
          audioBehavior: describeTermuxAudioBehavior(validation.normalized)
        }
      };
    } catch (err) {
      return { status: 500, body: { ok: false, error: getSafeError(err), warnings: validation.warnings } };
    } finally {
      directTtsInProgress = false;
      safeEmit("status", getStatusSnapshot());
    }
  }

  return {
    getStatusSnapshot,
    getQueueSnapshot,
    getPersistedTermuxConfig,
    normalizeTermux,
    getEffectiveTermuxConfig,
    getResolvedTermuxSpeakConfig,
    getTermuxConfigSnapshot,
    getInstalledVoices,
    validateTermuxConfig,
    applyTermuxConfig,
    describeTermuxAudioBehavior,
    enqueueMessage,
    skipQueueMessage,
    startQueueWorker,
    isTtsBusy,
    enqueueSpeechTask,
    speakMessage,
    setTtsEnabled,
    runTtsTest,
    getPersistScope: (raw) => getPersistScope(raw, constants.PERSIST_SCOPES)
  };
}
