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

// Room tracking structure: { roomId: Set(socketIds) }
const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`[Socket Connected]: ${socket.id}`);

  socket.on('create-or-join-room', (roomId) => {
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }

    const roomPeers = rooms.get(roomId);

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

  socket.on('disconnect', () => {
    console.log(`[Socket Disconnected]: ${socket.id}`);
    const roomId = socket.roomId;

    if (roomId && rooms.has(roomId)) {
      const roomPeers = rooms.get(roomId);
      roomPeers.delete(socket.id);

      if (roomPeers.size === 0) {
        rooms.delete(roomId);
      } else {
        socket.to(roomId).emit('peer-disconnected', { peerId: socket.id });
        io.to(roomId).emit('room-peers', {
          isInitiator: true,
          peers: Array.from(roomPeers)
        });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`>>> WebRTC Transfer Server active on http://localhost:${PORT}`);
});