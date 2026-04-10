// server.js — VoxGrid signalling server
// Node.js + Express + Socket.io

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// ── Serve static files ───────────────────────────────
app.use(express.static(path.join(__dirname)));

app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/room', (_, res) => res.sendFile(path.join(__dirname, 'room.html')));

// ── In-memory room store ─────────────────────────────
// rooms: Map<roomId, { id, name, users: Map<socketId, { socketId, username, muted }> }>
const rooms = new Map();

function getRoomList() {
  return [...rooms.values()].map(r => ({
    id:        r.id,
    name:      r.name,
    userCount: r.users.size
  }));
}

function broadcastRoomList() {
  io.emit('rooms-updated', getRoomList());
}

// ── Socket.io ────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[+] connected:', socket.id);

  // Send current room list on request
  socket.on('get-rooms', () => {
    socket.emit('room-list', getRoomList());
  });

  // ── Create room ────────────────────────────────────
  socket.on('create-room', ({ name, username }, cb) => {
    if (!name || !username) return cb({ error: 'missing fields' });

    const roomId = uuidv4();
    rooms.set(roomId, {
      id:    roomId,
      name:  name.trim(),
      users: new Map()
    });

    console.log('[room] created:', name, roomId);
    broadcastRoomList();
    cb({ roomId, roomName: name.trim() });
  });

  // ── Join room (pre-WebRTC, just for routing) ───────
  socket.on('join-room', ({ roomId, username }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: 'room not found' });
    cb({ roomName: room.name });
  });

  // ── Join room RTC (actual signalling join) ─────────
  socket.on('join-room-rtc', ({ roomId, username }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error-msg', 'room not found');
      return;
    }

    // Track which room this socket is in
    socket._roomId   = roomId;
    socket._username = username;

    // Notify existing users to initiate offers TO the new peer
    room.users.forEach((_, existingSocketId) => {
      io.to(existingSocketId).emit('user-joined-rtc', {
        socketId: socket.id,
        username
      });
    });

    // Add user to room
    room.users.set(socket.id, { socketId: socket.id, username, muted: false });

    socket.join(roomId);

    // Send full user list to the joining user
    socket.emit('room-users', [...room.users.values()]);

    // Also update everyone else's list
    socket.to(roomId).emit('room-users', [...room.users.values()]);

    broadcastRoomList();
    console.log(`[room] ${username} joined ${room.name}`);
  });

  // ── WebRTC signalling pass-through ────────────────
  socket.on('rtc-offer', ({ to, offer }) => {
    io.to(to).emit('rtc-offer', {
      from:     socket.id,
      offer,
      username: socket._username
    });
  });

  socket.on('rtc-answer', ({ to, answer }) => {
    io.to(to).emit('rtc-answer', { from: socket.id, answer });
  });

  socket.on('rtc-ice', ({ to, candidate }) => {
    io.to(to).emit('rtc-ice', { from: socket.id, candidate });
  });

  // ── Mute state ─────────────────────────────────────
  socket.on('mute-state', ({ roomId, muted }) => {
    const room = rooms.get(roomId);
    if (room && room.users.has(socket.id)) {
      room.users.get(socket.id).muted = muted;
      socket.to(roomId).emit('peer-muted', { socketId: socket.id, muted });
    }
  });

  // ── Leave room ─────────────────────────────────────
  socket.on('leave-room', ({ roomId }) => {
    handleLeave(socket, roomId);
  });

  // ── Disconnect ─────────────────────────────────────
  socket.on('disconnect', () => {
    console.log('[-] disconnected:', socket.id);
    if (socket._roomId) handleLeave(socket, socket._roomId);
  });
});

// ── Leave helper ─────────────────────────────────────
function handleLeave(socket, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const username = socket._username || 'unknown';
  room.users.delete(socket.id);
  socket.leave(roomId);

  // Notify remaining peers to clean up WebRTC connection
  socket.to(roomId).emit('user-left-rtc', {
    socketId: socket.id,
    username
  });

  // Update remaining users' participant lists
  if (room.users.size > 0) {
    io.to(roomId).emit('room-users', [...room.users.values()]);
  }

  // Delete empty rooms
  if (room.users.size === 0) {
    rooms.delete(roomId);
    console.log('[room] deleted empty room:', room.name);
  }

  broadcastRoomList();
  console.log(`[room] ${username} left ${room.name}`);
}

// ── Start ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n  VoxGrid running → http://localhost:${PORT}\n`);
});