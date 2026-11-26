// =====================================================================
// PULSE P2P: LOCAL-FIRST ENCRYPTED CHAT APPLICATION
// =====================================================================
const APP_NS = "pulsep2p_v2_as_sudo";
const MQTT_BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
const DEFAULT_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
      <rect width="120" height="120" fill="#1e293b"/>
      <circle cx="60" cy="46" r="22" fill="#475569"/>
      <path d="M20 108c0-22 18-36 40-36s40 14 40 36" fill="#475569"/>
    </svg>`
  );

let db = null;
let myProfile = null;
let directory = {};
let relations = {}; // { username: { username, iLiked, likedMe, blocked } }
let onlineMap = {};
let activeChatPeer = null;
let sharedKeyCache = {};

let mqttClient = null;
let peer = null;
let peerConns = {};
let tempSetupAvatar = DEFAULT_AVATAR;

// =====================================================================
// TOP MODERN TOAST NOTIFICATION
// =====================================================================
function showToast(message, type = "info", iconClass = "fa-solid fa-bell") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.innerHTML = `<i class="${iconClass}"></i><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-10px)";
    toast.style.transition = "all 0.22s ease";
    setTimeout(() => toast.remove(), 240);
  }, 3200);
}

// =====================================================================
// INDEXEDDB LOCAL STORAGE
// =====================================================================
function openLocalDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(`${APP_NS}_db`, 2);
    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains("messages")) {
        const store = database.createObjectStore("messages", { keyPath: "id", autoIncrement: true });
        store.createIndex("peer", "peer", { unique: false });
        store.createIndex("msgId", "msgId", { unique: false });
      }
      if (!database.objectStoreNames.contains("relations")) {
        database.createObjectStore("relations", { keyPath: "username" });
      }
      if (!database.objectStoreNames.contains("directory")) {
        database.createObjectStore("directory", { keyPath: "username" });
      }
    };
    req.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

function dbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function getPeerMessages(peerUsername) {
  return new Promise((resolve) => {
    const tx = db.transaction("messages", "readonly");
    const idx = tx.objectStore("messages").index("peer");
    const req = idx.getAll(peerUsername);
    req.onsuccess = () => resolve(req.result || []);
  });
}

function markMessageReadLocal(msgId) {
  return new Promise((resolve) => {
    const tx = db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    const idx = store.index("msgId");
    const req = idx.get(msgId);
    req.onsuccess = () => {
      const rec = req.result;
      if (rec && !rec.read) {
        rec.read = true;
        store.put(rec);
      }
    };
    tx.oncomplete = () => resolve();
  });
}

function clearPeerMessages(peerUsername) {
  return new Promise((resolve) => {
    const tx = db.transaction("messages", "readwrite");
    const idx = tx.objectStore("messages").index("peer");
    const req = idx.openCursor(IDBKeyRange.only(peerUsername));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
  });
}

function isBlocked(username) {
  return Boolean(relations[username] && relations[username].blocked);
}

// =====================================================================
// IMAGE COMPRESSION
// =====================================================================
function compressImageFile(file, maxSize = 480, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxSize) {
          height = Math.round((height * maxSize) / width);
          width = maxSize;
        } else if (height >= width && height > maxSize) {
          width = Math.round((width * maxSize) / height);
          height = maxSize;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = ev.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// =====================================================================
// INIT & EVENTS
// =====================================================================
window.addEventListener("DOMContentLoaded", async () => {
  await openLocalDB();

  const savedDir = await dbGetAll("directory");
  savedDir.forEach((u) => (directory[u.username] = u));

  const savedRels = await dbGetAll("relations");
  savedRels.forEach((r) => (relations[r.username] = r));

  document.getElementById("setup-avatar-preview").src = tempSetupAvatar;

  const rawProfile = localStorage.getItem(`${APP_NS}_profile`);
  if (!rawProfile) {
    showScreen("setup-screen");
  } else {
    myProfile = JSON.parse(rawProfile);
    document.getElementById("lock-user-label").textContent =
      `${myProfile.nickname} (@${myProfile.username})`;
    showScreen("lock-screen");
  }

  bindEvents();
});

function showScreen(screenId) {
  ["setup-screen", "lock-screen", "main-app"].forEach((id) => {
    document.getElementById(id).classList.add("hidden");
  });
  document.getElementById(screenId).classList.remove("hidden");
}

function bindEvents() {
  document.getElementById("setup-avatar-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    tempSetupAvatar = await compressImageFile(file, 300, 0.75);
    document.getElementById("setup-avatar-preview").src = tempSetupAvatar;
  });

  document.getElementById("btn-create-account").addEventListener("click", handleCreateAccount);

  document.getElementById("setup-import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const obj = JSON.parse(ev.target.result);
        const pin = prompt("बैकअप फ़ाइल अनलॉक करने के लिए अपना PIN डालें:");
        if (pin) restoreFromBackup(pin, obj);
      } catch {
        showToast("अमान्य बैकअप फ़ाइल!", "error", "fa-solid fa-circle-exclamation");
      }
    };
    reader.readAsText(file);
  });

  document.getElementById("btn-unlock-app").addEventListener("click", () => {
    const pin = document.getElementById("unlock-pin-input").value.trim();
    if (pin === myProfile.pin) {
      document.getElementById("unlock-pin-input").value = "";
      document.getElementById("lock-error").textContent = "";
      launchMainApp();
    } else {
      document.getElementById("lock-error").textContent = "गलत PIN! कृपया सही PIN डालें।";
      showToast("गलत PIN डाला गया है", "error", "fa-solid fa-lock");
    }
  });

  document.getElementById("btn-quick-lock").addEventListener("click", () => {
    document.getElementById("lock-user-label").textContent =
      `${myProfile.nickname} (@${myProfile.username})`;
    showScreen("lock-screen");
    showToast("ऐप लॉक हो गया", "info", "fa-solid fa-lock");
  });

  document.getElementById("btn-manual-sync").addEventListener("click", () => {
    publishPresence();
    publishDirectoryCard();
    pruneStaleOnlineUsers();
    renderHomeTab();
    renderChatTab();
    showToast("ऑनलाइन स्टेटस रिफ्रेश हो गया", "success", "fa-solid fa-rotate");
  });

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  const searchInput = document.getElementById("home-search-input");
  const clearSearchBtn = document.getElementById("btn-clear-search");
  searchInput.addEventListener("input", () => {
    clearSearchBtn.classList.toggle("hidden", searchInput.value.trim().length === 0);
    renderHomeTab();
  });
  clearSearchBtn.addEventListener("click", () => {
    searchInput.value = "";
    clearSearchBtn.classList.add("hidden");
    renderHomeTab();
  });

  document.getElementById("profile-avatar-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    myProfile.avatar = await compressImageFile(file, 300, 0.75);
    persistMyProfile();
    renderProfileTab();
    publishDirectoryCard();
    showToast("प्रोफ़ाइल फ़ोटो अपडेट हो गई", "success", "fa-solid fa-camera");
  });

  document.getElementById("btn-save-nickname").addEventListener("click", () => {
    const newNick = document.getElementById("profile-nickname-input").value.trim();
    if (newNick.length < 2) {
      showToast("Nickname कम से कम 2 अक्षर का रखें", "error", "fa-solid fa-triangle-exclamation");
      return;
    }
    myProfile.nickname = newNick;
    persistMyProfile();
    renderProfileTab();
    renderHomeTab();
    publishDirectoryCard();
    showToast("Nickname सेव हो गया", "success", "fa-solid fa-check");
  });

  document.getElementById("btn-copy-token").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(myProfile.personalToken);
      showToast("Personal Token कॉपी हो गया", "success", "fa-solid fa-copy");
    } catch {
      showToast("Token कॉपी नहीं हो सका", "error", "fa-solid fa-circle-exclamation");
    }
  });

  document.getElementById("btn-export-backup").addEventListener("click", handleExportBackup);

  document.getElementById("profile-import-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const obj = JSON.parse(ev.target.result);
        const pin = prompt("बैकअप रीस्टोर करने के लिए PIN डालें:");
        if (pin) restoreFromBackup(pin, obj);
      } catch {
        showToast("फ़ाइल पढ़ने में समस्या आई", "error", "fa-solid fa-circle-exclamation");
      }
    };
    reader.readAsText(file);
  });

  document.getElementById("btn-back-to-chats").addEventListener("click", () => {
    activeChatPeer = null;
    document.getElementById("chat-view-screen").classList.add("hidden");
    renderChatTab();
  });

  document.getElementById("btn-block-peer").addEventListener("click", async () => {
    if (!activeChatPeer) return;
    const target = activeChatPeer;
    activeChatPeer = null;
    document.getElementById("chat-view-screen").classList.add("hidden");
    await blockUser(target);
  });

  document.getElementById("btn-clear-peer-chat").addEventListener("click", async () => {
    if (!activeChatPeer) return;
    await clearPeerMessages(activeChatPeer);
    document.getElementById("chat-messages-box").innerHTML = "";
    showToast("इस चैट की लोकल हिस्ट्री साफ़ कर दी गई", "info", "fa-solid fa-trash");
  });

  document.getElementById("chat-send-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!activeChatPeer) return;
    const input = document.getElementById("chat-text-input");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    await sendEncryptedChatPayload(activeChatPeer, { kind: "text", text });
  });

  document.getElementById("chat-photo-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !activeChatPeer) return;
    showToast("फ़ोटो एन्क्रिप्ट होकर भेजी जा रही है...", "info", "fa-solid fa-shield-halved");
    const dataUrl = await compressImageFile(file, 640, 0.7);
    await sendEncryptedChatPayload(activeChatPeer, { kind: "image", imageData: dataUrl });
  });
}

async function handleCreateAccount() {
  const errEl = document.getElementById("setup-error");
  errEl.textContent = "";

  const cleanUser = document
    .getElementById("setup-username")
    .value.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "");
  const nick = document.getElementById("setup-nickname").value.trim();
  const pin = document.getElementById("setup-pin").value.trim();

  if (cleanUser.length < 3) {
    errEl.textContent = "Username कम से कम 3 अक्षर का हो (a-z, 0-9, _)।";
    return;
  }
  if (nick.length < 2) {
    errEl.textContent = "कृपया अपना Nickname डालें।";
    return;
  }
  if (pin.length < 4) {
    errEl.textContent = "कम से कम 4 अंकों का PIN डालें।";
    return;
  }

  const existing = directory[cleanUser];
  if (existing && existing.signPublic) {
    errEl.textContent = `यह username (@${cleanUser}) पहले से किसी और के Personal Token से सुरक्षित है।`;
    showToast("यह Username पहले से बुक है!", "error", "fa-solid fa-shield-halved");
    return;
  }

  const signKeys = await CryptoEngine.generateIdentityKeys();
  const ecdhKeys = await CryptoEngine.generateEcdhKeys();
  const personalToken = await CryptoEngine.createPersonalToken(signKeys.publicJwk);

  myProfile = {
    username: cleanUser,
    nickname: nick,
    avatar: tempSetupAvatar || DEFAULT_AVATAR,
    pin,
    personalToken,
    signKeys,
    ecdhKeys
  };

  persistMyProfile();
  launchMainApp();
  showToast(`स्वागत है ${nick}! आपका Personal Token बन गया है।`, "success", "fa-solid fa-shield-check");
}

function persistMyProfile() {
  localStorage.setItem(`${APP_NS}_profile`, JSON.stringify(myProfile));
}

// =====================================================================
// BACKUP EXPORT & IMPORT
// =====================================================================
async function handleExportBackup() {
  const allMsgs = await dbGetAll("messages");
  const allRels = await dbGetAll("relations");
  const allDir = await dbGetAll("directory");

  const payload = {
    exportedAt: Date.now(),
    profile: myProfile,
    messages: allMsgs,
    relations: allRels,
    directory: allDir
  };

  const encryptedBackup = await CryptoEngine.encryptBackupWithPin(myProfile.pin, payload);
  const blob = new Blob([JSON.stringify(encryptedBackup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `pulsep2p_backup_${myProfile.username}.json`;
  a.click();
  URL.revokeObjectURL(url);

  showToast("Encrypted Backup फ़ाइल डाउनलोड हो गई", "success", "fa-solid fa-download");
}

async function restoreFromBackup(pin, backupObj) {
  try {
    const restored = await CryptoEngine.decryptBackupWithPin(pin, backupObj);
    if (!restored || !restored.profile || !restored.profile.username) {
      throw new Error("Invalid backup data");
    }

    myProfile = restored.profile;
    persistMyProfile();

    directory = {};
    for (const item of restored.directory || []) {
      directory[item.username] = item;
      await dbPut("directory", item);
    }

    relations = {};
    for (const rel of restored.relations || []) {
      relations[rel.username] = rel;
      await dbPut("relations", rel);
    }

    const tx = db.transaction("messages", "readwrite");
    tx.objectStore("messages").clear();
    await new Promise((res) => (tx.oncomplete = res));

    for (const m of restored.messages || []) {
      const copy = { ...m };
      delete copy.id;
      await dbPut("messages", copy);
    }

    showToast("पूरा बैकअप सफलतापूर्वक रीस्टोर हो गया!", "success", "fa-solid fa-rotate-left");
    launchMainApp();
  } catch {
    showToast("PIN गलत है या बैकअप फ़ाइल क्षतिग्रस्त है!", "error", "fa-solid fa-circle-exclamation");
  }
}

// =====================================================================
// LAUNCH MAIN APP & NETWORKING
// =====================================================================
function launchMainApp() {
  showScreen("main-app");
  switchTab("home");
  renderProfileTab();
  renderHomeTab();
  renderChatTab();

  setupMqtt();
  setupPeer();
}

function switchTab(tabName) {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });

  document.getElementById("tab-home").classList.toggle("hidden", tabName !== "home");
  document.getElementById("tab-chat").classList.toggle("hidden", tabName !== "chat");
  document.getElementById("tab-profile").classList.toggle("hidden", tabName !== "profile");

  const titles = {
    home: ["Home", `@${myProfile.username}`],
    chat: ["Chat", "Mutual Connections"],
    profile: ["Profile", "Identity & Local Backup"]
  };
  document.getElementById("header-title").textContent = titles[tabName][0];
  document.getElementById("header-sub").textContent = titles[tabName][1];

  if (tabName === "chat") {
    document.getElementById("chat-unread-dot").classList.add("hidden");
    renderChatTab();
  } else if (tabName === "home") {
    renderHomeTab();
  } else if (tabName === "profile") {
    renderProfileTab();
  }
}

function setupMqtt() {
  if (mqttClient) return;
  mqttClient = mqtt.connect(MQTT_BROKER_URL);

  mqttClient.on("connect", () => {
    mqttClient.subscribe(`${APP_NS}/dir/+`);
    mqttClient.subscribe(`${APP_NS}/presence`);
    mqttClient.subscribe(`${APP_NS}/like/${myProfile.username}`);

    publishDirectoryCard();
    publishPresence();

    setInterval(() => {
      publishPresence();
      pruneStaleOnlineUsers();
      renderHomeTab();
    }, 10000);
  });

  mqttClient.on("message", async (topic, payloadBuf) => {
    try {
      const payload = JSON.parse(payloadBuf.toString());

      if (topic.startsWith(`${APP_NS}/dir/`)) {
        const u = payload.user;
        if (!u || !u.username || u.username === myProfile.username || isBlocked(u.username)) return;

        if (payload.signature && u.signPublic) {
          const valid = await CryptoEngine.verifySignature(u.signPublic, u, payload.signature);
          if (!valid) return;
        }

        const existing = directory[u.username];
        if (
          existing &&
          existing.signPublic &&
          u.signPublic &&
          JSON.stringify(existing.signPublic) !== JSON.stringify(u.signPublic)
        ) {
          return;
        }

        directory[u.username] = u;
        delete sharedKeyCache[u.username];
        await dbPut("directory", u);
        renderHomeTab();
        renderChatTab();
      }

      if (topic === `${APP_NS}/presence`) {
        if (payload.username && payload.username !== myProfile.username && !isBlocked(payload.username)) {
          onlineMap[payload.username] = Date.now();
          renderHomeTab();
          renderChatTab();
          if (activeChatPeer === payload.username) {
            updateChatHeaderStatus();
          }
        }
      }

      if (topic === `${APP_NS}/like/${myProfile.username}`) {
        const fromUser = payload.from;
        if (!fromUser || fromUser === myProfile.username || isBlocked(fromUser)) return;

        const rel = relations[fromUser] || {
          username: fromUser,
          iLiked: false,
          likedMe: false,
          blocked: false
        };
        const isUnlike = payload.action === "unlike";
        const prevLikedMe = rel.likedMe;
        rel.likedMe = !isUnlike;
        relations[fromUser] = rel;
        await dbPut("relations", rel);

        if (!isUnlike && !prevLikedMe) {
          const info = directory[fromUser];
          const label = info ? `${info.nickname} (@${fromUser})` : `@${fromUser}`;
          showToast(`${label} ने आपको Like किया है!`, "like", "fa-solid fa-heart");
        }

        renderHomeTab();
        renderChatTab();
      }
    } catch {
      // Ignore malformed packets
    }
  });
}

async function publishDirectoryCard() {
  if (!mqttClient || !mqttClient.connected || !myProfile) return;
  const userCard = {
    username: myProfile.username,
    nickname: myProfile.nickname,
    avatar: myProfile.avatar,
    ecdhPublic: myProfile.ecdhKeys.publicJwk,
    signPublic: myProfile.signKeys.publicJwk,
    updatedAt: Date.now()
  };
  const signature = await CryptoEngine.signData(myProfile.signKeys.privateJwk, userCard);
  mqttClient.publish(
    `${APP_NS}/dir/${myProfile.username}`,
    JSON.stringify({ user: userCard, signature }),
    { retain: true, qos: 0 }
  );
}

function publishPresence() {
  if (!mqttClient || !mqttClient.connected || !myProfile) return;
  mqttClient.publish(
    `${APP_NS}/presence`,
    JSON.stringify({ username: myProfile.username, ts: Date.now() })
  );
}

function pruneStaleOnlineUsers() {
  const now = Date.now();
  Object.keys(onlineMap).forEach((u) => {
    if (now - onlineMap[u] > 25000) delete onlineMap[u];
  });
}

function isUserOnline(username) {
  if (isBlocked(username)) return false;
  return Boolean(onlineMap[username] && Date.now() - onlineMap[username] <= 25000);
}

// =====================================================================
// PEERJS (E2EE CHAT + READ RECEIPTS)
// =====================================================================
function setupPeer() {
  if (peer) return;
  const peerId = `${APP_NS}_peer_${myProfile.username}`;
  peer = new Peer(peerId);

  peer.on("connection", (conn) => {
    const remoteUser = conn.peer.replace(`${APP_NS}_peer_`, "");
    if (isBlocked(remoteUser)) {
      conn.close();
      return;
    }
    attachPeerHandlers(remoteUser, conn);
  });
}

function ensurePeerConnection(remoteUser) {
  if (isBlocked(remoteUser)) return null;
  if (peerConns[remoteUser] && peerConns[remoteUser].open) {
    return peerConns[remoteUser];
  }
  const targetPeerId = `${APP_NS}_peer_${remoteUser}`;
  const conn = peer.connect(targetPeerId, { reliable: true });
  attachPeerHandlers(remoteUser, conn);
  return conn;
}

function attachPeerHandlers(remoteUser, conn) {
  peerConns[remoteUser] = conn;

  conn.on("open", () => {
    if (activeChatPeer === remoteUser) {
      updateChatHeaderStatus();
      sendPendingReadReceipts(remoteUser);
    }
  });

  conn.on("data", async (envelope) => {
    if (isBlocked(remoteUser)) return;
    const rel = relations[remoteUser];
    if (!rel || !rel.iLiked || !rel.likedMe) return;

    const peerInfo = directory[remoteUser];
    if (!peerInfo || !peerInfo.ecdhPublic) return;

    try {
      const aesKey = await getSharedKeyFor(remoteUser, peerInfo.ecdhPublic);
      const decrypted = await CryptoEngine.decryptWithAesKey(aesKey, envelope.cipher);

      // Handle Read Receipt from peer
      if (decrypted.kind === "read_receipt" && decrypted.msgId) {
        await markMessageReadLocal(decrypted.msgId);
        if (activeChatPeer === remoteUser) {
          await reloadActiveChatHistory(remoteUser);
        }
        return;
      }

      // Handle incoming Chat Message (text or image)
      const isCurrentlyViewing = activeChatPeer === remoteUser;
      const msgRecord = {
        msgId: decrypted.msgId || `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        peer: remoteUser,
        direction: "received",
        kind: decrypted.kind || "text",
        text: decrypted.text || "",
        imageData: decrypted.imageData || "",
        time: formatClockTime(Date.now()),
        read: isCurrentlyViewing
      };

      await dbPut("messages", msgRecord);

      if (isCurrentlyViewing) {
        appendChatBubble(msgRecord);
        await sendReadReceipt(remoteUser, msgRecord.msgId);
      } else {
        document.getElementById("chat-unread-dot").classList.remove("hidden");
        showToast(
          `${peerInfo.nickname} (@${remoteUser}) का नया मैसेज आया है`,
          "info",
          "fa-solid fa-comment-dots"
        );
      }
      renderChatTab();
    } catch {
      showToast("मैसेज डिक्रिप्ट करने में त्रुटि हुई", "error", "fa-solid fa-shield-halved");
    }
  });

  conn.on("close", () => {
    if (activeChatPeer === remoteUser) {
      updateChatHeaderStatus();
    }
  });
}

async function sendReadReceipt(targetUser, msgId) {
  const peerInfo = directory[targetUser];
  if (!peerInfo || !peerInfo.ecdhPublic) return;
  const conn = ensurePeerConnection(targetUser);
  if (!conn || !conn.open) return;

  const aesKey = await getSharedKeyFor(targetUser, peerInfo.ecdhPublic);
  const cipher = await CryptoEngine.encryptWithAesKey(aesKey, {
    kind: "read_receipt",
    msgId
  });
  conn.send({ from: myProfile.username, cipher });
}

async function sendPendingReadReceipts(targetUser) {
  const history = await getPeerMessages(targetUser);
  for (const m of history) {
    if (m.direction === "received" && !m.read && m.msgId) {
      m.read = true;
      await dbPut("messages", m);
      await sendReadReceipt(targetUser, m.msgId);
    }
  }
}

async function getSharedKeyFor(remoteUser, peerEcdhPublic) {
  if (sharedKeyCache[remoteUser]) return sharedKeyCache[remoteUser];
  const key = await CryptoEngine.deriveSharedAesKey(myProfile.ecdhKeys.privateJwk, peerEcdhPublic);
  sharedKeyCache[remoteUser] = key;
  return key;
}

async function sendEncryptedChatPayload(targetUser, payloadObj) {
  if (isBlocked(targetUser)) return;
  const rel = relations[targetUser];
  if (!rel || !rel.iLiked || !rel.likedMe) {
    showToast("मैसेज भेजने के लिए दोनों तरफ़ से Like ज़रूरी है", "error", "fa-solid fa-heart-crack");
    return;
  }

  const peerInfo = directory[targetUser];
  if (!peerInfo || !peerInfo.ecdhPublic) {
    showToast("यूज़र की Encryption Key उपलब्ध नहीं है", "error", "fa-solid fa-key");
    return;
  }

  const conn = ensurePeerConnection(targetUser);
  if (!conn || !conn.open) {
    showToast("दूसरा यूज़र अभी P2P कनेक्ट नहीं है", "error", "fa-solid fa-wifi");
    return;
  }

  const msgId = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const aesKey = await getSharedKeyFor(targetUser, peerInfo.ecdhPublic);
  const cipher = await CryptoEngine.encryptWithAesKey(aesKey, {
    ...payloadObj,
    msgId
  });

  conn.send({
    from: myProfile.username,
    cipher
  });

  const msgRecord = {
    msgId,
    peer: targetUser,
    direction: "sent",
    kind: payloadObj.kind,
    text: payloadObj.text || "",
    imageData: payloadObj.imageData || "",
    time: formatClockTime(Date.now()),
    read: false
  };

  await dbPut("messages", msgRecord);
  if (activeChatPeer === targetUser) {
    appendChatBubble(msgRecord);
  }
  renderChatTab();
}

// =====================================================================
// LIKE, UNLIKE & BLOCK ACTIONS
// =====================================================================
async function sendLike(targetUsername) {
  if (isBlocked(targetUsername)) return;
  const rel = relations[targetUsername] || {
    username: targetUsername,
    iLiked: false,
    likedMe: false,
    blocked: false
  };
  rel.iLiked = true;
  relations[targetUsername] = rel;
  await dbPut("relations", rel);

  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(
      `${APP_NS}/like/${targetUsername}`,
      JSON.stringify({ from: myProfile.username, action: "like", ts: Date.now() })
    );
  }

  if (rel.iLiked && rel.likedMe) {
    showToast(`@${targetUsername} से Mutual Match! अब Chat कर सकते हैं।`, "success", "fa-solid fa-heart");
  } else {
    showToast(`@${targetUsername} को Like भेजा गया`, "like", "fa-solid fa-heart");
  }

  renderHomeTab();
  renderChatTab();
}

async function unlikeUser(targetUsername) {
  const rel = relations[targetUsername] || {
    username: targetUsername,
    iLiked: false,
    likedMe: false,
    blocked: false
  };
  rel.iLiked = false;
  relations[targetUsername] = rel;
  await dbPut("relations", rel);

  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(
      `${APP_NS}/like/${targetUsername}`,
      JSON.stringify({ from: myProfile.username, action: "unlike", ts: Date.now() })
    );
  }

  showToast(`@${targetUsername} से Like हटा दिया गया`, "info", "fa-regular fa-heart");
  renderHomeTab();
  renderChatTab();
}

async function blockUser(targetUsername) {
  const rel = relations[targetUsername] || {
    username: targetUsername,
    iLiked: false,
    likedMe: false,
    blocked: false
  };
  rel.blocked = true;
  rel.iLiked = false;
  relations[targetUsername] = rel;
  await dbPut("relations", rel);

  if (peerConns[targetUsername]) {
    try {
      peerConns[targetUsername].close();
    } catch {}
    delete peerConns[targetUsername];
  }

  showToast(`@${targetUsername} को Block कर दिया गया`, "error", "fa-solid fa-ban");
  renderHomeTab();
  renderChatTab();
}

async function unblockUser(targetUsername) {
  const rel = relations[targetUsername] || {
    username: targetUsername,
    iLiked: false,
    likedMe: false,
    blocked: false
  };
  rel.blocked = false;
  relations[targetUsername] = rel;
  await dbPut("relations", rel);

  showToast(`@${targetUsername} को Unblock कर दिया गया`, "success", "fa-solid fa-check");
  renderHomeTab();
  renderChatTab();
}
// =====================================================================
// RENDERERS
// =====================================================================
function renderHomeTab() {
  const listEl = document.getElementById("home-users-list");
  const blockedListEl = document.getElementById("blocked-users-list");
  const query = document.getElementById("home-search-input").value.trim().toLowerCase();

  const allUsers = Object.values(directory).filter(
    (u) => u.username !== myProfile.username && !isBlocked(u.username)
  );
  const onlineTotal = allUsers.filter((u) => isUserOnline(u.username)).length;
  document.getElementById("online-count-badge").textContent = `${onlineTotal} Online`;

  const filtered = allUsers.filter((u) => {
    if (!query) return true;
    return (
      u.username.toLowerCase().includes(query) ||
      (u.nickname && u.nickname.toLowerCase().includes(query))
    );
  });

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div class="empty-box">
        <i class="fa-solid fa-user-slash"></i>
        कोई यूज़र नहीं मिला। Refresh दबाएँ या नया नाम सर्च करें।
      </div>`;
  } else {
    listEl.innerHTML = "";
    filtered.forEach((u) => {
      const online = isUserOnline(u.username);
      const rel = relations[u.username] || { iLiked: false, likedMe: false };

      let primaryBtn = "";
      if (rel.iLiked && rel.likedMe) {
        primaryBtn = `
          <button class="btn btn-sm btn-success" onclick="openChatScreen('${u.username}')">
            <i class="fa-solid fa-comment"></i> Chat
          </button>`;
      } else if (!rel.iLiked && rel.likedMe) {
        primaryBtn = `
          <button class="btn btn-sm btn-like-you" onclick="sendLike('${u.username}')">
            <i class="fa-solid fa-heart"></i> Like You
          </button>`;
      } else if (rel.iLiked && !rel.likedMe) {
        primaryBtn = `
          <button class="btn btn-sm btn-unlike" onclick="unlikeUser('${u.username}')">
            <i class="fa-solid fa-heart-crack"></i> Unlike
          </button>`;
      } else {
        primaryBtn = `
          <button class="btn btn-sm btn-like" onclick="sendLike('${u.username}')">
            <i class="fa-regular fa-heart"></i> Like
          </button>`;
      }

      const unlikeIfMutualBtn =
        rel.iLiked && rel.likedMe
          ? `<button class="btn btn-sm btn-unlike" title="Unlike" onclick="unlikeUser('${u.username}')">
               <i class="fa-solid fa-heart-crack"></i>
             </button>`
          : "";

      const card = document.createElement("div");
      card.className = "user-card";
      card.innerHTML = `
        <div class="user-card-left">
          <img src="${u.avatar || DEFAULT_AVATAR}" alt="${escapeHtml(u.nickname)}" class="avatar-md" />
          <div class="user-card-meta">
            <div class="user-card-name-row">
              <span class="user-card-nick">${escapeHtml(u.nickname)}</span>
              <span class="status-dot ${online ? "online" : "offline"}"></span>
            </div>
            <div class="user-card-sub">@${escapeHtml(u.username)} • ${online ? "Online" : "Offline"}</div>
          </div>
        </div>
        <div class="card-actions">
          ${primaryBtn}
          ${unlikeIfMutualBtn}
          <button class="icon-btn danger" style="width:30px;height:30px;font-size:12px;" title="Block" onclick="blockUser('${u.username}')">
            <i class="fa-solid fa-ban"></i>
          </button>
        </div>
      `;
      listEl.appendChild(card);
    });
  }

  // Blocked Users List
  const blockedUsers = Object.values(relations).filter((r) => r.blocked);
  if (blockedUsers.length === 0) {
    blockedListEl.innerHTML = `<div class="empty-box" style="padding:14px;">कोई Blocked यूज़र नहीं है।</div>`;
  } else {
    blockedListEl.innerHTML = "";
    blockedUsers.forEach((r) => {
      const info = directory[r.username] || { username: r.username, nickname: r.username, avatar: DEFAULT_AVATAR };
      const card = document.createElement("div");
      card.className = "user-card";
      card.innerHTML = `
        <div class="user-card-left">
          <img src="${info.avatar || DEFAULT_AVATAR}" alt="${escapeHtml(info.nickname)}" class="avatar-md" />
          <div class="user-card-meta">
            <div class="user-card-nick">${escapeHtml(info.nickname)}</div>
            <div class="user-card-sub">@${escapeHtml(r.username)} • Blocked</div>
          </div>
        </div>
        <button class="btn btn-sm btn-ghost" onclick="unblockUser('${r.username}')">
          Unblock
        </button>
      `;
      blockedListEl.appendChild(card);
    });
  }
}

async function renderChatTab() {
  const listEl = document.getElementById("chat-threads-list");
  const mutualUsers = Object.values(relations)
    .filter((r) => !r.blocked && r.iLiked && r.likedMe)
    .map((r) => r.username);

  if (mutualUsers.length === 0) {
    listEl.innerHTML = `
      <div class="empty-box">
        <i class="fa-regular fa-comments"></i>
        अभी कोई Mutual Chat नहीं है। Home टैब पर Like और Like You पूरा होने पर यहाँ चैट दिखेगी।
      </div>`;
    return;
  }

  listEl.innerHTML = "";
  for (const uname of mutualUsers) {
    const info = directory[uname] || {
      username: uname,
      nickname: uname,
      avatar: DEFAULT_AVATAR
    };
    const online = isUserOnline(uname);
    const msgs = await getPeerMessages(uname);
    const lastMsg = msgs[msgs.length - 1];
    const previewText = lastMsg
      ? lastMsg.kind === "image"
        ? "📷 फ़ोटो भेजी गई"
        : lastMsg.text
      : "बातचीत शुरू करने के लिए टैप करें";

    const card = document.createElement("div");
    card.className = "user-card clickable";
    card.onclick = () => openChatScreen(uname);
    card.innerHTML = `
      <div class="user-card-left">
        <img src="${info.avatar || DEFAULT_AVATAR}" alt="${escapeHtml(info.nickname)}" class="avatar-md" />
        <div class="user-card-meta">
          <div class="user-card-name-row">
            <span class="user-card-nick">${escapeHtml(info.nickname)}</span>
            <span class="status-dot ${online ? "online" : "offline"}"></span>
          </div>
          <div class="user-card-sub">${escapeHtml(previewText)}</div>
        </div>
      </div>
      <i class="fa-solid fa-chevron-right muted-text"></i>
    `;
    listEl.appendChild(card);
  }
}

function renderProfileTab() {
  if (!myProfile) return;
  document.getElementById("profile-avatar-img").src = myProfile.avatar || DEFAULT_AVATAR;
  document.getElementById("profile-display-nick").textContent = myProfile.nickname;
  document.getElementById("profile-display-user").textContent = `@${myProfile.username}`;
  document.getElementById("profile-nickname-input").value = myProfile.nickname;
  document.getElementById("profile-token-value").textContent = myProfile.personalToken;
}

async function openChatScreen(targetUsername) {
  if (isBlocked(targetUsername)) return;
  const rel = relations[targetUsername];
  if (!rel || !rel.iLiked || !rel.likedMe) {
    showToast("चैट के लिए दोनों तरफ़ से Like होना ज़रूरी है", "error", "fa-solid fa-lock");
    return;
  }

  activeChatPeer = targetUsername;
  const info = directory[targetUsername] || {
    username: targetUsername,
    nickname: targetUsername,
    avatar: DEFAULT_AVATAR
  };

  document.getElementById("chat-peer-avatar").src = info.avatar || DEFAULT_AVATAR;
  document.getElementById("chat-peer-name").textContent = `${info.nickname} (@${info.username})`;
  document.getElementById("chat-view-screen").classList.remove("hidden");

  updateChatHeaderStatus();
  await reloadActiveChatHistory(targetUsername);
  ensurePeerConnection(targetUsername);
  await sendPendingReadReceipts(targetUsername);
}

async function reloadActiveChatHistory(targetUsername) {
  const box = document.getElementById("chat-messages-box");
  box.innerHTML = "";
  const history = await getPeerMessages(targetUsername);
  history.forEach(appendChatBubble);
}

function updateChatHeaderStatus() {
  if (!activeChatPeer) return;
  const online = isUserOnline(activeChatPeer);
  const p2pOpen = Boolean(peerConns[activeChatPeer] && peerConns[activeChatPeer].open);
  const el = document.getElementById("chat-peer-sub");

  if (p2pOpen) {
    el.textContent = "E2EE • P2P Connected";
    el.style.color = "#10b981";
  } else if (online) {
    el.textContent = "E2EE • Online (Connecting P2P...)";
    el.style.color = "#38bdf8";
  } else {
    el.textContent = "E2EE • Offline";
    el.style.color = "#94a3b8";
  }
}

function appendChatBubble(msg) {
  const box = document.getElementById("chat-messages-box");
  const div = document.createElement("div");
  const isSent = msg.direction === "sent";
  div.className = `bubble ${isSent ? "sent" : "received"}`;

  let bodyHtml = "";
  if (msg.kind === "image" && msg.imageData) {
    bodyHtml += `<img src="${msg.imageData}" alt="Photo" class="bubble-img" />`;
  }
  if (msg.text) {
    bodyHtml += `<div>${escapeHtml(msg.text)}</div>`;
  }

  const receiptHtml = isSent
    ? `<span class="read-check ${msg.read ? "read" : ""}" title="${msg.read ? "Read" : "Sent"}">${
        msg.read ? "✓✓" : "✓"
      }</span>`
    : `<i class="fa-solid fa-lock" style="font-size:9px;"></i>`;

  bodyHtml += `<span class="bubble-meta">${escapeHtml(msg.time)} ${receiptHtml}</span>`;

  div.innerHTML = bodyHtml;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function formatClockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (m) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[m])
  );
}