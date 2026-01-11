const socket = io();

const statusEl = document.getElementById("status");
const liveStatus = document.getElementById("liveStatus");
const queueBody = document.getElementById("queueBody");
const bansBody = document.getElementById("bansBody");
const logEl = document.getElementById("log");

const ttsToggle = document.getElementById("ttsToggle");
const clearQueue = document.getElementById("clearQueue");
const connectTikTok = document.getElementById("connectTikTok");
const disconnectTikTok = document.getElementById("disconnectTikTok");
const tiktokInfo = document.getElementById("tiktokInfo");
const tiktokError = document.getElementById("tiktokError");

const exactTxt = document.getElementById("exactTxt");
const subTxt = document.getElementById("subTxt");
const saveLists = document.getElementById("saveLists");

const banUser = document.getElementById("banUser");
const banMinutes = document.getElementById("banMinutes");
const banReason = document.getElementById("banReason");
const banBtn = document.getElementById("banBtn");

let ttsEnabled = true;

function fmtUntil(ms) {
  if (!ms || ms === 0) return "inf";
  const d = new Date(ms);
  return d.toLocaleString();
}

function addLogLine(obj) {
  const line = JSON.stringify(obj);
  const div = document.createElement("div");
  div.textContent = line;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
}

socket.on("status", (s) => {
  ttsEnabled = !!s.ttsEnabled;
  statusEl.textContent = `TTS: ${ttsEnabled ? "ON" : "OFF"} | cola: ${s.queueSize}`;
});

function renderTikTokStatus(s) {
  if (!s) return;
  const statusMap = {
    idle: "idle",
    connecting: "conectando",
    connected: "conectado",
    error: "error"
  };
  const statusLabel = statusMap[s.status] || s.status || "idle";
  const liveLabel = s.live ? "ON LIVE" : "offline";
  liveStatus.textContent = `TikTok: ${liveLabel}`;
  tiktokInfo.textContent = `Estado: ${statusLabel}${s.roomId ? ` | roomId: ${s.roomId}` : ""}`;
  tiktokError.textContent = s.lastError ? `Error: ${s.lastError}` : "";
}

socket.on("queue", (q) => {
  queueBody.innerHTML = "";
  (q.items || []).forEach(m => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${m.id}</td>
      <td>@${m.uniqueId}</td>
      <td>${m.text}</td>
      <td>
        <button class="btn danger" data-ban="${m.uniqueId}">Ban</button>
      </td>
    `;
    queueBody.appendChild(tr);
  });

  queueBody.querySelectorAll("button[data-ban]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const uid = btn.getAttribute("data-ban");
      await fetch("/api/ban", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uniqueId: uid, minutes: 60, reason: "manual (desde cola)" })
      });
    });
  });
});

socket.on("bansUpdated", (db) => {
  bansBody.innerHTML = "";
  const users = db.users || {};
  Object.keys(users).sort().forEach(uid => {
    const e = users[uid];
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>@${uid}</td>
      <td>${e.reason || ""}</td>
      <td>${fmtUntil(e.untilMs)}</td>
      <td><button class="btn" data-unban="${uid}">Unban</button></td>
    `;
    bansBody.appendChild(tr);
  });

  bansBody.querySelectorAll("button[data-unban]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const uid = btn.getAttribute("data-unban");
      await fetch("/api/unban", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uniqueId: uid })
      });
    });
  });
});

socket.on("listsUpdated", () => {
  // opcional: podrías refrescar UI
});

socket.on("tiktokStatus", (s) => {
  renderTikTokStatus(s);
});

socket.on("logBulk", (items) => {
  logEl.innerHTML = "";
  (items || []).forEach(addLogLine);
});

socket.on("log", (evt) => addLogLine(evt));

// botones
ttsToggle.addEventListener("click", async () => {
  await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: !ttsEnabled })
  });
});

clearQueue.addEventListener("click", async () => {
  await fetch("/api/queue/clear", { method: "POST" });
});

connectTikTok.addEventListener("click", async () => {
  const r = await fetch("/api/tiktok/connect", { method: "POST" });
  const j = await r.json();
  renderTikTokStatus(j.status);
});

disconnectTikTok.addEventListener("click", async () => {
  const r = await fetch("/api/tiktok/disconnect", { method: "POST" });
  const j = await r.json();
  renderTikTokStatus(j.status);
});

banBtn.addEventListener("click", async () => {
  const uid = (banUser.value || "").trim().replace(/^@/, "");
  if (!uid) return;
  await fetch("/api/ban", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      uniqueId: uid,
      minutes: Number(banMinutes.value || 30),
      reason: banReason.value || "manual"
    })
  });
});

// cargar listas para edición
async function loadLists() {
  const r = await fetch("/api/lists");
  const j = await r.json();
  exactTxt.value = (j.exact || []).join("\n");
  subTxt.value = (j.sub || []).join("\n");
}
async function loadTikTokStatus() {
  const r = await fetch("/api/tiktok/status");
  const j = await r.json();
  renderTikTokStatus(j);
}
saveLists.addEventListener("click", async () => {
  await fetch("/api/lists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ exact: exactTxt.value, sub: subTxt.value })
  });
});
loadLists();
loadTikTokStatus();
