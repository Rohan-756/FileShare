document.addEventListener('DOMContentLoaded', () => {
  // 1. App State
  const state = {
    socket: null,
    roomId: null,
    isInitiator: false,
    peers: [],
    qrCodeInstance: null,
    peerConnection: null,
    dataChannel: null,

    // Incoming file state
    incomingFileInfo: null,
    receivedChunks: [],
    receivedSize: 0,
    CHUNK_SIZE: 16 * 1024,

    // Stream handles
    fileHandle: null,
    writableStream: null,

    // Transfer & Speed Metrics
    fileQueue: [],
    isTransferring: false,
    transferStartTime: 0,
    lastMetricTime: 0,
    lastMetricBytes: 0,
    transferCancelled: false,

    // Handshake resolver
    receiverReadyResolver: null
  };

  // STUN + TURN Fallback Configuration for Firewalls/NAT
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
      }
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

  // Helper Utilities
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
    requestAnimationFrame(() => {
      toast.classList.remove('translate-y-2', 'opacity-0');
    });

    setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-y-2');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // 2. DOM Elements
  const elements = {
    badge: document.getElementById('connection-badge'),
    roomCodeDisplay: document.getElementById('room-code-display'),
    shareUrlInput: document.getElementById('share-url-input'),
    btnCopyLink: document.getElementById('btn-copy-link'),
    qrContainer: document.getElementById('qrcode'),
    peersList: document.getElementById('peers-list'),
    peerPlaceholder: document.getElementById('peer-placeholder'),
    transferSection: document.getElementById('transfer-section'),
    dropzone: document.getElementById('dropzone'),
    fileInput: document.getElementById('file-input'),
    progressContainer: document.getElementById('progress-container'),
    transferFilename: document.getElementById('transfer-filename'),
    transferPercentage: document.getElementById('transfer-percentage'),
    progressBar: document.getElementById('progress-bar'),
    transferStatus: document.getElementById('transfer-status'),
    transferSpeed: document.getElementById('transfer-speed'),
    transferEta: document.getElementById('transfer-eta'),
    btnCancelTransfer: document.getElementById('btn-cancel-transfer')
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

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        state.socket.emit('signal', {
          targetId: targetPeerId,
          signalData: { type: 'candidate', candidate: event.candidate }
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('P2P State:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        updateBadge('P2P Connection Established (Encrypted)', 'bg-emerald-500', 'text-emerald-400');
        elements.transferSection.classList.remove('hidden');
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        updateBadge('P2P Connection Lost', 'bg-rose-500', 'text-rose-400');
        elements.transferSection.classList.add('hidden');
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
      console.log('DataChannel OPEN');
      elements.transferSection.classList.remove('hidden');
    };

    state.dataChannel.onclose = () => {
      console.log('DataChannel CLOSED');
      elements.transferSection.classList.add('hidden');
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

  // 5. File Sender Engine
  async function sendFile(file) {
    if (!state.dataChannel || state.dataChannel.readyState !== 'open') {
      showToast('Peer connection is not open!', 'error');
      return;
    }

    state.transferCancelled = false;
    state.transferStartTime = Date.now();
    state.lastMetricTime = Date.now();
    state.lastMetricBytes = 0;

    elements.progressContainer.classList.remove('hidden');
    elements.transferFilename.textContent = file.name;
    elements.transferStatus.textContent = 'Waiting for receiver...';

    // Metadata Header
    const metadata = {
      type: 'metadata',
      name: file.name,
      size: file.size,
      mimeType: file.type
    };
    state.dataChannel.send(JSON.stringify(metadata));

    // Wait for Handshake Ready Ack
    await new Promise((resolve) => {
      state.receiverReadyResolver = resolve;
      setTimeout(() => {
        if (state.receiverReadyResolver) {
          state.receiverReadyResolver = null;
          resolve();
        }
      }, 5000);
    });

    elements.transferStatus.textContent = 'Sending...';

    const arrayBuffer = await file.arrayBuffer();
    let offset = 0;
    state.dataChannel.bufferedAmountLowThreshold = 65536;

    return new Promise((resolve) => {
      const sendChunks = () => {
        while (offset < file.size) {
          if (state.transferCancelled) {
            state.dataChannel.send(JSON.stringify({ type: 'cancel' }));
            resetTransferUI('Sending cancelled');
            showToast(`Cancelled sending ${file.name}`, 'info');
            resolve();
            return;
          }

          if (state.dataChannel.bufferedAmount > state.dataChannel.bufferedAmountLowThreshold) {
            state.dataChannel.onbufferedamountlow = () => {
              state.dataChannel.onbufferedamountlow = null;
              sendChunks();
            };
            return;
          }

          const chunk = arrayBuffer.slice(offset, offset + state.CHUNK_SIZE);
          state.dataChannel.send(chunk);
          offset += chunk.byteLength;

          updateTransferMetrics(offset, file.size);
        }

        elements.transferStatus.textContent = 'Completed!';
        showToast(`Sent ${file.name} successfully`, 'success');
        setTimeout(() => resetTransferUI(), 3000);
        resolve();
      };

      sendChunks();
    });
  }

  // 6. File Receiver & Data Dispatcher
  async function handleIncomingData(event) {
    const data = event.data;

    // Control Messages
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);

        if (parsed.type === 'receiver-ready') {
          if (state.receiverReadyResolver) {
            state.receiverReadyResolver();
            state.receiverReadyResolver = null;
          }
          return;
        }

        if (parsed.type === 'metadata') {
          state.incomingFileInfo = parsed;
          state.receivedChunks = [];
          state.receivedSize = 0;
          state.transferStartTime = Date.now();
          state.lastMetricTime = Date.now();
          state.lastMetricBytes = 0;
          state.transferCancelled = false;
          state.fileHandle = null;
          state.writableStream = null;

          elements.progressContainer.classList.remove('hidden');
          elements.transferFilename.textContent = parsed.name;
          elements.transferStatus.textContent = 'Preparing save location...';

          if ('showSaveFilePicker' in window) {
            try {
              state.fileHandle = await window.showSaveFilePicker({
                suggestedName: parsed.name
              });
              state.writableStream = await state.fileHandle.createWritable();
              elements.transferStatus.textContent = 'Streaming to disk...';
            } catch (err) {
              elements.transferStatus.textContent = 'Receiving (Memory Fallback)...';
            }
          } else {
            elements.transferStatus.textContent = 'Receiving (Memory Fallback)...';
          }

          if (state.dataChannel && state.dataChannel.readyState === 'open') {
            state.dataChannel.send(JSON.stringify({ type: 'receiver-ready' }));
          }

          updateTransferMetrics(0, parsed.size);
          return;
        }

        if (parsed.type === 'cancel') {
          if (state.writableStream) {
            await state.writableStream.abort();
          }
          state.incomingFileInfo = null;
          state.receivedChunks = [];
          state.writableStream = null;
          state.fileHandle = null;
          resetTransferUI('Peer cancelled transfer');
          showToast('Sender cancelled transfer', 'error');
          return;
        }
      } catch (err) {
        console.error('DataChannel JSON Error:', err);
      }
      return;
    }

    // Binary Chunks
    if ((data instanceof ArrayBuffer || ArrayBuffer.isView(data)) && state.incomingFileInfo) {
      if (state.transferCancelled) return;

      const chunk = data instanceof ArrayBuffer ? data : data.buffer;
      state.receivedSize += chunk.byteLength;

      if (state.writableStream) {
        await state.writableStream.write(chunk);
      } else {
        state.receivedChunks.push(chunk);
      }

      updateTransferMetrics(state.receivedSize, state.incomingFileInfo.size);

      // Finished!
      if (state.receivedSize >= state.incomingFileInfo.size) {
        if (state.writableStream) {
          await state.writableStream.close();
          elements.transferStatus.textContent = 'Saved to disk!';
          showToast(`Saved to disk: ${state.incomingFileInfo.name}`, 'success');
        } else {
          const blob = new Blob(state.receivedChunks, { 
            type: state.incomingFileInfo.mimeType || 'application/octet-stream' 
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = state.incomingFileInfo.name;
          a.click();
          URL.revokeObjectURL(url);

          elements.transferStatus.textContent = 'Downloaded!';
          showToast(`Downloaded ${state.incomingFileInfo.name}`, 'success');
        }

        state.incomingFileInfo = null;
        state.receivedChunks = [];
        state.writableStream = null;
        state.fileHandle = null;

        setTimeout(() => resetTransferUI(), 3000);
      }
    }
  }

  // 7. Speed & ETA Metrics Calculation
  function updateTransferMetrics(currentBytes, totalBytes) {
    if (!totalBytes || totalBytes === 0) return;

    const percent = Math.min(100, Math.round((currentBytes / totalBytes) * 100));
    elements.progressBar.style.width = `${percent}%`;
    elements.transferPercentage.textContent = `${percent}%`;

    const now = Date.now();
    const timeDelta = (now - state.lastMetricTime) / 1000;

    // Update speed/ETA every 300ms window
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
    if (statusText) {
      elements.transferStatus.textContent = statusText;
    }
    elements.progressBar.style.width = '0%';
    elements.transferPercentage.textContent = '0%';
    if (elements.transferSpeed) elements.transferSpeed.textContent = '0 KB/s';
    if (elements.transferEta) elements.transferEta.textContent = 'ETA: --';

    setTimeout(() => {
      if (!state.incomingFileInfo && !state.isTransferring) {
        elements.progressContainer.classList.add('hidden');
      }
    }, 2500);
  }

  // Cancel Handler
  if (elements.btnCancelTransfer) {
    elements.btnCancelTransfer.addEventListener('click', () => {
      state.transferCancelled = true;
      if (state.dataChannel && state.dataChannel.readyState === 'open') {
        state.dataChannel.send(JSON.stringify({ type: 'cancel' }));
      }
      resetTransferUI('Cancelled');
      showToast('Transfer cancelled', 'info');
    });
  }

  // 8. Socket & UI Handlers
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

    state.socket.on('ready-to-connect', () => {
      const targetPeerId = state.peers.find((id) => id !== state.socket.id);
      if (targetPeerId) {
        startWebRTCOffer(targetPeerId);
      }
    });

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
      elements.transferSection.classList.add('hidden');
      renderPeers();
    });

    state.socket.on('disconnect', () => {
      updateBadge('Disconnected from Server', 'bg-rose-500', 'text-rose-400');
    });
  }

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

  // File Dropzone Listeners
  elements.dropzone.addEventListener('click', () => elements.fileInput.click());
  
  elements.fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      sendFile(e.target.files[0]);
    }
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
    if (e.dataTransfer.files.length > 0) {
      sendFile(e.dataTransfer.files[0]);
    }
  });

  // Copy Link Handler
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

  initRoom();
  initSocket();
});