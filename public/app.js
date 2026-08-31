"use strict";

const PREFIX = "gshr-7f3k-";
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let peer = null;
let myName = "";
let roomCode = "";
let isHost = false;
const members = new Map();
const outgoingCalls = new Map();
const incomingCalls = new Map();
const sharingPeers = new Set();
const tiles = new Map();
let focusedKey = null;
let localStream = null;

const $ = id => document.getElementById(id);
const landing = $("landing"), roomEl = $("room"), grid = $("grid"), emptyState = $("emptyState");
const shareBtn = $("shareBtn");

function randomCode() {
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf, n => CODE_CHARS[n % CODE_CHARS.length]).join("");
}

function getName() {
  return $("nameInput").value.trim() || "Convidado-" + Math.floor(Math.random() * 900 + 100);
}

$("createBtn").addEventListener("click", () => {
  myName = getName();
  roomCode = randomCode();
  isHost = true;
  startPeer(PREFIX + roomCode);
});

$("joinBtn").addEventListener("click", joinRoom);

function joinRoom() {
  const code = $("joinCode").value.trim().toUpperCase();
  if (!code) return;
  myName = getName();
  roomCode = code;
  isHost = false;
  startPeer(null);
}

function startPeer(fixedId) {
  peer = fixedId ? new Peer(fixedId, { config: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] } })
                 : new Peer({ config: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] } });

  peer.on("open", () => {
    if (isHost) {
      enterRoom();
    } else {
      const conn = peer.connect(PREFIX + roomCode, { metadata: { name: myName } });
      conn.on("open", () => { registerConn(conn, null); enterRoom(); });
    }
  });

  peer.on("connection", conn => {
    conn.on("open", () => registerConn(conn, conn.metadata && conn.metadata.name));
  });

  peer.on("call", call => {
    call.answer(); 
    incomingCalls.set(call.peer, call);
    
    call.on("stream", stream => {
      sharingPeers.add(call.peer);
      addTile(call.peer, stream);
    });
    
    call.on("close", () => removeTile(call.peer));
  });
}

function enterRoom() {
  landing.style.display = "none";
  roomEl.style.display = "flex";
  $("roomCodeLabel").textContent = roomCode;
  renderUsers();
}

function registerConn(conn, name) {
  if (members.has(conn.peer)) return;
  members.set(conn.peer, { conn, name: name || "Convidado" });

  conn.send({ type: "hello", name: myName });

  if (isHost) {
    const others = [...members.keys()].filter(id => id !== conn.peer);
    conn.send({ type: "members", list: others });
  }

  if (localStream) callPeer(conn.peer);

  conn.on("data", msg => handleData(conn.peer, msg));
  conn.on("close", () => dropMember(conn.peer));
  renderUsers();
}

function handleData(fromId, msg) {
  if (msg.type === "hello") {
    const m = members.get(fromId);
    if (m) { m.name = msg.name; renderUsers(); }
  } else if (msg.type === "members") {
    for (const id of msg.list || []) {
      if (id !== peer.id && !members.has(id)) {
        const c = peer.connect(id, { metadata: { name: myName } });
        c.on("open", () => registerConn(c, null));
      }
    }
  } else if (msg.type === "share-stopped") {
    sharingPeers.delete(fromId);
    removeTile(fromId);
    renderUsers();
  }
}

function dropMember(id) {
  members.delete(id);
  sharingPeers.delete(id);
  removeTile(id);
  renderUsers();
}

shareBtn.addEventListener("click", () => localStream ? stopShare() : startShare());

async function startShare() {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({ 
      video: {
        width: { max: 1280 },
        height: { max: 720 },
        frameRate: { ideal: 30, max: 30 }
      }, 
      audio: true 
    });
    
    addTile("local", localStream);

    for (const id of members.keys()) callPeer(id);

    shareBtn.classList.add("sharing");
    shareBtn.querySelector(".btnLabel").textContent = "Parar Compartilhamento";
    
    localStream.getVideoTracks()[0].addEventListener("ended", stopShare);
  } catch (e) {
    console.warn("Cancelado pelo usuário.");
  }
}

function stopShare() {
  if (!localStream) return;
  localStream.getTracks().forEach(t => t.stop());
  localStream = null;
  
  for (const call of outgoingCalls.values()) call.close();
  outgoingCalls.clear();
  
  broadcast({ type: "share-stopped" });
  removeTile("local");
  
  shareBtn.classList.remove("sharing");
  shareBtn.querySelector(".btnLabel").textContent = "Compartilhar Tela";
}

function broadcast(msg) {
  for (const { conn } of members.values()) {
    if (conn.open) conn.send(msg);
  }
}

function callPeer(id) {
  if (!localStream || outgoingCalls.has(id)) return;
  const call = peer.call(id, localStream);
  outgoingCalls.set(id, call);
  call.on("close", () => outgoingCalls.delete(id));
}

function addTile(key, stream) {
  removeTile(key);

  const el = document.createElement("div");
  el.className = "tile" + (focusedKey === key ? " focus" : "");

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.srcObject = stream;
  video.muted = true; 

  const bar = document.createElement("div");
  bar.className = "tileBar";
  bar.textContent = key === "local" ? "Sua Tela (Clique para Expandir)" : `Tela de ${members.get(key)?.name || "Convidado"}`;

  el.append(video, bar);
  el.addEventListener("click", () => toggleFocus(key));

  grid.appendChild(el);
  tiles.set(key, { el, video });
  layoutGrid();
  renderUsers();
}

function removeTile(key) {
  const t = tiles.get(key);
  if (!t) return;
  t.video.srcObject = null;
  t.el.remove();
  tiles.delete(key);
  if (focusedKey === key) setFocus(null);
  layoutGrid();
  renderUsers();
}

function setFocus(key) {
  focusedKey = key && tiles.has(key) ? key : null;
  grid.classList.toggle("focused", !!focusedKey);
  
  for (const [k, t] of tiles) {
    const isFocused = k === focusedKey;
    t.el.classList.toggle("focus", isFocused);
    if (k !== "local") t.video.muted = !isFocused;
  }
  
  layoutGrid();
  renderUsers();
}

function toggleFocus(key) { setFocus(focusedKey === key ? null : key); }

function layoutGrid() {
  const n = focusedKey ? 1 : tiles.size;
  emptyState.style.display = tiles.size === 0 ? "flex" : "none";
  if (n === 0) return;

  const cols = Math.ceil(Math.sqrt(n));
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}

function renderUsers() {
  const list = $("userList");
  list.textContent = "";
  const entries = [["local", myName + " (Você)"], ...[...members].map(([id, m]) => [id, m.name])];
  
  for (const [key, name] of entries) {
    const sharing = key === "local" ? !!localStream : sharingPeers.has(key);
    const row = document.createElement("div");
    row.className = "userRow" + (sharing ? " sharing" : "") + (focusedKey === key ? " selected" : "");

    const av = document.createElement("div");
    av.className = "avatar";
    av.textContent = (name.trim()[0] || "?").toUpperCase();

    const info = document.createElement("div");
    info.className = "userInfo";
    
    const nm = document.createElement("div");
    nm.className = "userName";
    nm.textContent = name;
    
    const st = document.createElement("div");
    st.className = "userStatus";
    st.textContent = sharing ? (focusedKey === key ? "Em Foco" : "Transmitindo") : "Apenas assistindo";
    
    info.append(nm, st);
    row.append(av, info);
    
    if (sharing) row.addEventListener("click", () => toggleFocus(key));
    list.appendChild(row);
  }
}

$("leaveBtn").addEventListener("click", () => location.reload());