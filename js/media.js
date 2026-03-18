/**
 * RoomChat — media.js
 * ─────────────────────────────────────────────
 * Zodpovědnost:
 *   • Peer-to-peer přenos fotek a videí
 *   • WebRTC Data Channel (ne MediaStream)
 *   • Soubor se nikdy nenahraje na server
 *   • Příjemce vidí soubor jako dočasnou blob URL
 *   • Po zavření stránky/chatu soubor zmizí
 *
 * ⚠️ Oba uživatelé musí být online současně
 *
 * Firestore signaling:
 *   rooms/{roomId}/mediaSignals/{sigId}
 *     from, to, fromUsername, offer, answer,
 *     offerCandidates[], answerCandidates[],
 *     status, fileName, fileType, fileSize, created
 *
 * Závislosti: config.js, utils.js, calls.js (ICE servery)
 * ─────────────────────────────────────────────
 */


// ─────────────────────────────────────────────
// STAV
// ─────────────────────────────────────────────

const MEDIA = {
  /** Aktivní přenosy { sigId: { pc, dc, chunks, meta } } */
  transfers: {},

  /** Blob URL dočasných médií — vyčistí se při odchodu */
  blobUrls: [],

  /** Velikost chunků (16KB) */
  CHUNK_SIZE: 16 * 1024,

  /** Max velikost souboru (25MB) */
  MAX_SIZE: 25 * 1024 * 1024,
};


// ─────────────────────────────────────────────
// TLAČÍTKO — výběr souboru
// ─────────────────────────────────────────────

/**
 * Otevře výběr příjemce a pak souboru.
 * Volá se z tlačítka 📷 v input area.
 */
function openMediaPicker() {
  // Filtruj online uživatele kromě sebe
  const targets = Object.values(S.slots).filter(slot =>
    slot.id !== S.slotId &&
    slot.username &&
    isOnline(slot)
  );

  if (!targets.length) {
    toast('Nikdo jiný není online — fotky lze posílat jen online uživatelům 😕', 'err');
    return;
  }

  // Pokud je jen jeden uživatel, rovnou vyber soubor
  if (targets.length === 1) {
    _pickFile(targets[0].id, targets[0].username);
    return;
  }

  // Více uživatelů → zobraz výběr
  _showMediaTargetPicker(targets);
}

/**
 * Zobrazí modal pro výběr příjemce.
 * @param {Object[]} targets - online sloty
 * @private
 */
function _showMediaTargetPicker(targets) {
  // Použij existující call modal ale s jiným obsahem
  const list = $('call-person-list');
  if (!list) return;

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
          onclick="closeM('m-call');_pickFile('${slot.id}','${escHtml(slot.username)}')">
          📷 Vybrat soubor
        </button>
      </div>
    </div>
  `).join('');

  const h3 = document.querySelector('#m-call h3');
  if (h3) h3.textContent = '📷 Poslat soubor';

  openM('m-call');
}

/**
 * Otevře file picker pro výběr obrázku nebo videa.
 * @param {string} targetSlotId
 * @param {string} targetUsername
 */
function _pickFile(targetSlotId, targetUsername) {
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = 'image/*,video/*';

  input.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > MEDIA.MAX_SIZE) {
      toast(`Soubor je příliš velký (max ${Math.round(MEDIA.MAX_SIZE / 1024 / 1024)} MB)`, 'err');
      return;
    }

    await sendMediaFile(file, targetSlotId, targetUsername);
  };

  input.click();
}


// ─────────────────────────────────────────────
// ODESÍLÁNÍ (offerer strana)
// ─────────────────────────────────────────────

/**
 * Zahájí P2P přenos souboru.
 * @param {File}   file           - soubor k odeslání
 * @param {string} targetSlotId   - ID příjemce
 * @param {string} targetUsername - jméno příjemce
 */
async function sendMediaFile(file, targetSlotId, targetUsername) {
  const sigId  = `m_${S.slotId}_${targetSlotId}_${Date.now()}`;
  const sigRef = db.collection('rooms').doc(S.roomId)
    .collection('mediaSignals').doc(sigId);

  toast(`Navazuji spojení s ${targetUsername}…`);

  try {
    const ice = await _getIceServers();
    const pc  = new RTCPeerConnection({ iceServers: ice, iceCandidatePoolSize: 10 });

    // Vytvoř Data Channel
    const dc = pc.createDataChannel('media', {
      ordered: true,
    });

    MEDIA.transfers[sigId] = {
      pc, dc,
      file,
      targetUsername,
      isOfferer: true,
      sent: 0,
    };

    // Nastav Data Channel handlery
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      toast(`Odesílám ${file.name}…`);
      _sendFileChunks(sigId);
    };

    dc.onmessage = e => {
      // Příjemce potvrdil příjem
      if (e.data === 'RECEIVED') {
        toast(`${targetUsername} obdržel/a soubor ✓`, 'ok');
        _cleanupTransfer(sigId);
      }
    };

    dc.onerror = () => {
      toast('Chyba přenosu', 'err');
      _cleanupTransfer(sigId);
    };

    // ICE kandidáti
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

    // Sleduj answer + answer kandidáty
    const unsub = sigRef.onSnapshot(async snap => {
      const data = snap.data();
      if (!data) return;

      if (data.status === 'rejected') {
        toast(`${targetUsername} odmítl/a soubor`, 'err');
        _cleanupTransfer(sigId, unsub);
        return;
      }

      if (data.status === 'ended') {
        _cleanupTransfer(sigId, unsub);
        return;
      }

      const t = MEDIA.transfers[sigId];
      if (!t?.pc) return;

      // Nastav remote description (answer)
      if (data.answer && !t.pc.remoteDescription) {
        try {
          await t.pc.setRemoteDescription(JSON.parse(data.answer));
        } catch {}
      }

      // Přidej answer ICE kandidáty
      if (data.answerCandidates && t.pc.remoteDescription) {
        const added = t.pc._addedCandidates || (t.pc._addedCandidates = new Set());
        for (const c of data.answerCandidates) {
          if (!added.has(c)) {
            added.add(c);
            try {
              await t.pc.addIceCandidate(new RTCIceCandidate(JSON.parse(c)));
            } catch {}
          }
        }
      }
    });

    MEDIA.transfers[sigId].unsub = unsub;

    // Vytvoř offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await sigRef.set({
      from:         S.slotId,
      to:           targetSlotId,
      fromUsername: S.username,
      fromColor:    S.color,
      offer:        JSON.stringify(pc.localDescription),
      answer:       null,
      offerCandidates:  [],
      answerCandidates: [],
      status:       'calling',
      fileName:     file.name,
      fileType:     file.type,
      fileSize:     file.size,
      created:      firebase.firestore.FieldValue.serverTimestamp(),
    });

    // Automatické zrušení po 30s
    MEDIA.transfers[sigId].timeout = setTimeout(() => {
      if (MEDIA.transfers[sigId]) {
        toast(`${targetUsername} neodpovídá`, 'err');
        _cleanupTransfer(sigId);
      }
    }, 30_000);

  } catch (e) {
    toast('Chyba při odesílání: ' + e.message, 'err');
    delete MEDIA.transfers[sigId];
  }
}

/**
 * Odesílá soubor po chunkcích přes Data Channel.
 * @param {string} sigId
 * @private
 */
async function _sendFileChunks(sigId) {
  const t = MEDIA.transfers[sigId];
  if (!t?.dc || !t?.file) return;

  const { dc, file } = t;
  const buffer = await file.arrayBuffer();
  const total  = buffer.byteLength;
  let   offset = 0;

  // Pošli metadata jako první zprávu
  dc.send(JSON.stringify({
    type:     'meta',
    fileName: file.name,
    fileType: file.type,
    fileSize: total,
  }));

  // Odešli chunky
  const sendChunk = () => {
    if (offset >= total) {
      dc.send(JSON.stringify({ type: 'done' }));
      return;
    }

    // Počkej pokud je buffer přeplněný
    if (dc.bufferedAmount > MEDIA.CHUNK_SIZE * 8) {
      setTimeout(sendChunk, 50);
      return;
    }

    const chunk = buffer.slice(offset, offset + MEDIA.CHUNK_SIZE);
    dc.send(chunk);
    offset += MEDIA.CHUNK_SIZE;

    // Progress toast každých 20%
    const pct = Math.round(offset / total * 100);
    if (pct % 20 === 0 && pct > 0 && pct < 100) {
      toast(`Odesílám… ${pct}%`);
    }

    setTimeout(sendChunk, 0);
  };

  sendChunk();
}


// ─────────────────────────────────────────────
// PŘÍJEM (answerer strana)
// ─────────────────────────────────────────────

/**
 * Nastaví listener pro příchozí mediální signály.
 * Volá se z enterChat().
 */
function setupMediaSignaling() {
  const unsub = db.collection('rooms').doc(S.roomId)
    .collection('mediaSignals')
    .where('to', '==', S.slotId)
    .where('status', '==', 'calling')
    .onSnapshot(snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type !== 'added') return;
        const sig = ch.doc.data();
        if (!sig?.offer) return;
        _showIncomingMedia(ch.doc.id, sig);
      });
    });

  S.unsubs.push(unsub);
}

/**
 * Zobrazí UI pro příchozí soubor.
 * @param {string} sigId
 * @param {Object} sig
 * @private
 */
function _showIncomingMedia(sigId, sig) {
  const sizeMB = (sig.fileSize / 1024 / 1024).toFixed(1);
  const isImg  = sig.fileType?.startsWith('image/');
  const isVid  = sig.fileType?.startsWith('video/');
  const icon   = isImg ? '🖼️' : isVid ? '🎥' : '📎';

  // Zobraz toast s accept/reject tlačítky
  _showMediaIncomingBar(sigId, sig.fromUsername, sig.fromColor, sig.fileName, sizeMB, icon);
}

/**
 * Zobrazí příchozí bar pro soubor.
 * @private
 */
function _showMediaIncomingBar(sigId, fromUsername, fromColor, fileName, sizeMB, icon) {
  // Odstraň existující bar pokud je
  const existing = $('media-incoming-bar');
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.id = 'media-incoming-bar';
  bar.style.cssText = `
    position: fixed;
    top: calc(70px + var(--safe-t));
    left: 50%;
    transform: translateX(-50%);
    background: var(--surface);
    border: 1px solid var(--border2);
    border-radius: 16px;
    padding: 16px 20px;
    z-index: 500;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    box-shadow: 0 8px 40px #000c;
    min-width: 260px;
    max-width: 90vw;
    animation: icIn .3s cubic-bezier(.34,1.4,.64,1);
  `;

  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <div style="width:40px;height:40px;border-radius:10px;background:${fromColor};
                  display:flex;align-items:center;justify-content:center;
                  font-weight:800;color:#fff;font-size:15px;flex-shrink:0">
        ${initials(fromUsername)}
      </div>
      <div>
        <div style="font-weight:800;font-size:14px">${escHtml(fromUsername)} ti posílá soubor</div>
        <div style="font-size:12px;color:var(--muted2)">${icon} ${escHtml(fileName)} · ${sizeMB} MB</div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--orange);font-weight:600">
      ⚠️ Soubor zmizí po přijetí — není uložen na serveru
    </div>
    <div style="display:flex;gap:12px">
      <button onclick="rejectMediaTransfer('${sigId}')"
        style="padding:10px 20px;border-radius:10px;background:#ff5c5c22;
               border:1px solid #ff5c5c44;color:var(--red);
               font-family:var(--fh);font-weight:700;font-size:13px;cursor:pointer">
        📵 Odmítnout
      </button>
      <button onclick="acceptMediaTransfer('${sigId}')"
        style="padding:10px 20px;border-radius:10px;background:var(--accent);
               border:none;color:#fff;
               font-family:var(--fh);font-weight:700;font-size:13px;cursor:pointer">
        ✅ Přijmout
      </button>
    </div>
  `;

  document.body.appendChild(bar);

  // Auto-odmítnutí po 30s
  setTimeout(() => {
    if ($('media-incoming-bar')) {
      rejectMediaTransfer(sigId);
    }
  }, 30_000);

  if (!isDnd()) playNotifSound();
}

/**
 * Přijme příchozí soubor.
 * @param {string} sigId
 */
async function acceptMediaTransfer(sigId) {
  const bar = $('media-incoming-bar');
  if (bar) bar.remove();

  const sigRef = db.collection('rooms').doc(S.roomId)
    .collection('mediaSignals').doc(sigId);

  try {
    const snap = await sigRef.get();
    if (!snap.exists) return;
    const sig = snap.data();

    toast('Přijímám soubor…');

    const ice = await _getIceServers();
    const pc  = new RTCPeerConnection({ iceServers: ice, iceCandidatePoolSize: 10 });

    MEDIA.transfers[sigId] = {
      pc,
      isOfferer:  false,
      chunks:     [],
      meta:       null,
      received:   0,
    };

    // Příjem Data Channel
    pc.ondatachannel = e => {
      const dc = e.channel;
      dc.binaryType = 'arraybuffer';
      MEDIA.transfers[sigId].dc = dc;

      dc.onmessage = e2 => {
        _handleIncomingChunk(sigId, e2.data, dc);
      };

      dc.onerror = () => {
        toast('Chyba při příjmu souboru', 'err');
        _cleanupTransfer(sigId);
      };
    };

    // ICE kandidáti
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

    // Sleduj offer kandidáty
    const unsub = sigRef.onSnapshot(async snap => {
      const data = snap.data();
      if (!data) return;
      const t = MEDIA.transfers[sigId];
      if (!t?.pc || !t.pc.remoteDescription) return;

      if (data.offerCandidates) {
        const added = t.pc._addedCandidates || (t.pc._addedCandidates = new Set());
        for (const c of data.offerCandidates) {
          if (!added.has(c)) {
            added.add(c);
            try {
              await t.pc.addIceCandidate(new RTCIceCandidate(JSON.parse(c)));
            } catch {}
          }
        }
      }
    });

    MEDIA.transfers[sigId].unsub = unsub;

    // Nastav remote description
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

  } catch (e) {
    toast('Chyba při přijímání: ' + e.message, 'err');
    _cleanupTransfer(sigId);
  }
}

/**
 * Odmítne příchozí soubor.
 * @param {string} sigId
 */
async function rejectMediaTransfer(sigId) {
  const bar = $('media-incoming-bar');
  if (bar) bar.remove();

  try {
    await db.collection('rooms').doc(S.roomId)
      .collection('mediaSignals').doc(sigId)
      .update({ status: 'rejected' });
  } catch {}

  _cleanupTransfer(sigId);
}

/**
 * Zpracuje příchozí chunk dat.
 * @param {string}          sigId
 * @param {string|ArrayBuffer} data
 * @param {RTCDataChannel}  dc
 * @private
 */
function _handleIncomingChunk(sigId, data, dc) {
  const t = MEDIA.transfers[sigId];
  if (!t) return;

  // JSON zprávy (meta, done)
  if (typeof data === 'string') {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'meta') {
        t.meta     = msg;
        t.chunks   = [];
        t.received = 0;
        toast(`Přijímám ${msg.fileName}…`);
        return;
      }

      if (msg.type === 'done') {
        // Sestav soubor z chunků
        _assembleFile(sigId, dc);
        return;
      }
    } catch {}
    return;
  }

  // Binární chunk
  t.chunks.push(data);
  t.received += data.byteLength;

  // Progress
  if (t.meta?.fileSize) {
    const pct = Math.round(t.received / t.meta.fileSize * 100);
    if (pct % 25 === 0 && pct > 0 && pct < 100) {
      toast(`Přijímám… ${pct}%`);
    }
  }
}

/**
 * Sestaví přijatý soubor a zobrazí ho.
 * @param {string}         sigId
 * @param {RTCDataChannel} dc
 * @private
 */
function _assembleFile(sigId, dc) {
  const t = MEDIA.transfers[sigId];
  if (!t?.meta || !t?.chunks) return;

  const blob    = new Blob(t.chunks, { type: t.meta.fileType });
  const blobUrl = URL.createObjectURL(blob);

  // Ulož blob URL pro cleanup
  MEDIA.blobUrls.push(blobUrl);

  // Potvrď příjem
  dc.send('RECEIVED');

  // Zobraz soubor v chatu
  _showReceivedMedia(blobUrl, t.meta, sigId);

  // Cleanup přenosu
  setTimeout(() => _cleanupTransfer(sigId), 1_000);
}

/**
 * Zobrazí přijatý soubor jako dočasnou bublinu v chatu.
 * @param {string} blobUrl
 * @param {Object} meta
 * @param {string} sigId
 * @private
 */
function _showReceivedMedia(blobUrl, meta, sigId) {
  const box = $('msgs');
  if (!box) return;

  const isImg = meta.fileType?.startsWith('image/');
  const isVid = meta.fileType?.startsWith('video/');

  // Vytvoř skupinu zprávy
  const group = document.createElement('div');
  group.className = 'msg-group other';
  group.dataset.mediaSigId = sigId;

  // Najdi odesílatele
  const sender = Object.values(S.slots).find(s =>
    s.id !== S.slotId && isOnline(s)
  );
  const senderName  = sender?.username || '?';
  const senderColor = sender?.color    || COLORS[0];

  group.innerHTML = `
    <div class="msg-meta">
      <div class="mm-av" style="background:${senderColor}">${initials(senderName)}</div>
      <span>${escHtml(senderName)}</span>
      <span class="mm-time">${new Date().toLocaleTimeString('cs', {hour:'2-digit',minute:'2-digit'})}</span>
    </div>
  `;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.style.padding = '8px';

  if (isImg) {
    const img = document.createElement('img');
    img.src    = blobUrl;
    img.style.cssText = 'max-width:240px;border-radius:10px;display:block;cursor:pointer';
    img.onclick = () => openLightbox(blobUrl);
    bubble.appendChild(img);
  } else if (isVid) {
    const vid = document.createElement('video');
    vid.src      = blobUrl;
    vid.controls = true;
    vid.style.cssText = 'max-width:240px;border-radius:10px;display:block';
    bubble.appendChild(vid);
  } else {
    // Jiný soubor — download link
    const link = document.createElement('a');
    link.href     = blobUrl;
    link.download = meta.fileName;
    link.style.cssText = 'color:#fff;font-weight:700';
    link.textContent = `📎 ${meta.fileName}`;
    bubble.appendChild(link);
  }

  // Badge "dočasné"
  const badge = document.createElement('div');
  badge.className = 'disappear-badge';
  badge.textContent = '👁️ dočasné — zmizí po zavření';
  bubble.appendChild(badge);

  // Wrap
  const wrap = document.createElement('div');
  wrap.className = 'bubble-wrap';
  wrap.appendChild(bubble);
  group.appendChild(wrap);

  box.appendChild(group);
  box.scrollTop = box.scrollHeight;

  toast('Soubor přijat! 📁', 'ok');
}


// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/**
 * Vrátí ICE servery — použije cache z calls.js pokud existuje.
 * @returns {Promise<RTCIceServer[]>}
 * @private
 */
async function _getIceServers() {
  // Použij cache z calls.js
  if (typeof CALL !== 'undefined' && CALL.iceServers) {
    return CALL.iceServers;
  }
  // Fallback
  try {
    const res  = await fetch(
      `https://${METERED_HOST}/api/v1/turn/credentials?apiKey=${METERED_KEY}`
    );
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) return data;
  } catch {}
  return [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
}

/**
 * Vyčistí přenos — zavře PC, DC, unsub.
 * @param {string}        sigId
 * @param {Function|null} unsub
 * @private
 */
function _cleanupTransfer(sigId, unsub) {
  const t = MEDIA.transfers[sigId];
  if (!t) return;

  try { t.dc?.close();  } catch {}
  try { t.pc?.close();  } catch {}
  if (t.unsub) { try { t.unsub(); } catch {} }
  if (unsub)   { try { unsub();   } catch {} }
  if (t.timeout) clearTimeout(t.timeout);

  delete MEDIA.transfers[sigId];

  // Smaž Firestore signaling doc
  if (S.roomId) {
    db.collection('rooms').doc(S.roomId)
      .collection('mediaSignals').doc(sigId)
      .delete().catch(() => {});
  }
}


// ─────────────────────────────────────────────
// CLEANUP při odchodu
// ─────────────────────────────────────────────

/**
 * Vyčistí všechny blob URL při odchodu ze stránky.
 * Volá se z goToRooms() nebo pagehide.
 */
function cleanupMediaBlobUrls() {
  MEDIA.blobUrls.forEach(url => {
    try { URL.revokeObjectURL(url); } catch {}
  });
  MEDIA.blobUrls = [];

  // Zavři všechny aktivní přenosy
  Object.keys(MEDIA.transfers).forEach(id => _cleanupTransfer(id));
}

// Cleanup při zavření stránky
window.addEventListener('pagehide', cleanupMediaBlobUrls);
