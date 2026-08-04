document.addEventListener('DOMContentLoaded', () => {
  function getOrCreateLocalUser() {
    const STORAGE_KEY = 'p2p_user_profile';
    const savedUser = localStorage.getItem(STORAGE_KEY);

    if (savedUser) {
      try {
        return JSON.parse(savedUser);
      } catch (e) {
        console.warn('Failed to parse cached user profile, re-generating.');
      }
    }

    const PROFILE_POOL = [
      { name: 'Neon Cyber', seed: 'NeonCyber' },
      { name: 'Swift Falcon', seed: 'SwiftFalcon' },
      { name: 'Quantum Byte', seed: 'QuantumByte' },
      { name: 'Solar Phoenix', seed: 'SolarPhoenix' },
      { name: 'Cosmic Drift', seed: 'CosmicDrift' },
      { name: 'Shadow Pulse', seed: 'ShadowPulse' }
    ];

    const randomProfile = PROFILE_POOL[Math.floor(Math.random() * PROFILE_POOL.length)];
    const uniqueSeed = `${randomProfile.seed}_${Math.random().toString(36).substring(2, 7)}`;

    const newUser = {
      userId: 'usr_' + Math.random().toString(36).substring(2, 9),
      name: randomProfile.name,
      avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${uniqueSeed}`
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(newUser));
    return newUser;
  }

  const localUser = getOrCreateLocalUser();

  const state = {
    socket: null,
    roomId: null,
    isInitiator: false,
    peers: [],
    qrCodeInstance: null,
    peerConnection: null,
    dataChannel: null,

    // E2EE Cryptographic State
    ecdhKeyPair: null,
    localPublicJwk: null,
    peerPublicJwk: null,
    sharedKey: null,

    // Sender Batch Staging
    stagedFiles: [],

    // Receiver Batch State
    incomingBatch: [], // List of { fileId, name, size, mimeType, accepted: true|false }

    // Active File Stream state
    incomingFileInfo: null,
    receivedChunks: [],
    receivedSize: 0,
    CHUNK_SIZE: 64 * 1024, // 64 KB chunk size for optimized WebRTC transfer
    fileHandle: null,
    writableStream: null,
    incomingFileHandles: {}, // Pre-opened handles map for batch downloads
    incomingFileStreams: {}, // Pre-opened streams map for batch downloads

    // Metrics & Controls
    isTransferring: false,
    transferStartTime: 0,
    lastMetricTime: 0,
    lastMetricBytes: 0,
    transferCancelled: false,

    // Handshake Resolvers
    batchDecisionResolver: null
  };

  const ICE_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  };

  function generateRoomId() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  function getRoomIdFromHash() {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    return params.get('room');
  }

  function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  }

  function formatETA(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return 'ETA: --';
    if (seconds < 60) return `ETA: ${Math.ceil(seconds)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.ceil(seconds % 60);
    return `ETA: ${mins}m ${secs}s`;
  }

  // Phase 3: Sound Synthesizer via Web Audio API
  function playAudioFeedback(type) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'start') {
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      } else if (type === 'complete') {
        osc.frequency.setValueAtTime(523.25, ctx.currentTime);
        osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1);
        osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.2);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
      } else if (type === 'cancel') {
        osc.frequency.setValueAtTime(300, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(150, ctx.currentTime + 0.2);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.2);
        osc.start();
        osc.stop(ctx.currentTime + 0.2);
      }
    } catch (e) {
      console.warn('Audio feedback error:', e);
    }
  }

  // Phase 3: Browser Haptics Feedback
  function triggerHaptic(pattern = [100, 50, 100]) {
    if ('vibrate' in navigator) {
      navigator.vibrate(pattern);
    }
  }

  function showToast(message, type = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.className = 'fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    const bgClass = type === 'error' ? 'bg-rose-900/90 border-rose-500 text-rose-200' :
                    type === 'success' ? 'bg-emerald-900/90 border-emerald-500 text-emerald-200' :
                    'bg-slate-800/90 border-indigo-500 text-slate-200';

    toast.className = `p-3 rounded-xl border shadow-xl text-xs font-medium backdrop-blur-md transition-all duration-300 transform translate-y-2 opacity-0 pointer-events-auto ${bgClass}`;
    toast.textContent = message;

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.remove('translate-y-2', 'opacity-0'));

    setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-y-2');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  function updateBadge(statusText, dotColorClass) {
    if (!elements.badge) return;
    const isLiveState = dotColorClass.includes('emerald') || dotColorClass.includes('sky');

    elements.badge.className = 'inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-800/80 border border-slate-700/60 text-xs font-medium text-slate-200 backdrop-blur-md shadow-sm transition-all duration-200';
    elements.badge.innerHTML = `
      <span class="relative flex h-2 w-2">
        ${isLiveState ? `<span class="animate-ping absolute inline-flex h-full w-full rounded-full ${dotColorClass} opacity-75"></span>` : ''}
        <span class="relative inline-flex rounded-full h-2 w-2 ${dotColorClass}"></span>
      </span>
      <span>${statusText}</span>
    `;
  }

  // Web Crypto API E2EE Cryptographic Helpers
  async function initializeE2EE() {
    try {
      state.ecdhKeyPair = await window.crypto.subtle.generateKey(
        {
          name: 'ECDH',
          namedCurve: 'P-256'
        },
        true,
        ['deriveKey', 'deriveBits']
      );
      state.localPublicJwk = await window.crypto.subtle.exportKey('jwk', state.ecdhKeyPair.publicKey);
      console.log('E2EE Keys generated locally.');
    } catch (e) {
      console.error('Failed to initialize local E2EE keys:', e);
      showToast('E2EE initialization failed. Transfers will run unencrypted.', 'error');
    }
  }

  async function handlePeerPublicKey(peerJwk) {
    try {
      state.peerPublicJwk = peerJwk;
      const peerPublicKey = await window.crypto.subtle.importKey(
        'jwk',
        peerJwk,
        {
          name: 'ECDH',
          namedCurve: 'P-256'
        },
        true,
        []
      );
      state.sharedKey = await window.crypto.subtle.deriveKey(
        {
          name: 'ECDH',
          public: peerPublicKey
        },
        state.ecdhKeyPair.privateKey,
        {
          name: 'AES-GCM',
          length: 256
        },
        false,
        ['encrypt', 'decrypt']
      );
      console.log('Derived AES-GCM-256 key successfully. Connection is secure.');
      showToast('Connection secured (E2EE Active)', 'success');
    } catch (e) {
      console.error('Failed to derive shared key:', e);
      showToast('Failed to secure connection. Transfer might be insecure.', 'error');
    }
  }

  const getEl = (id) => document.getElementById(id);

  const elements = {
    badge: getEl('connection-badge'),
    roomCodeDisplay: getEl('room-code-display'),
    joinRoomCodeInput: getEl('join-room-code-input'),
    btnJoinRoom: getEl('btn-join-room'),
    btnNewRoom: getEl('btn-new-room'),
    shareUrlInput: getEl('share-url-input'),
    btnCopyLink: getEl('btn-copy-link'),
    qrContainer: getEl('qrcode'),
    peersList: getEl('peers-list'),
    peerPlaceholder: getEl('peer-placeholder'),
    transferSection: getEl('transfer-section'),
    dropzone: getEl('dropzone'),
    fileInput: getEl('file-input'),

    // Sender Staging Queue
    dropzoneDefault: getEl('dropzone-default'),
    stagingContainer: getEl('staging-container'),
    stagingQueueList: getEl('staging-queue-list'),
    stagingCount: getEl('staging-count'),
    btnAddMore: getEl('btn-add-more'),
    btnClearAllStaging: getEl('btn-clear-all-staging'),
    btnConfirmSendAll: getEl('btn-confirm-send-all'),

    // Receiver Incoming Queue UI
    receiverQueueContainer: getEl('receiver-queue-container'),
    receiverPeerInfo: getEl('receiver-peer-info'),
    receiverFileList: getEl('receiver-file-list'),
    btnAcceptAllIncoming: getEl('btn-accept-all-incoming'),
    btnDeclineAllIncoming: getEl('btn-decline-all-incoming'),

    // Progress Bar Elements
    transferSenderLabel: getEl('transfer-sender-label'),
    transferReceiverLabel: getEl('transfer-receiver-label'),
    progressContainer: getEl('progress-container'),
    transferFilename: getEl('transfer-filename'),
    transferPercentage: getEl('transfer-percentage'),
    progressBar: getEl('progress-bar'),
    transferStatus: getEl('transfer-status'),
    transferSpeed: getEl('transfer-speed'),
    transferEta: getEl('transfer-eta'),
    btnCancelTransfer: getEl('btn-cancel-transfer')
  };

  // Sender Staging Functions
  function addFilesToStaging(fileList) {
    const newFiles = Array.from(fileList);
    newFiles.forEach((file) => {
      const exists = state.stagedFiles.some(
        (f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified
      );
      if (!exists) {
        state.stagedFiles.push(file);
      }
    });
    renderStagingQueue();
  }

  function removeFileFromStaging(index) {
    state.stagedFiles.splice(index, 1);
    renderStagingQueue();
  }

  function clearStagedFiles() {
    state.stagedFiles = [];
    if (elements.fileInput) elements.fileInput.value = '';
    renderStagingQueue();
  }

  function renderStagingQueue() {
    if (!elements.stagingContainer || !elements.dropzoneDefault) return;

    if (state.stagedFiles.length === 0) {
      elements.stagingContainer.classList.add('hidden');
      elements.dropzoneDefault.classList.remove('hidden');
      return;
    }

    elements.dropzoneDefault.classList.add('hidden');
    elements.stagingContainer.classList.remove('hidden');

    if (elements.stagingCount) {
      elements.stagingCount.textContent = `Staged Files (${state.stagedFiles.length})`;
    }

    if (!elements.stagingQueueList) return;
    elements.stagingQueueList.innerHTML = '';

    state.stagedFiles.forEach((file, index) => {
      const card = document.createElement('div');
      card.className = 'flex items-center justify-between p-2.5 rounded-xl bg-slate-900/80 border border-slate-700/60 backdrop-blur-md gap-3';

      const fileExt = file.name.split('.').pop() || 'FILE';
      const isImg = file.type.startsWith('image/');

      let previewHtml = '';
      if (isImg) {
        const objectUrl = URL.createObjectURL(file);
        previewHtml = `<img src="${objectUrl}" class="h-10 w-10 object-cover rounded-lg shrink-0 border border-slate-700" onload="URL.revokeObjectURL('${objectUrl}')"/>`;
      } else {
        previewHtml = `
          <div class="h-10 w-10 rounded-lg bg-indigo-500/10 border border-indigo-500/30 shrink-0 flex flex-col items-center justify-center text-indigo-300">
            <span class="text-[9px] font-bold uppercase tracking-wider">${fileExt.substring(0, 4)}</span>
          </div>
        `;
      }

      card.innerHTML = `
        <div class="flex items-center gap-3 min-w-0 flex-1">
          ${previewHtml}
          <div class="flex flex-col min-w-0 pr-2">
            <p class="text-xs font-bold text-slate-100 truncate">${file.name}</p>
            <p class="text-[11px] font-mono text-slate-400">${formatBytes(file.size)}</p>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button data-send-idx="${index}" class="px-2.5 py-1.5 bg-indigo-600/80 hover:bg-indigo-500 text-white text-[11px] font-semibold rounded-lg shadow transition-all active:scale-95">
            Send
          </button>
          <button data-remove-idx="${index}" class="p-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-rose-400 rounded-lg transition-colors">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
          </button>
        </div>
      `;

      elements.stagingQueueList.appendChild(card);
    });

    elements.stagingQueueList.querySelectorAll('[data-send-idx]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-send-idx'), 10);
        sendBatchFiles([state.stagedFiles[idx]], [idx]);
      });
    });

    elements.stagingQueueList.querySelectorAll('[data-remove-idx]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-remove-idx'), 10);
        removeFileFromStaging(idx);
      });
    });
  }

  // RECEIVER BATCH QUEUE RENDERING WITH DIRECT ACCEPT/DECLINE BUTTONS
  function renderReceiverBatchQueue() {
    if (!elements.receiverQueueContainer || !elements.receiverFileList) return;

    if (state.incomingBatch.length === 0) {
      elements.receiverQueueContainer.classList.add('hidden');
      return;
    }

    elements.receiverQueueContainer.classList.remove('hidden');
    elements.receiverFileList.innerHTML = '';

    if (elements.receiverPeerInfo) {
      const senderName = state.incomingBatch[0]?.senderName || 'Peer';
      elements.receiverPeerInfo.textContent = `${senderName} wants to send ${state.incomingBatch.length} file(s)`;
    }

    state.incomingBatch.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'flex items-center justify-between p-3 rounded-xl bg-slate-800/80 border border-slate-700/80 gap-3';

      card.innerHTML = `
        <div class="flex items-center gap-3 min-w-0 flex-1">
          <div class="flex flex-col min-w-0">
            <p class="text-xs font-bold text-slate-100 truncate">${item.name}</p>
            <p class="text-[11px] font-mono text-slate-400">${formatBytes(item.size)}</p>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button data-accept-id="${item.fileId}" class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
            item.accepted 
              ? 'bg-emerald-600 text-white shadow-md' 
              : 'bg-slate-700/60 text-slate-400 hover:bg-emerald-600/30 hover:text-emerald-300'
          }">
            Accept
          </button>
          <button data-decline-id="${item.fileId}" class="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
            !item.accepted 
              ? 'bg-rose-600 text-white shadow-md' 
              : 'bg-slate-700/60 text-slate-400 hover:bg-rose-600/30 hover:text-rose-300'
          }">
            Decline
          </button>
        </div>
      `;

      elements.receiverFileList.appendChild(card);
    });

    elements.receiverFileList.querySelectorAll('[data-accept-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const fileId = e.currentTarget.getAttribute('data-accept-id');
        const item = state.incomingBatch.find((i) => i.fileId === fileId);
        if (item) {
          item.accepted = true;
          renderReceiverBatchQueue();
        }
      });
    });

    elements.receiverFileList.querySelectorAll('[data-decline-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const fileId = e.currentTarget.getAttribute('data-decline-id');
        const item = state.incomingBatch.find((i) => i.fileId === fileId);
        if (item) {
          item.accepted = false;
          renderReceiverBatchQueue();
        }
      });
    });
  }

  async function submitReceiverBatchResponse(isAcceptingAny) {
    const decisions = {};
    
    // Clear any previous file streams / handles
    state.incomingFileStreams = {};
    state.incomingFileHandles = {};

    for (const item of state.incomingBatch) {
      const accepted = isAcceptingAny ? item.accepted : false;
      decisions[item.fileId] = accepted;

      if (accepted) {
        if ('showSaveFilePicker' in window) {
          try {
            // Prompt user for save file path (this requires a user gesture and is synchronous with the click event)
            const fileHandle = await window.showSaveFilePicker({ suggestedName: item.name });
            const writableStream = await fileHandle.createWritable();
            state.incomingFileHandles[item.fileId] = fileHandle;
            state.incomingFileStreams[item.fileId] = writableStream;
          } catch (e) {
            console.warn(`File picker cancelled or failed for ${item.name}, falling back to memory buffering:`, e);
            // We still accept it, but since state.incomingFileStreams[item.fileId] is empty, it will fall back to memory buffering.
          }
        }
      }
    }

    if (state.dataChannel && state.dataChannel.readyState === 'open') {
      state.dataChannel.send(
        JSON.stringify({
          type: 'batch-response',
          decisions
        })
      );
    }

    elements.receiverQueueContainer.classList.add('hidden');
  }

  // Room & WebRTC Setup
  function createNewRoom() {
    const newRoomId = generateRoomId();
    window.location.hash = `room=${newRoomId}`;
    showToast(`Created new room: ${newRoomId}`, 'info');
  }

  function initRoom() {
    let roomId = getRoomIdFromHash();
    if (!roomId) {
      roomId = generateRoomId();
      window.location.hash = `room=${roomId}`;
    }
    joinRoom(roomId);
  }

  function joinRoom(newRoomId) {
    if (state.roomId === newRoomId && state.socket && state.socket.connected) {
      return;
    }

    if (state.peerConnection) {
      state.peerConnection.close();
      state.peerConnection = null;
    }
    state.dataChannel = null;

    if (elements.transferSection) elements.transferSection.classList.add('hidden');

    state.roomId = newRoomId;
    state.peers = [];

    if (elements.roomCodeDisplay) elements.roomCodeDisplay.textContent = state.roomId;
    const fullShareUrl = `${window.location.origin}${window.location.pathname}#room=${state.roomId}`;
    if (elements.shareUrlInput) elements.shareUrlInput.value = fullShareUrl;

    if (elements.qrContainer && typeof QRCode !== 'undefined') {
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

    renderPeers();

    if (state.socket && state.socket.connected) {
      updateBadge('Waiting for peer', 'bg-sky-400');
      state.socket.emit('create-or-join-room', {
        roomId: state.roomId,
        userInfo: localUser
      });
    }
  }

  window.addEventListener('hashchange', () => {
    const roomId = getRoomIdFromHash();
    if (roomId) joinRoom(roomId);
  });

  function createPeerConnection(targetPeerId) {
    if (state.peerConnection) {
      state.peerConnection.close();
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);
    state.peerConnection = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate && state.socket) {
        state.socket.emit('signal', {
          targetId: targetPeerId,
          signalData: { type: 'candidate', candidate: event.candidate }
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        updateBadge('Connected', 'bg-emerald-400');
        if (elements.transferSection) elements.transferSection.classList.remove('hidden');
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        updateBadge('Peer left', 'bg-amber-400');
        if (elements.transferSection) elements.transferSection.classList.add('hidden');
      }
    };

    pc.ondatachannel = (event) => {
      state.dataChannel = event.channel;
      setupDataChannelEvents();
    };

    return pc;
  }

  function setupDataChannelEvents() {
    if (!state.dataChannel) return;
    state.dataChannel.binaryType = 'arraybuffer';

    state.dataChannel.onopen = () => {
      if (elements.transferSection) elements.transferSection.classList.remove('hidden');
    };

    state.dataChannel.onclose = () => {
      if (elements.transferSection) elements.transferSection.classList.add('hidden');
    };

    state.dataChannel.onmessage = handleIncomingData;
  }

  async function startWebRTCOffer(targetPeerId) {
    const pc = createPeerConnection(targetPeerId);
    state.dataChannel = pc.createDataChannel('file-transfer', { ordered: true });
    setupDataChannelEvents();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    state.socket.emit('signal', {
      targetId: targetPeerId,
      signalData: { type: 'offer', offer }
    });
  }

  async function handleSignalMessage({ senderId, signalData }) {
    if (signalData.type === 'ecdh-public-key') {
      await handlePeerPublicKey(signalData.key);
      if (state.localPublicJwk && !state.peerPublicJwk) {
        state.socket.emit('signal', {
          targetId: senderId,
          signalData: { type: 'ecdh-public-key', key: state.localPublicJwk }
        });
      }
    } else if (signalData.type === 'offer') {
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

  // SENDER BATCH TRANSMISSION ENGINE
  async function sendBatchFiles(filesToSend, indicesToRemove = []) {
    if (!state.dataChannel || state.dataChannel.readyState !== 'open') {
      showToast('Peer connection is not open!', 'error');
      return;
    }

    if (state.isTransferring) {
      showToast('A transfer is currently in progress', 'error');
      return;
    }

    state.isTransferring = true;
    state.transferCancelled = false;

    const batchPayload = filesToSend.map((file) => ({
      fileId: 'file_' + Math.random().toString(36).substring(2, 9),
      name: file.name,
      size: file.size,
      mimeType: file.type,
      senderName: localUser.name
    }));

    if (elements.progressContainer) elements.progressContainer.classList.remove('hidden');
    if (elements.transferStatus) elements.transferStatus.textContent = 'Waiting for receiver to accept files...';

    state.dataChannel.send(
      JSON.stringify({
        type: 'batch-offer',
        files: batchPayload
      })
    );

    const batchDecisions = await new Promise((resolve) => {
      state.batchDecisionResolver = resolve;
      setTimeout(() => {
        if (state.batchDecisionResolver) {
          state.batchDecisionResolver = null;
          resolve(null);
        }
      }, 60000);
    });

    if (!batchDecisions || state.transferCancelled) {
      state.isTransferring = false;
      resetTransferUI('Transfer declined or timed out');
      showToast('Transfer declined or timed out', 'error');
      playAudioFeedback('cancel');
      return;
    }

    const successfulIndices = [];

    const acceptedFilesToStream = filesToSend.filter((file, idx) => {
      const meta = batchPayload[idx];
      return batchDecisions[meta.fileId] === true;
    });

    if (acceptedFilesToStream.length === 0) {
      state.isTransferring = false;
      resetTransferUI('Peer declined all files');
      showToast('Peer declined all files in batch', 'error');
      playAudioFeedback('cancel');
      return;
    }

    for (let i = 0; i < acceptedFilesToStream.length; i++) {
      const file = acceptedFilesToStream[i];
      const originalIdx = filesToSend.indexOf(file);
      const meta = batchPayload[originalIdx];

      const success = await streamSingleFile(file, meta, i + 1, acceptedFilesToStream.length);
      if (!success) break;

      successfulIndices.push(indicesToRemove[originalIdx]);
    }

    if (successfulIndices.length > 0) {
      state.stagedFiles = state.stagedFiles.filter((_, idx) => !successfulIndices.includes(idx));
      renderStagingQueue();
    }

    state.isTransferring = false;
  }

  // SHA-256 Helper Function
  async function computeSHA256(arrayBuffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Inside streamSingleFile (Sender side):
  async function streamSingleFile(file, metadata, fileIndex, totalFiles) {
    if (state.transferCancelled) return false;

    state.transferStartTime = Date.now();
    state.lastMetricTime = Date.now();
    state.lastMetricBytes = 0;

    if (elements.transferSenderLabel) elements.transferSenderLabel.textContent = 'You (Sending)';
    if (elements.transferReceiverLabel) elements.transferReceiverLabel.textContent = 'Peer (Receiving)';

    const label = totalFiles > 1 ? `[${fileIndex}/${totalFiles}] ${file.name}` : file.name;
    if (elements.transferFilename) elements.transferFilename.textContent = label;
    if (elements.transferStatus) elements.transferStatus.textContent = 'Computing SHA-256 hash...';

    const arrayBuffer = await file.arrayBuffer();
    const checksum = await computeSHA256(arrayBuffer);

    if (elements.transferStatus) elements.transferStatus.textContent = 'Sending...';

    state.dataChannel.send(
      JSON.stringify({
        type: 'start-file-stream',
        fileId: metadata.fileId,
        name: metadata.name,
        size: metadata.size,
        mimeType: metadata.mimeType,
        checksum: checksum
      })
    );

    playAudioFeedback('start');

    let offset = 0;
    state.dataChannel.bufferedAmountLowThreshold = 1024 * 1024; // 1 MB low watermark

    while (offset < file.size) {
      if (state.transferCancelled) {
        if (state.dataChannel) state.dataChannel.onbufferedamountlow = null;
        resetTransferUI('Transfer cancelled');
        playAudioFeedback('cancel');
        return false;
      }

      // Backpressure Check: 16 MB high watermark
      if (state.dataChannel.bufferedAmount > 16 * 1024 * 1024) {
        await new Promise((res) => {
          state.dataChannel.onbufferedamountlow = () => {
            state.dataChannel.onbufferedamountlow = null;
            res();
          };
        });
        continue;
      }

      const end = Math.min(offset + state.CHUNK_SIZE, file.size);
      const plaintextChunk = arrayBuffer.slice(offset, end);
      let packetBuffer;

      if (state.sharedKey) {
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encrypted = await window.crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: iv
          },
          state.sharedKey,
          plaintextChunk
        );

        const packet = new Uint8Array(12 + encrypted.byteLength);
        packet.set(iv, 0);
        packet.set(new Uint8Array(encrypted), 12);
        packetBuffer = packet.buffer;
      } else {
        packetBuffer = plaintextChunk;
      }

      state.dataChannel.send(packetBuffer);
      offset += plaintextChunk.byteLength;

      updateTransferMetrics(offset, file.size);
    }

    if (elements.transferStatus) elements.transferStatus.textContent = 'Completed!';
    showToast(`Sent ${file.name}`, 'success');
    playAudioFeedback('complete');
    triggerHaptic([100, 50, 100]);
    setTimeout(() => resetTransferUI(), 1500);
    return true;
  }

  // RECEIVER INCOMING DATA DISPATCHER
  async function handleIncomingData(event) {
    const data = event.data;

    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);

        if (parsed.type === 'batch-offer') {
          state.incomingBatch = parsed.files.map((f) => ({
            ...f,
            accepted: true
          }));

          renderReceiverBatchQueue();
          playAudioFeedback('start');
          triggerHaptic([200, 100, 200]);
          return;
        }

        if (parsed.type === 'batch-response') {
          if (state.batchDecisionResolver) {
            state.batchDecisionResolver(parsed.decisions);
            state.batchDecisionResolver = null;
          }
          return;
        }

        if (parsed.type === 'start-file-stream') {
          state.incomingFileInfo = parsed;
          state.isTransferring = true;
          state.receivedChunks = [];
          state.receivedSize = 0;
          state.transferStartTime = Date.now();
          state.lastMetricTime = Date.now();
          state.lastMetricBytes = 0;
          state.transferCancelled = false;

          if (elements.transferSenderLabel) elements.transferSenderLabel.textContent = 'Peer (Sending)';
          if (elements.transferReceiverLabel) elements.transferReceiverLabel.textContent = 'You (Receiving)';

          if (elements.progressContainer) elements.progressContainer.classList.remove('hidden');
          if (elements.transferFilename) elements.transferFilename.textContent = parsed.name;
          if (elements.transferStatus) elements.transferStatus.textContent = 'Receiving stream...';

          // Assign the pre-opened stream and handle
          state.writableStream = (state.incomingFileStreams && state.incomingFileStreams[parsed.fileId]) || null;
          state.fileHandle = (state.incomingFileHandles && state.incomingFileHandles[parsed.fileId]) || null;

          updateTransferMetrics(0, parsed.size);
          return;
        }

        if (parsed.type === 'cancel') {
          state.transferCancelled = true;
          state.isTransferring = false;

          if (state.writableStream) {
            await state.writableStream.abort().catch(() => {});
            state.writableStream = null;
            if (state.incomingFileInfo) {
              delete state.incomingFileStreams[state.incomingFileInfo.fileId];
              delete state.incomingFileHandles[state.incomingFileInfo.fileId];
            }
          }

          state.incomingFileInfo = null;
          state.receivedChunks = [];
          resetTransferUI('Transfer cancelled');
          showToast('Transfer was cancelled', 'error');
          playAudioFeedback('cancel');
          return;
        }
      } catch (err) {
        console.error('Data error:', err);
      }
      return;
    }

    if ((data instanceof ArrayBuffer || ArrayBuffer.isView(data)) && state.incomingFileInfo) {
      if (state.transferCancelled) return;

      const packetBuffer = data instanceof ArrayBuffer ? data : data.buffer;
      let decryptedChunk;

      if (state.sharedKey) {
        try {
          const packet = new Uint8Array(packetBuffer);
          const iv = packet.subarray(0, 12);
          const ciphertext = packet.subarray(12);

          decryptedChunk = await window.crypto.subtle.decrypt(
            {
              name: 'AES-GCM',
              iv: iv
            },
            state.sharedKey,
            ciphertext
          );
        } catch (decErr) {
          console.error('Decryption failed! Bit-rot or wrong key:', decErr);
          showToast('Decryption failed. Transfer aborted.', 'error');
          state.transferCancelled = true;
          resetTransferUI('Decryption failed');
          playAudioFeedback('cancel');
          return;
        }
      } else {
        decryptedChunk = packetBuffer;
      }

      state.receivedSize += decryptedChunk.byteLength;

      if (state.writableStream) {
        await state.writableStream.write(decryptedChunk);
      } else {
        state.receivedChunks.push(decryptedChunk);
      }

      updateTransferMetrics(state.receivedSize, state.incomingFileInfo.size);

      if (state.receivedSize >= state.incomingFileInfo.size) {
        if (elements.transferStatus) elements.transferStatus.textContent = 'Verifying SHA-256 checksum...';

        let receivedBuffer;
        if (state.writableStream) {
          await state.writableStream.close();
          state.writableStream = null;
          // Delete from state trackers
          delete state.incomingFileStreams[state.incomingFileInfo.fileId];
          delete state.incomingFileHandles[state.incomingFileInfo.fileId];
          
          // For File System Access API, read back or rely on chunk buffer
          receivedBuffer = await (await state.fileHandle.getFile()).arrayBuffer();
        } else {
          const blob = new Blob(state.receivedChunks);
          receivedBuffer = await blob.arrayBuffer();
        }

        const calculatedChecksum = await computeSHA256(receivedBuffer);
        const expectedChecksum = state.incomingFileInfo.checksum;

        if (expectedChecksum && calculatedChecksum !== expectedChecksum) {
          showToast(`Integrity Check Failed: ${state.incomingFileInfo.name} (Bit-rot detected!)`, 'error');
          playAudioFeedback('cancel');
        } else {
          if (!state.fileHandle) {
            const blob = new Blob([receivedBuffer], {
              type: state.incomingFileInfo.mimeType || 'application/octet-stream'
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = state.incomingFileInfo.name;
            a.click();
            URL.revokeObjectURL(url);
          }
          showToast(`Verified & Saved: ${state.incomingFileInfo.name}`, 'success');
          playAudioFeedback('complete');
          triggerHaptic([100, 50, 100]);
        }

        state.incomingFileInfo = null;
        state.receivedChunks = [];
        state.isTransferring = false;

        setTimeout(() => resetTransferUI(), 1500);
      }
    }
  }

  // Phase 3: Metrics & Browser Tab Title Update
  function updateTransferMetrics(currentBytes, totalBytes) {
    if (!totalBytes || totalBytes === 0) return;

    const percent = Math.min(100, Math.round((currentBytes / totalBytes) * 100));
    if (elements.progressBar) elements.progressBar.style.width = `${percent}%`;
    if (elements.transferPercentage) elements.transferPercentage.textContent = `${percent}%`;

    // Tab title update
    document.title = `(${percent}%) FileShare`;

    const now = Date.now();
    const timeDelta = (now - state.lastMetricTime) / 1000;

    if (timeDelta >= 0.3) {
      const bytesDelta = currentBytes - state.lastMetricBytes;
      const bytesPerSec = bytesDelta / timeDelta;

      if (elements.transferSpeed) {
        elements.transferSpeed.textContent = `${formatBytes(bytesPerSec)}/s`;
      }

      const remainingBytes = totalBytes - currentBytes;
      const etaSeconds = bytesPerSec > 0 ? remainingBytes / bytesPerSec : 0;
      if (elements.transferEta) {
        elements.transferEta.textContent = formatETA(etaSeconds);
      }

      state.lastMetricTime = now;
      state.lastMetricBytes = currentBytes;
    }
  }

  function resetTransferUI(statusText = '') {
    document.title = 'FileShare';

    if (statusText && elements.transferStatus) {
      elements.transferStatus.textContent = statusText;
    }
    if (elements.progressBar) elements.progressBar.style.width = '0%';
    if (elements.transferPercentage) elements.transferPercentage.textContent = '0%';
    if (elements.transferSpeed) elements.transferSpeed.textContent = '0 KB/s';
    if (elements.transferEta) elements.transferEta.textContent = 'ETA: --';

    setTimeout(() => {
      if (!state.incomingFileInfo && !state.isTransferring && elements.progressContainer) {
        elements.progressContainer.classList.add('hidden');
      }
    }, 2500);
  }

  // Event Listeners
  if (elements.btnCancelTransfer) {
    elements.btnCancelTransfer.addEventListener('click', () => {
      state.transferCancelled = true;
      state.isTransferring = false;

      if (state.dataChannel && state.dataChannel.readyState === 'open') {
        try {
          state.dataChannel.send(JSON.stringify({ type: 'cancel' }));
        } catch (e) {}
      }

      if (state.writableStream) {
        state.writableStream.abort().catch(() => {});
        state.writableStream = null;
      }

      state.receivedChunks = [];
      resetTransferUI('Transfer cancelled');
      showToast('Transfer was cancelled', 'error');
      playAudioFeedback('cancel');
    });
  }

  if (elements.btnAddMore && elements.fileInput) {
    elements.btnAddMore.addEventListener('click', (e) => {
      e.stopPropagation();
      elements.fileInput.click();
    });
  }

  if (elements.btnClearAllStaging) {
    elements.btnClearAllStaging.addEventListener('click', (e) => {
      e.stopPropagation();
      clearStagedFiles();
    });
  }

  if (elements.btnConfirmSendAll) {
    elements.btnConfirmSendAll.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.stagedFiles.length > 0) {
        const allIndices = state.stagedFiles.map((_, i) => i);
        sendBatchFiles([...state.stagedFiles], allIndices);
      }
    });
  }

  if (elements.btnAcceptAllIncoming) {
    elements.btnAcceptAllIncoming.addEventListener('click', () => {
      submitReceiverBatchResponse(true);
    });
  }

  if (elements.btnDeclineAllIncoming) {
    elements.btnDeclineAllIncoming.addEventListener('click', () => {
      submitReceiverBatchResponse(false);
    });
  }

  // Socket Setup
  function initSocket() {
    if (typeof io === 'undefined') return;

    state.socket = io(window.location.origin);

    state.socket.on('connect', () => {
      // Always register our presence on the socket room
      state.socket.emit('create-or-join-room', {
        roomId: state.roomId,
        userInfo: localUser
      });

      if (state.isTransferring && state.peerConnection && state.peerConnection.connectionState === 'connected') {
        console.log('Signaling reconnected mid-stream. Preserving active WebRTC connection.');
        updateBadge('Connected', 'bg-emerald-400');
        return;
      }

      updateBadge('Waiting for peer', 'bg-sky-400');
    });

    state.socket.on('room-peers', ({ isInitiator, peers }) => {
      state.isInitiator = isInitiator;
      state.peers = peers;
      renderPeers();
    });

    state.socket.on('ready-to-connect', () => {
      const targetPeer = state.peers.find((p) => p.socketId !== state.socket.id);
      if (targetPeer) {
        // Send our ECDH public key to the peer
        if (state.localPublicJwk) {
          state.socket.emit('signal', {
            targetId: targetPeer.socketId,
            signalData: { type: 'ecdh-public-key', key: state.localPublicJwk }
          });
        }

        // If WebRTC is already connected or connecting, do not renegotiate
        if (state.peerConnection && (state.peerConnection.connectionState === 'connected' || state.peerConnection.connectionState === 'connecting')) {
          console.log('Already connected/connecting. Skipping WebRTC offer.');
          return;
        }

        if (state.isInitiator) {
          startWebRTCOffer(targetPeer.socketId);
        }
      }
    });

    state.socket.on('signal', handleSignalMessage);

    state.socket.on('peer-disconnected', ({ peerId }) => {
      state.peers = state.peers.filter((p) => p.socketId !== peerId);
      
      // If WebRTC is still connected, do not close the active session
      if (state.peerConnection && state.peerConnection.connectionState === 'connected') {
        console.log('Peer disconnected from signaling, but WebRTC is active. Keeping connection.');
        renderPeers();
        return;
      }

      if (state.peerConnection) {
        state.peerConnection.close();
        state.peerConnection = null;
      }
      if (elements.transferSection) elements.transferSection.classList.add('hidden');
      updateBadge('Waiting for peer', 'bg-sky-400');
      renderPeers();
    });

    state.socket.on('disconnect', () => {
      if (state.peerConnection && state.peerConnection.connectionState === 'connected') {
        console.log('Signaling server offline, but active WebRTC P2P connection is live.');
        updateBadge('Connected (P2P Direct)', 'bg-emerald-400');
      } else {
        updateBadge('Signaling Offline', 'bg-rose-500');
      }
    });
  }

  function renderPeers() {
    if (!elements.peersList) return;
    elements.peersList.innerHTML = '';

    if (state.peers.length === 0) {
      if (elements.peerPlaceholder) {
        elements.peersList.appendChild(elements.peerPlaceholder);
      }
    } else {
      state.peers.forEach((peer) => {
        const socketId = typeof peer === 'string' ? peer : peer.socketId;
        const name = peer.name || 'Anonymous Peer';
        const avatar = peer.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${socketId}`;
        const isSelf = socketId === state.socket.id;

        const card = document.createElement('div');
        card.className = 'flex flex-row items-center p-4 rounded-xl bg-white/5 border border-white/10 backdrop-blur-md gap-4 shadow-xl';
        card.innerHTML = `
          <div class="relative shrink-0">
            <img src="${avatar}" alt="${name}" class="h-16 w-16 rounded-full bg-white/10 p-1 border-2 ${isSelf ? 'border-indigo-400' : 'border-emerald-400'}"/>
            <span class="absolute bottom-0 right-0 h-4 w-4 rounded-full bg-emerald-400 border-2 border-slate-900"></span>
          </div>
          <div class="flex flex-col justify-center min-w-0">
            <p class="text-base font-bold text-slate-100 truncate">${name}</p>
            <span class="inline-block mt-1 text-[10px] font-semibold tracking-wider uppercase px-2 py-0.5 rounded-md w-max ${isSelf ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'}">
              ${isSelf ? 'You' : 'Peer'}
            </span>
          </div>
        `;
        elements.peersList.appendChild(card);
      });
    }
  }

  // Dropzone Setup
  if (elements.dropzone && elements.fileInput) {
    elements.dropzone.addEventListener('click', (e) => {
      if (e.target.closest('#staging-container')) return;
      elements.fileInput.click();
    });

    elements.fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) addFilesToStaging(e.target.files);
    });

    elements.dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      elements.dropzone.classList.add('border-indigo-500', 'bg-indigo-500/10');
    });

    elements.dropzone.addEventListener('dragleave', () => {
      elements.dropzone.classList.remove('border-indigo-500', 'bg-indigo-500/10');
    });

    elements.dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      elements.dropzone.classList.remove('border-indigo-500', 'bg-indigo-500/10');
      if (e.dataTransfer.files.length > 0) addFilesToStaging(e.dataTransfer.files);
    });
  }

  if (elements.btnCopyLink && elements.shareUrlInput) {
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
        console.error('Copy link error:', err);
      }
    });
  }

  if (elements.btnNewRoom) elements.btnNewRoom.addEventListener('click', createNewRoom);

  function handleJoinByCode() {
    if (!elements.joinRoomCodeInput) return;
    const inputCode = elements.joinRoomCodeInput.value.trim();
    if (!inputCode) return showToast('Please enter a room code', 'error');
    if (inputCode === state.roomId) return showToast('You are already in this room', 'info');

    window.location.hash = `room=${inputCode}`;
    elements.joinRoomCodeInput.value = '';
    showToast(`Joining room: ${inputCode}`, 'info');
  }

  if (elements.btnJoinRoom) elements.btnJoinRoom.addEventListener('click', handleJoinByCode);

  if (elements.joinRoomCodeInput) {
    elements.joinRoomCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleJoinByCode();
    });
  }

  initializeE2EE();
  initRoom();
  initSocket();
});