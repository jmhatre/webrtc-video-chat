/**
 * server.js — WebRTC Signaling Server
 * ─────────────────────────────────────────────────────────────────────────────
 * WebRTC peers need to exchange three things before they can talk directly:
 *   1. Session descriptions (SDP offer/answer) — what codecs, formats each
 *      peer supports
 *   2. ICE candidates — the network addresses each peer can be reached at
 *
 * This server handles that exchange using Socket.IO rooms. Once signaling is
 * complete, all audio/video data flows directly peer-to-peer — this server
 * is no longer in the media path.
 *
 * Room model:
 *   - Any user can create or join a named room (e.g. /room/my-meeting)
 *   - First user in a room waits; second user triggers the offer/answer flow
 *   - Rooms are limited to 2 peers (for simplicity — mesh N-peer would need
 *     a different signaling model)
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const PORT = process.env.PORT || 3000;

// Track active rooms: roomId → Set of socket IDs
const rooms = new Map();

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// Room page route
app.get("/room/:roomId", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "room.html"));
});

// ─── Socket.IO signaling ──────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] Client connected: ${socket.id}`);

  /**
   * join-room
   * Client requests to join a named room.
   * If room is empty → they wait as the "caller" (will receive offer later)
   * If room has one peer → they join and trigger the offer/answer exchange
   */
  socket.on("join-room", (roomId) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }

    const room = rooms.get(roomId);

    if (room.size >= 2) {
      socket.emit("room-full");
      console.log(`[!] Room ${roomId} is full`);
      return;
    }

    room.add(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;

    const isInitiator = room.size === 2;
    socket.emit("joined", { roomId, isInitiator, peerCount: room.size });

    console.log(
      `[+] ${socket.id} joined room "${roomId}" ` +
      `(${room.size}/2 peers, initiator: ${isInitiator})`
    );

    if (isInitiator) {
      // Tell the first peer that someone joined — they should now send an offer
      socket.to(roomId).emit("peer-joined");
    }
  });

  /**
   * offer
   * Initiating peer sends an SDP offer to the other peer in the room.
   * We relay it through the server — the peers don't know each other's
   * socket IDs, only the room name.
   */
  socket.on("offer", ({ roomId, offer }) => {
    console.log(`[→] Offer from ${socket.id} in room "${roomId}"`);
    socket.to(roomId).emit("offer", { offer, from: socket.id });
  });

  /**
   * answer
   * Receiving peer responds with an SDP answer.
   */
  socket.on("answer", ({ roomId, answer }) => {
    console.log(`[→] Answer from ${socket.id} in room "${roomId}"`);
    socket.to(roomId).emit("answer", { answer });
  });

  /**
   * ice-candidate
   * Both peers continuously emit ICE candidates as they discover them.
   * We relay each one to the other peer.
   */
  socket.on("ice-candidate", ({ roomId, candidate }) => {
    socket.to(roomId).emit("ice-candidate", { candidate });
  });

  /**
   * Cleanup when a peer disconnects
   */
  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (roomId && rooms.has(roomId)) {
      rooms.get(roomId).delete(socket.id);
      if (rooms.get(roomId).size === 0) {
        rooms.delete(roomId);
        console.log(`[-] Room "${roomId}" closed`);
      } else {
        // Notify remaining peer that their partner left
        socket.to(roomId).emit("peer-disconnected");
        console.log(`[-] ${socket.id} left room "${roomId}"`);
      }
    }
    console.log(`[-] Client disconnected: ${socket.id}`);
  });
});

// ─── Active rooms API (useful for debugging) ──────────────────────────────────
app.get("/api/rooms", (req, res) => {
  const summary = {};
  rooms.forEach((peers, roomId) => {
    summary[roomId] = peers.size;
  });
  res.json(summary);
});

server.listen(PORT, () => {
  console.log(`\n[*] WebRTC Signaling Server running on http://localhost:${PORT}`);
  console.log(`[*] Open two browser tabs at http://localhost:${PORT}/room/demo\n`);
});
