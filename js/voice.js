/**
 * RoomChat — voice.js
 * ─────────────────────────────────────────────
 * Hlasové zprávy přes MediaRecorder API.
 * Přenos P2P přes existující MEDIA infrastrukturu.
 * Fallback: uloží jako blob, přenese jako soubor.
 * ─────────────────────────────────────────────
 */

var VOICE = {
  recorder:   null,    // MediaRecorder instance
  stream:     null,    // MediaStream
  chunks:     [],      // nahraná data
  startTime:  null,    // kdy začalo nahrávání
  timerID:    null,    // interval pro UI timer
  maxSeconds: 120,     // max délka nahrávky
};

// ─────────────────────────────────────────────
// NAHRÁVÁNÍ
// ─────────────────────────────────────────────

/**
 * Spustí / zastaví nahrávání hlasové zprávy.
 * Volá se z tlačítka 🎤 v input area.
 */
async function toggleVoiceRecord() {
  if (VOICE.recorder && VOICE.recorder.state === 'recording') {
    _stopRecord();
  } else {
    await _startRecord();
  }
}

async function _startRecord() {
  try {
    VOICE.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast('Povol přístup k mikrofonu', 'err');
    return;
  }

  // Zvol správný MIME type dle prohlížeče
  const mimeType = _getSupportedMime();
  const options  = mimeType ? { mimeType } : {};

  VOICE.chunks    = [];
  VOICE.startTime = Date.now();
  VOICE.recorder  = new MediaRecorder(VOICE.stream, options);

  VOICE.recorder.ondataavailable = e => {
    if (e.data?.size > 0) VOICE.chunks.push(e.data);
  };

  VOICE.recorder.onstop = () => _onRecordStop();

  VOICE.recorder.start(100); // chunk každých 100ms

  // UI
  _setVoiceUI(true);

  // Automatické zastavení po maxSeconds
  VOICE.timerID = setInterval(() => {
    const elapsed = Math.floor((Date.now() - VOICE.startTime) / 1000);
    _updateTimer(elapsed);
    if (elapsed >= VOICE.maxSeconds) _stopRecord();
  }, 1000);
}

function _stopRecord() {
  if (!VOICE.recorder) return;
  VOICE.recorder.stop();
  VOICE.stream?.getTracks().forEach(t => t.stop());
  clearInterval(VOICE.timerID);
  _setVoiceUI(false);
}

function _onRecordStop() {
  if (!VOICE.chunks.length) return;

  const mimeType = VOICE.recorder.mimeType || 'audio/webm';
  const blob     = new Blob(VOICE.chunks, { type: mimeType });
  const duration = Math.floor((Date.now() - VOICE.startTime) / 1000);

  if (blob.size < 1000) {
    toast('Nahrávka je příliš krátká', 'err');
    _resetVoice();
    return;
  }

  // Zobraz preview před odesláním
  _showVoicePreview(blob, duration, mimeType);
  _resetVoice();
}

function _resetVoice() {
  VOICE.recorder  = null;
  VOICE.stream    = null;
  VOICE.chunks    = [];
  VOICE.startTime = null;
  clearInterval(VOICE.timerID);
}

// ─────────────────────────────────────────────
// ODESÍLÁNÍ
// ─────────────────────────────────────────────

/**
 * Odešle hlasovou zprávu — P2P pokud je někdo online,
 * jinak zobrazí chybu (hlasovky vyžadují online příjemce).
 */
async function _sendVoiceBlob(blob, duration, mimeType) {
  $('voice-preview')?.remove();

  const online = Object.values(S.slots).filter(s =>
    s.id !== S.slotId && s.username && isOnline(s)
  );

  if (!online.length) {
    toast('Nikdo není online — hlasová zpráva nelze odeslat 😕', 'err');
    return;
  }

  // Vytvoř File objekt z blobu
  const ext  = _mimeToExt(mimeType);
  const file = new File([blob], `hlasova_zprava.${ext}`, { type: mimeType });

  // Přidej metadata o délce nahrávky
  file._voiceDuration = duration;

  toast('Odesílám hlasovou zprávu…');

  // Pošli všem online uživatelům
  for (const target of online) {
    await _sendVoiceToTarget(file, target, duration);
  }
}

async function _sendVoiceToTarget(file, target, duration) {
  // Použij existující MEDIA infrastrukturu s voice flag
  const sigId  = 'v_' + S.slotId + '_' + target.id + '_' + Date.now();
  const sigRef = db.collection('rooms').doc(S.roomId)
    .collection('mediaSignals').doc(sigId);

  try {
    const ice = await _mediaIce();
    const pc  = new RTCPeerConnection({ iceServers: ice });
    const dc  = pc.createDataChannel('voice', { ordered: true });
    dc.binaryType = 'arraybuffer';

    MEDIA.transfers[sigId] = { pc, dc, file, target, isOfferer: true, unsub: null, timeout: null };

    dc.onopen = () => _pumpVoice(sigId, file);

    dc.onmessage = e => {
      if (e.data === 'ACK') {
        toast(target.username + ' obdržel/a hlasovou zprávu ✓', 'ok');
        _cleanup(sigId);
      }
    };

    dc.onerror = () => { toast('Chyba přenosu', 'err'); _cleanup(sigId); };

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
      status:    'calling',
      fileName:  file.name,
      fileType:  file.type,
      fileSize:  file.size,
      isVoice:   true,
      duration,
      created:   firebase.firestore.FieldValue.serverTimestamp(),
    });

    MEDIA.transfers[sigId].timeout = setTimeout(() => {
      if (MEDIA.transfers[sigId]) { toast(target.username + ' neodpovídá', 'err'); _cleanup(sigId); }
    }, 45000);

  } catch (e) {
    toast('Chyba: ' + e.message, 'err');
    delete MEDIA.transfers[sigId];
  }
}

async function _pumpVoice(sigId, file) {
  const t = MEDIA.transfers[sigId];
  if (!t?.dc || t.dc.readyState !== 'open') return;
  const { dc } = t;
  let buf;
  try { buf = await file.arrayBuffer(); } catch { toast('Chyba čtení souboru', 'err'); _cleanup(sigId); return; }

  dc.send(JSON.stringify({
    type: 'meta', fileName: file.name, fileType: file.type,
    fileSize: buf.byteLength, isVoice: true, duration: file._voiceDuration || 0,
  }));

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
  };
  send();
}


// ─────────────────────────────────────────────
// ZOBRAZENÍ — VOICE BUBBLE
// ─────────────────────────────────────────────

/**
 * Zobrazí hlasovou zprávu v chatu jako audio přehrávač.
 * Volá se z media.js _showInChat pokud isVoice === true.
 */
function showVoiceBubble(blobUrl, meta, fromUsername, fromColor, own) {
  const box = document.getElementById('msgs');
  if (!box) return;

  const name     = own ? S.username : (fromUsername || '?');
  const color    = own ? S.color    : (fromColor    || '#5c6bff');
  const now      = new Date().toLocaleTimeString('cs', { hour: '2-digit', minute: '2-digit' });
  const duration = meta.duration || 0;

  const group = document.createElement('div');
  group.className = 'msg-group ' + (own ? 'own' : 'other');

  const metaEl = document.createElement('div');
  metaEl.className = 'msg-meta';
  metaEl.innerHTML = `
    <div class="mm-av" style="background:${color}">${initials(name)}</div>
    <span>${escHtml(name)}</span>
    <span class="mm-time">${now}</span>
  `;

  const wrap   = document.createElement('div');
  wrap.className = 'bubble-wrap';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.style.padding = '10px 14px';
  bubble.style.minWidth = '200px';

  // Vlastní audio přehrávač
  bubble.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <button class="voice-play-btn" data-url="${blobUrl}"
        style="width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.25);
               border:none;cursor:pointer;font-size:16px;display:flex;align-items:center;
               justify-content:center;flex-shrink:0;color:inherit"
        onclick="toggleVoicePlay(this)">▶️</button>
      <div style="flex:1;min-width:0">
        <div class="voice-progress-wrap"
          style="height:4px;background:rgba(255,255,255,.25);border-radius:2px;
                 cursor:pointer;position:relative;margin-bottom:4px"
          onclick="seekVoice(this, event)">
          <div class="voice-progress-bar"
            style="height:100%;background:rgba(255,255,255,.7);border-radius:2px;width:0%;
                   transition:width .1s;pointer-events:none"></div>
        </div>
        <div style="font-size:10px;opacity:.7">
          <span class="voice-current">0:00</span>
          <span> / ${_fmtDur(duration)}</span>
        </div>
      </div>
      <span style="font-size:18px">🎤</span>
    </div>
  `;

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

/**
 * Přehraje / pozastaví hlasovou zprávu.
 */
function toggleVoicePlay(btn) {
  const blobUrl = btn.dataset.url;
  if (!blobUrl) return;

  const bubble   = btn.closest('.bubble');
  const bar      = bubble?.querySelector('.voice-progress-bar');
  const current  = bubble?.querySelector('.voice-current');

  // Zastav ostatní přehrávače
  document.querySelectorAll('.voice-play-btn.playing').forEach(b => {
    if (b !== btn) {
      b.classList.remove('playing');
      b.textContent = '▶️';
      b._audio?.pause();
    }
  });

  // Vytvoř nebo použij existující audio
  if (!btn._audio) {
    btn._audio = new Audio(blobUrl);
    btn._audio.ontimeupdate = () => {
      const pct = (btn._audio.currentTime / btn._audio.duration) * 100 || 0;
      if (bar)     bar.style.width     = pct + '%';
      if (current) current.textContent = _fmtDur(Math.floor(btn._audio.currentTime));
    };
    btn._audio.onended = () => {
      btn.textContent = '▶️';
      btn.classList.remove('playing');
      if (bar)     bar.style.width     = '0%';
      if (current) current.textContent = '0:00';
    };
  }

  if (btn.classList.contains('playing')) {
    btn._audio.pause();
    btn.textContent = '▶️';
    btn.classList.remove('playing');
  } else {
    btn._audio.play().catch(() => toast('Nelze přehrát', 'err'));
    btn.textContent = '⏸️';
    btn.classList.add('playing');
  }
}

/**
 * Seek v hlasové zprávě kliknutím na progress bar.
 */
function seekVoice(wrap, event) {
  const btn = wrap.closest('.bubble')?.querySelector('.voice-play-btn');
  if (!btn?._audio) return;
  const rect = wrap.getBoundingClientRect();
  const pct  = (event.clientX - rect.left) / rect.width;
  btn._audio.currentTime = pct * btn._audio.duration;
}


// ─────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────

function _setVoiceUI(recording) {
  const btn = document.getElementById('voice-btn');
  if (!btn) return;
  if (recording) {
    btn.textContent = '⏹️';
    btn.style.color = 'var(--red)';
    btn.title       = 'Zastavit nahrávání';
    // Zobraz timer v input area
    _showRecordingIndicator();
  } else {
    btn.textContent = '🎤';
    btn.style.color = '';
    btn.title       = 'Hlasová zpráva';
    document.getElementById('voice-recording-ind')?.remove();
  }
}

function _showRecordingIndicator() {
  document.getElementById('voice-recording-ind')?.remove();
  const ind = document.createElement('div');
  ind.id = 'voice-recording-ind';
  ind.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 12px;' +
    'background:#ff5c5c11;border:1px solid #ff5c5c44;border-radius:8px;' +
    'margin-bottom:8px;font-size:12px;font-weight:600;color:var(--red)';
  ind.innerHTML = `
    <div style="width:8px;height:8px;border-radius:50%;background:var(--red);
                animation:pulse .8s ease infinite;flex-shrink:0"></div>
    <span>Nahrávám… <span id="voice-timer">0:00</span></span>
    <span style="margin-left:auto;color:var(--muted);font-size:10px">max 2:00</span>
  `;
  const replyPreview = document.getElementById('reply-preview');
  const inputArea    = document.getElementById('input-area');
  if (inputArea) {
    inputArea.insertBefore(ind, replyPreview || inputArea.firstChild);
  }
}

function _updateTimer(elapsed) {
  const el = document.getElementById('voice-timer');
  if (el) el.textContent = _fmtDur(elapsed);
}

function _showVoicePreview(blob, duration, mimeType) {
  document.getElementById('voice-preview')?.remove();

  const blobUrl = URL.createObjectURL(blob);
  MEDIA.blobUrls.push(blobUrl);

  const prev = document.createElement('div');
  prev.id = 'voice-preview';
  prev.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;' +
    'background:var(--surface2);border-left:3px solid var(--accent);' +
    'border-radius:8px;margin-bottom:8px';
  prev.innerHTML = `
    <span style="font-size:18px">🎤</span>
    <span style="font-size:12px;font-weight:600;flex:1">
      Hlasová zpráva · ${_fmtDur(duration)}
    </span>
    <button onclick="document.getElementById('voice-preview')?.remove();URL.revokeObjectURL('${blobUrl}')"
      style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:18px;padding:0;line-height:1">✕</button>
    <button onclick="_sendVoiceBlob(window._voiceBlob, ${duration}, '${mimeType}')"
      style="padding:6px 14px;border-radius:8px;background:var(--accent);border:none;
             color:#fff;font-family:var(--fh);font-weight:700;font-size:12px;cursor:pointer">
      Odeslat →
    </button>
  `;

  // Ulož blob globálně pro odeslání
  window._voiceBlob = blob;

  const inputArea = document.getElementById('input-area');
  if (inputArea) {
    const replyPreview = document.getElementById('reply-preview');
    inputArea.insertBefore(prev, replyPreview || inputArea.firstChild);
  }
}

function _fmtDur(secs) {
  if (!secs || isNaN(secs)) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function _getSupportedMime() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function _mimeToExt(mime) {
  if (mime.includes('ogg'))  return 'ogg';
  if (mime.includes('mp4'))  return 'm4a';
  return 'webm';
}
