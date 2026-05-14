// room.js — Voice room: WebRTC mesh + Socket.io signalling + classroom features

const socket = io();

// ── Helpers ───────────────────────────────────────────
function getQueryParam(name) {
  return new URL(window.location.href).searchParams.get(name);
}
function buildShareUrl(roomId) {
  const origin = window.location.origin || `${window.location.protocol}//${window.location.host}`;
  return `${origin}/room?roomId=${encodeURIComponent(roomId)}`;
}
function escHtml(str) {
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}
function setStatus(msg) {
  const header = document.getElementById('audio-status');
  if (header) header.textContent = msg;
  const control = document.getElementById('audio-status-text');
  if (control) control.textContent = msg;
}

// ── Session state ─────────────────────────────────────
const urlRoomId       = getQueryParam('roomId');
const roomId          = urlRoomId || sessionStorage.getItem('roomId');
const roomName        = sessionStorage.getItem('roomName');
const scenario        = sessionStorage.getItem('scenario')        || roomName;
const cefrLevel       = sessionStorage.getItem('cefrLevel')       || '';
const targetFunction  = sessionStorage.getItem('targetFunction')  || '';
const isHost          = sessionStorage.getItem('isHost') === 'true';
let   username        = sessionStorage.getItem('username') || 'Guest';
let   myRole          = sessionStorage.getItem('role') || 'learner';

if (!roomId) { window.location.href = '/'; }

// Set share link immediately if we have a roomId
const shareInput = document.getElementById('share-link-input');
if (shareInput && roomId) {
  shareInput.value = buildShareUrl(roomId);
}

// Fetch logged-in user from server to get full name
fetch('/api/user')
  .then(res => res.json())
  .then(data => {
    if (data.success && data.user) {
      username = data.user.fullName || sessionStorage.getItem('username') || 'Guest';
      sessionStorage.setItem('username', username);
    }
  })
  .catch(() => {
    // If fetch fails, use sessionStorage username or generate one
    username = sessionStorage.getItem('username') || 'Guest_' + Math.floor(Math.random() * 9000 + 1000);
    sessionStorage.setItem('username', username);
  })
  .finally(() => {
    // Set share link once we have all the data
    const shareInput = document.getElementById('share-link-input');
    if (shareInput && roomId) {
      shareInput.value = buildShareUrl(roomId);
    }
  });

// ── WebRTC state ──────────────────────────────────────
let localStream       = null;
let isMuted           = false;
let silenceTimer      = null;
const peers           = {};
const ICE_CONFIG      = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

let audioContext      = null;
let analyserNode      = null;
let audioDataArray    = null;
let canvasCtx         = null;
let mediaRecorder     = null;
let recordingChunks   = [];
let isRecording       = false;
const reactionCounts  = { '👏': 0, '😂': 0, '🔥': 0, '💡': 0, '🎯': 0, '🤔': 0 };

// ── Conversation prompts ───────────────────────────────
const DEFAULT_PROMPTS = [
  'Introduce yourself and share one thing you want to practise today.',
  'Describe a recent experience using at least three new words.',
  'Ask your partner to explain something they just said in a different way.',
  'Share an opinion and ask others if they agree.',
  'Summarise what has been discussed so far in two or three sentences.',
];
let prompts   = [...DEFAULT_PROMPTS];
let promptIdx = 0;

// ── Avatar / role helpers ─────────────────────────────
const ROLE_COLORS = {
  native:   '#c8f04a',
  advanced: '#4ab8f0',
  beginner: '#f5a623',
  learner:  '#a78bfa',
};
const ROLE_LABELS = { native: 'Native', advanced: 'Advanced', beginner: 'Beginner', learner: 'Learner' };

function getInitials(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
function roleColor(role) { return ROLE_COLORS[role] || ROLE_COLORS.learner; }
function roleName(role)  { return ROLE_LABELS[role]  || 'Participant'; }

// ── ★ IMMEDIATE self-render ───────────────────────────
// Show the local user in the participant grid RIGHT AWAY, before any
// socket round-trip completes. This is purely local/optimistic and will
// be replaced cleanly once the server sends back the real room-users list.
function renderSelfImmediately() {
  const list = document.getElementById('participants-list');
  if (!list) return;

  const color    = roleColor(myRole);
  const initials = getInitials(username);
  const hostBadge = isHost
    ? `<div class="role-badge" style="background:rgba(200,240,74,0.15);color:#c8f04a;border-color:rgba(200,240,74,0.3)">Host</div>`
    : '';

  list.innerHTML = `
    <div class="participant speaking" data-socket="local-self" data-local="true">
      <div class="avatar-wrap">
        <div class="avatar" style="background:${color}22; border: 2px solid ${color}; color:${color}">${escHtml(initials)}</div>
        <div class="speaking-ring"></div>
      </div>
      <div class="p-name">${escHtml(username)} <span style="font-size:9px;opacity:0.6">(you)</span></div>
      <div class="p-role">${roleName(myRole)}</div>
      ${hostBadge}
      <div class="mic-bars">
        <span style="height:5px"></span>
        <span style="height:9px"></span>
        <span style="height:4px"></span>
        <span style="height:7px"></span>
      </div>
    </div>
    <div class="joining-indicator" style="font-size:11px;font-family:monospace;color:#5a5a52;padding:8px 0;">
      ⟳ connecting…
    </div>
  `;

  // Update the live badge immediately too
  const connBadge = document.getElementById('conn-status');
  if (connBadge) connBadge.textContent = 'CONNECTING…';
}

// ── Init UI ───────────────────────────────────────────
document.getElementById('room-title').textContent = scenario || roomName || roomId;
document.getElementById('room-objective').textContent =
  targetFunction ? `Function: ${targetFunction}` : '';

const tagsEl = document.getElementById('obj-tags');
if (cefrLevel) {
  const b = document.createElement('span');
  b.className = `tag cefr-badge cefr-${cefrLevel.slice(0,1).toLowerCase()}`;
  b.textContent = cefrLevel;
  tagsEl.appendChild(b);
}
if (targetFunction) {
  const t = document.createElement('span');
  t.className = 'tag';
  t.textContent = targetFunction;
  tagsEl.appendChild(t);
}

document.getElementById('share-link-input').value = buildShareUrl(roomId);
const hdrRoomTitle = document.getElementById('hdr-room-title');
if (hdrRoomTitle) hdrRoomTitle.textContent = scenario || roomName || roomId;

showPrompt();

// Render self immediately — don't wait for sockets or mic permission
renderSelfImmediately();

// ── Socket connection ─────────────────────────────────
socket.on('connect', async () => {
  setStatus('MIC ACCESS…');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    setStatus('TRANSMITTING');
    initializeAudioTools(localStream);
    socket.emit('join-room-rtc', { roomId, username, role: myRole });
    startSilenceNudge();
  } catch (err) {
    // Mic blocked — still show self in participant list, just no audio
    setStatus('NO MIC — ' + err.message);
    showToast('Mic access denied — you can still observe');
    // Emit join without audio so other participants know you're here
    socket.emit('join-room-rtc', { roomId, username, role: myRole });
  }

  // Update share link once connected (in case it wasn't set initially)
  const shareInput = document.getElementById('share-link-input');
  if (shareInput && roomId) {
    shareInput.value = buildShareUrl(roomId);
  }
});

socket.on('disconnect',    () => {
  setStatus('DISCONNECTED');
  const badge = document.getElementById('conn-status');
  if (badge) badge.textContent = 'OFFLINE';
});
socket.on('connect_error', () => {
  const badge = document.getElementById('conn-status');
  if (badge) badge.textContent = 'ERROR';
});

socket.on('room-list', rooms => {
  if (!scenario) {
    const room = rooms.find(r => r.id === roomId);
    if (room) document.getElementById('room-title').textContent = room.scenario || room.name;
  }
});

// ── Participants ──────────────────────────────────────
// Once the server sends the authoritative list, replace our optimistic render
socket.on('room-users', users => {
  const badge = document.getElementById('conn-status');
  if (badge) badge.textContent = 'LIVE · ' + socket.id.slice(0, 6);
  renderParticipants(users);
});

// ── WebRTC signalling ─────────────────────────────────
socket.on('user-joined-rtc', async ({ socketId, username: peerName, role: peerRole }) => {
  showToast(peerName + ' joined');
  const pc = createPeerConnection(socketId, peerName, peerRole);
  peers[socketId] = pc;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('rtc-offer', { to: socketId, offer });
});

socket.on('rtc-offer', async ({ from, offer, username: peerName }) => {
  const pc = createPeerConnection(from, peerName, '');
  peers[from] = pc;
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('rtc-answer', { to: from, answer });
});

socket.on('rtc-answer', async ({ from, answer }) => {
  const pc = peers[from];
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on('rtc-ice', async ({ from, candidate }) => {
  const pc = peers[from];
  if (pc && candidate) {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
  }
});

socket.on('user-left-rtc', ({ socketId, username: peerName }) => {
  showToast((peerName || 'A user') + ' left');
  if (peers[socketId]) { peers[socketId].close(); delete peers[socketId]; }
  const el = document.getElementById('audio-' + socketId);
  if (el) el.remove();
});

// ── Mute / speaking ───────────────────────────────────
socket.on('peer-muted', ({ socketId, muted }) => {
  const card   = document.querySelector(`[data-socket="${socketId}"]`);
  if (!card) return;
  const icon   = card.querySelector('.muted-icon');
  const status = card.querySelector('.p-status');
  if (icon)   icon.style.display = muted ? 'inline' : 'none';
  if (status) status.textContent = muted ? 'muted' : 'live';
});

// ── Vocab & grammar broadcast ─────────────────────────
socket.on('vocab-snapshot',   entries => entries.forEach(addVocabCard));
socket.on('vocab-new',        entry   => { addVocabCard(entry); showToast('Vocab: ' + entry.word); });
socket.on('grammar-snapshot', pins    => pins.forEach(addGrammarPin));
socket.on('grammar-pinned',   pin     => { addGrammarPin(pin); showToast('Grammar: ' + pin.label); });

// ── RTCPeerConnection factory ─────────────────────────
function createPeerConnection(socketId, peerName, peerRole) {
  const pc = new RTCPeerConnection(ICE_CONFIG);

  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('rtc-ice', { to: socketId, candidate });
  };

  pc.ontrack = ({ streams }) => {
    let audioEl = document.getElementById('audio-' + socketId);
    if (!audioEl) {
      audioEl = Object.assign(document.createElement('audio'), { id: 'audio-' + socketId, autoplay: true });
      document.getElementById('audio-elements').appendChild(audioEl);
    }
    audioEl.srcObject = streams[0];
  };

  pc.onconnectionstatechange = () => {
    const card = document.querySelector(`[data-socket="${socketId}"]`);
    if (card) card.classList.toggle('connected', pc.connectionState === 'connected');
  };

  return pc;
}

// ── Mute toggle ───────────────────────────────────────
function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });

  const btn = document.getElementById('mute-btn');
  btn.textContent = isMuted ? '🔇 Mic off' : '🎙 Mic on';
  btn.classList.toggle('muted', isMuted);

  socket.emit('mute-state', { roomId, muted: isMuted });
  setStatus(isMuted ? 'MUTED' : 'TRANSMITTING');

  if (!isMuted) dismissNudge();
}

// ── Leave ─────────────────────────────────────────────
function leaveRoom() {
  Object.values(peers).forEach(pc => pc.close());
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  socket.emit('leave-room', { roomId });
  // Clear session so we don't re-enter accidentally
  sessionStorage.removeItem('isHost');
  window.location.href = 'index.html';
}

function copyShareLink() {
  const val = document.getElementById('share-link-input').value;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(val).then(() => showToast('Link copied'));
  } else {
    const inp = document.getElementById('share-link-input');
    inp.select();
    document.execCommand('copy');
    showToast('Link copied');
  }
}

window.addEventListener('beforeunload', () => socket.emit('leave-room', { roomId }));

// ── Render participants (authoritative, from server) ──
function renderParticipants(users) {
  const list = document.getElementById('participants-list');
  if (!users?.length) {
    // Edge case: server says nobody is here yet — keep showing self
    renderSelfImmediately();
    return;
  }

  list.innerHTML = users.map(u => {
    const isMe     = u.socketId === socket.id;
    const color    = roleColor(u.role);
    const initials = escHtml(getInitials(u.username));
    const muted    = u.muted ? 'block' : 'none';
    const hostTag  = isHost && isMe
      ? `<div class="role-badge" style="background:rgba(200,240,74,0.15);color:#c8f04a;border-color:rgba(200,240,74,0.3)">Host</div>`
      : '';
    return `
      <div class="participant ${isMe ? 'speaking' : ''}" data-socket="${u.socketId}">
        <div class="avatar-wrap">
          <div class="avatar" style="background:${color}22; border: 2px solid ${color}; color:${color}">${initials}</div>
          <div class="speaking-ring"></div>
        </div>
        <div class="p-name">${escHtml(u.username)}${isMe ? ' <span style="font-size:9px;opacity:0.6">(you)</span>' : ''}</div>
        <div class="p-role">${roleName(u.role)}</div>
        ${hostTag}
        ${isMe ? `
          <div class="mic-bars">
            <span style="height:5px"></span>
            <span style="height:9px"></span>
            <span style="height:4px"></span>
            <span style="height:7px"></span>
          </div>
        ` : `
          <div class="mic-off-badge" style="display:${muted};"></div>
          <div class="muted-icon" style="display:${muted}">🔇</div>
        `}
      </div>
    `;
  }).join('');

  const badge = document.getElementById('conn-status');
  if (badge) badge.textContent = 'LIVE · ' + users.length;

  if (document.getElementById('prompt-box')) {
    document.getElementById('prompt-box').style.display = 'block';
  }
}

// ── Conversation prompts ──────────────────────────────
function showPrompt() {
  const el = document.getElementById('prompt-text');
  if (el) el.textContent = prompts[promptIdx % prompts.length];
}

function nextPrompt() {
  promptIdx = (promptIdx + 1) % prompts.length;
  showPrompt();
}

function showHint() {
  const hints = [
    'Try using "Could I…" or "Would it be possible to…"',
    "Don't worry about being perfect — focus on communicating clearly.",
    'Listen carefully and ask for clarification if needed: "Sorry, could you repeat that?"',
    'Use what you know, even if it\'s simple.',
  ];
  showToast(hints[Math.floor(Math.random() * hints.length)]);
}

// ── Participation nudge ───────────────────────────────
function startSilenceNudge() {
  silenceTimer = setTimeout(() => {
    if (isMuted) {
      const nudge = document.getElementById('participate-nudge');
      if (nudge) nudge.style.display = 'block';
    }
  }, 60000);
}

function dismissNudge() {
  clearTimeout(silenceTimer);
  const nudge = document.getElementById('participate-nudge');
  if (nudge) nudge.style.display = 'none';
}

// ── Vocab capture ─────────────────────────────────────
function openAddVocab()    { document.getElementById('vocab-modal').style.display = 'flex'; document.getElementById('vocab-word').focus(); }
function openVocabModal()  { openAddVocab(); }
function openGrammarModal(){ openAddGrammar(); }

function switchMobileTab(tab) {
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.id === 'nav-' + tab));
  document.querySelectorAll('.mobile-panel').forEach(panel => panel.classList.remove('open'));
  if (tab === 'vocab' || tab === 'grammar') {
    const panel = document.getElementById('mobile-' + tab);
    if (panel) panel.classList.add('open');
  }
}

function closeVocabModal() {
  document.getElementById('vocab-modal').style.display = 'none';
  ['vocab-word','vocab-def','vocab-ctx'].forEach(id => { document.getElementById(id).value = ''; });
}

function closeModal(id) {
  if (id === 'vocab-modal')   return closeVocabModal();
  if (id === 'grammar-modal') return closeGrammarModal();
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function submitVocab() {
  const word       = document.getElementById('vocab-word').value.trim();
  const definition = document.getElementById('vocab-def').value.trim();
  const context    = document.getElementById('vocab-ctx').value.trim();
  if (!word) { showToast('enter a word first'); return; }
  socket.emit('vocab-add', { roomId, word, definition, context });
  closeVocabModal();
}

function addVocabCard(entry) {
  ['vocab-list', 'vocab-list-mobile'].forEach(listId => {
    const list = document.getElementById(listId);
    if (!list) return;
    const empty = list.querySelector('.empty-note');
    if (empty) empty.remove();
    const card = document.createElement('div');
    card.className = 'vocab-card';
    card.innerHTML = `
      <div class="vocab-word">${escHtml(entry.word)}</div>
      ${entry.definition ? `<div class="vocab-def">${escHtml(entry.definition)}</div>` : ''}
      ${entry.context    ? `<div class="vocab-ctx">${escHtml(entry.context)}</div>`    : ''}
    `;
    list.prepend(card);
  });
}

// ── Grammar pins ──────────────────────────────────────
function openAddGrammar() {
  document.getElementById('grammar-modal').style.display = 'flex';
  document.getElementById('gm-label').focus();
}

function closeGrammarModal() {
  document.getElementById('grammar-modal').style.display = 'none';
  ['gm-label','gm-pattern','gm-example'].forEach(id => { document.getElementById(id).value = ''; });
}

function submitGrammar() {
  const label   = document.getElementById('gm-label').value.trim();
  const pattern = document.getElementById('gm-pattern').value.trim();
  const example = document.getElementById('gm-example').value.trim();
  if (!label || !pattern) { showToast('enter a label and pattern first'); return; }
  socket.emit('grammar-pin', { roomId, label, pattern, example });
  closeGrammarModal();
}

function addGrammarPin(pin) {
  ['grammar-list', 'grammar-list-mobile'].forEach(listId => {
    const list = document.getElementById(listId);
    if (!list) return;
    const empty = list.querySelector('.empty-note');
    if (empty) empty.remove();
    const card = document.createElement('div');
    card.className = 'grammar-card';
    card.innerHTML = `
      <div class="gp-label">${escHtml(pin.label)}</div>
      <div class="gp-pattern">${escHtml(pin.pattern)}</div>
      ${pin.example ? `<div class="gp-example">${escHtml(pin.example)}</div>` : ''}
    `;
    list.prepend(card);
  });
}

// ── Sidebar tabs ──────────────────────────────────────
function switchSidebarTab(name, el) {
  document.querySelectorAll('.s-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.sidebar-pane').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('sidepane-' + name).classList.add('active');
}

// ── Modal backdrop close ──────────────────────────────
document.getElementById('vocab-modal')?.addEventListener('click', e => {
  if (e.target === e.currentTarget) closeVocabModal();
});
document.getElementById('grammar-modal')?.addEventListener('click', e => {
  if (e.target === e.currentTarget) closeGrammarModal();
});

function closeModalOnBackdrop(event, id) {
  if (event.target === event.currentTarget) closeModal(id);
}

// ── Audio tools ───────────────────────────────────────
function initializeAudioTools(stream) {
  if (!window.AudioContext) return;

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(stream);
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 256;
  source.connect(analyserNode);
  audioDataArray = new Uint8Array(analyserNode.frequencyBinCount);

  const canvas = document.getElementById('audio-canvas');
  if (canvas) {
    canvasCtx = canvas.getContext('2d');
    drawAudioVisualizer();
  }

  startSpeakingDetector(stream);
  startSpeechRecognition();
}

function drawAudioVisualizer() {
  if (!analyserNode || !canvasCtx) return;
  requestAnimationFrame(drawAudioVisualizer);

  analyserNode.getByteFrequencyData(audioDataArray);
  const width    = canvasCtx.canvas.width;
  const height   = canvasCtx.canvas.height;
  const barWidth = width / audioDataArray.length;

  canvasCtx.clearRect(0, 0, width, height);
  const average = audioDataArray.reduce((sum, value) => sum + value, 0) / audioDataArray.length;
  const dbValue = Math.round((average / 255) * 60 - 20);
  const vizLevel = document.getElementById('viz-level');
  if (vizLevel) vizLevel.textContent = `${dbValue} dB`;

  audioDataArray.forEach((value, i) => {
    const barHeight = (value / 255) * height;
    const x = i * barWidth;
    const gradient = canvasCtx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(74,184,240,0.9)');
    gradient.addColorStop(1, 'rgba(200,240,74,0.2)');
    canvasCtx.fillStyle = gradient;
    canvasCtx.fillRect(x, height - barHeight, barWidth * 0.8, barHeight);
  });
}

function startSpeakingDetector(stream) {
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) return;

  const localAnalyzer = audioContext.createAnalyser();
  const localSource   = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
  localSource.connect(localAnalyzer);
  localAnalyzer.fftSize = 256;
  const buffer = new Uint8Array(localAnalyzer.frequencyBinCount);

  let speakingState = false;
  setInterval(() => {
    localAnalyzer.getByteFrequencyData(buffer);
    const volume     = buffer.reduce((sum, v) => sum + v, 0) / buffer.length;
    const nowSpeaking = volume > 18;
    if (nowSpeaking !== speakingState) {
      speakingState = nowSpeaking;
      socket.emit('speech-activity', { roomId, speaking: speakingState });
      if (speakingState) updateAICoach('You are speaking confidently. Keep it up!');
    }
  }, 200);
}

function startSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  const recognition       = new SpeechRecognition();
  recognition.continuous     = true;
  recognition.interimResults = true;
  recognition.lang           = 'en-US';

  recognition.onresult = event => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    if (transcript.trim()) {
      addTranscript('You', transcript.trim());
      updateAICoach('The AI hears you clearly. Great job using full sentences!');
    }
  };

  recognition.onerror = () => {};
  recognition.onend   = () => recognition.start();
  recognition.start();
}

function addTranscript(speaker, text) {
  const list = document.getElementById('transcript-list');
  if (!list) return;
  const empty = list.querySelector('.empty-note');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'transcript-item';
  item.innerHTML = `
    <div class="transcript-speaker">${escHtml(speaker)}:</div>
    <div class="transcript-text">${escHtml(text)}</div>
  `;
  list.prepend(item);
}

function updateAICoach(message) {
  const el = document.getElementById('ai-msg');
  if (el) el.textContent = message;
}

function applyTip(tip) {
  updateAICoach(tip);
  showToast('AI tip applied');
}

function sendReaction(emoji) {
  if (!reactionCounts.hasOwnProperty(emoji)) return;
  reactionCounts[emoji] += 1;
  socket.emit('reaction', { roomId, emoji });
  updateReactionDisplay();
  createFloatingReaction(emoji);
}

function updateReactionDisplay() {
  const keyMap = { '👏':'applause', '😂':'laughing', '🔥':'fire', '💡':'idea', '🎯':'target', '🤔':'thinking' };
  Object.entries(reactionCounts).forEach(([emoji, count]) => {
    const el = document.getElementById(`rc-${keyMap[emoji]}`);
    if (el) el.textContent = count;
  });
}

function createFloatingReaction(emoji) {
  const bubble = document.createElement('div');
  bubble.className  = 'floating-reaction';
  bubble.textContent = emoji;
  bubble.style.left  = `${50 + Math.random() * 20}%`;
  bubble.style.bottom = '90px';
  document.body.appendChild(bubble);
  setTimeout(() => bubble.remove(), 1500);
}

function toggleRecording() {
  const btn = document.getElementById('record-btn');
  if (isRecording) {
    mediaRecorder.stop();
    btn.classList.remove('recording');
    btn.textContent = '⏺ Record';
    isRecording = false;
    return;
  }

  if (!localStream) return showToast('Microphone not ready');
  try {
    mediaRecorder = new MediaRecorder(localStream);
  } catch (err) {
    return showToast('Recording not supported');
  }

  recordingChunks = [];
  mediaRecorder.ondataavailable = event => recordingChunks.push(event.data);
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordingChunks, { type: 'audio/webm' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: `linguagrid-${Date.now()}.webm` });
    a.click();
    URL.revokeObjectURL(url);
    showToast('Recording saved');
  };

  mediaRecorder.start();
  isRecording = true;
  btn.classList.add('recording');
  btn.textContent = '■ Stop';
}

// ── Incoming socket events ────────────────────────────
socket.on('reaction-received', ({ emoji, counts }) => {
  if (reactionCounts.hasOwnProperty(emoji)) {
    reactionCounts[emoji] = counts[emoji] || reactionCounts[emoji];
  }
  updateReactionDisplay();
});

socket.on('ai-suggestion', ({ message }) => {
  updateAICoach(message);
});

socket.on('peer-speaking', ({ socketId, speaking }) => {
  const card = document.querySelector(`[data-socket="${socketId}"]`);
  if (card) card.classList.toggle('speaking', speaking);
});