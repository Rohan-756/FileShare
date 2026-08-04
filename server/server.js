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

// Room tracking structure: Map<roomId, Map<socketId, peerProfile>>
const rooms = new Map();

function leaveCurrentRoom(socket) {
  const currentRoomId = socket.roomId;
  if (currentRoomId && rooms.has(currentRoomId)) {
    const roomPeers = rooms.get(currentRoomId);
    roomPeers.delete(socket.id);

    const remainingPeers = Array.from(roomPeers.values());

    if (roomPeers.size === 0) {
      rooms.delete(currentRoomId);
    } else {
      socket.to(currentRoomId).emit('peer-left', {
        peerId: socket.id,
        roomSize: roomPeers.size
      });

      socket.to(currentRoomId).emit('peer-disconnected', {
        peerId: socket.id
      });

      io.to(currentRoomId).emit('room-peers', {
        isInitiator: true,
        peers: remainingPeers
      });
    }

    socket.leave(currentRoomId);
    socket.roomId = null;
  }
}

io.on('connection', (socket) => {
  console.log(`[Socket Connected]: ${socket.id}`);

  socket.on('create-or-join-room', (payload) => {
    let roomId;
    let userInfo = {};

    if (typeof payload === 'object' && payload !== null) {
      roomId = payload.roomId;
      userInfo = payload.userInfo || {};
    } else {
      roomId = payload;
    }

    if (!roomId) return;

    // If switching rooms, leave previous room first
    if (socket.roomId && socket.roomId !== roomId) {
      leaveCurrentRoom(socket);
    }

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }

    const roomPeers = rooms.get(roomId);

    // Prune stale/disconnected sockets
    for (const id of Array.from(roomPeers.keys())) {
      if (!io.sockets.sockets.has(id)) {
        roomPeers.delete(id);
      }
    }

    if (roomPeers.has(socket.id)) {
      roomPeers.set(socket.id, {
        socketId: socket.id,
        userId: userInfo.userId || socket.id,
        name: userInfo.name || 'Anonymous Peer',
        avatar: userInfo.avatar || ''
      });
      return;
    }

    if (roomPeers.size >= 2) {
      socket.emit('room-full', { roomId });
      return;
    }

    const peerData = {
      socketId: socket.id,
      userId: userInfo.userId || socket.id,
      name: userInfo.name || 'Anonymous Peer',
      avatar: userInfo.avatar || ''
    };

    roomPeers.set(socket.id, peerData);
    socket.join(roomId);
    socket.roomId = roomId;

    const peersArray = Array.from(roomPeers.values());

    roomPeers.forEach((peer, peerSocketId) => {
      const isPeerInitiator = peersArray[0].socketId === peerSocketId;
      io.to(peerSocketId).emit('room-peers', {
        isInitiator: isPeerInitiator,
        peers: peersArray
      });
    });

    if (roomPeers.size === 2) {
      io.to(roomId).emit('ready-to-connect');
    }
  });

  socket.on('signal', ({ targetId, signalData }) => {
    io.to(targetId).emit('signal', {
      senderId: socket.id,
      signalData
    });
  });

  socket.on('disconnecting', () => {
    leaveCurrentRoom(socket);
  });

  socket.on('disconnect', () => {
    console.log(`[Socket Disconnected]: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`>>> WebRTC Transfer Server active on http://localhost:${PORT}`);
});