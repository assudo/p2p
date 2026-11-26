// ==========================================
// 1. LOCAL DATABASE (IndexedDB) SETUP
// ==========================================
let db;
const DB_NAME = "LocalP2PChatDB";
const DB_VERSION = 1;

function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      db = e.target.result;
      if (!db.objectStoreNames.contains("messages")) {
        const msgStore = db.createObjectStore("messages", { keyPath: "id", autoIncrement: true });
        msgStore.createIndex("chatWith", "chatWith", { unique: false });
      }
      if (!db.objectStoreNames.contains("relations")) {
        db.createObjectStore("relations", { keyPath: "userId" });
      }
    };
    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    request.onerror = (e) => reject(e);
  });
}

// Local Message Save
function saveMessageLocal(chatWith, sender, text) {
  return new Promise((resolve) => {
    const tx = db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    const msg = {
      chatWith,
      sender,
      text,
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    };
    store.add(msg);
    tx.oncomplete = () => resolve(msg);
  });
}

// Get Chat History from Phone
function getMessagesLocal(chatWith) {
  return new Promise((resolve) => {
    const tx = db.transaction("messages", "readonly");
    const store = tx.objectStore("messages");
    const index = store.index("chatWith");
    const req = index.getAll(chatWith);
    req.onsuccess = () => resolve(req.result || []);
  });
}

// Clear Local Chat
function clearMessagesLocal(chatWith) {
  return new Promise((resolve) => {
    const tx = db.transaction("messages", "readwrite");
    const store = tx.objectStore("messages");
    const index = store.index("chatWith");
    const req = index.openCursor(IDBKeyRange.only(chatWith));
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

// Save Follow / Relation state locally
function saveRelationLocal(userId, iFollow, followsMe) {
  return new Promise((resolve) => {
    const tx = db.transaction("relations", "readwrite");
    const store = tx.objectStore("relations");
    store.put({ userId, iFollow, followsMe });
    tx.oncomplete = () => resolve();
  });
}

function getAllRelationsLocal() {
  return new Promise((resolve) => {
    const tx = db.transaction("relations", "readonly");
    const store = tx.objectStore("relations");
    const req = store.getAll();
    req.onsuccess = () => {
      const map = {};
      (req.result || []).forEach(r => map[r.userId] = r);
      resolve(map);
    };
  });
}

// ==========================================
// 2. APP STATE & AUTH (Permanent ID + PIN)
// ==========================================
let myUserId = localStorage.getItem("p2p_permanent_id");
let myPin = localStorage.getItem("p2p_pin");
let relations = {}; // { userId: { userId, iFollow, followsMe } }
let onlineUsers = {}; // { userId: lastSeenTimestamp }
let activeChatUser = null;

let peer = null;
let connections = {}; // Active WebRTC connections
let mqttClient = null;

// यूनीक टॉपिक ताकि आपके ऐप के यूज़र्स आपस में दिखें
const APP_TOPIC_PREFIX = "as_sudo_local_p2p_chat_v1";

window.addEventListener("DOMContentLoaded", async () => {
  await initDB();
  relations = await getAllRelationsLocal();

  if (!myUserId || !myPin) {
    showScreen("setup-screen");
  } else {
    document.getElementById("locked-userid").textContent = myUserId;
    showScreen("lock-screen");
  }
});

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
  document.getElementById(id).classList.remove("hidden");
}

// Save New Permanent ID & PIN
document.getElementById("btn-save-profile").addEventListener("click", () => {
  const uid = document.getElementById("input-userid").value.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
  const pin = document.getElementById("input-pin").value.trim();

  if (uid.length < 3) {
    document.getElementById("setup-error").textContent = "ID कम से कम 3 अक्षर की रखें (a-z, 0-9, _)";
    return;
  }
  if (pin.length < 4) {
    document.getElementById("setup-error").textContent = "कम से कम 4 अंकों का PIN डालें।";
    return;
  }

  localStorage.setItem("p2p_permanent_id", uid);
  localStorage.setItem("p2p_pin", pin);
  myUserId = uid;
  myPin = pin;
  startApp();
});

// Unlock with PIN
document.getElementById("btn-unlock").addEventListener("click", () => {
  const enteredPin = document.getElementById("unlock-pin").value.trim();
  if (enteredPin === myPin) {
    document.getElementById("unlock-pin").value = "";
    document.getElementById("lock-error").textContent = "";
    startApp();
  } else {
    document.getElementById("lock-error").textContent = "गलत PIN! फिर से कोशिश करें।";
  }
});

document.getElementById("btn-lock-now").addEventListener("click", () => {
  document.getElementById("locked-userid").textContent = myUserId;
  showScreen("lock-screen");
});

// ==========================================
// 3. START P2P (WebRTC) & ONLINE PRESENCE (MQTT)
// ==========================================
function startApp() {
  showScreen("main-screen");
  document.getElementById("my-id-display").textContent = "@" + myUserId;
  renderLists();

  initPeerJS();
  initMQTTPresence();
}

// PeerJS: Direct P2P Data Connection
function initPeerJS() {
  if (peer) return;
  const peerId = `${APP_TOPIC_PREFIX}_${myUserId}`;
  peer = new Peer(peerId);

  peer.on("open", () => {
    console.log("P2P Ready with ID:", myUserId);
  });

  peer.on("connection", (conn) => {
    const remoteUserId = conn.peer.replace(`${APP_TOPIC_PREFIX}_`, "");
    setupConnectionHandlers(remoteUserId, conn);
  });
}

function connectToPeer(targetUserId) {
  if (connections[targetUserId] && connections[targetUserId].open) {
    return connections[targetUserId];
  }
  const targetPeerId = `${APP_TOPIC_PREFIX}_${targetUserId}`;
  const conn = peer.connect(targetPeerId, { reliable: true });
  setupConnectionHandlers(targetUserId, conn);
  return conn;
}

function setupConnectionHandlers(remoteUserId, conn) {
  connections[remoteUserId] = conn;

  conn.on("open", () => {
    if (activeChatUser === remoteUserId) {
      document.getElementById("chat-peer-status").textContent = "● P2P Connected (Direct)";
    }
  });

  conn.on("data", async (data) => {
    // केवल Mutual Follow होने पर ही मैसेज स्वीकार करें
    const rel = relations[remoteUserId];
    if (!rel || !rel.iFollow || !rel.followsMe) {
      console.warn("Blocked message from non-mutual user:", remoteUserId);
      return;
    }

    if (data.type === "chat") {
      const savedMsg = await saveMessageLocal(remoteUserId, remoteUserId, data.text);
      if (activeChatUser === remoteUserId) {
        appendMessageUI(savedMsg);
      } else {
        alert(`@${remoteUserId} का नया मैसेज आया है!`);
      }
    }
  });

  conn.on("close", () => {
    if (activeChatUser === remoteUserId) {
      document.getElementById("chat-peer-status").textContent = "Offline / Disconnected";
    }
  });
}

// MQTT: Online Status & Follow Signaling
function initMQTTPresence() {
  if (mqttClient) return;
  mqttClient = mqtt.connect("wss://broker.emqx.io:8084/mqtt");

  mqttClient.on("connect", () => {
    mqttClient.subscribe(`${APP_TOPIC_PREFIX}/presence`);
    mqttClient.subscribe(`${APP_TOPIC_PREFIX}/signal/${myUserId}`);
    broadcastPresence();
    // हर 10 सेकंड में Online स्टेटस भेजें
    setInterval(broadcastPresence, 10000);
  });

  mqttClient.on("message", async (topic, payload) => {
    try {
      const msg = JSON.parse(payload.toString());

      // 1. कोई यूज़र ऑनलाइन आया
      if (topic === `${APP_TOPIC_PREFIX}/presence`) {
        if (msg.userId && msg.userId !== myUserId) {
          onlineUsers[msg.userId] = Date.now();
          renderLists();
        }
      }

      // 2. किसी ने Follow या Follow-Back भेजा
      if (topic === `${APP_TOPIC_PREFIX}/signal/${myUserId}`) {
        if (msg.type === "follow" && msg.from) {
          const existing = relations[msg.from] || { userId: msg.from, iFollow: false, followsMe: false };
          existing.followsMe = true;
          relations[msg.from] = existing;
          await saveRelationLocal(msg.from, existing.iFollow, true);
          renderLists();
        }
      }
    } catch (e) {
      console.error(e);
    }
  });
}

function broadcastPresence() {
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(
      `${APP_TOPIC_PREFIX}/presence`,
      JSON.stringify({ userId: myUserId, ts: Date.now() })
    );
  }
}

document.getElementById("btn-refresh").addEventListener("click", () => {
  broadcastPresence();
  // 25 सेकंड से पुराने ऑफ़लाइन यूज़र्स हटाएँ
  const now = Date.now();
  Object.keys(onlineUsers).forEach(uid => {
    if (now - onlineUsers[uid] > 25000) delete onlineUsers[uid];
  });
  renderLists();
});

// ==========================================
// 4. FOLLOW & FOLLOW-BACK LOGIC
// ==========================================
async function sendFollow(targetUserId) {
  const existing = relations[targetUserId] || { userId: targetUserId, iFollow: false, followsMe: false };
  existing.iFollow = true;
  relations[targetUserId] = existing;
  await saveRelationLocal(targetUserId, true, existing.followsMe);

  // सामने वाले को Follow सिग्नल भेजें
  if (mqttClient && mqttClient.connected) {
    mqttClient.publish(
      `${APP_TOPIC_PREFIX}/signal/${targetUserId}`,
      JSON.stringify({ type: "follow", from: myUserId })
    );
  }

  renderLists();
}

// ==========================================
// 5. UI RENDERING & CHAT ACTIONS
// ==========================================
function renderLists() {
  const onlineListEl = document.getElementById("online-users-list");
  const contactsListEl = document.getElementById("contacts-list");
  onlineListEl.innerHTML = "";
  contactsListEl.innerHTML = "";

  const now = Date.now();

  // Online Users List
  Object.keys(onlineUsers).forEach(uid => {
    if (now - onlineUsers[uid] > 25000) return;
    const rel = relations[uid] || { iFollow: false, followsMe: false };

    const li = document.createElement("li");
    li.className = "user-item";

    let actionBtn = "";
    if (rel.iFollow && rel.followsMe) {
      actionBtn = `<button class="btn small success" onclick="openChat('${uid}')">💬 Chat</button>`;
    } else if (rel.iFollow && !rel.followsMe) {
      actionBtn = `<span style="font-size:11px;color:#fbbf24;">Requested...</span>`;
    } else if (!rel.iFollow && rel.followsMe) {
      actionBtn = `<button class="btn small primary" onclick="sendFollow('${uid}')">Follow Back</button>`;
    } else {
      actionBtn = `<button class="btn small primary" onclick="sendFollow('${uid}')">+ Follow</button>`;
    }

    li.innerHTML = `
      <div class="user-info">
        <strong>@${uid}</strong>
        <span>🟢 Online</span>
      </div>
      ${actionBtn}
    `;
    onlineListEl.appendChild(li);
  });

  if (onlineListEl.children.length === 0) {
    onlineListEl.innerHTML = `<li class="hint">अभी कोई दूसरा यूज़र ऑनलाइन नहीं दिख रहा। Refresh दबाएँ।</li>`;
  }

  // Contacts & Follow Requests List
  Object.values(relations).forEach(rel => {
    const uid = rel.userId;
    const isOnline = onlineUsers[uid] && (now - onlineUsers[uid] <= 25000);
    const li = document.createElement("li");
    li.className = "user-item";

    let statusText = isOnline ? "🟢 Online" : "⚪ Offline";
    let actionBtn = "";

    if (rel.iFollow && rel.followsMe) {
      statusText += " • Mutual";
      actionBtn = `<button class="btn small success" onclick="openChat('${uid}')">💬 Open</button>`;
    } else if (rel.followsMe && !rel.iFollow) {
      statusText += " • आपको Follow किया है";
      actionBtn = `<button class="btn small primary" onclick="sendFollow('${uid}')">Follow Back</button>`;
    } else {
      statusText += " • Follow Back का इंतज़ार";
      actionBtn = `<button class="btn small" onclick="sendFollow('${uid}')">Resend</button>`;
    }

    li.innerHTML = `
      <div class="user-info">
        <strong>@${uid}</strong>
        <span>${statusText}</span>
      </div>
      ${actionBtn}
    `;
    contactsListEl.appendChild(li);
  });
}

async function openChat(targetUserId) {
  const rel = relations[targetUserId];
  if (!rel || !rel.iFollow || !rel.followsMe) {
    alert("मैसेज करने के लिए दोनों तरफ़ से Follow / Follow-Back होना ज़रूरी है!");
    return;
  }

  activeChatUser = targetUserId;
  document.getElementById("no-chat-selected").classList.add("hidden");
  document.getElementById("active-chat-box").classList.remove("hidden");
  document.getElementById("chat-with-name").textContent = "@" + targetUserId;
  document.getElementById("chat-peer-status").textContent = "Connecting P2P...";

  // फ़ोन के IndexedDB से पुरानी चैट लोड करें
  const msgs = await getMessagesLocal(targetUserId);
  const container = document.getElementById("messages-container");
  container.innerHTML = "";
  msgs.forEach(appendMessageUI);

  // सीधा P2P कनेक्शन जोड़ें
  connectToPeer(targetUserId);
}

function appendMessageUI(msg) {
  const container = document.getElementById("messages-container");
  const div = document.createElement("div");
  const isMe = msg.sender === myUserId;
  div.className = `msg ${isMe ? "sent" : "received"}`;
  div.innerHTML = `${escapeHTML(msg.text)}<span class="msg-time">${msg.time}</span>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

document.getElementById("chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeChatUser) return;

  const input = document.getElementById("message-input");
  const text = input.value.trim();
  if (!text) return;

  const conn = connectToPeer(activeChatUser);
  if (!conn || !conn.open) {
    alert("दूसरा यूज़र अभी P2P कनेक्टेड नहीं है। सुनिश्चित करें कि दूसरा फ़ोन भी ऑनलाइन है और ऐप खुला है।");
    return;
  }

  // सामने वाले को P2P से भेजें
  conn.send({ type: "chat", text });

  // अपने फ़ोन में लोकल सेव करें
  const savedMsg = await saveMessageLocal(activeChatUser, myUserId, text);
  appendMessageUI(savedMsg);
  input.value = "";
});

document.getElementById("btn-clear-chat").addEventListener("click", async () => {
  if (!activeChatUser) return;
  await clearMessagesLocal(activeChatUser);
  document.getElementById("messages-container").innerHTML = "";
});

function escapeHTML(str) {
  return str.replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}
