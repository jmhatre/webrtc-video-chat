# webrtc-video-chat

Browser-to-browser video and audio communication using the WebRTC API. No accounts, no plugins, no media server — once two peers connect, all video and audio flows directly between browsers, encrypted end-to-end.

A lightweight Node.js + Socket.IO server handles the initial signaling (session negotiation and ICE candidate exchange). After that handshake completes, the server is out of the media path entirely.

---

## Live demo

Open two browser tabs at the same URL:

```
http://localhost:3000/room/demo
```

Tab 1 waits. Tab 2 joins and triggers the offer/answer exchange. Within a second or two you have a live peer-to-peer video call.

---

## How WebRTC works (and what this project shows)

WebRTC is a browser API that enables direct peer-to-peer media streaming. The catch: two peers can't connect directly without first exchanging some metadata. That exchange is called **signaling**, and WebRTC deliberately doesn't define how you do it — you have to build it yourself.

This project implements signaling over Socket.IO. Here's the full connection flow:

```
Peer A (first to join)            Signaling Server          Peer B (second to join)
──────────────────────            ────────────────          ───────────────────────
getUserMedia()                                              getUserMedia()
join-room ──────────────────────────────────────────────→  join-room
          ←──────────────────── peer-joined

createOffer()
setLocalDescription(offer)
offer ──────────────────────────────────────────────────→  setRemoteDescription(offer)
                                                           createAnswer()
                                                           setLocalDescription(answer)
          ←──────────────────── answer ←─────────────────  answer
setRemoteDescription(answer)

          ←──── ICE candidates flowing both directions ────→

          ════════════ Direct P2P media stream ════════════
                    (server no longer involved)
```

**SDP (Session Description Protocol):** The offer and answer contain SDP — a text format describing what codecs, resolutions, and network formats each peer supports. The answer is the responding peer saying "here's what I can work with from your offer."

**ICE (Interactive Connectivity Establishment):** After SDP negotiation, both peers gather "ICE candidates" — possible network addresses (local IP, public IP via STUN, relayed via TURN). They exchange these through the signaling server and try each one until a direct path works.

**STUN servers:** This project uses Google's public STUN servers to help peers discover their public IP address when they're behind NAT. No TURN server is included (TURN relays media when direct connection fails — needed for ~15% of real-world scenarios with strict firewalls).

---

## Project structure

```
webrtc-video-chat/
├── server.js               # Socket.IO signaling server
├── package.json
├── Dockerfile
└── public/
    ├── index.html          # Landing page — create/join a room
    ├── room.html           # Video call UI
    └── js/
        └── client.js       # WebRTC peer connection + signaling logic
```

**server.js** manages rooms (max 2 peers each) and relays three types of messages: offers, answers, and ICE candidates. That's all a signaling server needs to do.

**client.js** is where the WebRTC work happens:
- `initLocalMedia()` — requests camera/mic access
- `createPeerConnection()` — builds the `RTCPeerConnection`, attaches local tracks, sets up ICE and track event handlers
- `createAndSendOffer()` — called by the waiting peer when someone joins
- `handleOffer()` — called by the joining peer when they receive an offer

---

## Quick start

```bash
git clone https://github.com/jmhatre/webrtc-video-chat
cd webrtc-video-chat
npm install
npm start
```

Open `http://localhost:3000` in your browser. Share the room link with someone (or open a second tab) to start a call.

### With Docker

```bash
docker build -t webrtc-video-chat .
docker run -p 3000:3000 webrtc-video-chat
```

### Dev mode (auto-restart on changes)

```bash
npm run dev
```

---

## Features

- Camera and microphone toggle (mutes track without stopping stream)
- One-click room link copy
- Connection info panel showing ICE state, signaling state, SDP type
- Clean disconnect handling — remaining peer is notified when partner leaves
- Rooms auto-close when both peers disconnect

---

## Limitations and production notes

This is a learning project. For a production deployment you'd want:

- **TURN server** — for peers behind symmetric NAT or strict firewalls (~15% of connections). [Coturn](https://github.com/coturn/coturn) is the standard open-source option.
- **HTTPS** — `getUserMedia()` requires a secure origin in production. Use a reverse proxy (nginx + Let's Encrypt).
- **Mesh vs. SFU** — this project is strictly 1:1. Group calls need either a mesh (N*(N-1)/2 peer connections, gets expensive fast) or a Selective Forwarding Unit (media server that receives one stream and fans it out).
- **Room auth** — anyone who knows the room name can join. Add token-based auth to the signaling layer if rooms need to be private.

---

## Background

Built as part of graduate research in Network Security at San Jose State University, exploring browser-native APIs for real-time communication. The original implementation used raw WebSocket signaling and a single HTML file. This version separates concerns cleanly (signaling server, room UI, client logic) and adds proper ICE handling, connection state tracking, and a production-ready Dockerfile.

---

## License

MIT
