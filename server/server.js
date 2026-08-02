const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, '../client')));

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create-or-join-room', (roomId) => {
    currentRoom = roomId;
    const room = io.sockets.adapter.rooms.get(roomId);
    const numClients = room ? room.size : 0;

    if (numClients === 0) {
      socket.join(roomId);
      socket.emit('room-peers', { isInitiator: true, peers: [socket.id] });
    } else if (numClients === 1) {
      socket.join(roomId);
      const peers = Array.from(io.sockets.adapter.rooms.get(roomId));
      
      // Notify both peers of updated room list
      io.to(roomId).emit('room-peers', { isInitiator: false, peers });
      
      // Prompt the initiator to start the WebRTC offer
      socket.to(roomId).emit('ready-to-connect');
    } else {
      socket.emit('room-full', { roomId });
    }
  });

  // Relay WebRTC Signaling Messages (Offer, Answer, ICE Candidates)
  socket.on('signal', ({ targetId, signalData }) => {
    io.to(targetId).emit('signal', {
      senderId: socket.id,
      signalData
    });
  });

  socket.on('disconnect', () => {
    if (currentRoom) {
      socket.to(currentRoom).emit('peer-disconnected', { peerId: socket.id });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});