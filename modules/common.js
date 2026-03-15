export function nowMs() {
  return Date.now();
}

export function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

export function toInt(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

export function normalizeTikTokUsername(value) {
  const raw = String(value ?? "").trim().replace(/^@+/, "");
  if (!raw) return "";
  return raw.replace(/\s+/g, "").slice(0, 64);
}

export function sanitizeBindHost(value, allowedHosts, fallback) {
  const raw = String(value ?? fallback ?? "").trim().toLowerCase();
  return allowedHosts.has(raw) ? raw : fallback;
}

export function sanitizePort(value, fallback) {
  const port = toInt(value, fallback);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return fallback;
  return port;
}

export function normalizeAdminToken(value) {
  const raw = String(value ?? "").trim();
  return raw.replace(/[\r\n\t]+/g, "").slice(0, 256);
}

export function isLoopbackBindHost(host) {
  const raw = String(host ?? "").trim().toLowerCase();
  return raw === "127.0.0.1" || raw === "localhost";
}

export function sanitizeTermuxStream(value, termuxStreams, fallback) {
  const raw = String(value || fallback || "").trim().toUpperCase();
  return termuxStreams.has(raw) ? raw : fallback;
}

export function sanitizeMode(value, allowed, fallback) {
  const raw = String(value || fallback || "").trim().toLowerCase();
  return allowed.has(raw) ? raw : fallback;
}

export function sanitizeSimpleToken(value, maxLen = 64) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, maxLen);
}

export function sanitizeLocaleToken(value, kind) {
  const token = sanitizeSimpleToken(value, 16);
  if (!token) return "";

  if (kind === "language") {
    const lower = token.toLowerCase();
    return /^[a-z]{2,3}$/.test(lower) ? lower : "";
  }

  if (kind === "region") {
    const upper = token.toUpperCase();
    return /^[A-Z]{2,3}$/.test(upper) ? upper : "";
  }

  return token;
}

export function normalizeTermuxConfig(raw = {}, fallback = {}, options = {}) {
  const {
    termuxStreams,
    outputModes,
    coexistenceModes,
    termuxDefaultStream,
    minPitch,
    maxPitch,
    minRate,
    maxRate,
    clampNumberFn = clampNumber
  } = options;
  const merged = { ...(fallback || {}), ...(raw || {}) };

  return {
    engine: sanitizeSimpleToken(merged.engine, 96),
    language: sanitizeLocaleToken(merged.language, "language"),
    region: sanitizeLocaleToken(merged.region, "region"),
    variant: sanitizeSimpleToken(merged.variant, 64),
    stream: sanitizeTermuxStream(merged.stream, termuxStreams, fallback?.stream || termuxDefaultStream),
    pitch: clampNumberFn(merged.pitch, minPitch, maxPitch, fallback?.pitch ?? 1.0),
    rate: clampNumberFn(merged.rate, minRate, maxRate, fallback?.rate ?? 1.0),
    outputMode: sanitizeMode(merged.outputMode, outputModes, fallback?.outputMode || "media"),
    coexistenceMode: sanitizeMode(merged.coexistenceMode, coexistenceModes, fallback?.coexistenceMode || "duck")
  };
}

export function resolveTermuxStream(config, options = {}) {
  const { outputModes, coexistenceModes, termuxDefaultStream, termuxStreams } = options;
  const outputMode = sanitizeMode(config?.outputMode, outputModes, "media");

  if (outputMode === "media") return "MUSIC";
  if (outputMode === "notification") return "NOTIFICATION";

  const fallback = sanitizeMode(config?.coexistenceMode, coexistenceModes, "duck") === "pause"
    ? "NOTIFICATION"
    : termuxDefaultStream;

  return sanitizeTermuxStream(config?.stream, termuxStreams, fallback);
}

export function getSafeError(err, fallback = "unknown_error") {
  const text = String(err?.message || err || fallback).replace(/[\r\n\t]+/g, " ").trim();
  return text.slice(0, 280) || fallback;
}

export function validateTextForSpeech(rawText, maxLen, normalizeForTtsFn) {
  return normalizeForTtsFn(String(rawText || "")).slice(0, maxLen);
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function stripDiacritics(text) {
  return String(text || "").normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export function normalizeForTts(value) {
  if (!value) return "";
  let text = String(value);
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, "");
  text = stripDiacritics(text);
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

export function normalizeForModeration(value) {
  let text = String(value).toLowerCase();
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, "");
  text = stripDiacritics(text);

  text = text
    .replace(/0/g, "o")
    .replace(/[1!|]/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/8/g, "b")
    .replace(/\$/g, "s")
    .replace(/@/g, "a");

  text = text.replace(/[^\p{L}\p{N}\s]+/gu, " ");
  text = text.replace(/([a-z])\1{2,}/g, "$1$1");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

export function tokenize(normalized) {
  return String(normalized || "").split(" ").filter(Boolean);
}

export function validateEnumField(rawValue, allowed, fieldName, errors) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return;
  const value = String(rawValue).trim().toLowerCase();
  if (!allowed.has(value)) {
    errors.push({ field: fieldName, message: `valor_invalido: ${value}` });
  }
}

export function pickDefined(target, source, sourceKey, targetKey = sourceKey) {
  if (!source || typeof source !== "object") return;
  if (!Object.prototype.hasOwnProperty.call(source, sourceKey)) return;
  target[targetKey] = source[sourceKey];
}

export function extractTermuxConfigInput(payload = {}) {
  const out = {};
  const root = payload && typeof payload === "object" ? payload : {};
  const nested = root.termux && typeof root.termux === "object" ? root.termux : {};

  pickDefined(out, root, "engine");
  pickDefined(out, root, "language");
  pickDefined(out, root, "region");
  pickDefined(out, root, "variant");
  pickDefined(out, root, "stream");
  pickDefined(out, root, "pitch");
  pickDefined(out, root, "rate");
  pickDefined(out, root, "outputMode");
  pickDefined(out, root, "coexistenceMode");

  pickDefined(out, root, "termuxEngine", "engine");
  pickDefined(out, root, "termuxLanguage", "language");
  pickDefined(out, root, "termuxRegion", "region");
  pickDefined(out, root, "termuxVariant", "variant");
  pickDefined(out, root, "termuxStream", "stream");
  pickDefined(out, root, "termuxPitch", "pitch");
  pickDefined(out, root, "termuxRate", "rate");
  pickDefined(out, root, "termuxOutputMode", "outputMode");
  pickDefined(out, root, "termuxCoexistenceMode", "coexistenceMode");

  pickDefined(out, nested, "engine");
  pickDefined(out, nested, "language");
  pickDefined(out, nested, "region");
  pickDefined(out, nested, "variant");
  pickDefined(out, nested, "stream");
  pickDefined(out, nested, "pitch");
  pickDefined(out, nested, "rate");
  pickDefined(out, nested, "outputMode");
  pickDefined(out, nested, "coexistenceMode");

  return out;
}

export function getPersistScope(raw, persistScopes) {
  const scope = String(raw || "global").trim().toLowerCase();
  return persistScopes.has(scope) ? scope : "global";
}
