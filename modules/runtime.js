export function commandExistsSync(fs, path, cmd, pathValue = process.env.PATH || "") {
  if (!cmd) return false;

  const raw = String(cmd).trim();
  if (!raw) return false;

  if (raw.includes("/") || raw.includes("\\") || path.isAbsolute(raw)) {
    const candidate = path.isAbsolute(raw) ? raw : path.resolve(raw);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  for (const dir of String(pathValue || "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, raw), fs.constants.X_OK);
      return true;
    } catch {}
  }

  return false;
}

export function normalizePiperModelPath(path, rootDir, rawPath, platform = process.platform) {
  const raw = String(rawPath || "").trim();
  if (!raw) return "";

  if (platform !== "win32" && /^[A-Za-z]:[\\/]/.test(raw)) {
    return "";
  }

  const normalized = raw.replace(/[\\/]/g, path.sep);
  const baseDir = rootDir || process.cwd();
  return path.isAbsolute(normalized) ? normalized : path.resolve(baseDir, normalized);
}

export function getPreferredAudioPlayer(runtimeCaps = {}) {
  if (runtimeCaps.platform === "win32" && runtimeCaps.hasPowerShell) return "powershell";
  if (runtimeCaps.platform === "darwin" && runtimeCaps.hasAfplay) return "afplay";
  if (runtimeCaps.hasAplay) return "aplay";
  if (runtimeCaps.hasPaplay) return "paplay";
  if (runtimeCaps.hasTermuxMediaPlayer) return "termux-media-player";
  return "";
}

export function getPiperRuntimeStatus({
  fs,
  path,
  rootDir,
  settings = {},
  runtimeCaps = {},
  defaultPythonCmd = "python",
  commandExists = null
}) {
  const piperSettings = settings?.piper || {};
  const pythonCmd = String(piperSettings.pythonCmd || defaultPythonCmd || "").trim() || String(defaultPythonCmd || "python");
  const hasCommand = typeof commandExists === "function"
    ? commandExists
    : (cmd) => commandExistsSync(fs, path, cmd);

  const pythonFound = hasCommand(pythonCmd);
  const modelPath = normalizePiperModelPath(path, rootDir, piperSettings.modelPath || "", runtimeCaps.platform);
  const modelConfigured = !!String(piperSettings.modelPath || "").trim();

  let modelExists = false;
  if (modelPath) {
    try {
      fs.accessSync(modelPath, fs.constants.F_OK);
      modelExists = true;
    } catch {}
  }

  const audioPlayer = getPreferredAudioPlayer(runtimeCaps);
  const issues = [];

  if (!pythonFound) issues.push("python_not_found");
  if (!modelConfigured) issues.push("piper_model_missing");
  else if (!modelExists) issues.push("piper_model_not_found");
  if (!audioPlayer) issues.push("no_audio_player_for_piper");

  return {
    pythonCmd,
    pythonFound,
    modelPath,
    modelConfigured,
    modelExists,
    audioPlayer,
    ready: pythonFound && modelExists && !!audioPlayer,
    issues
  };
}

export function getAvailableTtsEngines({ runtimeCaps = {}, piperStatus = null } = {}) {
  const out = [];

  if (runtimeCaps.hasTermuxTts) out.push("termux");
  if (piperStatus?.ready) out.push("piper");
  if (runtimeCaps.platform !== "android") out.push("say");

  return out;
}

export function getRecommendedTtsEngine({ runtimeCaps = {}, piperStatus = null, fallbackEngine = "piper" } = {}) {
  if (runtimeCaps.hasTermuxTts) return "termux";
  if (runtimeCaps.platform === "win32" || runtimeCaps.platform === "darwin" || runtimeCaps.platform === "linux") {
    return "say";
  }
  if (piperStatus?.ready) return "piper";
  return fallbackEngine;
}

export function buildRuntimeSnapshot({
  fs,
  path,
  rootDir,
  settings = {},
  runtimeCaps = {},
  defaultPythonCmd = "python",
  commandExists = null
}) {
  const piper = getPiperRuntimeStatus({
    fs,
    path,
    rootDir,
    settings,
    runtimeCaps,
    defaultPythonCmd,
    commandExists
  });

  return {
    platform: runtimeCaps.platform,
    isTermux: !!runtimeCaps.isTermux,
    hasTermuxTts: !!runtimeCaps.hasTermuxTts,
    hasTermuxTtsEngines: !!runtimeCaps.hasTermuxTtsEngines,
    hasTermuxMediaPlayer: !!runtimeCaps.hasTermuxMediaPlayer,
    availableTtsEngines: getAvailableTtsEngines({ runtimeCaps, piperStatus: piper }),
    recommendedTtsEngine: getRecommendedTtsEngine({ runtimeCaps, piperStatus: piper }),
    piper
  };
}
