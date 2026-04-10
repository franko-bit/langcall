// app.js — Lobby logic

const socket = io();
let pendingRoomId = null;

// ── Connection status ────────────────────────────────
socket.on('connect', () => {
  document.getElementById('server-status').textContent = 'ONLINE · ' + socket.id.slice(0, 6);
  socket.emit('get-rooms');
});

socket.on('disconnect', () => {
  document.getElementById('server-status').textContent = 'OFFLINE';
});

// ── Room list ────────────────────────────────────────
socket.on('room-list', (rooms) => {
  renderRooms(rooms);
});

socket.on('rooms-updated', (rooms) => {
  renderRooms(rooms);
});

function renderRooms(rooms) {
  const list = document.getElementById('room-list');

  if (!rooms || rooms.length === 0) {
    list.innerHTML = '<div class="empty-state">// no active channels — be the first to transmit</div>';
    return;
  }

  list.innerHTML = rooms.map(room => `
    <div class="room-item">
      <div class="room-info">
        <div class="room-name">
          <span class="room-dot"></span>${escHtml(room.name)}
        </div>
        <div class="room-meta">
          ${room.userCount} user${room.userCount !== 1 ? 's' : ''} · ID: ${room.id.slice(0, 8)}
        </div>
      </div>
      <button class="btn btn-ghost" onclick="openJoinModal('${room.id}', '${escHtml(room.name)}')">
        → JOIN
      </button>
    </div>
  `).join('');
}

// ── Create room ──────────────────────────────────────
function createRoom() {
  const nameInput = document.getElementById('room-name-input');
  const usernameInput = document.getElementById('username-create');

  const roomName = nameInput.value.trim();
  const username = usernameInput.value.trim() || 'Anon_' + Math.floor(Math.random() * 9000 + 1000);

  if (!roomName) {
    showToast('enter a channel name first');
    nameInput.focus();
    return;
  }

  socket.emit('create-room', { name: roomName, username }, (response) => {
    if (response.error) {
      showToast('error: ' + response.error);
      return;
    }
    // Navigate to room and preserve the generated room ID for sharing
    sessionStorage.setItem('username', username);
    sessionStorage.setItem('roomId', response.roomId);
    sessionStorage.setItem('roomName', response.roomName);
    window.location.href = 'room.html?roomId=' + encodeURIComponent(response.roomId);
  });
}

// ── Join modal ───────────────────────────────────────
function openJoinModal(roomId, roomName) {
  pendingRoomId = roomId;
  document.getElementById('join-room-label').textContent = '# ' + roomName;
  const modal = document.getElementById('join-modal');
  modal.style.display = 'flex';
  document.getElementById('username-join').focus();
}

function closeModal() {
  document.getElementById('join-modal').style.display = 'none';
  pendingRoomId = null;
}

function confirmJoin() {
  if (!pendingRoomId) return;
  const usernameInput = document.getElementById('username-join');
  const username = usernameInput.value.trim() || 'Anon_' + Math.floor(Math.random() * 9000 + 1000);

  socket.emit('join-room', { roomId: pendingRoomId, username }, (response) => {
    if (response.error) {
      showToast('error: ' + response.error);
      return;
    }
    sessionStorage.setItem('username', username);
    sessionStorage.setItem('roomId', pendingRoomId);
    sessionStorage.setItem('roomName', response.roomName);
    window.location.href = 'room.html';
  });
}

// Close modal on backdrop click
document.getElementById('join-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

// Enter key to create room
document.getElementById('room-name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') createRoom();
});

document.getElementById('username-join').addEventListener('keydown', e => {
  if (e.key === 'Enter') confirmJoin();
});

// ── Toast ────────────────────────────────────────────
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