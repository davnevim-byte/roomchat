/**
 * RoomChat — calls.js
 * ─────────────────────────────────────────────
 * Zodpovědnost:
 *   • WebRTC volání 1-na-1 (audio i video)
 *   • Výběr osoby před voláním
 *   • Incoming call UI (přijmout / odmítnout)
 *   • Trickle ICE + Metered TURN server
 *   • Přepínač mikrofon / kamera za hovoru
 *   • Signaling přes Firestore subcollection
 *   • Čistý cleanup při zavření hovoru
 *
 * Závislosti: config.js, utils.js, notifications.js
 *
 * Firestore struktura signalingu:
 *   rooms/{roomId}/callSignals/{callId}
 *     from, to, callType, offer, answer,
 *     offerCandidates[], answerCandidates[],
 *     status ('calling'|'accepted'|'rejected'|'ended'),
 *     created
 * ─────────────────────────────────────────────
 */


// ─────────────────────────────────────────────
// CALL STATE OBJEKT
// ─────────────────────────────────────────────

/**
 * Stav aktuálního hovoru.
 * Resetuje se při každém endCall().
 */
const CALL = {
  /** Je hovor aktivní? */
  active: false,

  /** Je mikrofon ztlumen? */
  muted: false,

  /** Je kamera zapnuta? */
  videoEnabled: false,

  /** Typ hovoru: 'audio' | 'video' */
  callType: 'audio',

  /** Lokální MediaStream (mikrofon + případně kamera) */
  localStream: null,

  /** RTCPeerConnection pro aktuální hovor */
  peer: null,

  /** Audio element pro přehrávání vzdáleného zvuku */
  audioEl: null,

  /** Načtené ICE servery (cache) */
  iceServers: null,

  /** Firestore doc ID aktuálního signaling dokumentu */
  sigDocId: null,

  /** Unsubscribe funkce pro signaling listener */
  sigUnsub: null,

  /** slotId volaného / volajícího */
  targetSlotId: null,

  /** Username volaného / volajícího */
  targetUsername: null,

  /** Barva avataru volaného / volajícího */
  targetColor: null,

  /** Timeout pro automatické odmítnutí (30s) */
  ringTimeout: null,

  /** Je aktuální uživatel ten kdo volá (offerer)? */
  isOfferer: false,
};


// ─────────────────────────────────────────────
// MODAL VÝBĚRU OSOBY
// ─────────────────────────────────────────────

/**
 * Otevře modal s výběrem komu zavolat.
 * Zobrazí pouze online uživatele (mimo aktuálního).
 */
function openCallModal() {
  const list = $('call-person-list');
  if (!list) return;

  // Filtruj online uživatele kromě sebe
  const targets = Object.values(S.slots).filter(slot =>
    slot.id !== S.slotId &&
    slot.username &&
    isOnline(slot)
  );

  if (!targets.length) {
    toast('Nikdo jiný není online 😕', 'err');
    return;
  }

  list.innerHTML = targets.map(slot => `
    <div class="cp-item">
      <div class="cp-av" style="background:${slot.color}">
        ${initials(slot.username)}
      </div>
      <div class="cp-info">
        <div class="cp-name">${escHtml(slot.username)}</div>
        <div class="cp-status">🟢 online</div>
      </div>
      <div class="cp-btns">
        <button class="cp-btn audio"
          onclick="startCallTo('${slot.id}','audio');closeM('m-call')">
          📞 Hlasový
        </button>
        <button class="cp-btn video"
          onclick="startCallTo('${slot.id}','video');closeM('m-call')">
          📹 Video
        </button>
      </div>
    </div>
  `).join('');

  openM('m-call');
}


// ─────────────────────────────────────────────
// ZAHÁJENÍ HOVORU (offerer strana)
// ─────────────────────────────────────────────

/**
 * Zahájí hovor s konkrétním uživatelem.
 * @param {string} targetSlotId - slotId volaného
 * @param {string} callType     - 'audio' | 'video'
 */
async function startCallTo(targetSlotId, callType = 'audio') {
  if (CALL.active) {
    toast('Hovor již probíhá', 'err');
    return;
  }

  const target = S.slots[targetSlotId];
  if (!target) {
    toast('Uživatel nenalezen', 'err');
    return;
  }

  // Získej lokální stream
  if (!await _acquireStream(callType)) return;

  // Nastav stav
  CALL.active         = true;
  CALL.callType       = callType;
  CALL.isOfferer      = true;
  CALL.targetSlotId   = targetSlotId;
  CALL.targetUsername = target.username;
  CALL.targetColor    = target.color;

  // Zobraz video overlay
  _showVideoOverlay(target.username, target.color, callType, 'Vyzvání…');

  try {
    const ice = await _fetchIceServers();
    const pc  = _createPeerConnection(ice);
    CALL.peer = pc;

    // Unikátní ID pro signaling dokument
    CALL.sigDocId = `${S.slotId}_${targetSlotId}_${Date.now()}`;
    const sigRef  = db.collection('rooms').doc(S.roomId)
      .collection('callSignals').doc(CALL.sigDocId);

    // Streamuj ICE kandidáty (trickle ICE)
    pc.onicecandidate = async e => {
      if (!e.candidate) return;
      try {
        await sigRef.update({
          offerCandidates: firebase.firestore.FieldValue.arrayUnion(
            JSON.stringify(e.candidate.toJSON())
          ),
        });
      } catch {}
    };

    // Vytvoř a odešli offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await sigRef.set({
      from:             S.slotId,
      to:               targetSlotId,
      fromUsername:     S.username,
      fromColor:        S.color,
      callType,
      offer:            JSON.stringify(pc.localDescription),
      answer:           null,
      offerCandidates:  [],
      answerCandidates: [],
      status:           'calling',
      created:          firebase.firestore.FieldValue.serverTimestamp(),
    });

    // Poslouchej na answer + answer kandidáty
    CALL.sigUnsub = sigRef.onSnapshot(snap => {
      if (!snap.exists) { endCall(); return; }
      const data = snap.data();

      // Odmítnutí
      if (data.status === 'rejected') {
        toast(`${target.username} odmítl/a hovor`, 'err');
        endCall();
        return;
      }

      // Ukončení druhou stranou
      if (data.status === 'ended' && CALL.active) {
        endCall();
        return;
      }

      const peerPc = CALL.peer;
      if (!peerPc) return;

      // Nastav remote description (answer)
      if (data.answer && !peerPc.remoteDescription) {
        peerPc.setRemoteDescription(JSON.parse(data.answer))
          .then(() => {
            $('v-call-status').textContent = 'Spojeno ✓';
          })
          .catch(() => {});
      }

      // Přidej answer ICE kandidáty
      if (data.answerCandidates && peerPc.remoteDescription) {
        const added = peerPc._addedCandidates || (peerPc._addedCandidates = new Set());
        data.answerCandidates.forEach(async c => {
          if (!added.has(c)) {
            added.add(c);
            try {
              await peerPc.addIceCandidate(new RTCIceCandidate(JSON.parse(c)));
            } catch {}
          }
        });
      }
    });

    // Automatické zrušení po 30s (bez odpovědi)
    CALL.ringTimeout = setTimeout(() => {
      if (CALL.active && CALL.isOfferer) {
        toast('Hovor nebyl přijat', 'err');
        endCall();
      }
    }, 30_000);

  } catch (e) {
    toast('Chyba při volání: ' + e.message, 'err');
    endCall();
  }
}


// ─────────────────────────────────────────────
// PŘÍCHOZÍ HOVOR (answerer strana)
// ─────────────────────────────────────────────

/**
 * Nastaví Firestore listener pro příchozí hovory.
 * Volá se z enterChat().
 */
function setupCallSignaling() {
  const unsub = db.collection('rooms').doc(S.roomId)
    .collection('callSignals')
    .where('to', '==', S.slotId)
    .where('status', '==', 'calling')
    .onSnapshot(snap => {
      snap.docChanges().forEach(async ch => {
        if (ch.type !== 'added') return;
        const sig = ch.doc.data();
        if (!sig?.offer) return;
        // Nezobrazuj pokud již hovorujeme
        if (CALL.active) {
          // Automaticky odmítni
          await ch.doc.ref.update({ status: 'rejected' });
          return;
        }
        _showIncomingCall(ch.doc.id, sig);
      });
    });
  S.unsubs.push(unsub);
}

/**
 * Zobrazí UI pro příchozí hovor.
 * @param {string} sigDocId - ID signaling dokumentu
 * @param {Object} sig      - data signaling dokumentu
 * @private
 */
function _showIncomingCall(sigDocId, sig) {
  CALL.sigDocId       = sigDocId;
  CALL.targetSlotId   = sig.from;
  CALL.targetUsername = sig.fromUsername || '?';
  CALL.targetColor    = sig.fromColor    || COLORS[0];
  CALL.callType       = sig.callType     || 'audio';
  CALL.isOfferer      = false;

  // Nastav UI
  const avatar = $('ic-avatar');
  if (avatar) {
    avatar.textContent       = initials(CALL.targetUsername);
    avatar.style.background  = CALL.targetColor;
  }
  $('ic-name').textContent = escHtml(CALL.targetUsername);
  $('ic-type').textContent = CALL.callType === 'video'
    ? 'Příchozí videohovor 📹'
    : 'Příchozí hovor 📞';

  $('incoming-call').classList.add('show');

  // Automatické odmítnutí po 30s
  CALL.ringTimeout = setTimeout(() => {
    rejectCall();
  }, 30_000);

  // Přehraj zvuk (pokud není DnD)
  if (!isDnd()) playNotifSound();
}

/**
 * Přijme příchozí hovor.
 */
async function acceptCall() {
  clearTimeout(CALL.ringTimeout);
  $('incoming-call').classList.remove('show');

  if (!await _acquireStream(CALL.callType)) return;

  CALL.active = true;

  const sigRef = db.collection('rooms').doc(S.roomId)
    .collection('callSignals').doc(CALL.sigDocId);

  try {
    const snap = await sigRef.get();
    if (!snap.exists) { endCall(); return; }
    const sig = snap.data();

    // Zobraz video overlay
    _showVideoOverlay(CALL.targetUsername, CALL.targetColor, CALL.callType, 'Připojuji…');

    const ice = await _fetchIceServers();
    const pc  = _createPeerConnection(ice);
    CALL.peer = pc;

    // Streamuj answer ICE kandidáty
    pc.onicecandidate = async e => {
      if (!e.candidate) return;
      try {
        await sigRef.update({
          answerCandidates: firebase.firestore.FieldValue.arrayUnion(
            JSON.stringify(e.candidate.toJSON())
          ),
        });
      } catch {}
    };

    // Nastav remote description (offer)
    await pc.setRemoteDescription(JSON.parse(sig.offer));

    // Přidej existující offer kandidáty
    if (sig.offerCandidates) {
      const added = pc._addedCandidates || (pc._addedCandidates = new Set());
      for (const c of sig.offerCandidates) {
        if (!added.has(c)) {
          added.add(c);
          try {
            await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(c)));
          } catch {}
        }
      }
    }

    // Vytvoř answer
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sigRef.update({
      answer: JSON.stringify(pc.localDescription),
      status: 'accepted',
    });

    // Poslouchej na nové offer kandidáty + ukončení
    CALL.sigUnsub = sigRef.onSnapshot(snap => {
      if (!snap.exists) { endCall(); return; }
      const data = snap.data();

      if (data.status === 'ended' && CALL.active) {
        endCall();
        return;
      }

      const peerPc = CALL.peer;
      if (!peerPc || !peerPc.remoteDescription) return;

      if (data.offerCandidates) {
        const added = peerPc._addedCandidates || (peerPc._addedCandidates = new Set());
        data.offerCandidates.forEach(async c => {
          if (!added.has(c)) {
            added.add(c);
            try {
              await peerPc.addIceCandidate(new RTCIceCandidate(JSON.parse(c)));
            } catch {}
          }
        });
      }
    });

    $('v-call-status').textContent = 'Spojeno ✓';

  } catch (e) {
    toast('Chyba při přijímání hovoru: ' + e.message, 'err');
    endCall();
  }
}

/**
 * Odmítne příchozí hovor.
 */
async function rejectCall() {
  clearTimeout(CALL.ringTimeout);
  $('incoming-call').classList.remove('show');

  if (CALL.sigDocId) {
    try {
      await db.collection('rooms').doc(S.roomId)
        .collection('callSignals').doc(CALL.sigDocId)
        .update({ status: 'rejected' });
    } catch {}
  }

  // Reset jen signaling state (hovor nebyl zahájen)
  CALL.sigDocId       = null;
  CALL.targetSlotId   = null;
  CALL.targetUsername = null;
  CALL.targetColor    = null;
  CALL.ringTimeout    = null;
}


// ─────────────────────────────────────────────
// UKONČENÍ HOVORU
// ─────────────────────────────────────────────

/**
 * Ukončí aktivní hovor — zavře PC, zastaví stream, skryje UI.
 * Bezpečné volat i když hovor neprobíhá.
 */
async function endCall() {
  clearTimeout(CALL.ringTimeout);

  // Schovej UI
  $('video-overlay').classList.remove('show');
  $('incoming-call').classList.remove('show');
  $('call-bar').classList.remove('show');

  // Odhlás signaling listener
  if (CALL.sigUnsub) {
    CALL.sigUnsub();
    CALL.sigUnsub = null;
  }

  // Označ hovor jako ukončený v Firestore
  if (CALL.sigDocId && S.roomId) {
    try {
      await db.collection('rooms').doc(S.roomId)
        .collection('callSignals').doc(CALL.sigDocId)
        .update({ status: 'ended' });
    } catch {}

    // Smaž signaling dokument po chvíli
    setTimeout(async () => {
      try {
        await db.collection('rooms').doc(S.roomId)
          .collection('callSignals').doc(CALL.sigDocId).delete();
      } catch {}
    }, 3_000);
  }

  // Zavři RTCPeerConnection
  try { CALL.peer?.close(); } catch {}

  // Zastav lokální stream
  CALL.localStream?.getTracks().forEach(t => t.stop());

  // Odstraň audio element
  if (CALL.audioEl) {
    CALL.audioEl.srcObject = null;
    CALL.audioEl.remove();
  }

  // Vyčisti video elementy
  const remoteVideo = $('video-remote');
  const localVideo  = $('video-local');
  if (remoteVideo) remoteVideo.srcObject = null;
  if (localVideo)  localVideo.srcObject  = null;

  // Reset CALL state
  CALL.active         = false;
  CALL.muted          = false;
  CALL.videoEnabled   = false;
  CALL.callType       = 'audio';
  CALL.localStream    = null;
  CALL.peer           = null;
  CALL.audioEl        = null;
  CALL.sigDocId       = null;
  CALL.targetSlotId   = null;
  CALL.targetUsername = null;
  CALL.targetColor    = null;
  CALL.ringTimeout    = null;
  CALL.isOfferer      = false;
}


// ─────────────────────────────────────────────
// OVLÁDÁNÍ ZA HOVORU
// ─────────────────────────────────────────────

/**
 * Přepne ztlumení mikrofonu.
 */
function vToggleMute() {
  if (!CALL.localStream) return;
  CALL.muted = !CALL.muted;
  CALL.localStream.getAudioTracks().forEach(t => {
    t.enabled = !CALL.muted;
  });
  const btn = $('v-mute-btn');
  if (btn) {
    btn.textContent = CALL.muted ? '🔇' : '🎤';
    btn.classList.toggle('off', CALL.muted);
  }
}

/**
 * Přepne kameru (zapnout / vypnout).
 * Funguje pouze pro videohovory.
 */
function vToggleVideo() {
  if (!CALL.localStream || CALL.callType !== 'video') return;
  const tracks = CALL.localStream.getVideoTracks();
  CALL.videoEnabled = !CALL.videoEnabled;
  tracks.forEach(t => { t.enabled = CALL.videoEnabled; });
  const btn = $('v-video-btn');
  if (btn) {
    btn.textContent = CALL.videoEnabled ? '📹' : '📵';
    btn.classList.toggle('off', !CALL.videoEnabled);
  }
  // Schovej/zobraz lokální náhled
  const lw = $('video-local-wrap');
  if (lw) lw.style.display = CALL.videoEnabled ? '' : 'none';
}


// ─────────────────────────────────────────────
// VIDEO OVERLAY UI
// ─────────────────────────────────────────────

/**
 * Zobrazí video overlay pro probíhající hovor.
 * @param {string} username - jméno druhé strany
 * @param {string} color    - barva avataru druhé strany
 * @param {string} callType - 'audio' | 'video'
 * @param {string} status   - stavový text
 * @private
 */
function _showVideoOverlay(username, color, callType, status) {
  // Nastav texty
  $('v-peer-name').textContent   = escHtml(username);
  $('v-peer-name2').textContent  = escHtml(username);
  $('v-call-status').textContent = status;

  // Avatar pro audio-only
  const audioAvatar = $('v-audio-avatar');
  if (audioAvatar) {
    audioAvatar.textContent      = initials(username);
    audioAvatar.style.background = color;
  }

  // Zobraz/skryj video vs audio-only view
  const remoteVideo   = $('video-remote');
  const audioOnlyView = $('video-audio-only');
  const localWrap     = $('video-local-wrap');
  const videoBtn      = $('v-video-btn');

  if (callType === 'video') {
    if (remoteVideo)   remoteVideo.style.display   = '';
    if (audioOnlyView) audioOnlyView.style.display = 'none';
    if (videoBtn)      videoBtn.style.display      = '';
    CALL.videoEnabled = true;
  } else {
    if (remoteVideo)   remoteVideo.style.display   = 'none';
    if (audioOnlyView) audioOnlyView.style.display = '';
    if (videoBtn)      videoBtn.style.display      = 'none';
    if (localWrap)     localWrap.style.display     = 'none';
  }

  // Reset mute button
  const muteBtn = $('v-mute-btn');
  if (muteBtn) {
    muteBtn.textContent = '🎤';
    muteBtn.classList.remove('off');
  }

  $('video-overlay').classList.add('show');
}

/**
 * Aktualizuje call bar (tenký banner pod headerem).
 * Volá se z room doc listeneru v chat.js.
 * @param {Object} [data] - data místnosti z Firestore
 */
function _updateCallBar(data) {
  const d   = data || S.roomData;
  const bar = $('call-bar');
  if (!bar) return;

  // Pokud hovor probíhá zobraz bar s jménem partnera
  if (CALL.active && CALL.targetUsername) {
    bar.classList.add('show');
    const namesEl = $('call-bar-names');
    if (namesEl) namesEl.textContent = CALL.targetUsername;
  } else {
    bar.classList.remove('show');
  }
}


// ─────────────────────────────────────────────
// WEBRTC HELPERS
// ─────────────────────────────────────────────

/**
 * Získá lokální MediaStream dle typu hovoru.
 * @param {string} callType - 'audio' | 'video'
 * @returns {Promise<boolean>} true = úspěch
 * @private
 */
async function _acquireStream(callType) {
  if (CALL.localStream) return true;

  const constraints = {
    audio: true,
    video: callType === 'video'
      ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
      : false,
  };

  try {
    CALL.localStream = await navigator.mediaDevices.getUserMedia(constraints);

    // Nastav lokální video náhled
    if (callType === 'video') {
      const localVideo = $('video-local');
      if (localVideo) {
        localVideo.srcObject = CALL.localStream;
        localVideo.play().catch(() => {});
      }
    }

    // iOS AudioContext hack — udržuje audio session aktivní
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') await ac.resume();
      ac.createMediaStreamSource(CALL.localStream).connect(ac.destination);
    } catch {}

    return true;

  } catch (e) {
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      toast('Povol přístup k mikrofonu v nastavení prohlížeče', 'err');
    } else {
      toast('Mikrofon/kamera není dostupná: ' + e.message, 'err');
    }
    return false;
  }
}

/**
 * Načte ICE servery z Metered.live (s cache).
 * Fallback na Google STUN pokud API selže.
 * @returns {Promise<RTCIceServer[]>}
 * @private
 */
async function _fetchIceServers() {
  if (CALL.iceServers) return CALL.iceServers;

  try {
    const res  = await fetch(
      `https://${METERED_HOST}/api/v1/turn/credentials?apiKey=${METERED_KEY}`
    );
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) {
      CALL.iceServers = data;
      return data;
    }
    throw new Error('Prázdná odpověď');
  } catch {
    // Fallback na veřejné STUN servery
    CALL.iceServers = [
      { urls: 'stun:stun.l.google.com:19302'  },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
    return CALL.iceServers;
  }
}

/**
 * Vytvoří RTCPeerConnection s nastavenými handlery.
 * @param {RTCIceServer[]} iceServers
 * @returns {RTCPeerConnection}
 * @private
 */
function _createPeerConnection(iceServers) {
  const pc = new RTCPeerConnection({
    iceServers,
    iceCandidatePoolSize: 10,
  });

  // Přidej lokální tracky
  if (CALL.localStream) {
    CALL.localStream.getTracks().forEach(t => {
      pc.addTrack(t, CALL.localStream);
    });
  }

  // Přehrávej vzdálený stream
  pc.ontrack = e => {
    const stream = e.streams?.[0];
    if (!stream) return;

    if (CALL.callType === 'video') {
      // Video stream → zobraz v <video> elementu
      const remoteVideo = $('video-remote');
      if (remoteVideo) {
        remoteVideo.srcObject = stream;
        remoteVideo.play().catch(() => {});
      }
    } else {
      // Audio only → skrytý <audio> element
      if (!CALL.audioEl) {
        CALL.audioEl = document.createElement('audio');
        CALL.audioEl.autoplay = true;
        CALL.audioEl.setAttribute('playsinline', '');
        CALL.audioEl.style.display = 'none';
        document.body.appendChild(CALL.audioEl);
      }
      CALL.audioEl.srcObject = stream;
      CALL.audioEl.play().catch(() => {});
    }
  };

  // Monitoring stavu spojení
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;

    if (state === 'connected') {
      $('v-call-status').textContent = 'Spojeno ✓';
      _updateCallBar();
    }

    if (state === 'failed') {
      // Pokus o ICE restart
      if (CALL.active) {
        pc.restartIce();
        $('v-call-status').textContent = 'Obnovuji spojení…';
      }
    }

    if (state === 'disconnected') {
      $('v-call-status').textContent = 'Přerušeno…';
      // Dej 5s na automatické zotavení
      setTimeout(() => {
        if (pc.connectionState === 'disconnected' && CALL.active) {
          toast('Hovor byl přerušen', 'err');
          endCall();
        }
      }, 5_000);
    }

    if (state === 'closed') {
      if (CALL.active) endCall();
    }
  };

  return pc;
}


// ─────────────────────────────────────────────
// PAGE UNLOAD — čistý odchod při zavření stránky
// ─────────────────────────────────────────────

window.addEventListener('pagehide', () => {
  if (CALL.active && CALL.sigDocId && S.roomId) {
    // sendBeacon — funguje při zavření záložky
    const url = `https://firestore.googleapis.com/v1/projects/roomchat-6092c/databases/(default)/documents/rooms/${S.roomId}/callSignals/${CALL.sigDocId}`;
    navigator.sendBeacon?.(
      url + '?updateMask.fieldPaths=status',
      new Blob(
        [JSON.stringify({ fields: { status: { stringValue: 'ended' } } })],
        { type: 'application/json' }
      )
    );
  }
});
