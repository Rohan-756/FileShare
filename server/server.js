require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST']
  }
});

// Serve static frontend assets
app.use(express.static(path.join(__dirname, '../client')));

// SPA Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

// Room tracking structure: Map<roomId, Set<socketId>>
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`[Socket Connected]: ${socket.id}`);

  socket.on('create-or-join-room', (roomId) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }

    const roomPeers = rooms.get(roomId);

    // Prune stale/disconnected sockets from the room set before checking size
    for (const id of Array.from(roomPeers)) {
      if (!io.sockets.sockets.has(id)) {
        roomPeers.delete(id);
      }
    }

    // If this socket is already in the room, don't re-add
    if (roomPeers.has(socket.id)) {
      return;
    }

    // Enforce max 2 peers per P2P transfer room
    if (roomPeers.size >= 2) {
      socket.emit('room-full', { roomId });
      return;
    }

    roomPeers.add(socket.id);
    socket.join(roomId);
    socket.roomId = roomId;

    const peersArray = Array.from(roomPeers);
    const isInitiator = peersArray.length === 1;

    // Send updated peer list to everyone in room
    io.to(roomId).emit('room-peers', {
      isInitiator,
      peers: peersArray
    });

    // When 2 peers join, trigger connection signaling
    if (roomPeers.size === 2) {
      io.to(roomId).emit('ready-to-connect');
    }
  });

  // Relay WebRTC signaling messages (offers, answers, candidates)
  socket.on('signal', ({ targetId, signalData }) => {
    io.to(targetId).emit('signal', {
      senderId: socket.id,
      signalData
    });
  });

  // Handle peer disconnect immediately when tab closes or refreshes
  socket.on('disconnecting', () => {
    const roomId = socket.roomId;
    if (roomId && rooms.has(roomId)) {
      const roomPeers = rooms.get(roomId);
      roomPeers.delete(socket.id);

      const remainingPeers = Array.from(roomPeers);

      // Clean up empty rooms
      if (roomPeers.size === 0) {
        rooms.delete(roomId);
      } else {
        // Notify remaining peers
        socket.to(roomId).emit('peer-left', {
          peerId: socket.id,
          roomSize: roomPeers.size
        });

        socket.to(roomId).emit('peer-disconnected', {
          peerId: socket.id
        });

        io.to(roomId).emit('room-peers', {
          isInitiator: true,
          peers: remainingPeers
        });
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket Disconnected]: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`>>> WebRTC Transfer Server active on http://localhost:${PORT}`);
});