// app.js — Lobby logic

const socket = io();
let pendingRoomId   = null;
let allRooms        = [];
let activeFilter    = 'all';
let searchQuery     = '';
let sortMode        = 'default';

// Fetch current logged-in user
let currentUser = null;
fetch('/api/user')
  .then(res => res.json())
  .then(data => {
    if (data.success && data.user) {
      currentUser = data.user;
      console.log('Logged in as:', currentUser.fullName);
    } else {
      window.location.href = '/login';
    }
  })
  .catch(() => window.location.href = '/login');

// ── Connection status ─────────────────────────────────
socket.on('connect', () => {
  socket.emit('get-rooms');
});

socket.on('disconnect', () => {
  // handle disconnect
});

// ── Room list ─────────────────────────────────────────
socket.on('room-list',     rooms => { allRooms = rooms; renderRooms(); });
socket.on('rooms-updated', rooms => { allRooms = rooms; renderRooms(); });

function renderRooms() {
  const list = document.getElementById('roomsGrid');
  const query = searchQuery.trim().toLowerCase();

  let filtered = allRooms;
  if (activeFilter !== 'all') {
    filtered = filtered.filter(r => r.cefrLevel && r.cefrLevel.startsWith(activeFilter));
  }
  if (query) {
    filtered = filtered.filter(r => {
      const haystack = `${r.name || ''} ${r.scenario || ''} ${r.targetFunction || ''} ${r.cefrLevel || ''}`.toLowerCase();
      return haystack.includes(query);
    });
  }

  if (!filtered.length) {
    list.innerHTML = '<div class="empty-grid">// no rooms match your search or level</div>';
    return;
  }

  const sorted = [...filtered];
  if (sortMode === 'size') {
    sorted.sort((a, b) => (b.userCount || 0) - (a.userCount || 0));
  } else if (sortMode === 'name') {
    sorted.sort((a, b) => (a.scenario || a.name || '').localeCompare(b.scenario || b.name || '', undefined, { sensitivity: 'base' }));
  }

  list.innerHTML = sorted.map(room => {
    const cefr  = room.cefrLevel      || '??';
    const fn    = room.targetFunction || '';
    const count = room.userCount      || 0;
    const avatarsHtml = buildAvatarPreviews(room);
    return `
      <div class="room-card" onclick="openJoinModal('${escHtml(room.id)}', '${escHtml(room.name)}', '${escHtml(room.scenario || room.name)}')">
        <div class="card-header">
          <div class="room-title">${escHtml(room.scenario || room.name)}</div>
          <span class="level-tag">${escHtml(cefr)}</span>
        </div>
        ${fn ? `<div class="function-text">${escHtml(fn)}</div>` : ''}
        <div class="participants-avatars">${avatarsHtml}</div>
        <div class="room-footer">
          <span class="counter">${count} participant${count === 1 ? '' : 's'}</span>
          <button class="join-mini" onclick="event.stopPropagation(); openJoinModal('${escHtml(room.id)}', '${escHtml(room.name)}', '${escHtml(room.scenario || room.name)}')">Join →</button>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('liveBadge').textContent = `● LIVE · ${allRooms.length} room${allRooms.length === 1 ? '' : 's'}`;
}

// Build small avatar initials preview for lobby cards
function buildAvatarPreviews(room) {
  if (!room.userCount) return '<span style="font-size:12px;color:#6a6a62;font-family:monospace">No participants yet</span>';
  const roleColors = { native: '#c8f04a', advanced: '#4ab8f0', beginner: '#f5a623', learner: '#a78bfa' };
  const chips = [];
  if (room.nativeCount)   for (let i = 0; i < Math.min(room.nativeCount, 3); i++)   chips.push({ label: 'N', color: roleColors.native });
  if (room.advCount)      for (let i = 0; i < Math.min(room.advCount, 3); i++)       chips.push({ label: 'A', color: roleColors.advanced });
  if (room.begCount)      for (let i = 0; i < Math.min(room.begCount, 3); i++)       chips.push({ label: 'B', color: roleColors.beginner });
  return chips.slice(0, 6).map(c =>
    `<div class="avatar-circle" style="background: ${c.color}22; border: 1.5px solid ${c.color}55; color: ${c.color}; width:32px; height:32px; font-size:12px;">${c.label}</div>`
  ).join('');
}

// ── CEFR filter chips ─────────────────────────────────
document.querySelectorAll('.level-chip')?.forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.level-chip').forEach(c => c.classList.remove('active-level'));
    chip.classList.add('active-level');
    activeFilter = chip.getAttribute('data-filter') || 'all';
    renderRooms();
  });
});

document.getElementById('searchInput')?.addEventListener('input', e => {
  searchQuery = e.target.value;
  renderRooms();
});

document.querySelectorAll('.speed-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-chip').forEach(b => b.classList.remove('active-speed'));
    btn.classList.add('active-speed');
    if (btn.getAttribute('data-speed') === '3x') sortMode = 'size';
    else if (btn.getAttribute('data-speed') === '2x') sortMode = 'name';
    else sortMode = 'default';
    renderRooms();
  });
});

// ── Create room modal ─────────────────────────────────
function openCreateModal() {
  document.getElementById('createModal').style.display = 'flex';
  document.getElementById('newScenario').focus();
}

function closeCreateModal() {
  document.getElementById('createModal').style.display = 'none';
}

function createRoom() {
  const scenario       = document.getElementById('newScenario').value.trim();
  const cefrLevel      = document.getElementById('newLevel').value;
  const targetFunction = document.getElementById('newFunction').value.trim();
  const role           = 'native'; // Creator is native speaker

  if (!scenario) {
    showToast('Please enter a topic or scenario');
    document.getElementById('newScenario').focus();
    return;
  }

  // Use logged-in user's name
  const username = currentUser.fullName || 'Guest';

  socket.emit('create-room', { name: scenario, username, role, scenario, cefrLevel, targetFunction }, response => {
    if (response.error) { showToast('error: ' + response.error); return; }

    // Store everything needed so room.js can render the creator immediately
    sessionStorage.setItem('username',       username);
    sessionStorage.setItem('role',           role);
    sessionStorage.setItem('roomId',         response.roomId);
    sessionStorage.setItem('roomName',       response.roomName);
    sessionStorage.setItem('scenario',       scenario);
    sessionStorage.setItem('cefrLevel',      cefrLevel);
    sessionStorage.setItem('targetFunction', targetFunction);
    // Flag: this user is the room creator/host
    sessionStorage.setItem('isHost', 'true');

    closeCreateModal();
    showToast('✨ Room created!');
    setTimeout(() => {
      window.location.href = '/room';
    }, 600);
  });
}

// ── Join modal ────────────────────────────────────────
function openJoinModal(roomId, roomName, scenario) {
  pendingRoomId = roomId;
  document.getElementById('joinRoomPreview').textContent = scenario || roomName;
  document.getElementById('joinModal').style.display = 'flex';
  document.getElementById('joinRoleSelect').focus();
}

function closeModal() {
  document.getElementById('joinModal').style.display = 'none';
  document.getElementById('joinErrorMsg').textContent = '';
  pendingRoomId = null;
}

function confirmJoin() {
  if (!pendingRoomId) return;
  const role        = document.getElementById('joinRoleSelect').value;
  const username    = currentUser.fullName || 'Guest';

  socket.emit('join-room', { roomId: pendingRoomId, username }, response => {
    if (response.error) {
      document.getElementById('joinErrorMsg').textContent = response.error;
      return;
    }

    sessionStorage.setItem('username',       username);
    sessionStorage.setItem('role',           role);
    sessionStorage.setItem('roomId',         pendingRoomId);
    sessionStorage.setItem('roomName',       response.roomName);
    sessionStorage.setItem('scenario',       response.scenario       || response.roomName);
    sessionStorage.setItem('cefrLevel',      response.cefrLevel      || '');
    sessionStorage.setItem('targetFunction', response.targetFunction || '');
    sessionStorage.setItem('isHost',         'false');

    closeModal();
    showToast('✨ Joining room...');
    setTimeout(() => {
      window.location.href = '/room';
    }, 600);
  });
}

// Close modals on backdrop click
document.getElementById('joinModal')?.addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});
document.getElementById('createModal')?.addEventListener('click', e => {
  if (e.target === e.currentTarget) closeCreateModal();
});

// Enter key shortcuts
document.getElementById('newScenario')?.addEventListener('keydown',  e => { if (e.key === 'Enter') createRoom(); });
document.getElementById('joinRoleSelect')?.addEventListener('keydown', e => { if (e.key === 'Enter') confirmJoin(); });

// Button event listeners
document.getElementById('createRoomBtn')?.addEventListener('click',      openCreateModal);
document.getElementById('confirmCreate')?.addEventListener('click',      createRoom);
document.getElementById('cancelCreateModal')?.addEventListener('click',  closeCreateModal);
document.getElementById('confirmJoinBtn')?.addEventListener('click',     confirmJoin);
document.getElementById('closeJoinModalBtn')?.addEventListener('click',  closeModal);

// ── Helpers ───────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById('toastMessage') || document.getElementById('toast');
  if (t) {
    t.textContent = msg;
    t.style.opacity = '1';
    setTimeout(() => t.style.opacity = '0', 2800);
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}