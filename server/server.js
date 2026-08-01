const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Serve static frontend assets
app.use(express.static(path.join(__dirname, '../client')));

// Socket.io Room & Signaling Handler
io.on('connection', (socket) => {
  console.log(`[+] Socket connected: ${socket.id}`);

  // Phase 1: Room Creation / Joining
  socket.on('create-or-join-room', (roomId) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    const numClients = room ? room.size : 0;

    if (numClients === 0) {
      socket.join(roomId);
      socket.emit('room-peers', { isInitiator: true, peers: [socket.id] });
      console.log(`Room [${roomId}] created by ${socket.id}`);
    } else if (numClients === 1) {
      socket.join(roomId);
      const peers = Array.from(io.sockets.adapter.rooms.get(roomId));
      
      // Notify both peers in the room
      io.to(roomId).emit('room-peers', { isInitiator: false, peers });
      console.log(`Peer ${socket.id} joined room [${roomId}]`);
    } else {
      // Room is full (LocalDrop Global strictly supports 1-to-1 rooms)
      socket.emit('room-full', { roomId });
    }
  });

  // Relay WebRTC & Cryptographic Signals transparently
  socket.on('send-signal', ({ target, data }) => {
    io.to(target).emit('signal', {
      from: socket.id,
      data
    });
  });

  socket.on('disconnecting', () => {
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        socket.to(room).emit('peer-disconnected', { peerId: socket.id });
      }
    }
  });

  socket.on('disconnect', () => {
    console.log(`[-] Socket disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 LocalDrop Global running on http://localhost:${PORT}`);
});
