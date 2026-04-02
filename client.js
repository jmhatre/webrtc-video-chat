/**
 * client.js — WebRTC peer connection + signaling client
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages the full WebRTC lifecycle:
 *   1. Get local media (camera + microphone)
 *   2. Connect to signaling server via Socket.IO
 *   3. Join a room and wait for a peer
 *   4. Execute the offer/answer/ICE exchange
 *   5. Establish a direct peer-to-peer media stream
 *
 * The WebRTC flow looks like this:
 *
 *   Peer A (initiator)              Signaling Server          Peer B (joiner)
 *   ──────────────────              ────────────────          ───────────────
 *   getUserMedia()                                            getUserMedia()
 *   join-room ──────────────────────────────────────────────→ join-room
 *                                                            ← joined {isInitiator: true}
 *             ← peer-joined (server tells A that B arrived)
 *   createOffer()
 *   setLocalDescription(offer)
 *   offer ──────────────────────────────────────────────────→ setRemoteDescription(offer)
 *                                                            createAnswer()
 *                                                            setLocalDescription(answer)
 *             ← answer ←───────────────────────────────────── answer
 *   setRemoteDescription(answer)
 *
 *   [ICE candidates flow both ways throughout the above]
 *
 *   At this point: direct P2P audio/video stream established 🎉
 */

"use strict";

// ─── State ────────────────────────────────────────────────────────────────────
const roomId = window.location.pathname.split("/room/")[1];
let localStream = null;
let peerConnection = null;
let micEnabled = true;
let camEnabled = true;

// ICE servers: Google's public STUN servers for NAT traversal
// In production you'd add TURN servers for stricter NAT environments
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
  ],
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const localVideo   = document.getElementById("localVideo");
const remoteVideo  = document.getElementById("remoteVideo");
const remoteWrapper = document.getElementById("remoteWrapper");
const remoteOverlay = document.getElementById("remoteOverlay");
const videoGrid    = document.getElementById("videoGrid");
const statusDot    = document.getElementById("statusDot");
const statusText   = document.getElementById("statusText");
const shareUrl     = document.getElementById("shareUrl");

// ─── Init ─────────────────────────────────────────────────────────────────────
document.getElementById("roomName").textContent = roomId;
document.getElementById("infoRoom").textContent = roomId;
shareUrl.textContent = window.location.href;

// ─── Socket.IO connection ─────────────────────────────────────────────────────
const socket = io();

// ─── 1. Get local camera + mic ────────────────────────────────────────────────
async function initLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    localVideo.srcObject = localStream;
    console.log("[+] Local media acquired");

    // Now that we have media, join the signaling room
    socket.emit("join-room", roomId);
  } catch (err) {
    console.error("getUserMedia failed:", err);
    setStatus("error", `Camera/mic access denied: ${err.message}`);
  }
}

// ─── 2. Build RTCPeerConnection ───────────────────────────────────────────────
function createPeerConnection() {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  // Add local tracks so the remote peer will receive our video/audio
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
  });

  // When the remote peer's track arrives, attach it to the <video> element
  pc.ontrack = (event) => {
    console.log("[+] Remote track received:", event.track.kind);
    if (remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      remoteOverlay.style.display = "none";
      showRemoteVideo();
    }
  };

  // Relay ICE candidates to the other peer via signaling server
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit("ice-candidate", { roomId, candidate: event.candidate });
    }
  };

  pc.oniceconnectionstatechange = () => {
    console.log("[ICE]", pc.iceConnectionState);
    updateInfoPanel();
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      setStatus("connected", "Connected");
    } else if (pc.iceConnectionState === "disconnected") {
      setStatus("waiting", "Peer disconnected");
    } else if (pc.iceConnectionState === "failed") {
      setStatus("error", "Connection failed — try refreshing");
    }
  };

  pc.onsignalingstatechange = () => updateInfoPanel();
  pc.onconnectionstatechange = () => updateInfoPanel();

  return pc;
}

// ─── 3. Offer/answer flow ─────────────────────────────────────────────────────

// Called on the waiting peer (Peer A) when Peer B joins
async function createAndSendOffer() {
  peerConnection = createPeerConnection();

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  socket.emit("offer", { roomId, offer });
  console.log("[→] Offer sent");
}

// Called on Peer B when they receive an offer from Peer A
async function handleOffer(offer) {
  peerConnection = createPeerConnection();

  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));

  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  socket.emit("answer", { roomId, answer });
  console.log("[→] Answer sent");
  updateInfoPanel();
}

// ─── Socket.IO event handlers ─────────────────────────────────────────────────

socket.on("joined", ({ isInitiator, peerCount }) => {
  console.log(`[+] Joined room "${roomId}" (initiator: ${isInitiator})`);
  if (!isInitiator) {
    setStatus("waiting", "Waiting for peer...");
    remoteWrapper.style.display = "flex";
  }
});

// Server tells A that B has arrived → A creates the offer
socket.on("peer-joined", () => {
  console.log("[+] Peer joined — creating offer");
  remoteWrapper.style.display = "flex";
  setStatus("waiting", "Connecting...");
  createAndSendOffer();
});

socket.on("offer", async ({ offer }) => {
  console.log("[←] Offer received");
  await handleOffer(offer);
});

socket.on("answer", async ({ answer }) => {
  console.log("[←] Answer received");
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  updateInfoPanel();
});

socket.on("ice-candidate", async ({ candidate }) => {
  if (!peerConnection) return;
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (err) {
    console.warn("ICE candidate error:", err);
  }
});

socket.on("peer-disconnected", () => {
  console.log("[-] Peer disconnected");
  setStatus("waiting", "Peer left the room");
  remoteVideo.srcObject = null;
  remoteOverlay.style.display = "flex";
  hideRemoteVideo();
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
});

socket.on("room-full", () => {
  setStatus("error", "Room is full (max 2 peers)");
});

// ─── UI Controls ──────────────────────────────────────────────────────────────

window.toggleMic = function () {
  if (!localStream) return;
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach((t) => (t.enabled = micEnabled));
  const btn = document.getElementById("micBtn");
  btn.querySelector(".icon").textContent = micEnabled ? "🎙" : "🔇";
  btn.querySelector("span:last-child").textContent = micEnabled ? "Mute" : "Unmute";
  btn.classList.toggle("active", !micEnabled);
};

window.toggleCam = function () {
  if (!localStream) return;
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach((t) => (t.enabled = camEnabled));
  const btn = document.getElementById("camBtn");
  btn.querySelector(".icon").textContent = camEnabled ? "📷" : "🚫";
  btn.querySelector("span:last-child").textContent = camEnabled ? "Camera" : "Camera off";
  btn.classList.toggle("active", !camEnabled);
};

window.hangup = function () {
  if (peerConnection) peerConnection.close();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  socket.disconnect();
  window.location = "/";
};

window.copyLink = function () {
  navigator.clipboard.writeText(window.location.href).then(() => {
    const btn = document.querySelector(".copy-btn");
    btn.textContent = "✅ Copied!";
    setTimeout(() => (btn.textContent = "📋 Copy link"), 2000);
  });
};

window.toggleInfo = function () {
  document.getElementById("infoPanel").classList.toggle("open");
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(state, text) {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = text;
}

function showRemoteVideo() {
  videoGrid.classList.remove("solo");
}

function hideRemoteVideo() {
  videoGrid.classList.add("solo");
}

function updateInfoPanel() {
  if (!peerConnection) return;
  document.getElementById("infoIce").textContent  = peerConnection.iceConnectionState;
  document.getElementById("infoSig").textContent  = peerConnection.signalingState;
  document.getElementById("infoConn").textContent = peerConnection.connectionState;
  document.getElementById("infoSdp").textContent  =
    peerConnection.localDescription?.type ?? "—";
}

// ─── Start ────────────────────────────────────────────────────────────────────
initLocalMedia();
