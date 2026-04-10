// room.js — Voice room: WebRTC mesh + Socket.io signalling

const socket = io();

function getQueryParam(name) {
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}

function buildShareUrl(roomId) {
  return `${window.location.origin}/room?roomId=${encodeURIComponent(roomId)}`;
}

// ── Session state ────────────────────────────────────
const urlRoomId  = getQueryParam('roomId');
const roomId     = urlRoomId || sessionStorage.getItem('roomId');
const roomName   = sessionStorage.getItem('roomName');
let username     = sessionStorage.getItem('username');

if (!roomId) {
  window.location.href = 'index.html';
}

if (!username) {
  username = prompt('Enter your callsign to join the room', 'Anon_' + Math.floor(Math.random() * 9000 + 1000));
  if (!username) {
    username = 'Anon_' + Math.floor(Math.random() * 9000 + 1000);
  }
  sessionStorage.setItem('username', username);
}

// ── WebRTC state ─────────────────────────────────────
let localStream   = null;
let isMuted       = false;
const peers       = {};   // socketId → RTCPeerConnection
const ICE_CONFIG  = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ── Init ─────────────────────────────────────────────
document.getElementById('room-title').textContent = '# ' + (roomName || roomId);
document.getElementById('room-id-badge').textContent = 'ROOM ID: ' + roomId;
document.getElementById('share-link-input').value = buildShareUrl(roomId);

socket.on('connect', async () => {
  setStatus('MIC ACCESS...');
  socket.emit('get-rooms');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    setStatus('TRANSMITTING');
    socket.emit('join-room-rtc', { roomId, username });
  } catch (err) {
    setStatus('MIC BLOCKED — ' + err.message);
    showToast('microphone access denied');
  }
});

socket.on('room-list', (rooms) => {
  if (!roomName) {
    const room = rooms.find(r => r.id === roomId);
    if (room) {
      document.getElementById('room-title').textContent = '# ' + room.name;
    }
  }
});

socket.on('disconnect', () => {
  setStatus('DISCONNECTED');
  document.getElementById('conn-status').textContent = 'OFFLINE';
});

socket.on('connect_error', () => {
  document.getElementById('conn-status').textContent = 'ERROR';
});

// ── Participants list from server ────────────────────
socket.on('room-users', (users) => {
  document.getElementById('conn-status').textContent = 'LIVE · ' + socket.id.slice(0, 6);
  renderParticipants(users);
});

// ── WebRTC signalling ────────────────────────────────

// A new peer joined — we (existing user) initiate offer
socket.on('user-joined-rtc', async ({ socketId, username: peerName }) => {
  showToast(peerName + ' joined');
  const pc = createPeerConnection(socketId, peerName);
  peers[socketId] = pc;

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('rtc-offer', { to: socketId, offer });
});

// We received an offer — answer it
socket.on('rtc-offer', async ({ from, offer, username: peerName }) => {
  const pc = createPeerConnection(from, peerName);
  peers[from] = pc;

  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('rtc-answer', { to: from, answer });
});

// We received an answer
socket.on('rtc-answer', async ({ from, answer }) => {
  const pc = peers[from];
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
});

// ICE candidate exchange
socket.on('rtc-ice', async ({ from, candidate }) => {
  const pc = peers[from];
  if (pc && candidate) {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
  }
});

// Peer left
socket.on('user-left-rtc', ({ socketId, username: peerName }) => {
  showToast((peerName || 'user') + ' left');
  if (peers[socketId]) {
    peers[socketId].close();
    delete peers[socketId];
  }
  // Remove their audio element
  const el = document.getElementById('audio-' + socketId);
  if (el) el.remove();
});

// ── Create RTCPeerConnection ─────────────────────────
function createPeerConnection(socketId, peerName) {
  const pc = new RTCPeerConnection(ICE_CONFIG);

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  // ICE candidates
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('rtc-ice', { to: socketId, candidate });
    }
  };

  // Remote audio
  pc.ontrack = ({ streams }) => {
    let audioEl = document.getElementById('audio-' + socketId);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = 'audio-' + socketId;
      audioEl.autoplay = true;
      document.getElementById('audio-elements').appendChild(audioEl);
    }
    audioEl.srcObject = streams[0];
  };

  // Connection state UI feedback
  pc.onconnectionstatechange = () => {
    const card = document.querySelector('[data-socket="' + socketId + '"]');
    if (!card) return;
    const speaking = pc.connectionState === 'connected';
    card.classList.toggle('speaking', speaking);
  };

  return pc;
}

// ── Mute / unmute ────────────────────────────────────
function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;

  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });

  const btn = document.getElementById('mute-btn');
  btn.textContent = isMuted ? '🔇 MIC OFF' : '🎙 MIC ON';
  btn.classList.toggle('muted', isMuted);

  socket.emit('mute-state', { roomId, muted: isMuted });
  setStatus(isMuted ? 'MUTED' : 'TRANSMITTING');
}

// Mute state from others
socket.on('peer-muted', ({ socketId, muted }) => {
  const card = document.querySelector('[data-socket="' + socketId + '"]');
  if (!card) return;
  const icon = card.querySelector('.muted-icon');
  if (icon) icon.style.display = muted ? 'block' : 'none';
  const status = card.querySelector('.participant-status');
  if (status) status.textContent = muted ? 'muted' : 'live';
});

// ── Leave ────────────────────────────────────────────
function leaveRoom() {
  Object.values(peers).forEach(pc => pc.close());
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  socket.emit('leave-room', { roomId });
  window.location.href = 'index.html';
}

function copyShareLink() {
  const shareInput = document.getElementById('share-link-input');
  const shareUrl = shareInput.value;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(shareUrl).then(() => showToast('link copied'));
    return;
  }

  shareInput.select();
  document.execCommand('copy');
  showToast('link copied');
}

window.addEventListener('beforeunload', () => {
  socket.emit('leave-room', { roomId });
});

// ── Render participants ──────────────────────────────
function renderParticipants(users) {
  const list = document.getElementById('participants-list');
  if (!users || users.length === 0) {
    list.innerHTML = '<div class="empty-state">// no users</div>';
    return;
  }

  list.innerHTML = users.map(u => `
    <div class="participant-card ${u.socketId === socket.id ? 'speaking' : ''}"
         data-socket="${u.socketId}">
      <div class="participant-avatar">${initials(u.username)}</div>
      <div class="participant-name">${escHtml(u.username)}</div>
      <div class="participant-status">${u.socketId === socket.id ? 'you · live' : 'live'}</div>
      <span class="muted-icon" style="display:none">🔇</span>
    </div>
  `).join('');
}

// ── Helpers ──────────────────────────────────────────
function initials(name) {
  return name.slice(0, 2).toUpperCase();
}

function setStatus(msg) {
  document.getElementById('audio-status').textContent = msg;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}