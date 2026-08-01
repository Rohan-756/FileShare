document.addEventListener('DOMContentLoaded', () => {
  // 1. App State & Utilities
  const state = {
    socket: null,
    roomId: null,
    isInitiator: false,
    peers: [],
    qrCodeInstance: null
  };

  // Helper: Generate a random 6-digit room code
  function generateRoomId() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  // Helper: Parse room ID from URL hash (#room=123456)
  function getRoomIdFromHash() {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    return params.get('room');
  }

  // 2. DOM Elements
  const elements = {
    badge: document.getElementById('connection-badge'),
    roomCodeDisplay: document.getElementById('room-code-display'),
    shareUrlInput: document.getElementById('share-url-input'),
    btnCopyLink: document.getElementById('btn-copy-link'),
    qrContainer: document.getElementById('qrcode'),
    peersList: document.getElementById('peers-list'),
    peerPlaceholder: document.getElementById('peer-placeholder')
  };

  // 3. Room & QR Initialization
  function initRoom() {
    let roomId = getRoomIdFromHash();
    if (!roomId) {
      roomId = generateRoomId();
      window.location.hash = `room=${roomId}`;
    }
    state.roomId = roomId;

    // Render Room Code
    elements.roomCodeDisplay.textContent = state.roomId;

    // Render Shareable URL
    const fullShareUrl = `${window.location.origin}${window.location.pathname}#room=${state.roomId}`;
    elements.shareUrlInput.value = fullShareUrl;

    // Render QR Code
    elements.qrContainer.innerHTML = '';
    state.qrCodeInstance = new QRCode(elements.qrContainer, {
      text: fullShareUrl,
      width: 140,
      height: 140,
      colorDark: '#0f172a',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  }

  // 4. Socket.io Connection & Signal Handlers
  function initSocket() {
    state.socket = io("http://localhost:3000");

    state.socket.on('connect', () => {
      updateBadge('Connected to Signaling Server', 'bg-emerald-500', 'text-emerald-400');
      
      // Join or create room on server
      state.socket.emit('create-or-join-room', state.roomId);
    });

    state.socket.on('room-peers', ({ isInitiator, peers }) => {
      state.isInitiator = isInitiator;
      state.peers = peers;
      renderPeers();
    });

    state.socket.on('room-full', ({ roomId }) => {
      updateBadge(`Room ${roomId} is full!`, 'bg-rose-500', 'text-rose-400');
      alert('This transfer room already has 2 connected peers.');
    });

    state.socket.on('peer-disconnected', ({ peerId }) => {
      state.peers = state.peers.filter((id) => id !== peerId);
      renderPeers();
    });

    state.socket.on('disconnect', () => {
      updateBadge('Disconnected from Server', 'bg-rose-500', 'text-rose-400');
    });
  }

  // 5. UI Render Helpers
  function updateBadge(text, indicatorClass, textClass) {
    elements.badge.className = `flex items-center gap-2 text-xs font-medium px-3 py-1 rounded-full bg-slate-800 ${textClass} border border-slate-700`;
    elements.badge.innerHTML = `
      <span class="h-2 w-2 rounded-full ${indicatorClass}"></span>
      <span>${text}</span>
    `;
  }

  function renderPeers() {
    elements.peersList.innerHTML = '';

    if (state.peers.length <= 1) {
      elements.peersList.appendChild(elements.peerPlaceholder);
    } else {
      state.peers.forEach((peerId) => {
        const isSelf = peerId === state.socket.id;
        const card = document.createElement('div');
        card.className = 'flex items-center justify-between p-3 rounded-xl bg-slate-900 border border-slate-700/70';
        card.innerHTML = `
          <div class="flex items-center gap-3">
            <div class="h-8 w-8 rounded-full bg-indigo-500/20 text-indigo-400 flex items-center justify-center font-mono font-semibold text-xs border border-indigo-500/30">
              ${isSelf ? 'YOU' : 'PEER'}
            </div>
            <div>
              <p class="text-xs font-mono font-medium text-slate-200">${peerId}</p>
              <p class="text-[10px] text-slate-500">${isSelf ? 'Local Device' : 'Remote Peer'}</p>
            </div>
          </div>
          <span class="h-2 w-2 rounded-full bg-emerald-400"></span>
        `;
        elements.peersList.appendChild(card);
      });
    }
  }

  // 6. Copy Link Handler
  elements.btnCopyLink.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(elements.shareUrlInput.value);
      const originalText = elements.btnCopyLink.textContent;
      elements.btnCopyLink.textContent = 'Copied!';
      elements.btnCopyLink.classList.replace('bg-indigo-600', 'bg-emerald-600');

      setTimeout(() => {
        elements.btnCopyLink.textContent = originalText;
        elements.btnCopyLink.classList.replace('bg-emerald-600', 'bg-indigo-600');
      }, 2000);
    } catch (err) {
      console.error('Failed to copy share link:', err);
    }
  });

  // Entry Point Execution
  initRoom();
  initSocket();
});