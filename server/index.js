const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '../client')));

const rooms = {};
const pendingUploads = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Create room — generate a shared AES key for the whole room
  socket.on('create-room', (username) => {
    const roomCode = generateRoomCode();
    const roomKey = crypto.randomBytes(32).toString('hex');
    rooms[roomCode] = { users: {}, key: roomKey, files: [] };
    socket.username = username;
    socket.roomCode = roomCode;
    rooms[roomCode].users[socket.id] = { id: socket.id, username };
    socket.join(roomCode);
    socket.emit('room-created', { roomCode, users: rooms[roomCode].users, roomKey });
    console.log(`${username} created room ${roomCode}`);
  });

  // Join room — receive the room key and existing files
  socket.on('join-room', ({ username, roomCode }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('room-error', 'Room not found! Check the code and try again.');
      return;
    }
    socket.username = username;
    socket.roomCode = roomCode;
    room.users[socket.id] = { id: socket.id, username };
    socket.join(roomCode);
    socket.emit('room-joined', {
      roomCode,
      users: room.users,
      roomKey: room.key,
      files: room.files.map(f => ({
        fileId: f.fileId, filename: f.filename,
        fileSize: f.fileSize, fromName: f.fromName, time: f.time
      }))
    });
    socket.to(roomCode).emit('user-joined', { id: socket.id, username });
    console.log(`${username} joined room ${roomCode}`);
  });

  // File upload init
  socket.on('room-file-init', ({ filename, totalChunks, fileSize, iv, transferId }) => {
    pendingUploads[transferId] = {
      filename, totalChunks, fileSize, iv,
      fromId: socket.id,
      fromName: socket.username || 'Unknown',
      roomCode: socket.roomCode,
      chunks: [],
      received: 0
    };
  });

  // Receive chunks and store them
  socket.on('room-file-chunk', ({ chunk, chunkIndex, transferId }) => {
    const upload = pendingUploads[transferId];
    if (!upload) return;

    upload.chunks[chunkIndex] = chunk;
    upload.received++;

    socket.emit('chunk-ack', { chunkIndex, transferId });

    if (upload.received === upload.totalChunks) {
      const { roomCode, filename, fileSize, iv, fromId, fromName, chunks } = upload;
      const fileId = crypto.randomBytes(8).toString('hex');
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      if (rooms[roomCode]) {
        rooms[roomCode].files.push({ fileId, filename, fileSize, iv, fromId, fromName, chunks, time });

        // Tell everyone in the room a new file is available
        io.to(roomCode).emit('room-file-available', {
          fileId, filename, fileSize, fromName, time
        });
      }

      delete pendingUploads[transferId];
      console.log(`"${filename}" shared in room ${roomCode}`);
    }
  });

  // Someone wants to download a file
  socket.on('download-file', ({ fileId }) => {
    const room = rooms[socket.roomCode];
    if (!room) return;

    const file = room.files.find(f => f.fileId === fileId);
    if (!file) return;

    socket.emit('download-start', {
      fileId, filename: file.filename,
      totalChunks: file.chunks.length, iv: file.iv
    });

    file.chunks.forEach((chunk, index) => {
      socket.emit('download-chunk', { chunk, chunkIndex: index, fileId });
    });
  });

  // Chat
  socket.on('chat-message', ({ roomCode, message }) => {
    console.log(`Message from ${socket.username} in room ${roomCode}: ${message}`);
    io.to(roomCode).emit('chat-message', {
      from: socket.id,
      fromName: socket.username || 'Unknown',
      message,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
  });

  socket.on('disconnect', () => {
    const { roomCode, username } = socket;
    if (roomCode && rooms[roomCode]) {
      delete rooms[roomCode].users[socket.id];
      io.to(roomCode).emit('user-left', { id: socket.id });
      if (Object.keys(rooms[roomCode].users).length === 0) {
        delete rooms[roomCode];
        console.log(`Room ${roomCode} deleted`);
      }
    }
    console.log(`${username || socket.id} disconnected`);
  });
});

server.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
});