const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || '*';

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST']
  }
});

// Serve client static files
app.use(express.static(path.join(__dirname, '../client')));

// Socket.io Room Logic
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('create-or-join-room', (roomId) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    const numClients = room ? room.size : 0;

    if (numClients === 0) {
      socket.join(roomId);
      socket.emit('room-peers', { isInitiator: true, peers: [socket.id] });
    } else if (numClients === 1) {
      socket.join(roomId);
      const peers = Array.from(io.sockets.adapter.rooms.get(roomId));
      io.to(roomId).emit('room-peers', { isInitiator: false, peers });
      io.to(roomId).emit('ready-to-connect');
    } else {
      socket.emit('room-full', { roomId });
    }
  });

  socket.on('signal', ({ targetId, signalData }) => {
    io.to(targetId).emit('signal', {
      senderId: socket.id,
      signalData
    });
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomId !== socket.id) {
        socket.to(roomId).emit('peer-disconnected', { peerId: socket.id });
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`FileShare Server running on http://localhost:${PORT}`);
});