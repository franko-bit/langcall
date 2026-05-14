// server.js — VoxGrid signalling server with authentication
// Node.js + Express + Socket.io + Session management

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');
const bodyParser = require('body-parser');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// ── Session configuration ────────────────────────────
app.use(bodyParser.urlencoded({ extended: false }));
app.use(session({
  secret: 'your-secret-key-change-this',
  resave: false,
  saveUninitialized: true,
  cookie: { 
    secure: false,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// ── Simple in-memory user database ──────────────────
const users = new Map();
users.set('test@example.com', {
  id: 1,
  email: 'test@example.com',
  password: 'password123',
  fullName: 'Test User'
});
users.set('alice@example.com', {
  id: 2,
  email: 'alice@example.com',
  password: 'alice123',
  fullName: 'Alice Johnson'
});
users.set('bob@example.com', {
  id: 3,
  email: 'bob@example.com',
  password: 'bob123',
  fullName: 'Bob Smith'
});

// ── Middleware to check authentication ──────────────
function requireAuth(req, res, next) {
  if (req.session.user) {
    next();
  } else {
    // Preserve the intended destination for redirect after login
    const returnTo = req.originalUrl || '/';
    res.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Authentication Routes ────────────────────────────

app.get('/login', (req, res) => {
  if (req.session.user) {
    const returnTo = req.query.returnTo || '/';
    return res.redirect(returnTo);
  }
  
  const error = req.query.error || '';
  const returnTo = req.query.returnTo || '/';
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign In · Free4Talk</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg-base: #0c0c0c;
      --bg-surface: #121212;
      --bg-elevated: #1a1a1a;
      --text-primary: #f0f0ea;
      --text-muted: #8a8a82;
      --accent-lime: #c8f04a;
      --border-subtle: #2c2c2c;
    }
    body {
      font-family: 'Inter', sans-serif;
      background: var(--bg-base);
      color: var(--text-primary);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
    }
    .login-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 40px;
      max-width: 400px;
      width: 100%;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 24px;
    }
    .logo-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--accent-lime);
    }
    .logo-text {
      font-weight: 700;
      font-size: 16px;
      letter-spacing: 2px;
    }
    h1 {
      font-size: 24px;
      margin-bottom: 8px;
      font-weight: 700;
    }
    .subtitle {
      color: var(--text-muted);
      font-size: 14px;
      margin-bottom: 32px;
    }
    .form-group {
      margin-bottom: 20px;
    }
    label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
      color: var(--text-muted);
    }
    input {
      width: 100%;
      padding: 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 14px;
      outline: none;
      transition: all 0.2s;
    }
    input:focus {
      border-color: var(--accent-lime);
      background: #0a0a0a;
    }
    input::placeholder {
      color: var(--text-muted);
    }
    .error {
      background: rgba(255, 90, 90, 0.1);
      border: 1px solid #ff5a5a;
      color: #ff5a5a;
      padding: 12px;
      border-radius: 6px;
      font-size: 13px;
      margin-bottom: 20px;
      display: ${error ? 'block' : 'none'};
    }
    .btn {
      width: 100%;
      padding: 12px;
      background: var(--accent-lime);
      color: var(--bg-base);
      border: none;
      border-radius: 6px;
      font-weight: 700;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s;
    }
    .btn:hover {
      opacity: 0.9;
      transform: translateY(-1px);
    }
    .hint {
      margin-top: 20px;
      padding-top: 20px;
      border-top: 1px solid var(--border-subtle);
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="logo">
      <div class="logo-dot"></div>
      <div class="logo-text">FREE4TALK</div>
    </div>
    <h1>Welcome back</h1>
    <p class="subtitle">Sign in to your account</p>
    
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    
    <form method="POST" action="/login">
      <div class="form-group">
        <label>Email</label>
        <input type="email" name="email" placeholder="test@example.com" required autofocus>
      </div>
      <div class="form-group">
        <label>Password</label>
        <input type="password" name="password" placeholder="••••••••" required>
      </div>
      <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">
      <button class="btn">Sign In</button>
    </form>
    
    <div class="hint">
      <strong>Demo accounts:</strong><br>
      Email: test@example.com<br>
      Password: password123<br><br>
      Or: alice@example.com / alice123<br>
      Or: bob@example.com / bob123
    </div>
  </div>
</body>
</html>
  `);
});

// Handle login submission
app.post('/login', (req, res) => {
  const { email, password, returnTo } = req.body;
  const destination = returnTo || '/';
  
  if (!email || !password) {
    return res.redirect(`/login?error=Email and password are required&returnTo=${encodeURIComponent(destination)}`);
  }
  
  const user = users.get(email);
  
  if (!user || user.password !== password) {
    return res.redirect(`/login?error=Invalid email or password&returnTo=${encodeURIComponent(destination)}`);
  }
  
  // Create session
  req.session.user = {
    id: user.id,
    email: user.email,
    fullName: user.fullName
  };
  
  // Redirect to the originally requested page, or home if not specified
  res.redirect(destination);
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// API endpoint to check current user (for JavaScript)
app.get('/api/user', (req, res) => {
  if (req.session.user) {
    res.json({
      success: true,
      user: req.session.user
    });
  } else {
    res.json({
      success: false,
      user: null
    });
  }
});

// ── Serve static files ───────────────────────────────
app.use(express.static(path.join(__dirname)));

// Protected routes
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/room', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'room.html'));
});

// ── In-memory room store ─────────────────────────────
// rooms: Map<roomId, { id, name, scenario, cefrLevel, targetFunction, users: Map<socketId, { socketId, username, role, muted }>, vocab: Array, grammar: Array }>
const rooms = new Map();

function countRoomRoles(room) {
  const counts = { nativeCount: 0, advCount: 0, begCount: 0 };
  room.users.forEach(user => {
    if (user.role === 'native') counts.nativeCount += 1;
    else if (user.role === 'advanced') counts.advCount += 1;
    else if (user.role === 'beginner') counts.begCount += 1;
  });
  return counts;
}

function getRoomList() {
  return [...rooms.values()].map(r => ({
    id:            r.id,
    name:          r.name,
    scenario:      r.scenario,
    cefrLevel:     r.cefrLevel,
    targetFunction:r.targetFunction,
    userCount:     r.users.size,
    ...countRoomRoles(r)
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
  socket.on('create-room', ({ name, username, role, scenario, cefrLevel, targetFunction }, cb) => {
    if (!name || !username) return cb({ error: 'missing fields' });

    const roomId = uuidv4();
    const users = new Map();
    
    // Add creator as first participant
    users.set(socket.id, {
      socketId: socket.id,
      username,
      role:     role || 'learner',
      muted:    false,
      isCreator: true
    });

    rooms.set(roomId, {
      id:             roomId,
      name:           name.trim(),
      scenario:       scenario ? scenario.trim() : name.trim(),
      cefrLevel:      cefrLevel || '',
      targetFunction: targetFunction || '',
      users:          users,
      vocab:          [],
      grammar:        [],
      reactionCounts: {},
      creatorSocketId: socket.id
    });

    // Join room immediately
    socket._roomId   = roomId;
    socket._username = username;
    socket.join(roomId);

    console.log('[room] created:', name, roomId, 'by', username);
    broadcastRoomList();
    cb({
      roomId,
      roomName:       name.trim(),
      scenario:       scenario ? scenario.trim() : name.trim(),
      cefrLevel:      cefrLevel || '',
      targetFunction: targetFunction || ''
    });
  });

  // ── Join room (pre-WebRTC, just for routing) ───────
  socket.on('join-room', ({ roomId, username }, cb) => {
    const room = rooms.get(roomId);
    if (!room) return cb({ error: 'room not found' });
    cb({
      roomName:       room.name,
      scenario:       room.scenario || room.name,
      cefrLevel:      room.cefrLevel || '',
      targetFunction: room.targetFunction || ''
    });
  });

  // ── Join room RTC (actual signalling join) ─────────
  socket.on('join-room-rtc', ({ roomId, username, role }) => {
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
        username,
        role:     role || 'learner'
      });
    });

    // Add user to room
    room.users.set(socket.id, {
      socketId: socket.id,
      username,
      role:     role || 'learner',
      muted:    false
    });

    socket.join(roomId);

    // Send full user list and existing room data to the joining user
    socket.emit('room-users', [...room.users.values()]);
    socket.emit('vocab-snapshot', room.vocab);
    socket.emit('grammar-snapshot', room.grammar);

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
      broadcastRoomList();
    }
  });

  socket.on('speech-activity', ({ roomId, speaking }) => {
    if (!rooms.has(roomId)) return;
    socket.to(roomId).emit('peer-speaking', { socketId: socket.id, speaking });
  });

  socket.on('reaction', ({ roomId, emoji }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.reactionCounts[emoji] = (room.reactionCounts[emoji] || 0) + 1;
    io.to(roomId).emit('reaction-received', {
      emoji,
      counts: room.reactionCounts
    });
  });

  socket.on('vocab-add', ({ roomId, word, definition, context }) => {
    const room = rooms.get(roomId);
    if (!room || !word) return;
    const entry = { word: word.trim(), definition: definition?.trim() || '', context: context?.trim() || '' };
    room.vocab.unshift(entry);
    io.to(roomId).emit('vocab-new', entry);
  });

  socket.on('grammar-pin', ({ roomId, label, pattern, example }) => {
    const room = rooms.get(roomId);
    if (!room || !label || !pattern) return;
    const pin = { label: label.trim(), pattern: pattern.trim(), example: example?.trim() || '' };
    room.grammar.unshift(pin);
    io.to(roomId).emit('grammar-pinned', pin);
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
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  VoxGrid running → http://localhost:${PORT}`);
  console.log(`  On your network → http://192.168.1.105:${PORT}\n`);
  console.log('  Demo accounts:');
  console.log('    test@example.com / password123');
  console.log('    alice@example.com / alice123');
  console.log('    bob@example.com / bob123\n');
});