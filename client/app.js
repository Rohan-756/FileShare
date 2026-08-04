document.addEventListener('DOMContentLoaded', () => {
  // 1. Persistent User Identity Management
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

  // 2. App State
  const state = {
    socket: null,
    roomId: null,
    isInitiator: false,
    peers: [],
    qrCodeInstance: null,
    peerConnection: null,
    dataChannel: null,

    // Step 1: Staging state
    stagedFile: null,

    // Step 2: Auto-accept state & Modal Resolvers
    autoAccept: false,
    incomingFileInfo: null,
    receiverResponseResolver: null,

    // Incoming file assembly state
    receivedChunks: [],
    receivedSize: 0,
    CHUNK_SIZE: 16 * 1024,

    // Stream handles
    fileHandle: null,
    writableStream: null,

    // Transfer & Speed Metrics
    isTransferring: false,
    transferStartTime: 0,
    lastMetricTime: 0,
    lastMetricBytes: 0,
    transferCancelled: false,

    // Handshake resolver
    receiverReadyResolver: null
  };

  // STUN + TURN Fallback Configuration
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

  // Helper Utilities
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

  // STEP 3: Audio & Haptic Feedback Helpers
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
        osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
        osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1); // E5
        osc.frequency.setValueAtTime(783.99, ctx.currentTime + 0.2); // G5
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
      console.warn('Web Audio API disabled or blocked:', e);
    }
  }

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
    requestAnimationFrame(() => {
      toast.classList.remove('translate-y-2', 'opacity-0');
    });

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

  // 3. DOM Elements
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

    // Step 1: Staging Elements
    dropzoneDefault: getEl('dropzone-default'),
    stagingContainer: getEl('staging-container'),
    stagingPreview: getEl('staging-preview'),
    stagingFilename: getEl('staging-filename'),
    stagingFilesize: getEl('staging-filesize'),
    btnCancelStaging: getEl('btn-cancel-staging'),
    btnConfirmSend: getEl('btn-confirm-send'),

    // Step 2: Incoming Modal Elements
    incomingModal: getEl('incoming-modal'),
    incomingPeerName: getEl('incoming-peer-name'),
    incomingFileName: getEl('incoming-file-name'),
    incomingFileSize: getEl('incoming-file-size'),
    chkAutoAccept: getEl('chk-auto-accept'),
    btnAcceptTransfer: getEl('btn-accept-transfer'),
    btnRejectTransfer: getEl('btn-reject-transfer'),

    // Step 3: Direction Indicator Elements
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

  // STEP 1: Staging Logic
  function stageFile(file) {
    state.stagedFile = file;

    if (elements.dropzoneDefault) elements.dropzoneDefault.classList.add('hidden');
    if (elements.stagingContainer) elements.stagingContainer.classList.remove('hidden');

    if (elements.stagingFilename) elements.stagingFilename.textContent = file.name;
    if (elements.stagingFilesize) elements.stagingFilesize.textContent = formatBytes(file.size);

    if (elements.stagingPreview) {
      elements.stagingPreview.innerHTML = '';

      if (file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.className = 'h-full w-full object-cover rounded-xl';
        img.onload = () => URL.revokeObjectURL(img.src);
        elements.stagingPreview.appendChild(img);
      } else {
        const iconSvg = document.createElement('div');
        iconSvg.className = 'flex flex-col items-center justify-center text-indigo-400';
        iconSvg.innerHTML = `
          <svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"></path>
          </svg>
          <span class="text-[10px] font-bold uppercase mt-1 text-slate-300">${file.name.split('.').pop() || 'FILE'}</span>
        `;
        elements.stagingPreview.appendChild(iconSvg);
      }
    }
  }

  function clearStagedFile() {
    state.stagedFile = null;
    if (elements.fileInput) elements.fileInput.value = '';
    if (elements.stagingContainer) elements.stagingContainer.classList.add('hidden');
    if (elements.dropzoneDefault) elements.dropzoneDefault.classList.remove('hidden');
  }

  // 4. Room Management
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

    if (elements.transferSection) {
      elements.transferSection.classList.add('hidden');
    }

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
    if (roomId) {
      joinRoom(roomId);
    }
  });

  // 5. WebRTC Connection Setup
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

  // 6. File Sender Engine
  async function sendFile(file) {
    if (!state.dataChannel || state.dataChannel.readyState !== 'open') {
      showToast('Peer connection is not open!', 'error');
      return;
    }

    state.isTransferring = true;
    state.transferCancelled = false;
    state.transferStartTime = Date.now();
    state.lastMetricTime = Date.now();
    state.lastMetricBytes = 0;

    // STEP 3 UI: Direction Setup
    if (elements.transferSenderLabel) elements.transferSenderLabel.textContent = 'You (Sending)';
    if (elements.transferReceiverLabel) elements.transferReceiverLabel.textContent = 'Peer (Receiving)';

    if (elements.progressContainer) elements.progressContainer.classList.remove('hidden');
    if (elements.transferFilename) elements.transferFilename.textContent = file.name;
    if (elements.transferStatus) elements.transferStatus.textContent = 'Waiting for receiver confirmation...';

    const metadata = {
      type: 'metadata',
      name: file.name,
      size: file.size,
      mimeType: file.type,
      senderName: localUser.name
    };
    state.dataChannel.send(JSON.stringify(metadata));

    playAudioFeedback('start');

    // Wait for receiver confirmation response
    const accepted = await new Promise((resolve) => {
      state.receiverReadyResolver = resolve;
      setTimeout(() => {
        if (state.receiverReadyResolver) {
          state.receiverReadyResolver = null;
          resolve(false); // Timeout rejected
        }
      }, 30000); // 30s confirmation window
    });

    if (!accepted || state.transferCancelled) {
      resetTransferUI('Transfer declined or timed out');
      playAudioFeedback('cancel');
      triggerHaptic([150, 50, 150]);
      clearStagedFile();
      return;
    }

    if (elements.transferStatus) elements.transferStatus.textContent = 'Sending...';

    const arrayBuffer = await file.arrayBuffer();
    let offset = 0;
    state.dataChannel.bufferedAmountLowThreshold = 65536;

    return new Promise((resolve) => {
      const sendChunks = () => {
        while (offset < file.size) {
          if (state.transferCancelled) {
            state.isTransferring = false;
            if (state.dataChannel) {
              state.dataChannel.onbufferedamountlow = null;
            }
            resetTransferUI('Transfer was cancelled');
            playAudioFeedback('cancel');
            triggerHaptic([150, 50, 150]);
            clearStagedFile();
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

        if (!state.transferCancelled) {
          if (elements.transferStatus) elements.transferStatus.textContent = 'Completed!';
          showToast(`Sent ${file.name} successfully`, 'success');
          playAudioFeedback('complete');
          triggerHaptic([100, 50, 100, 50, 200]);
          state.isTransferring = false;
          clearStagedFile();
          setTimeout(() => resetTransferUI(), 3000);
        }
        resolve();
      };

      sendChunks();
    });
  }

  // STEP 2: Show Incoming Confirmation Modal
  function promptIncomingTransfer(metadata) {
    if (state.autoAccept) {
      return Promise.resolve(true);
    }

    if (elements.incomingPeerName) elements.incomingPeerName.textContent = `${metadata.senderName || 'Peer'} wants to send a file`;
    if (elements.incomingFileName) elements.incomingFileName.textContent = metadata.name;
    if (elements.incomingFileSize) elements.incomingFileSize.textContent = formatBytes(metadata.size);

    if (elements.incomingModal) elements.incomingModal.classList.remove('hidden');

    playAudioFeedback('start');
    triggerHaptic([200, 100, 200]);

    return new Promise((resolve) => {
      state.receiverResponseResolver = resolve;
    });
  }

  // 7. File Receiver & Data Dispatcher
  async function handleIncomingData(event) {
    const data = event.data;

    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);

        // Receiver response handling
        if (parsed.type === 'receiver-accept') {
          if (state.receiverReadyResolver) {
            state.receiverReadyResolver(true);
            state.receiverReadyResolver = null;
          }
          return;
        }

        if (parsed.type === 'receiver-reject') {
          if (state.receiverReadyResolver) {
            state.receiverReadyResolver(false);
            state.receiverReadyResolver = null;
          }
          return;
        }

        // STEP 2: Metadata Handshake & Modal Trigger
        if (parsed.type === 'metadata') {
          state.incomingFileInfo = parsed;

          const userAccepted = await promptIncomingTransfer(parsed);

          if (!userAccepted) {
            if (state.dataChannel && state.dataChannel.readyState === 'open') {
              state.dataChannel.send(JSON.stringify({ type: 'receiver-reject' }));
            }
            state.incomingFileInfo = null;
            return;
          }

          // User accepted transfer
          state.isTransferring = true;
          state.receivedChunks = [];
          state.receivedSize = 0;
          state.transferStartTime = Date.now();
          state.lastMetricTime = Date.now();
          state.lastMetricBytes = 0;
          state.transferCancelled = false;
          state.fileHandle = null;
          state.writableStream = null;

          // STEP 3 UI: Direction Setup
          if (elements.transferSenderLabel) elements.transferSenderLabel.textContent = `${parsed.senderName || 'Peer'} (Sending)`;
          if (elements.transferReceiverLabel) elements.transferReceiverLabel.textContent = 'You (Receiving)';

          if (elements.progressContainer) elements.progressContainer.classList.remove('hidden');
          if (elements.transferFilename) elements.transferFilename.textContent = parsed.name;
          if (elements.transferStatus) elements.transferStatus.textContent = 'Preparing save location...';

          if ('showSaveFilePicker' in window) {
            try {
              state.fileHandle = await window.showSaveFilePicker({
                suggestedName: parsed.name
              });
              state.writableStream = await state.fileHandle.createWritable();
              if (elements.transferStatus) elements.transferStatus.textContent = 'Streaming to disk...';
            } catch (err) {
              if (elements.transferStatus) elements.transferStatus.textContent = 'Receiving (Memory Fallback)...';
            }
          } else {
            if (elements.transferStatus) elements.transferStatus.textContent = 'Receiving (Memory Fallback)...';
          }

          if (state.dataChannel && state.dataChannel.readyState === 'open') {
            state.dataChannel.send(JSON.stringify({ type: 'receiver-accept' }));
          }

          updateTransferMetrics(0, parsed.size);
          return;
        }

        if (parsed.type === 'cancel') {
          state.transferCancelled = true;
          state.isTransferring = false;
          state.incomingFileInfo = null;

          if (state.dataChannel) {
            state.dataChannel.onbufferedamountlow = null;
          }
          if (state.writableStream) {
            await state.writableStream.abort().catch(() => {});
            state.writableStream = null;
          }

          state.receivedChunks = [];
          state.fileHandle = null;

          resetTransferUI('Transfer was cancelled');
          showToast('Transfer was cancelled', 'error');
          playAudioFeedback('cancel');
          triggerHaptic([150, 50, 150]);
          return;
        }
      } catch (err) {
        console.error('DataChannel JSON Error:', err);
      }
      return;
    }

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

      if (state.receivedSize >= state.incomingFileInfo.size) {
        if (state.writableStream) {
          await state.writableStream.close();
          if (elements.transferStatus) elements.transferStatus.textContent = 'Saved to disk!';
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

          if (elements.transferStatus) elements.transferStatus.textContent = 'Downloaded!';
          showToast(`Downloaded ${state.incomingFileInfo.name}`, 'success');
        }

        playAudioFeedback('complete');
        triggerHaptic([100, 50, 100, 50, 200]);

        state.incomingFileInfo = null;
        state.receivedChunks = [];
        state.writableStream = null;
        state.fileHandle = null;
        state.isTransferring = false;

        setTimeout(() => resetTransferUI(), 3000);
      }
    }
  }

  // 8. Speed & ETA Metrics Calculation
  function updateTransferMetrics(currentBytes, totalBytes) {
    if (!totalBytes || totalBytes === 0) return;

    const percent = Math.min(100, Math.round((currentBytes / totalBytes) * 100));
    if (elements.progressBar) elements.progressBar.style.width = `${percent}%`;
    if (elements.transferPercentage) elements.transferPercentage.textContent = `${percent}%`;

    // Tab percentage update
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

  // Cancel Button Handlers
  if (elements.btnCancelTransfer) {
    elements.btnCancelTransfer.addEventListener('click', () => {
      state.transferCancelled = true;
      state.isTransferring = false;
      state.incomingFileInfo = null;

      if (state.dataChannel && state.dataChannel.readyState === 'open') {
        try {
          state.dataChannel.send(JSON.stringify({ type: 'cancel' }));
        } catch (e) {
          console.warn('Failed to send cancel signal:', e);
        }
      }

      if (state.writableStream) {
        state.writableStream.abort().catch(() => {});
        state.writableStream = null;
      }

      state.receivedChunks = [];
      state.fileHandle = null;

      resetTransferUI('Transfer was cancelled');
      showToast('Transfer was cancelled', 'error');
      playAudioFeedback('cancel');
      triggerHaptic([150, 50, 150]);
      clearStagedFile();
    });
  }

  // STEP 1 Event Listeners: Staging Controls
  if (elements.btnCancelStaging) {
    elements.btnCancelStaging.addEventListener('click', (e) => {
      e.stopPropagation();
      clearStagedFile();
    });
  }

  if (elements.btnConfirmSend) {
    elements.btnConfirmSend.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.stagedFile) {
        sendFile(state.stagedFile);
      }
    });
  }

  // STEP 2 Event Listeners: Modal Controls
  if (elements.btnAcceptTransfer) {
    elements.btnAcceptTransfer.addEventListener('click', () => {
      if (elements.chkAutoAccept && elements.chkAutoAccept.checked) {
        state.autoAccept = true;
      }
      if (elements.incomingModal) elements.incomingModal.classList.add('hidden');
      if (state.receiverResponseResolver) {
        state.receiverResponseResolver(true);
        state.receiverResponseResolver = null;
      }
    });
  }

  if (elements.btnRejectTransfer) {
    elements.btnRejectTransfer.addEventListener('click', () => {
      if (elements.incomingModal) elements.incomingModal.classList.add('hidden');
      if (state.receiverResponseResolver) {
        state.receiverResponseResolver(false);
        state.receiverResponseResolver = null;
      }
    });
  }

  // 9. Socket & UI Handlers
  function initSocket() {
    if (typeof io === 'undefined') {
      console.warn('Socket.io client SDK not found.');
      return;
    }

    state.socket = io(window.location.origin);

    state.socket.on('connect', () => {
      updateBadge('Waiting for peer', 'bg-sky-400');
      
      state.socket.emit('create-or-join-room', {
        roomId: state.roomId,
        userInfo: localUser
      });
    });

    state.socket.on('room-peers', ({ isInitiator, peers }) => {
      state.isInitiator = isInitiator;
      state.peers = peers;
      renderPeers();
    });

    state.socket.on('ready-to-connect', () => {
      const targetPeer = state.peers.find((p) => p.socketId !== state.socket.id);
      if (targetPeer) {
        startWebRTCOffer(targetPeer.socketId);
      }
    });

    state.socket.on('signal', handleSignalMessage);

    state.socket.on('room-full', ({ roomId }) => {
      updateBadge('Room full', 'bg-rose-500');
      alert('This transfer room already has 2 connected peers.');
    });

    state.socket.on('peer-disconnected', ({ peerId }) => {
      state.peers = state.peers.filter((p) => p.socketId !== peerId);
      if (state.peerConnection) {
        state.peerConnection.close();
        state.peerConnection = null;
      }
      if (elements.transferSection) elements.transferSection.classList.add('hidden');
      
      updateBadge('Waiting for peer', 'bg-sky-400');
      renderPeers();
    });

    state.socket.on('disconnect', () => {
      updateBadge('Offline', 'bg-rose-500');
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
            <img 
              src="${avatar}" 
              alt="${name}" 
              class="h-16 w-16 rounded-full bg-white/10 p-1 border-2 ${isSelf ? 'border-indigo-400' : 'border-emerald-400'}"
            />
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

  // Dropzone & File Selection Listeners
  if (elements.dropzone && elements.fileInput) {
    elements.dropzone.addEventListener('click', (e) => {
      // Don't trigger file dialog if clicking staging buttons
      if (e.target.closest('#staging-container')) return;
      elements.fileInput.click();
    });

    elements.fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        stageFile(e.target.files[0]);
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
        stageFile(e.dataTransfer.files[0]);
      }
    });
  }

  // Copy Share Link Listener
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
        console.error('Failed to copy share link:', err);
      }
    });
  }

  // New Room Listener
  if (elements.btnNewRoom) {
    elements.btnNewRoom.addEventListener('click', createNewRoom);
  }

  // Join Room by Code Listener
  function handleJoinByCode() {
    if (!elements.joinRoomCodeInput) return;
    const inputCode = elements.joinRoomCodeInput.value.trim();

    if (!inputCode) {
      showToast('Please enter a room code', 'error');
      return;
    }

    if (inputCode === state.roomId) {
      showToast('You are already in this room', 'info');
      return;
    }

    window.location.hash = `room=${inputCode}`;
    elements.joinRoomCodeInput.value = '';
    showToast(`Joining room: ${inputCode}`, 'info');
  }

  if (elements.btnJoinRoom) {
    elements.btnJoinRoom.addEventListener('click', handleJoinByCode);
  }

  if (elements.joinRoomCodeInput) {
    elements.joinRoomCodeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handleJoinByCode();
      }
    });
  }

  // Initialize
  initRoom();
  initSocket();
});