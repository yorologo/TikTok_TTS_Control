export function createPersistenceModule({ fs, path, getLogger = null }) {
  const resourceQueues = new Map();

  function reportPersistenceIssue(type, filePath, err, extra = {}) {
    const error = String(err?.message || err || type).replace(/[\r\n\t]+/g, " ").trim().slice(0, 280) || type;
    const payload = { type, filePath, error, ...extra };

    try {
      const logger = typeof getLogger === "function" ? getLogger() : null;
      if (typeof logger === "function") {
        logger(payload);
      } else {
        console.error(`[${type}] ${filePath}: ${error}`);
      }
    } catch {
      console.error(`[${type}] ${filePath}: ${error}`);
    }

    return payload;
  }

  async function ensureDir(dir) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  function parseTextLines(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function serializeWordLines(lines) {
    const cleanLines = Array.isArray(lines) ? lines.filter(Boolean) : [];
    return cleanLines.length > 0 ? `${cleanLines.join("\n")}\n` : "";
  }

  async function readTextSafe(filePath, fallback = "", options = {}) {
    try {
      return (await fs.promises.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
    } catch (err) {
      if (err?.code !== "ENOENT" || options.logMissing) {
        reportPersistenceIssue(options.errorType || "file_read_failed", filePath, err, options.extra);
      }
      return fallback;
    }
  }

  async function readLinesSafe(filePath, fallback = [], options = {}) {
    const text = await readTextSafe(filePath, "", options);
    if (!text) return Array.isArray(fallback) ? [...fallback] : [];
    return parseTextLines(text);
  }

  async function readJsonSafe(filePath, fallback, options = {}) {
    const text = await readTextSafe(filePath, "", options);
    if (!text) return fallback;

    try {
      return JSON.parse(text);
    } catch (err) {
      reportPersistenceIssue(options.parseErrorType || options.errorType || "json_parse_failed", filePath, err, options.extra);
      return fallback;
    }
  }

  function withResourceLock(resourceKey, task) {
    const previous = resourceQueues.get(resourceKey) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);

    resourceQueues.set(resourceKey, next);
    void next.finally(() => {
      if (resourceQueues.get(resourceKey) === next) {
        resourceQueues.delete(resourceKey);
      }
    });

    return next;
  }

  async function writeTextAtomic(filePath, content, options = {}) {
    const operation = async () => {
      const dir = path.dirname(filePath);
      await ensureDir(dir);

      const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
      try {
        await fs.promises.writeFile(tmp, content, "utf8");
        await fs.promises.rename(tmp, filePath);
      } catch (err) {
        await fs.promises.unlink(tmp).catch(() => {});
        throw err;
      }
    };

    if (options.skipQueue) {
      return operation();
    }

    return withResourceLock(filePath, operation);
  }

  async function writeJsonAtomic(filePath, obj, options = {}) {
    return writeTextAtomic(filePath, JSON.stringify(obj, null, 2), options);
  }

  async function ensureFileIfMissing(filePath, content) {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      await ensureDir(path.dirname(filePath));
      await fs.promises.writeFile(filePath, content, "utf8");
    }
  }

  async function pathExists(filePath) {
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  return {
    reportPersistenceIssue,
    ensureDir,
    parseTextLines,
    serializeWordLines,
    readTextSafe,
    readLinesSafe,
    readJsonSafe,
    withResourceLock,
    writeTextAtomic,
    writeJsonAtomic,
    ensureFileIfMissing,
    pathExists
  };
}
