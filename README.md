# 🚀 FileShare (LocalDrop) — Zero-Trust P2P File Transfer Engine

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https.shields.org)
[![WebRTC](https://img.shields.io/badge/WebRTC-PeerToPeer-indigo.svg)](https://webrtc.org/)
[![Security](https://img.shields.io/badge/Security-AES--GCM--256-emerald.svg)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-green.svg)](https://nodejs.org/)

**FileShare (LocalDrop)** is a high-performance, zero-trust, peer-to-peer (P2P) file transfer system built using **WebRTC DataChannels**, **Web Crypto API**, and **Node.js**. It enables ultra-fast, encrypted file streaming directly between web browsers without storing or routing file payloads through central cloud servers.

---

## 🔥 Top Technical Highlights & Key Features

### 1. 🔐 Zero-Trust End-to-End Encryption (E2EE)
* **Ephemeral ECDH Key Exchange**: Generates transient **ECDH (P-256 curve)** cryptographic key pairs in browser RAM via `window.crypto.subtle` upon startup. Public keys are exchanged securely over signaling.
* **Derived AES-GCM 256-bit Key**: Computes a shared symmetric key on both peers using Diffie-Hellman derivation.
* **Per-Chunk Authenticated Encryption**: Each 64 KB chunk is encrypted with a cryptographically secure random 12-byte **Initialization Vector (IV)**. Authenticated tags prevent payload tampering or MITM injection.

### 2. 🌐 Multi-Network NAT Traversal (STUN + TURN Relaying)
* **CGNAT & Cellular Support**: Configured with Google STUN servers and **OpenRelay TURN servers** operating across ports 80 and 443 over both **UDP and TCP**.
* **Cross-Network Capability**: Connects peers across symmetric NATs, Carrier-Grade NAT (e.g., Jio 5G / Airtel 5G), strict university firewalls, and home Wi-Fi networks seamlessly.

### 3. 💾 Direct-to-Disk Streaming & Graceful Fallbacks
* **File System Access API Integration**: Prompts for destination file paths via `showSaveFilePicker()` synchronously during the user "Accept" gesture, pre-opening a `FileSystemWritableFileStream`.
* **Zero RAM Exhaustion**: Streamed chunks write directly to disk as they arrive, enabling gigabyte-scale transfers without memory leaks.
* **Cross-Browser Fallbacks**: Full fallback support for **Firefox and Mobile Safari** via in-memory Blob chunk buffering and auto-triggered Object URL downloads.

### 4. ⚡ Dynamic Flow Control & Backpressure Engine
* **MTU-Optimized Chunking**: Uses **64 KB** chunk payloads for optimal WebRTC transport protocol framing.
* **Watermark Throttling**: Implements adaptive flow control configured to a **16 MB High Watermark** (pause transmission) and a **1 MB Low Watermark** (`onbufferedamountlow` resume), avoiding WebRTC buffer bloat and packet drops.

### 5. 🛡️ Macro Whole-File SHA-256 Integrity Verification
* **End-to-End Integrity**: Sender computes a full **SHA-256 hash** of the source file prior to transmission.
* **Post-Transfer Verification**: Receiver recalculates the SHA-256 hash on the saved payload to detect any bit-rot, corruption, or missing sequence packets post-transfer.

### 6. 🔄 Signaling-Decoupled Session Resilience
* **Decoupled DataChannels**: WebRTC P2P DataChannels remain fully functional even if the signaling server drops offline mid-transfer.
* **Smart UI Status**: Updates badge state to **`Connected (P2P Direct)`** when signaling drops, preserving active transfer streams without interrupting the user.

---

## 🏗️ Architecture & Protocol Sequence

```mermaid
sequenceDiagram
    autonumber
    actor PeerA as Sender (Peer A)
    participant Signal as Signaling Server (Node/Socket.io)
    actor PeerB as Receiver (Peer B)

    Note over PeerA, PeerB: 1. Room Pairing & Key Exchange
    PeerA->>Signal: Join Room (Room ID)
    PeerB->>Signal: Join Room (Room ID)
    Signal->>PeerA: room-peers (isInitiator: true)
    Signal->>PeerB: room-peers (isInitiator: false)
    Signal->>PeerA: ready-to-connect
    Signal->>PeerB: ready-to-connect

    PeerA->>Signal: signal (ecdh-public-key)
    Signal->>PeerB: signal (ecdh-public-key)
    PeerB->>Signal: signal (ecdh-public-key)
    Signal->>PeerA: signal (ecdh-public-key)
    Note over PeerA, PeerB: Both derive shared AES-GCM-256 key

    Note over PeerA, PeerB: 2. WebRTC Handshake & Encrypted Data Streaming
    PeerA->>PeerB: WebRTC DataChannel established
    PeerA->>PeerB: Send Batch Metadata Offer
    PeerB->>PeerA: Accept Batch + Pre-open File System Handle
    PeerA->>PeerB: Send Encrypted Chunks (AES-GCM + IV)
    PeerB->>PeerB: Decrypt Chunks & Stream to Disk
    PeerB->>PeerB: Verify SHA-256 Integrity Hash
```

---

## 🛠️ Technology Stack

| Layer | Technologies Used |
| :--- | :--- |
| **Core Logic** | Vanilla JavaScript (ES2022+), Asynchronous Streams, Event Loop Management |
| **Security & E2EE** | Web Crypto API (`window.crypto.subtle`), ECDH (P-256), AES-GCM (256-bit), SHA-256 |
| **P2P Networking** | WebRTC (`RTCPeerConnection`, `RTCDataChannel`), STUN, OpenRelay TURN (UDP/TCP/443) |
| **File I/O** | Native File System Access API (`showSaveFilePicker`), WritableStreams, Blob Object URLs |
| **UI & UX** | Glassmorphism Dark Mode (Tailwind CSS), Web Audio API, Haptic Vibrate API, QRCode.js |
| **Signaling Server** | Node.js, Express, Socket.io (WebSocket signaling relay only; zero payload access) |

---

## 📦 Getting Started

### Prerequisites
* **Node.js**: v18.0.0 or higher
* **npm**: v9.0.0 or higher

### Installation & Execution

1. **Clone the repository**:
   ```bash
   git clone https://github.com/Rohan-756/FileShare.git
   cd FileShare
   ```

2. **Install Server Dependencies**:
   ```bash
   cd server
   npm install
   ```

3. **Launch Local Development Server**:
   ```bash
   npm run dev
   ```

4. **Access the Application**:
   Open your browser to `http://localhost:3000`. Open a second tab or scan the QR code with a mobile device to test direct P2P transfer!

---

## 🔒 Security Threat Model

1. **Zero Server Payload Storage**: The server acts exclusively as an ephemeral signaling broker for SDP/ICE exchange and ECDH public key relay. No file bytes or ciphertexts ever pass through or touch disk on the server.
2. **Ephemeral In-Memory Keys**: Keys exist strictly in browser RAM memory and are never persisted to `localStorage`, cookies, or unencrypted storage.
3. **Chunk-Level Authentication**: AES-GCM provides authenticated encryption, guaranteeing that tampered or corrupted payload chunks fail decryption immediately.

---

## 📄 License
Distributed under the **MIT License**. See `LICENSE` for more information.
