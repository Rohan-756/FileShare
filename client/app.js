document.addEventListener('DOMContentLoaded', () => {
  // 1. App State & Utilities
  const state = {
    socket: null,
    roomId: null,
    isInitiator: false,
    peers: [],
    qrCodeInstance: null
  };

  // Preset list of fun nicknames and matching avatar seeds
  const PROFILE_POOL = [
    { name: 'Neon Cyber', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=NeonCyber' },
    { name: 'Swift Falcon', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=SwiftFalcon' },
    { name: 'Quantum Byte', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=QuantumByte' },
    { name: 'Solar Phoenix', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=SolarPhoenix' },
    { name: 'Cosmic Drift', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=CosmicDrift' },
    { name: 'Shadow Pulse', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=ShadowPulse' }
  ];

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

  // Helper: Deterministically pick a profile based on socket ID
  function getProfileForSocket(socketId) {
    let hash = 0;
    for (let i = 0; i < socketId.length; i++) {
      hash = socketId.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % PROFILE_POOL.length;
    return PROFILE_POOL[index];
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
    // Connect dynamically to host (works on 3000, 3001, etc.)
    state.socket = io(window.location.origin);

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

  // Updated renderPeers: Horizontal layout with larger avatar
  function renderPeers() {
    elements.peersList.innerHTML = '';

    if (state.peers.length <= 1) {
      elements.peersList.appendChild(elements.peerPlaceholder);
    } else {
      state.peers.forEach((peerId) => {
        const isSelf = peerId === state.socket.id;
        const profile = getProfileForSocket(peerId);

        const card = document.createElement('div');
        card.className = 'flex flex-row items-center p-4 rounded-xl bg-slate-900/80 border border-slate-700/70 gap-4 shadow-md';
        card.innerHTML = `
          <!-- Larger Avatar on the Left -->
          <div class="relative shrink-0">
            <img 
              src="${profile.avatar}" 
              alt="${profile.name}" 
              class="h-16 w-16 rounded-full bg-slate-800 p-1 border-2 ${isSelf ? 'border-indigo-500' : 'border-emerald-500'}"
            />
            <span class="absolute bottom-0 right-0 h-4 w-4 rounded-full bg-emerald-400 border-2 border-slate-900"></span>
          </div>

          <!-- Name & Label Stacked to the Right -->
          <div class="flex flex-col justify-center min-w-0">
            <p class="text-base font-bold text-slate-100 truncate">${profile.name}</p>
            <span class="inline-block mt-1 text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-md w-max ${isSelf ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'}">
              ${isSelf ? 'You' : 'Peer'}
            </span>
          </div>
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