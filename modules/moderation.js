export function createModerationModule({
  fs,
  state,
  settingsRef,
  paths,
  persistence,
  safeEmit,
  nowMs,
  debounce,
  stripDiacritics,
  normalizeForModeration,
  tokenize
}) {
  const RE_URL = /(https?:\/\/|www\.|\.com|\.net|\.gg|\.ru|\.mx|\.xyz)/i;
  const RE_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
  const RE_PHONE = /\b\d{10}\b/;
  const RE_MENTION = /@\w+/u;
  const RE_SPAM_REPEAT = /(.)\1{4,}/u;
  const RE_PUNCT_SPAM = /[!?¿¡]{4,}/u;
  const RE_ALLOWED = /^[\p{Script=Latin}\p{N}\s.,!?¿¡'":;()\-+]{1,200}$/u;
  const RE_DISALLOWED = /[^\p{Script=Latin}\p{N}\s.,!?¿¡'":;()\-+]+/gu;

  const BANNED_SPACED = new Set([
    "puta", "puto", "verga", "mierda", "pendejo", "pendeja",
    "chingada", "chingar", "cabron", "culero", "pinche",
    "mamada", "mamon", "ojete", "imbecil", "estupido",
    "hdp", "ptm", "alv", "vtlv"
  ]);

  function getSettings() {
    return settingsRef();
  }

  function getHistorySnapshot() {
    const settings = getSettings();
    const limit = settings.historySize ?? 25;
    return { size: state.recentHistory.length, items: state.recentHistory.slice(-limit) };
  }

  function getBansSnapshot() {
    return state.bannedDb;
  }

  function getListsSnapshot() {
    return {
      badwordsExact: Array.from(state.bannedExact.values()).slice(0, 200),
      badwordsSub: state.bannedSub.slice(0, 200)
    };
  }

  function pushLog(evt) {
    const item = { ...evt, ts: nowMs() };
    state.recentLog.push(item);
    while (state.recentLog.length > 200) state.recentLog.shift();
    safeEmit("log", item);
  }

  function buildHistoryEntry(entry) {
    const comment = entry.comment || "";
    const normalized = normalizeForModeration(comment);
    const tokens = tokenize(normalized);
    return {
      id: state.nextHistoryId++,
      ts: nowMs(),
      uniqueId: entry.uniqueId,
      nickname: entry.nickname,
      comment,
      source: entry.source || "tiktok",
      status: entry.status,
      reason: entry.reason || "",
      tokens
    };
  }

  function pushHistory(entry) {
    const item = buildHistoryEntry(entry);
    state.recentHistory.push(item);
    while (state.recentHistory.length > (getSettings().historySize ?? 25)) {
      state.recentHistory.shift();
    }
    safeEmit("history", item);
  }

  async function reloadExactFromDisk() {
    const lines = await persistence.readLinesSafe(paths.BAD_EXACT_PATH, [], { errorType: "badwords_exact_reload_failed" });
    state.bannedExact = new Set(lines.map((line) => line.toLowerCase()));
    safeEmit("listsUpdated", getListsSnapshot());
  }

  async function reloadSubFromDisk() {
    const lines = await persistence.readLinesSafe(paths.BAD_SUB_PATH, [], { errorType: "badwords_sub_reload_failed" });
    state.bannedSub = lines.map((line) => line.toLowerCase()).filter((line) => line.length >= 4);
    safeEmit("listsUpdated", getListsSnapshot());
  }

  async function reloadBansFromDisk() {
    state.bannedDb = await persistence.readJsonSafe(paths.BANNED_PATH, { users: {} }, { errorType: "bans_reload_failed" });
    safeEmit("bansUpdated", getBansSnapshot());
  }

  const reloadExact = debounce(() => {
    void reloadExactFromDisk();
  }, 250);

  const reloadSub = debounce(() => {
    void reloadSubFromDisk();
  }, 250);

  const reloadBans = debounce(() => {
    void reloadBansFromDisk();
  }, 250);

  function startWatchers() {
    fs.watchFile(paths.BAD_EXACT_PATH, { interval: 1500 }, reloadExact);
    fs.watchFile(paths.BAD_SUB_PATH, { interval: 1500 }, reloadSub);
    fs.watchFile(paths.BANNED_PATH, { interval: 1500 }, reloadBans);
  }

  function hasBannedExact(tokens) {
    for (const word of tokens) {
      if (state.bannedExact.has(word)) return true;
    }
    return false;
  }

  function hasBannedJoined(normalized) {
    const joined = normalized.replace(/\s+/g, "");
    for (const bad of state.bannedSub) {
      if (joined.includes(bad)) return true;
    }
    return false;
  }

  function hasBannedSpaced(tokens) {
    if (tokens.length < 3) return false;
    if (!tokens.every((token) => token.length === 1)) return false;
    return BANNED_SPACED.has(tokens.join(""));
  }

  function filterChatText(raw) {
    const settings = getSettings();
    if (!raw) return { ok: false, reason: "empty" };

    const trimmed = String(raw).trim();
    if (!trimmed) return { ok: false, reason: "empty" };

    const clipped = trimmed.slice(0, settings.maxChars);

    if (RE_URL.test(clipped)) return { ok: false, reason: "url" };
    if (RE_EMAIL.test(clipped)) return { ok: false, reason: "email" };
    if (RE_PHONE.test(clipped)) return { ok: false, reason: "phone" };
    if (RE_MENTION.test(clipped)) return { ok: false, reason: "mention" };
    if (RE_SPAM_REPEAT.test(clipped)) return { ok: false, reason: "repeat_spam" };
    if (RE_PUNCT_SPAM.test(clipped)) return { ok: false, reason: "punct_spam" };

    const cleaned = clipped.replace(RE_DISALLOWED, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return { ok: false, reason: "empty_norm" };
    if (!RE_ALLOWED.test(cleaned)) return { ok: false, reason: "chars" };

    const normalized = normalizeForModeration(cleaned);
    const tokens = tokenize(normalized);

    if (tokens.length === 0) return { ok: false, reason: "empty_norm" };
    if (tokens.length > settings.maxWords) return { ok: false, reason: "too_many_words" };

    if (hasBannedSpaced(tokens)) return { ok: false, reason: "badword_spaced" };
    if (hasBannedExact(tokens)) return { ok: false, reason: "badword_exact" };
    if (hasBannedJoined(normalized)) return { ok: false, reason: "badword_joined" };

    return { ok: true, text: cleaned };
  }

  function cloneBannedUsers(users = {}) {
    const cloned = {};
    for (const [uniqueId, entry] of Object.entries(users || {})) {
      cloned[uniqueId] = entry && typeof entry === "object" ? { ...entry } : entry;
    }
    return cloned;
  }

  async function persistBannedSnapshot(snapshot, meta = {}) {
    try {
      await persistence.writeJsonAtomic(paths.BANNED_PATH, snapshot);
      return snapshot;
    } catch (err) {
      persistence.reportPersistenceIssue("bans_persist_failed", paths.BANNED_PATH, err, meta);
      throw err;
    }
  }

  function commitBannedSnapshot(snapshot, emit = true) {
    state.bannedDb = snapshot;
    if (emit) safeEmit("bansUpdated", getBansSnapshot());
  }

  function isBanned(uniqueId) {
    const entry = state.bannedDb.users[uniqueId];
    if (!entry) return { banned: false };

    if (entry.untilMs && entry.untilMs > 0 && nowMs() > entry.untilMs) {
      const nextUsers = cloneBannedUsers(state.bannedDb.users);
      delete nextUsers[uniqueId];
      const nextDb = { ...state.bannedDb, users: nextUsers };
      commitBannedSnapshot(nextDb);
      void persistBannedSnapshot(nextDb, { reason: "ban_expired", uniqueId }).catch(() => {});
      return { banned: false };
    }

    return { banned: true, entry };
  }

  function banUser(uniqueId, reason, minutes = 30, options = {}) {
    const duration = Math.max(1, Math.min(24 * 60, Number(minutes) || 30));
    const untilMs = duration > 0 ? nowMs() + duration * 60 * 1000 : 0;
    const nextUsers = cloneBannedUsers(state.bannedDb.users);
    nextUsers[uniqueId] = { reason, addedAtMs: nowMs(), untilMs };
    const nextDb = { ...state.bannedDb, users: nextUsers };

    commitBannedSnapshot(nextDb);

    const persistPromise = persistBannedSnapshot(nextDb, { reason: "ban_user", uniqueId });
    if (options.awaitPersistence) return persistPromise;
    void persistPromise.catch(() => {});
    return Promise.resolve(nextDb);
  }

  function unbanUser(uniqueId, options = {}) {
    const nextUsers = cloneBannedUsers(state.bannedDb.users);
    delete nextUsers[uniqueId];
    const nextDb = { ...state.bannedDb, users: nextUsers };

    commitBannedSnapshot(nextDb);

    const persistPromise = persistBannedSnapshot(nextDb, { reason: "unban_user", uniqueId });
    if (options.awaitPersistence) return persistPromise;
    void persistPromise.catch(() => {});
    return Promise.resolve(nextDb);
  }

  function addStrike(uniqueId) {
    const settings = getSettings();
    const count = (state.strikes.get(uniqueId) ?? 0) + 1;
    state.strikes.set(uniqueId, count);

    if (settings.autoBan?.enabled && count >= settings.autoBan.strikeThreshold) {
      banUser(uniqueId, `Auto-ban: ${count} infracciones`, settings.autoBan.banMinutes);
      state.strikes.set(uniqueId, 0);
    }

    return count;
  }

  function canSpeakNow(uniqueId) {
    const now = nowMs();
    const settings = getSettings();

    if (now - state.lastGlobalSpeak < settings.globalCooldownMs) return false;

    const last = state.lastUserSpeak.get(uniqueId) ?? 0;
    if (now - last < settings.perUserCooldownMs) return false;

    return true;
  }

  function markSpeak(uniqueId) {
    const now = nowMs();
    state.lastGlobalSpeak = now;
    state.lastUserSpeak.set(uniqueId, now);
  }

  function sanitizeBadword(word) {
    if (!word) return "";
    const ascii = stripDiacritics(String(word).toLowerCase());
    return ascii.replace(/[^a-z0-9]+/g, "").trim();
  }

  async function replaceLists({ exact, sub }) {
    try {
      if (typeof exact === "string") {
        const exactText = exact.replace(/\r/g, "");
        await persistence.withResourceLock(paths.BAD_EXACT_PATH, async () => {
          const nextExact = persistence.parseTextLines(exactText).map((line) => line.toLowerCase());
          await persistence.writeTextAtomic(paths.BAD_EXACT_PATH, exactText, { skipQueue: true });
          state.bannedExact = new Set(nextExact);
        });
      }

      if (typeof sub === "string") {
        const subText = sub.replace(/\r/g, "");
        await persistence.withResourceLock(paths.BAD_SUB_PATH, async () => {
          const nextSub = persistence.parseTextLines(subText).map((line) => line.toLowerCase()).filter((line) => line.length >= 4);
          await persistence.writeTextAtomic(paths.BAD_SUB_PATH, subText, { skipQueue: true });
          state.bannedSub = nextSub;
        });
      }

      safeEmit("listsUpdated", getListsSnapshot());
      return { ok: true };
    } catch (err) {
      persistence.reportPersistenceIssue("lists_persist_failed", paths.DATA_DIR, err, { scope: "lists_replace" });
      throw err;
    }
  }

  async function addBadword(word, mode) {
    const cleaned = sanitizeBadword(word);
    if (!cleaned || cleaned.length < 3) {
      return { ok: false, status: 400, error: "word_invalida" };
    }

    const target = mode === "sub" ? "sub" : "exact";
    const filePath = target === "sub" ? paths.BAD_SUB_PATH : paths.BAD_EXACT_PATH;

    try {
      await persistence.withResourceLock(filePath, async () => {
        const currentLines = target === "sub"
          ? state.bannedSub.slice()
          : Array.from(state.bannedExact.values());

        if (currentLines.includes(cleaned)) return;

        const nextLines = [...currentLines, cleaned];
        await persistence.writeTextAtomic(filePath, persistence.serializeWordLines(nextLines), { skipQueue: true });

        if (target === "sub") {
          state.bannedSub = nextLines;
        } else {
          state.bannedExact = new Set(nextLines);
        }
      });

      safeEmit("listsUpdated", getListsSnapshot());
      return { ok: true, word: cleaned, mode: target };
    } catch (err) {
      persistence.reportPersistenceIssue("badword_add_persist_failed", filePath, err, { target, word: cleaned });
      throw err;
    }
  }

  return {
    getHistorySnapshot,
    getBansSnapshot,
    getListsSnapshot,
    pushLog,
    pushHistory,
    startWatchers,
    reloadExactFromDisk,
    reloadSubFromDisk,
    reloadBansFromDisk,
    filterChatText,
    isBanned,
    banUser,
    unbanUser,
    addStrike,
    canSpeakNow,
    markSpeak,
    sanitizeBadword,
    replaceLists,
    addBadword
  };
}
