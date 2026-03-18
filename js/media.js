/**
 * RoomChat — media.js (v2)
 * P2P přenos fotek a videí přes WebRTC Data Channel.
 */

var MEDIA = {
  transfers:  {},
  blobUrls:   [],
  CHUNK_SIZE: 16384,
  MAX_SIZE:   25 * 1024 * 1024,
};

// ── VÝBĚR SOUBORU ──────────────────────────

function openMediaPicker() {
  const targets = Object.values(S.slots).filter(s =>
    s.id !== S.slotId && s.username && isOnline(s)
  );
  if (!targets.length) { toast('Nikdo jiný není online 😕', 'err'); return; }
  if (targets.length === 1) { _pickFile(targets[0]); return; }
  _showTargetPicker(targets);
}

function _showTargetPicker(targets) {
  const h3 = document.querySelector('#m-call h3');
  if (h3) h3.textContent = '📷 Poslat soubor komu?';
  const list = $('call-person-list');
  if (!list) return;
  list.innerHTML = targets.map(s => `
    <div class="cp-item">
      <div class="cp-av" style="background:${s.color}">${initials(s.username)}</div>
      <div class="cp-info">
        <div class="cp-name">${escHtml(s.username)}</div>
        <div class="cp-status">🟢 online</div>
      </div>
      <div class="cp-btns">
        <button class="cp-btn audio"
          onclick="closeM('m-call');_pickFile(S.slots['${s.id}'])">
          📷 Vybrat
        </button>
      </div>
    </div>`).join('');
  openM('m-call');
}

function _pickFile(slot) {
  if (!slot) return;
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*,video/*';
  inp.onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > MEDIA.MAX_SIZE) { toast('Max 25 MB', 'err'); return; }
    await _sendFile(f, slot);
  };
  inp.click();
}

// ── ODESÍLÁNÍ ──────────────────────────────

async function _sendFile(file, target) {
  const sigId  = 'm_' + S.slotId + '_' + target.id + '_' + Date.now();
  const sigRef = db.collection('rooms').doc(S.roomId).collection('mediaSignals').doc(sigId);

  toast('Navazuji spojení s ' + target.username + '…');

  try {
    const ice = await _mediaIce();
    const pc  = new RTCPeerConnection({ iceServers: ice });
    const dc  = pc.createDataChannel('media', { ordered: true });
    dc.binaryType = 'arraybuffer';

    MEDIA.transfers[sigId] = { pc, dc, file, target, isOfferer: true, unsub: null, timeout: null };

    dc.onopen = () => {
      toast('Odesílám ' + file.name + '…');
      _pump(sigId);
    };

    dc.onmessage = e => {
      if (e.data === 'ACK') {
        toast(target.username + ' obdržel/a soubor ✓', 'ok');
        _cleanup(sigId);
      }
    };

    dc.onerror = () => { toast('Chyba přenosu', 'err'); _cleanup(sigId); };

    pc.onicecandidate = async e => {
      if (!e.candidate) return;
      try { await sigRef.update({ offerCandidates: firebase.firestore.FieldValue.arrayUnion(JSON.stringify(e.candidate.toJSON())) }); } catch {}
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') { toast('Spojení selhalo', 'err'); _cleanup(sigId); }
    };

    const unsub = sigRef.onSnapshot(async snap => {
      if (!snap.exists) return;
      const d = snap.data();
      const t = MEDIA.transfers[sigId];
      if (!t) return;
      if (d.status === 'rejected') { toast(target.username + ' odmítl/a', 'err'); _cleanup(sigId); return; }
      if (d.answer && !t.pc.remoteDescription) {
        try { await t.pc.setRemoteDescription(JSON.parse(d.answer)); } catch {}
      }
      if (d.answerCandidates && t.pc.remoteDescription) {
        const added = t.pc._a || (t.pc._a = new Set());
        for (const c of d.answerCandidates) {
          if (added.has(c)) continue; added.add(c);
          try { await t.pc.addIceCandidate(new RTCIceCandidate(JSON.parse(c))); } catch {}
        }
      }
    });
    MEDIA.transfers[sigId].unsub = unsub;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await sigRef.set({
      from: S.slotId, to: target.id,
      fromUsername: S.username, fromColor: S.color,
      offer: JSON.stringify(pc.localDescription),
      answer: null, offerCandidates: [], answerCandidates: [],
      status: 'calling',
      fileName: file.name, fileType: file.type, fileSize: file.size,
      created: firebase.firestore.FieldValue.serverTimestamp(),
    });

    MEDIA.transfers[sigId].timeout = setTimeout(() => {
      if (MEDIA.transfers[sigId]) { toast(target.username + ' neodpovídá', 'err'); _cleanup(sigId); }
    }, 45000);

  } catch (e) {
    toast('Chyba: ' + e.message, 'err');
    delete MEDIA.transfers[sigId];
  }
}

async function _pump(sigId) {
  const t = MEDIA.transfers[sigId];
  if (!t?.dc || t.dc.readyState !== 'open') return;
  const { dc, file } = t;
  let buf;
  try { buf = await file.arrayBuffer(); } catch { toast('Nelze přečíst soubor', 'err'); _cleanup(sigId); return; }

  dc.send(JSON.stringify({ type: 'meta', fileName: file.name, fileType: file.type, fileSize: buf.byteLength }));

  let off = 0;
  const send = () => {
    if (!MEDIA.transfers[sigId] || dc.readyState !== 'open') return;
    while (off < buf.byteLength) {
      if (dc.bufferedAmount > MEDIA.CHUNK_SIZE * 8) {
        dc.bufferedAmountLowThreshold = MEDIA.CHUNK_SIZE;
        dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; send(); };
        return;
      }
      const chunk = buf.slice(off, Math.min(off + MEDIA.CHUNK_SIZE, buf.byteLength));
      dc.send(chunk);
      off += chunk.byteLength;
    }
    dc.send(JSON.stringify({ type: 'done' }));
    toast('Odesláno! Čekám na potvrzení…', 'ok');
  };
  send();
}

// ── PŘÍJEM ─────────────────────────────────

function setupMediaSignaling() {
  if (!S.roomId || !S.slotId) return;
  const unsub = db.collection('rooms').doc(S.roomId)
    .collection('mediaSignals')
    .where('to', '==', S.slotId)
    .onSnapshot(snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type !== 'added') return;
        const sig = ch.doc.data();
        if (sig?.offer && sig.status === 'calling') _showIncoming(ch.doc.id, sig);
      });
    });
  S.unsubs.push(unsub);
}

function _showIncoming(sigId, sig) {
  document.getElementById('media-incoming-bar')?.remove();
  const sizeMB = (sig.fileSize / 1024 / 1024).toFixed(1);
  const icon   = sig.fileType?.startsWith('image/') ? '🖼️' : sig.fileType?.startsWith('video/') ? '🎥' : '📎';

  const bar = document.createElement('div');
  bar.id = 'media-incoming-bar';
  bar.style.cssText = 'position:fixed;top:calc(70px + var(--safe-t));left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border2);border-radius:16px;padding:16px 20px;z-index:500;display:flex;flex-direction:column;align-items:center;gap:12px;box-shadow:0 8px 40px #000c;min-width:260px;max-width:90vw;text-align:center;animation:icIn .3s cubic-bezier(.34,1.4,.64,1)';
  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;text-align:left">
      <div style="width:40px;height:40px;border-radius:10px;background:${sig.fromColor||'#5c6bff'};display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:15px;flex-shrink:0">${initials(sig.fromUsername||'?')}</div>
      <div>
        <div style="font-weight:800;font-size:14px">${escHtml(sig.fromUsername||'?')} ti posílá soubor</div>
        <div style="font-size:12px;color:var(--muted2)">${icon} ${escHtml(sig.fileName||'soubor')} · ${sizeMB} MB</div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--orange);font-weight:600">⚠️ Jednorazové — zmizí po zavření</div>
    <div style="display:flex;gap:12px">
      <button onclick="rejectMediaTransfer('${sigId}')" style="padding:10px 20px;border-radius:10px;background:#ff5c5c22;border:1px solid #ff5c5c44;color:var(--red);font-family:var(--fh);font-weight:700;font-size:13px;cursor:pointer">📵 Odmítnout</button>
      <button onclick="acceptMediaTransfer('${sigId}')" style="padding:10px 20px;border-radius:10px;background:var(--accent);border:none;color:#fff;font-family:var(--fh);font-weight:700;font-size:13px;cursor:pointer">✅ Přijmout</button>
    </div>`;
  document.body.appendChild(bar);
  setTimeout(() => { if (document.getElementById('media-incoming-bar')) rejectMediaTransfer(sigId); }, 45000);
  if (!isDnd()) playNotifSound();
}

async function acceptMediaTransfer(sigId) {
  document.getElementById('media-incoming-bar')?.remove();
  const sigRef = db.collection('rooms').doc(S.roomId).collection('mediaSignals').doc(sigId);
  try {
    const snap = await sigRef.get();
    if (!snap.exists) { toast('Signál nenalezen', 'err'); return; }
    const sig = snap.data();
    toast('Přijímám soubor…');

    const ice = await _mediaIce();
    const pc  = new RTCPeerConnection({ iceServers: ice });

    const t = {
      pc, dc: null, isOfferer: false,
      chunks: [], meta: null,
      fromUsername: sig.fromUsername,
      fromColor:    sig.fromColor,
      fromSlotId:   sig.from,
      unsub: null,
    };
    MEDIA.transfers[sigId] = t;

    pc.ondatachannel = e => {
      const dc = e.channel;
      dc.binaryType = 'arraybuffer';
      t.dc = dc;
      dc.onmessage = ev => _handleChunk(sigId, ev.data, dc);
      dc.onerror   = () => { toast('Chyba při příjmu', 'err'); _cleanup(sigId); };
    };

    pc.onicecandidate = async e => {
      if (!e.candidate) return;
      try { await sigRef.update({ answerCandidates: firebase.firestore.FieldValue.arrayUnion(JSON.stringify(e.candidate.toJSON())) }); } catch {}
    };

    const unsub = sigRef.onSnapshot(async snap => {
      if (!snap.exists) return;
      const d  = snap.data();
      const tr = MEDIA.transfers[sigId];
      if (!tr?.pc?.remoteDescription) return;
      if (d.offerCandidates) {
        const added = tr.pc._a || (tr.pc._a = new Set());
        for (const c of d.offerCandidates) {
          if (added.has(c)) continue; added.add(c);
          try { await tr.pc.addIceCandidate(new RTCIceCandidate(JSON.parse(c))); } catch {}
        }
      }
    });
    t.unsub = unsub;

    await pc.setRemoteDescription(JSON.parse(sig.offer));

    if (sig.offerCandidates?.length) {
      const added = pc._a || (pc._a = new Set());
      for (const c of sig.offerCandidates) {
        if (added.has(c)) continue; added.add(c);
        try { await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(c))); } catch {}
      }
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sigRef.update({ answer: JSON.stringify(pc.localDescription), status: 'accepted' });

  } catch (e) {
    toast('Chyba přijímání: ' + e.message, 'err');
    _cleanup(sigId);
  }
}

async function rejectMediaTransfer(sigId) {
  document.getElementById('media-incoming-bar')?.remove();
  try { await db.collection('rooms').doc(S.roomId).collection('mediaSignals').doc(sigId).update({ status: 'rejected' }); } catch {}
  _cleanup(sigId);
}

function _handleChunk(sigId, data, dc) {
  const t = MEDIA.transfers[sigId];
  if (!t) return;
  if (typeof data === 'string') {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'meta') { t.meta = msg; t.chunks = []; toast('Přijímám ' + msg.fileName + '…'); return; }
      if (msg.type === 'done') { _assemble(sigId, dc); return; }
    } catch {}
    return;
  }
  t.chunks.push(data);
}

function _assemble(sigId, dc) {
  const t = MEDIA.transfers[sigId];
  if (!t?.meta || !t?.chunks?.length) return;

  const blob    = new Blob(t.chunks, { type: t.meta.fileType || 'application/octet-stream' });
  const blobUrl = URL.createObjectURL(blob);
  MEDIA.blobUrls.push(blobUrl);

  try { dc.send('ACK'); } catch {}

  _showInChat(blobUrl, t.meta, t.fromUsername, t.fromColor);
  toast('Soubor přijat! 📁', 'ok');
  setTimeout(() => _cleanup(sigId), 1000);
}

function _showInChat(blobUrl, meta, fromUsername, fromColor) {
  // Voice zpráva → speciální přehrávač
  if (meta.isVoice && typeof showVoiceBubble === 'function') {
    showVoiceBubble(blobUrl, meta, fromUsername, fromColor, false);
    return;
  }

  const box = document.getElementById('msgs');
  if (!box) return;

  const isImg = meta.fileType?.startsWith('image/');
  const isVid = meta.fileType?.startsWith('video/');
  const name  = fromUsername || '?';
  const color = fromColor    || '#5c6bff';
  const now   = new Date().toLocaleTimeString('cs', { hour: '2-digit', minute: '2-digit' });

  const group  = document.createElement('div');
  group.className = 'msg-group other';

  const metaEl = document.createElement('div');
  metaEl.className = 'msg-meta';
  metaEl.innerHTML = `<div class="mm-av" style="background:${color}">${initials(name)}</div><span>${escHtml(name)}</span><span class="mm-time">${now}</span>`;

  const wrap   = document.createElement('div');
  wrap.className = 'bubble-wrap';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.style.padding = '8px';

  if (isImg) {
    const img = document.createElement('img');
    img.src   = blobUrl;
    img.style.cssText = 'max-width:240px;border-radius:10px;display:block;cursor:pointer';
    img.onclick = () => openLightbox(blobUrl);
    img.onerror = () => { img.alt = '⚠️ Nelze zobrazit'; };
    bubble.appendChild(img);
  } else if (isVid) {
    const vid = document.createElement('video');
    vid.src   = blobUrl;
    vid.controls = true;
    vid.setAttribute('playsinline', '');
    vid.style.cssText = 'max-width:240px;border-radius:10px;display:block';
    bubble.appendChild(vid);
  } else {
    const a   = document.createElement('a');
    a.href    = blobUrl;
    a.download = meta.fileName || 'soubor';
    a.style.cssText = 'color:#fff;font-weight:700;text-decoration:underline';
    a.textContent = '📎 ' + (meta.fileName || 'soubor');
    bubble.appendChild(a);
  }

  const badge = document.createElement('div');
  badge.className = 'disappear-badge';
  badge.textContent = '👁️ dočasné — zmizí po zavření';
  bubble.appendChild(badge);

  wrap.appendChild(bubble);
  group.appendChild(metaEl);
  group.appendChild(wrap);
  box.appendChild(group);
  box.scrollTop = box.scrollHeight;
}

// ── HELPERS ────────────────────────────────

async function _mediaIce() {
  if (typeof CALL !== 'undefined' && CALL.iceServers) return CALL.iceServers;
  try {
    const r = await fetch('https://' + METERED_HOST + '/api/v1/turn/credentials?apiKey=' + METERED_KEY);
    const d = await r.json();
    if (Array.isArray(d) && d.length) return d;
  } catch {}
  return [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
}

function _cleanup(sigId) {
  const t = MEDIA.transfers[sigId];
  if (!t) return;
  try { t.dc?.close(); } catch {}
  try { t.pc?.close(); } catch {}
  try { t.unsub?.();   } catch {}
  if (t.timeout) clearTimeout(t.timeout);
  delete MEDIA.transfers[sigId];
  if (S.roomId) db.collection('rooms').doc(S.roomId).collection('mediaSignals').doc(sigId).delete().catch(() => {});
}

function cleanupMediaBlobUrls() {
  MEDIA.blobUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch {} });
  MEDIA.blobUrls = [];
  Object.keys(MEDIA.transfers).forEach(id => _cleanup(id));
  document.getElementById('media-incoming-bar')?.remove();
}

window.addEventListener('pagehide', cleanupMediaBlobUrls);
