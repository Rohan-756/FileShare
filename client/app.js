document.addEventListener('DOMContentLoaded', () => {
  // 1. App State & Utilities
  const state = {
    socket: null,
    roomId: null,
    isInitiator: false,
    peers: [],
    qrCodeInstance: null,
    peerConnection: null,
    dataChannel: null
  };

  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };

  const PROFILE_POOL = [
    { name: 'Neon Cyber', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=NeonCyber' },
    { name: 'Swift Falcon', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=SwiftFalcon' },
    { name: 'Quantum Byte', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=QuantumByte' },
    { name: 'Solar Phoenix', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=SolarPhoenix' },
    { name: 'Cosmic Drift', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=CosmicDrift' },
    { name: 'Shadow Pulse', avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=ShadowPulse' }
  ];

  function generateRoomId() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  function getRoomIdFromHash() {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    return params.get('room');
  }

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

    elements.roomCodeDisplay.textContent = state.roomId;

    const fullShareUrl = `${window.location.origin}${window.location.pathname}#room=${state.roomId}`;
    elements.shareUrlInput.value = fullShareUrl;

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

  // 4. WebRTC Connection Setup
  function createPeerConnection(targetPeerId) {
    if (state.peerConnection) {
      state.peerConnection.close();
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);
    state.peerConnection = pc;

    // Send local ICE candidates to the remote peer via signaling server
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        state.socket.emit('signal', {
          targetId: targetPeerId,
          signalData: { type: 'candidate', candidate: event.candidate }
        });
      }
    };

    // Connection state changes
    pc.onconnectionstatechange = () => {
      console.log('P2P Connection State:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        updateBadge('P2P Direct Connection Established', 'bg-emerald-500', 'text-emerald-400');
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        updateBadge('P2P Connection Lost', 'bg-rose-500', 'text-rose-400');
      }
    };

    // Receiver setup for DataChannel
    pc.ondatachannel = (event) => {
      state.dataChannel = event.channel;
      setupDataChannelEvents();
    };

    return pc;
  }

  function setupDataChannelEvents() {
    if (!state.dataChannel) return;

    state.dataChannel.onopen = () => {
      console.log('WebRTC DataChannel is OPEN');
    };

    state.dataChannel.onclose = () => {
      console.log('WebRTC DataChannel is CLOSED');
    };

    state.dataChannel.onmessage = (event) => {
      console.log('Received message via DataChannel:', event.data);
    };
  }

  async function startWebRTCOffer(targetPeerId) {
    const pc = createPeerConnection(targetPeerId);

    // Create DataChannel (Initiator)
    state.dataChannel = pc.createDataChannel('file-transfer', { ordered: true });
    setupDataChannelEvents();

    // Create Offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    state.socket.emit('signal', {
      targetId: targetPeerId,
      signalData: { type: 'offer', offer }
    });
  }

  async function handleSignalMessage({ senderId, signalData }) {
    if (signalData.type === 'offer') {
      const pc = createPeerConnection(senderId);
      await pc.setRemoteDescription(new RTCSessionDescription(signalData.offer));

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      state.socket.emit('signal', {
        targetId: senderId,
        signalData: { type: 'answer', answer }
      });
    } else if (signalData.type === 'answer') {
      if (state.peerConnection) {
        await state.peerConnection.setRemoteDescription(new RTCSessionDescription(signalData.answer));
      }
    } else if (signalData.type === 'candidate') {
      if (state.peerConnection) {
        await state.peerConnection.addIceCandidate(new RTCIceCandidate(signalData.candidate));
      }
    }
  }

  // 5. Socket.io Connection & Signal Handlers
  function initSocket() {
    state.socket = io(window.location.origin);

    state.socket.on('connect', () => {
      updateBadge('Connected to Signaling Server', 'bg-emerald-500', 'text-emerald-400');
      state.socket.emit('create-or-join-room', state.roomId);
    });

    state.socket.on('room-peers', ({ isInitiator, peers }) => {
      state.isInitiator = isInitiator;
      state.peers = peers;
      renderPeers();
    });

    // Triggered when second peer connects
    state.socket.on('ready-to-connect', () => {
      const targetPeerId = state.peers.find((id) => id !== state.socket.id);
      if (targetPeerId) {
        startWebRTCOffer(targetPeerId);
      }
    });

    // Handle incoming signals (Offer, Answer, ICE Candidates)
    state.socket.on('signal', handleSignalMessage);

    state.socket.on('room-full', ({ roomId }) => {
      updateBadge(`Room ${roomId} is full!`, 'bg-rose-500', 'text-rose-400');
      alert('This transfer room already has 2 connected peers.');
    });

    state.socket.on('peer-disconnected', ({ peerId }) => {
      state.peers = state.peers.filter((id) => id !== peerId);
      if (state.peerConnection) {
        state.peerConnection.close();
        state.peerConnection = null;
      }
      renderPeers();
    });

    state.socket.on('disconnect', () => {
      updateBadge('Disconnected from Server', 'bg-rose-500', 'text-rose-400');
    });
  }

  // 6. UI Render Helpers
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
        const profile = getProfileForSocket(peerId);

        const card = document.createElement('div');
        card.className = 'flex flex-row items-center p-4 rounded-xl bg-slate-900/80 border border-slate-700/70 gap-4 shadow-md';
        card.innerHTML = `
          <div class="relative shrink-0">
            <img 
              src="${profile.avatar}" 
              alt="${profile.name}" 
              class="h-16 w-16 rounded-full bg-slate-800 p-1 border-2 ${isSelf ? 'border-indigo-500' : 'border-emerald-500'}"
            />
            <span class="absolute bottom-0 right-0 h-4 w-4 rounded-full bg-emerald-400 border-2 border-slate-900"></span>
          </div>

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

  // 7. Copy Link Handler
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