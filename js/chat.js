/**
 * RoomChat — chat.js
 * ─────────────────────────────────────────────
 * Zodpovědnost:
 *   • Inicializace chatu (enterChat)
 *   • Real-time render zpráv
 *   • Odesílání, mazání, editace zpráv
 *   • Reakce na zprávy (emoji)
 *   • Pin zprávy
 *   • Read receipts
 *   • Expiry countdown timery
 *   • Zmizení po přečtení (disappear on read)
 *   • Export konverzace
 *   • Smazání celého chatu (admin)
 *   • Heartbeat (online přítomnost)
 *
 * Závislosti: config.js, utils.js, storage.js,
 *             rooms.js, sidebar.js, features.js,
 *             notifications.js, settings.js
 * ─────────────────────────────────────────────
 */


// ─────────────────────────────────────────────
// POČÍTADLA ZPRÁV
// ─────────────────────────────────────────────

/** Počet dnešních zpráv — zobrazeno v header badge */
let todayMsgCount = 0;

/** Počet zpráv při posledním renderu — detekce nových */
let lastMsgCount  = 0;


// ─────────────────────────────────────────────
// ENTER CHAT — inicializace po přihlášení
// ─────────────────────────────────────────────

/**
 * Hlavní inicializační funkce chatu.
 * Volá se po úspěšném přihlášení/rejoinu.
 * Nastavuje UI, spouští Firestore listenery a timery.
 */
function enterChat() {
  $('loader').style.display = 'none';
  show('s-chat');

  // ── Header ──
  $('h-name').textContent         = '╱ ' + (S.roomData?.name || 'Místnost');
  $('mob-sb-room-name').textContent = S.roomData?.name || 'Místnost';
  $('h-lock').style.display       = S.roomData?.password ? '' : 'none';

  // ── Admin UI ──
  if (S.isAdmin) {
    $('sb-inv').style.display     = '';
    $('mob-sb-inv').style.display = '';
    $('btn-switch-room').style.display = '';
    $('btn-call').style.display   = '';
  } else {
    $('btn-call').style.display   = '';
  }

  // ── Timery + badge ──
  updateHeaderBadge();
  S.countdown = setInterval(updateHeaderBadge, 60_000);

  // ── Inicializace modulů ──
  renderSidebarActions();
  renderThemeGrid();
  checkRoomExpiry();
  _updateLockBanner();
  _setupSwipeSidebar();
  setupMentions();
  if (typeof setupDmListeners === 'function') setupDmListeners();
  resetActivityTimer();

  // ── Notifikace + push ──
  requestNotifPerm();
  if (Notification.permission === 'granted') {
    setTimeout(() => _subscribePush().catch(() => {}), 2_000);
  }
  _clearBadge();

  // ── Firestore listener: room doc (téma, nastavení, call, pin) ──
  const uRoom = db.collection('rooms').doc(S.roomId).onSnapshot(snap => {
    if (!snap.exists) return;
    const d = snap.data();
    S.roomData = { ...S.roomData, ...d };

    // Sdílené téma
    if (d.theme) _applySharedTheme(d);

    // Lock banner
    _updateLockBanner();

    // Pin bar
    S.pinnedMsg = d.pinnedMsg || null;
    renderPinBar();

    // Call bar (volání)
    if (typeof _updateCallBar === 'function') _updateCallBar(d);
  });
  S.unsubs.push(uRoom);

  // ── Firestore listener: slots (uživatelé, přítomnost, typing) ──
  const uSlots = db.collection('rooms').doc(S.roomId)
    .collection('slots')
    .onSnapshot(snap => {
      S.slots = {};
      snap.forEach(d => {
        S.slots[d.id] = { id: d.id, ...d.data() };
      });
      renderSidebar();
      renderTyping();
    });
  S.unsubs.push(uSlots);

  // ── Firestore listener: read receipts ──
  const uReads = db.collection('rooms').doc(S.roomId)
    .collection('reads')
    .onSnapshot(snap => {
      snap.docChanges().forEach(ch => {
        S.reads[ch.doc.id] = ch.doc.data();
      });
      _updateReadTicks();
    });
  S.unsubs.push(uReads);

  // ── Firestore listener: zprávy (real-time) ──
  const cutoff   = new Date(Date.now() - getMsgLifetime());
  const uMsgs = db.collection('rooms').doc(S.roomId)
    .collection('messages')
    .where('timestamp', '>', firebase.firestore.Timestamp.fromDate(cutoff))
    .orderBy('timestamp', 'asc')
    .limitToLast(200)
    .onSnapshot(snap => renderMessages(snap));
  S.unsubs.push(uMsgs);

  // ── Heartbeat — online přítomnost ──
  heartbeat();
  S.heartbeat = setInterval(heartbeat, 20_000);

  // ── Čištění expirovaných zpráv ──
  setInterval(cleanExpired, 15_000);

  // ── Signaling pro volání ──
  if (typeof setupCallSignaling === 'function') setupCallSignaling();

  // ── Input event listenery ──
  _setupInputListeners();

  // ── PWA banner (iOS) ──
  setTimeout(() => {
    if (isIos() && !window.navigator.standalone && !isPwaDismissed()) {
      showPwaBanner('ios');
    }
  }, 3_000);
}

/**
 * Nastaví event listenery pro input pole.
 * Odděleno kvůli přehlednosti enterChat.
 * @private
 */
function _setupInputListeners() {
  const inp = $('msg-inp');
  if (!inp) return;

  inp.addEventListener('keydown', e => {
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !$('mention-drop').classList.contains('show')
    ) {
      e.preventDefault();
      sendMsg();
    }
  });

  inp.addEventListener('input', onTyping);

  inp.addEventListener('focus', () => {
    setTimeout(() => {
      $('msgs').scrollTop = $('msgs').scrollHeight;
    }, 300);
  });

  // Zavři media panel / mention drop při kliknutí mimo
  document.addEventListener('click', e => {
    if (!e.target.closest('#media-panel') && !e.target.closest('#media-btn')) {
      closeMediaPanel();
    }
    if (!e.target.closest('#mention-drop') && !e.target.closest('#msg-inp')) {
      hideMentionDrop();
    }
    if (!e.target.closest('.bubble-wrap')) {
      $all('.bubble-wrap.menu-open').forEach(w => w.classList.remove('menu-open'));
    }
  });
}

/**
 * Aplikuje téma sdílené přes Firestore.
 * @param {Object} d - data místnosti
 * @private
 */
function _applySharedTheme(d) {
  if (d.theme === 'custom' && d.customBg) {
    const cm = $('chat-main');
    if (cm) {
      cm.classList.add('has-bg');
      cm.style.setProperty('--chat-bg-img', `url('${d.customBg}')`);
    }
    document.documentElement.setAttribute('data-theme', 'custom');
    const inp = $('custom-bg-url');
    if (inp) inp.value = d.customBg;
  } else if (d.theme && d.theme !== 'custom') {
    const cm = $('chat-main');
    if (cm) {
      cm.classList.remove('has-bg');
      cm.style.removeProperty('--chat-bg-img');
    }
    document.documentElement.setAttribute('data-theme', d.theme);
  }
  renderThemeGrid();
}


// ─────────────────────────────────────────────
// HEARTBEAT + ČIŠTĚNÍ
// ─────────────────────────────────────────────

/**
 * Aktualizuje lastSeen a online status v Firestore.
 * Volá se každých 20 sekund.
 */
async function heartbeat() {
  if (!S.roomId || !S.slotId) return;
  try {
    await db.collection('rooms').doc(S.roomId)
      .collection('slots').doc(S.slotId)
      .update({
        online:   true,
        lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
      });
  } catch (e) {
    // Ignorujeme — heartbeat selhání není kritické
  }
}

/**
 * Smaže expirované zprávy z Firestore.
 * Volá se každých 15 sekund.
 * Zprávy expirují buď časem (timestamp < cutoff) nebo expiresAt polem.
 */
async function cleanExpired() {
  if (!S.roomId) return;
  try {
    const batch   = db.batch();
    const now     = new Date();
    const cutoff  = firebase.firestore.Timestamp.fromDate(
      new Date(Date.now() - getMsgLifetime())
    );

    const [byTime, byExpiry] = await Promise.all([
      // Zprávy starší než msgLifetime
      getMsgLifetime() > 0
        ? db.collection('rooms').doc(S.roomId)
            .collection('messages')
            .where('timestamp', '<', cutoff)
            .limit(10).get()
        : Promise.resolve({ docs: [] }),
      // Zprávy s nastaveným expiresAt
      db.collection('rooms').doc(S.roomId)
        .collection('messages')
        .where('expiresAt', '<=', firebase.firestore.Timestamp.fromDate(now))
        .limit(10).get(),
    ]);

    const all = [...byTime.docs, ...byExpiry.docs];
    if (!all.length) return;

    // Deduplikuj a smaž
    const seen = new Set();
    all.forEach(d => {
      if (!seen.has(d.id)) {
        seen.add(d.id);
        batch.delete(d.ref);
      }
    });

    await batch.commit();
  } catch (e) {
    // Ignorujeme — čištění selhání není kritické
  }
}


// ─────────────────────────────────────────────
// RENDER ZPRÁV
// ─────────────────────────────────────────────

/**
 * Renderuje všechny zprávy z Firestore snapshot.
 * Detekuje nové zprávy pro notifikace.
 * @param {firebase.firestore.QuerySnapshot} snap
 */
function renderMessages(snap) {
  const box      = $('msgs');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const hasNew   = snap.size > lastMsgCount && lastMsgCount > 0;
  lastMsgCount   = snap.size;

  // Spočítej dnešní zprávy
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  let count = 0;
  let mentionMe = false;

  snap.forEach(doc => {
    const d = doc.data();
    if (!d.isSystem && d.timestamp) {
      const t = d.timestamp.toDate ? d.timestamp.toDate() : new Date(d.timestamp);
      if (t >= midnight) count++;
    }
    // Detekuj zmínku o mně v nové zprávě
    if (hasNew && d.slotId !== S.slotId && d.text?.includes('@' + S.username)) {
      const t = d.timestamp?.toDate?.();
      if (t && Date.now() - t.getTime() < 3_000) mentionMe = true;
    }
  });

  todayMsgCount = count;
  updateHeaderBadge();

  // Rebuild DOM
  box.innerHTML = '';
  let lastUsername = null;

  snap.forEach(doc => {
    const msg = { id: doc.id, ...doc.data() };

    // Přeskoč expirované zprávy
    if (msg.expiresAt) {
      const exp = msg.expiresAt.toDate ? msg.expiresAt.toDate() : new Date(msg.expiresAt);
      if (Date.now() > exp.getTime()) return;
    }

    // Systémová zpráva
    if (msg.isSystem) {
      const el = document.createElement('div');
      el.className = 'sys-msg';
      el.innerHTML = `<span>${escHtml(msg.text)}</span>`;
      box.appendChild(el);
      lastUsername = null;
      return;
    }

    // Normální zpráva — seskupit stejného odesílatele
    const own    = msg.slotId === S.slotId;
    const isDm   = !!msg.dmTo;
    const newGrp = msg.username !== lastUsername || isDm;
    const nick   = getNick(S.roomId, msg.slotId) || msg.username;

    if (newGrp) {
      const group = document.createElement('div');
      group.className = `msg-group ${own ? 'own' : 'other'}${isDm ? ' dm-msg-grp' : ''}`;

      // Meta (avatar + jméno + čas)
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML = `
        <div class="mm-av" style="background:${msg.color}">${initials(msg.username)}</div>
        <span>${escHtml(nick)}${isDm ? '<span class="dm-label">DM</span>' : ''}</span>
        <span class="mm-time">${fmtTime(msg.timestamp)}</span>
      `;
      group.appendChild(meta);
      group.appendChild(makeBubble(msg, own));
      box.appendChild(group);
    } else {
      // Přidej bublinku do poslední skupiny
      const lastGroup = box.querySelector('.msg-group:last-child');
      if (lastGroup) lastGroup.appendChild(makeBubble(msg, own));
    }

    lastUsername = isDm ? null : msg.username;
  });

  // Scroll na konec pokud jsme tam byli
  if (atBottom) {
    box.scrollTop = box.scrollHeight;
    // Reset unread počítadla
    _unreadCount = 0;
    _clearBadge();
  }

  // Notifikace pro nové zprávy
  if (hasNew) {
    const lastDoc  = Array.from(snap.docs).pop()?.data();
    const fromMe   = lastDoc?.slotId === S.slotId;
    if (!fromMe) {
      if (typeof playNotifSound === 'function') playNotifSound();
      showPup(mentionMe);
    }
    if (mentionMe) toast(`📣 @${S.username} — tě někdo zmínil!`);
  }

  // Aktualizuj read ticky
  _updateReadTicks();
}


// ─────────────────────────────────────────────
// TVORBA BUBLINY
// ─────────────────────────────────────────────

/**
 * Vytvoří DOM element bubliny zprávy.
 * @param {Object}  msg - data zprávy z Firestore
 * @param {boolean} own - true pokud je zpráva od aktuálního uživatele
 * @returns {HTMLElement} .bubble-wrap element
 */
function makeBubble(msg, own) {
  const wrap = document.createElement('div');
  wrap.className = 'bubble-wrap';
  wrap.dataset.msgid = msg.id;

  // ── Swipe-to-delete (admin) ──
  if (S.isAdmin) {
    const hint = document.createElement('div');
    hint.className = 'swipe-hint';
    hint.textContent = '🗑️';
    wrap.appendChild(hint);
    _setupSwipe(wrap, msg.id);
  }

  // ── Hlavní bublina ──
  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  // Reply quote
  if (msg.replyTo) {
    const qbar = document.createElement('div');
    qbar.className = 'quote-bar';
    qbar.innerHTML = `
      <div class="quote-name">${escHtml(msg.replyTo.username)}</div>
      <div>${escHtml((msg.replyTo.text || '[GIF]').slice(0, 80))}</div>
    `;
    bubble.appendChild(qbar);
  }

  // Obsah dle typu zprávy
  if (msg.type === 'gif') {
    const gw  = document.createElement('div');
    gw.className = 'gif-bubble';
    const img = document.createElement('img');
    img.src = msg.mediaUrl;
    img.alt = 'GIF';
    gw.appendChild(img);
    gw.onclick = () => openLightbox(msg.mediaUrl);
    bubble.appendChild(gw);
  } else {
    const txt = document.createElement('div');
    txt.innerHTML = parseMentions(msg.text || '');
    bubble.appendChild(txt);
  }

  // Edited badge
  if (msg.edited) {
    const eb = document.createElement('span');
    eb.className   = 'edited-badge';
    eb.textContent = '✏️ upraveno';
    eb.onclick     = e => {
      e.stopPropagation();
      showEditHistory(msg.editHistory || [], msg.text);
    };
    bubble.appendChild(eb);
  }

  // Expiry countdown badge
  if (msg.expiresAt) {
    const exp = msg.expiresAt.toDate ? msg.expiresAt.toDate() : new Date(msg.expiresAt);
    const rem = Math.max(0, Math.floor((exp.getTime() - Date.now()) / 1_000));
    const eb  = document.createElement('div');
    eb.className   = 'expiry-badge';
    eb.textContent = `⏱ zmizí za ${fmtExp(rem) || 'chvíli'}`;
    bubble.appendChild(eb);
    _startCd(msg.id, exp, eb, wrap);
  }

  // Zmizí po přečtení badge
  if (msg.disappearOnRead) {
    const db2 = document.createElement('div');
    db2.className   = 'disappear-badge';
    db2.textContent = '👁️ zmizí po přečtení';
    bubble.appendChild(db2);
  }

  // Read receipts (jen vlastní zprávy)
  if (own) {
    const rr = document.createElement('div');
    rr.className      = 'read-receipt';
    rr.dataset.msgid  = msg.id;
    rr.dataset.sender = S.slotId;
    const tick = document.createElement('span');
    tick.className   = 'read-tick';
    tick.textContent = '✓';
    const nm = document.createElement('span');
    nm.className = 'read-names';
    rr.appendChild(tick);
    rr.appendChild(nm);
    bubble.appendChild(rr);
  }

  // Reaction chips
  const reWrap = document.createElement('div');
  reWrap.className = 'bubble-re';
  const reactions = msg.reactions || {};
  Object.keys(reactions)
    .filter(k => reactions[k] > 0)
    .forEach(emoji => {
      const chip = document.createElement('div');
      chip.className = 're-chip';
      chip.innerHTML = `${emoji} <span class="cnt">${reactions[emoji]}</span>`;
      chip.onclick   = () => addReaction(msg.id, emoji);
      reWrap.appendChild(chip);
    });
  bubble.appendChild(reWrap);

  // Confirm bar pro mazání (swipe)
  const dcBar = document.createElement('div');
  dcBar.className = 'del-confirm-bar';
  dcBar.innerHTML = `
    <span>🗑️ Opravdu smazat?</span>
    <button onclick="deleteMsg('${msg.id}')">Smazat</button>
    <button onclick="this.closest('.del-confirm-bar').classList.remove('show')">Zrušit</button>
  `;
  bubble.appendChild(dcBar);

  // ── Akční tlačítka (hover / long press) ──
  const acts = document.createElement('div');
  acts.className = 'bubble-actions';

  // Reply
  const btnReply = _makeActBtn('↩️', 'Citovat', () => {
    setReply(msg);
    wrap.classList.remove('menu-open');
  });

  // Reakce
  const btnRe = _makeActBtn('😊', 'Reakce', e => {
    e.stopPropagation();
    toggleEp(msg.id, bubble);
  });

  // Kopírovat
  const btnCopy = _makeActBtn('📋', 'Kopírovat', () => {
    copyToClipboard(msg.text || msg.mediaUrl || '');
    wrap.classList.remove('menu-open');
  });

  acts.appendChild(btnReply);
  acts.appendChild(btnRe);
  acts.appendChild(btnCopy);

  // Editace (jen vlastní textové zprávy)
  if (own && (!msg.type || msg.type === 'text')) {
    const btnEdit = _makeActBtn('✏️', 'Upravit', e => {
      e.stopPropagation();
      startEdit(msg.id, msg.text || '', bubble, wrap);
    });
    acts.appendChild(btnEdit);
  }

  // Pin (admin)
  if (S.isAdmin) {
    const isPinned = S.pinnedMsg?.id === msg.id;
    const btnPin = _makeActBtn(
      isPinned ? '📌' : '📍',
      isPinned ? 'Odepnout' : 'Připnout',
      () => {
        isPinned ? unpinMessage() : pinMessage(msg);
        wrap.classList.remove('menu-open');
      }
    );
    acts.appendChild(btnPin);

    // Smazat (admin)
    const btnDel = _makeActBtn('🗑️', 'Smazat', e => {
      e.stopPropagation();
      deleteMsg(msg.id);
    });
    acts.appendChild(btnDel);
  }

  wrap.appendChild(acts);
  wrap.appendChild(bubble);

  // Long press pro mobilní menu
  let lpTO;
  wrap.addEventListener('touchstart', () => {
    lpTO = setTimeout(() => wrap.classList.add('menu-open'), 420);
  }, { passive: true });
  wrap.addEventListener('touchend',  () => clearTimeout(lpTO), { passive: true });
  wrap.addEventListener('touchmove', () => clearTimeout(lpTO), { passive: true });

  // Sleduj viditelnost pro read receipts (cizí zprávy)
  if (!own) _viewObs.observe(wrap);

  // Zprávy "zmizí po přečtení" — smaž po zobrazení (cizí zprávy)
  if (!own && msg.disappearOnRead) {
    _setupDisappearOnRead(msg.id, wrap);
  }

  return wrap;
}

/**
 * Helper — vytvoří akční tlačítko bubliny.
 * @private
 */
function _makeActBtn(emoji, title, onClick) {
  const btn = document.createElement('div');
  btn.className   = 'bact-btn';
  btn.textContent = emoji;
  btn.title       = title;
  btn.onclick     = onClick;
  return btn;
}


// ─────────────────────────────────────────────
// ODESÍLÁNÍ ZPRÁV
// ─────────────────────────────────────────────

/**
 * Odešle textovou zprávu do Firestore.
 * Respektuje reply context a nastavení expirace.
 */
async function sendMsg() {
  const inp  = $('msg-inp');
  const text = inp.value.trim();
  if (!text) return;

  const expiryVal = $('expiry-sel').value;

  inp.value = '';
  clearTyping();
  hideMentionDrop();

  const msgData = {
    type:      'text',
    text,
    slotId:    S.slotId,
    username:  S.username,
    color:     S.color,
    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
    reactions: {},
    edited:    false,
    editHistory: [],
  };

  // Reply
  if (S.replyTo) {
    msgData.replyTo = S.replyTo;
  }

  // Expirace
  if (expiryVal === 'read') {
    // Zmizí po přečtení
    msgData.disappearOnRead = true;
  } else {
    const expirySecs = parseInt(expiryVal) || 0;
    if (expirySecs > 0) {
      msgData.expiresAt = new firebase.firestore.Timestamp(
        Math.floor(Date.now() / 1_000) + expirySecs,
        0
      );
    }
  }

  clearReply();

  try {
    const ref = await db.collection('rooms').doc(S.roomId)
      .collection('messages').add(msgData);

    // Vlastní zprávu označíme jako přečtenou hned
    db.collection('rooms').doc(S.roomId)
      .collection('reads').doc(ref.id)
      .set({ [S.slotId]: Date.now() }, { merge: true })
      .catch(() => {});

    // Trigger push notifikace pro ostatní
    _triggerPush({ text, type: 'text' });

  } catch (e) {
    toast('Chyba při odesílání', 'err');
    // Vrať text do inputu
    inp.value = text;
  }
}

/**
 * Trigger push notifikace přes serverless funkci.
 * Fire-and-forget — neblokuje UI.
 * @param {{ text: string, type: string }} payload
 */
function _triggerPush({ text, type }) {
  if (!S.roomId || !S.slotId) return;
  fetch('/api/notify', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomId:      S.roomId,
      senderSlotId: S.slotId,
      username:    S.username,
      text,
      type,
    }),
  }).catch(() => {});
}


// ─────────────────────────────────────────────
// MAZÁNÍ ZPRÁV
// ─────────────────────────────────────────────

/**
 * Smaže zprávu z Firestore.
 * @param {string} msgId
 */
async function deleteMsg(msgId) {
  try {
    await db.collection('rooms').doc(S.roomId)
      .collection('messages').doc(msgId).delete();

    // Pokud byla pinnutá, odepni ji
    if (S.pinnedMsg?.id === msgId) {
      await unpinMessage();
    }
  } catch (e) {
    toast('Nelze smazat: ' + e.message, 'err');
  }
}

/**
 * Smaže VŠECHNY zprávy v místnosti (admin akce).
 * Volá se z room settings modalu.
 */
async function clearAllMessages() {
  // Dvojité potvrzení
  if (!confirm('Opravdu smazat všechny zprávy? Tato akce je nevratná.')) return;

  closeM('m-room-settings');

  try {
    // Firestore neumožňuje smazat kolekci přímo — batch po 500
    let deleted = 0;
    do {
      const snap = await db.collection('rooms').doc(S.roomId)
        .collection('messages').limit(500).get();
      if (snap.empty) break;

      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      deleted += snap.docs.length;
    } while (deleted % 500 === 0);

    // Smaž i read receipts
    const readSnap = await db.collection('rooms').doc(S.roomId)
      .collection('reads').limit(500).get();
    if (!readSnap.empty) {
      const b = db.batch();
      readSnap.docs.forEach(d => b.delete(d.ref));
      await b.commit();
    }

    // Odepni zprávu
    await db.collection('rooms').doc(S.roomId)
      .update({ pinnedMsg: null });

    toast('Chat byl smazán 🗑️', 'ok');

  } catch (e) {
    toast('Chyba při mazání: ' + e.message, 'err');
  }
}

/**
 * Zkopíruje text zprávy.
 * @param {string} text
 */
function copyMsg(text) {
  if (!text) return;
  copyToClipboard(text);
}


// ─────────────────────────────────────────────
// EDITACE ZPRÁV
// ─────────────────────────────────────────────

/**
 * Spustí inline editaci zprávy.
 * Nahradí obsah bubliny textarea + tlačítky.
 * @param {string}      msgId     - ID zprávy
 * @param {string}      currentText - aktuální text
 * @param {HTMLElement} bubbleEl  - .bubble element
 * @param {HTMLElement} wrapEl    - .bubble-wrap element
 */
function startEdit(msgId, currentText, bubbleEl, wrapEl) {
  // Ulož originální HTML pro cancel
  bubbleEl.dataset.origHtml = bubbleEl.innerHTML;

  bubbleEl.innerHTML = `
    <textarea class="edit-inp" id="edit-ta-${msgId}" rows="2">${escHtml(currentText)}</textarea>
    <div class="edit-btns">
      <button class="edit-cancel" onclick="cancelEdit('${msgId}')">Zrušit</button>
      <button class="edit-save"   onclick="saveEdit('${msgId}')">Uložit</button>
    </div>
  `;

  const ta = $('edit-ta-' + msgId);
  if (!ta) return;

  // Auto-výška
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
  ta.focus();
  ta.selectionStart = ta.selectionEnd = ta.value.length;

  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(msgId); }
    if (e.key === 'Escape') cancelEdit(msgId);
  });

  wrapEl.classList.remove('menu-open');
}

/**
 * Zruší editaci a obnoví původní obsah bubliny.
 * @param {string} msgId
 */
function cancelEdit(msgId) {
  const ta = $('edit-ta-' + msgId);
  if (!ta) return;
  const bubble = ta.closest('.bubble');
  if (bubble?.dataset.origHtml) {
    bubble.innerHTML = bubble.dataset.origHtml;
  }
}

/**
 * Uloží upravenou zprávu do Firestore.
 * Ukládá historii editací.
 * @param {string} msgId
 */
async function saveEdit(msgId) {
  const ta = $('edit-ta-' + msgId);
  if (!ta) return;
  const newText = ta.value.trim();
  if (!newText) return;

  try {
    const docRef = db.collection('rooms').doc(S.roomId)
      .collection('messages').doc(msgId);
    const doc    = await docRef.get();
    if (!doc.exists) return;

    const data = doc.data();
    const hist = data.editHistory || [];
    hist.push({
      text:     data.text,
      editedAt: firebase.firestore.Timestamp.now(),
    });

    await docRef.update({
      text:        newText,
      edited:      true,
      editHistory: hist,
      editedAt:    firebase.firestore.FieldValue.serverTimestamp(),
    });

  } catch (e) {
    toast('Chyba úpravy: ' + e.message, 'err');
  }
}

/**
 * Zobrazí historii editací zprávy.
 * @param {Array}  history     - pole { text, editedAt }
 * @param {string} currentText - aktuální text
 */
function showEditHistory(history, currentText) {
  const list = $('hist-list');
  list.innerHTML =
    `<div class="hist-item">
       <div class="hist-text" style="font-weight:700">📍 Aktuální</div>
       <div class="hist-text">${escHtml(currentText)}</div>
     </div>` +
    [...history].reverse().map(h =>
      `<div class="hist-item hist-orig">
         <div class="hist-time">${fmtDate(h.editedAt)} — před úpravou</div>
         <div class="hist-text">${escHtml(h.text)}</div>
       </div>`
    ).join('');
  openM('m-edit-hist');
}


// ─────────────────────────────────────────────
// REPLY
// ─────────────────────────────────────────────

/**
 * Nastaví reply context pro příští zprávu.
 * @param {Object} msg - data zprávy
 */
function setReply(msg) {
  const preview = msg.type === 'gif' ? '[GIF]' : (msg.text || '');
  S.replyTo = { id: msg.id, text: preview, username: msg.username };
  $('reply-text').textContent = `${msg.username}: ${preview.slice(0, 60)}`;
  $('reply-preview').classList.add('show');
  $('msg-inp').focus();
}

/**
 * Zruší reply context.
 */
function clearReply() {
  S.replyTo = null;
  $('reply-preview').classList.remove('show');
}


// ─────────────────────────────────────────────
// REAKCE
// ─────────────────────────────────────────────

/**
 * Přidá/zvýší počet reakce na zprávu.
 * @param {string} msgId
 * @param {string} emoji
 */
async function addReaction(msgId, emoji) {
  try {
    await db.collection('rooms').doc(S.roomId)
      .collection('messages').doc(msgId)
      .update({
        [`reactions.${emoji}`]: firebase.firestore.FieldValue.increment(1),
      });
  } catch (e) {
    // Ignorujeme — UI se aktualizuje přes listener
  }
}

/**
 * Zobrazí emoji picker pro reakce u bubliny.
 * Používá getMyReactions() pro uživatelův vlastní výběr.
 * @param {string}      msgId    - ID zprávy
 * @param {HTMLElement} bubbleEl - .bubble element
 */
function toggleEp(msgId, bubbleEl) {
  // Odstraň existující pickery
  $all('.ep[data-msg]').forEach(p => p.remove());

  const ep = document.createElement('div');
  ep.className    = 'ep';
  ep.dataset.msg  = msgId;
  ep.style.cssText =
    'position:absolute;bottom:calc(100% + 8px);left:0;' +
    'background:var(--surface);border:1px solid var(--border2);' +
    'border-radius:12px;padding:8px;display:flex;gap:4px;' +
    'flex-wrap:wrap;max-width:240px;z-index:100;' +
    'box-shadow:0 8px 24px #0008;animation:fadeUp .15s ease';

  getMyReactions().forEach(emoji => {
    const btn = document.createElement('div');
    btn.style.cssText =
      'width:33px;height:33px;display:flex;align-items:center;' +
      'justify-content:center;font-size:18px;border-radius:7px;cursor:pointer';
    btn.textContent = emoji;
    btn.onclick     = () => {
      addReaction(msgId, emoji);
      ep.remove();
    };
    ep.appendChild(btn);
  });

  bubbleEl.style.position = 'relative';
  bubbleEl.appendChild(ep);
}


// ─────────────────────────────────────────────
// PIN ZPRÁVY
// ─────────────────────────────────────────────

/**
 * Připne zprávu — uloží do room dokumentu.
 * @param {Object} msg - data zprávy
 */
async function pinMessage(msg) {
  if (!S.isAdmin || !S.roomId) return;
  try {
    const pinData = {
      id:       msg.id,
      text:     msg.text || '[GIF]',
      username: msg.username,
      pinnedBy: S.username,
      pinnedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    await db.collection('rooms').doc(S.roomId).update({ pinnedMsg: pinData });
    toast('Zpráva připnuta 📌', 'ok');
  } catch (e) {
    toast('Chyba: ' + e.message, 'err');
  }
}

/**
 * Odepne aktuálně připnutou zprávu.
 */
async function unpinMessage() {
  if (!S.isAdmin || !S.roomId) return;
  try {
    await db.collection('rooms').doc(S.roomId).update({ pinnedMsg: null });
  } catch (e) {
    toast('Chyba: ' + e.message, 'err');
  }
}

/**
 * Scrolluje na připnutou zprávu.
 */
function scrollToPin() {
  if (!S.pinnedMsg?.id) return;
  const el = document.querySelector(`[data-msgid="${S.pinnedMsg.id}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.outline = '2px solid var(--orange)';
    setTimeout(() => { el.style.outline = ''; }, 1_500);
  }
}

/**
 * Renderuje pin bar nad zprávami.
 * Zobrazí se pokud existuje pinnedMsg v roomData.
 */
function renderPinBar() {
  const bar = $('pin-bar');
  if (!bar) return;

  if (!S.pinnedMsg) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = '';
  $('pin-bar-text').textContent =
    (S.pinnedMsg.text || '[GIF]').slice(0, 80);
  $('pin-bar-by').textContent =
    `Připnuto od ${S.pinnedMsg.pinnedBy || '?'}`;
}


// ─────────────────────────────────────────────
// READ RECEIPTS
// ─────────────────────────────────────────────

/** Sada ID zpráv které jsme již označili jako přečtené (session) */
const _readDone = new Set();

/**
 * IntersectionObserver sleduje viditelnost cizích zpráv.
 * Při zobrazení označí zprávu jako přečtenou.
 */
const _viewObs = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      const id = e.target.dataset.msgid;
      if (id) _markRead(id, e.target);
      _viewObs.unobserve(e.target);
    }
  });
}, { threshold: 0.8 });

/**
 * Označí zprávu jako přečtenou v Firestore.
 * @param {string}      msgId  - ID zprávy
 * @param {HTMLElement} wrapEl - .bubble-wrap element
 */
async function _markRead(msgId, wrapEl) {
  if (_readDone.has(msgId) || !S.roomId || !S.slotId) return;
  _readDone.add(msgId);

  try {
    await db.collection('rooms').doc(S.roomId)
      .collection('reads').doc(msgId)
      .set({ [S.slotId]: Date.now() }, { merge: true });
  } catch (e) {
    // Ignorujeme
  }
}

/**
 * Aktualizuje vizuální read ticky (✓ / ✓✓ / modrá ✓✓).
 * Volá se při každé změně reads kolekce.
 */
function _updateReadTicks() {
  $all('.read-receipt[data-msgid]').forEach(rr => {
    const msgId  = rr.dataset.msgid;
    const sender = rr.dataset.sender;
    const reads  = S.reads[msgId] || {};
    const readers = Object.keys(reads).filter(id => id !== sender);
    const others  = Object.values(S.slots).filter(
      s => s.username && s.id !== sender
    );
    const tick = rr.querySelector('.read-tick');
    const nm   = rr.querySelector('.read-names');
    if (!tick) return;

    if (!readers.length) {
      tick.textContent = '✓';
      tick.className   = 'read-tick';
    } else if (others.length && readers.length >= others.length) {
      tick.textContent = '✓✓';
      tick.className   = 'read-tick all';
    } else {
      tick.textContent = '✓✓';
      tick.className   = 'read-tick seen';
    }

    if (nm) {
      nm.textContent = readers
        .map(id => S.slots[id]?.username)
        .filter(Boolean)
        .join(', ');
    }
  });
}


// ─────────────────────────────────────────────
// EXPIRY COUNTDOWN TIMER
// ─────────────────────────────────────────────

/** Mapa aktivních countdown timerů { msgId: intervalId } */
const _cdTimers = {};

/**
 * Spustí countdown timer pro časovanou zprávu.
 * Při vypršení odstraní zprávu z DOM.
 * @param {string}      msgId   - ID zprávy
 * @param {Date}        expDate - datum expirace
 * @param {HTMLElement} badgeEl - .expiry-badge element
 * @param {HTMLElement} wrapEl  - .bubble-wrap element
 */
function _startCd(msgId, expDate, badgeEl, wrapEl) {
  if (_cdTimers[msgId]) return; // Již běží

  const tick = () => {
    const rem = Math.max(0, Math.floor((expDate.getTime() - Date.now()) / 1_000));
    if (rem <= 0) {
      clearInterval(_cdTimers[msgId]);
      delete _cdTimers[msgId];
      // Odstraň skupinu zpráv z DOM
      const group = wrapEl.closest('.msg-group');
      if (group) {
        const wraps = group.querySelectorAll('.bubble-wrap');
        if (wraps.length <= 1) group.remove();
        else wrapEl.remove();
      }
      return;
    }
    badgeEl.textContent = `⏱ zmizí za ${fmtExp(rem)}`;
  };

  tick();
  _cdTimers[msgId] = setInterval(tick, 1_000);
}


// ─────────────────────────────────────────────
// ZMIZÍ PO PŘEČTENÍ
// ─────────────────────────────────────────────

/**
 * Nastaví observer pro zprávy "zmizí po přečtení".
 * Zpráva se smaže z Firestore při zobrazení příjemci.
 * @param {string}      msgId  - ID zprávy
 * @param {HTMLElement} wrapEl - .bubble-wrap element
 */
function _setupDisappearOnRead(msgId, wrapEl) {
  const obs = new IntersectionObserver(async entries => {
    if (entries[0].isIntersecting) {
      obs.disconnect();
      // Krátká prodleva pro UX (uživatel vidí zprávu)
      await new Promise(r => setTimeout(r, 1_500));
      try {
        await db.collection('rooms').doc(S.roomId)
          .collection('messages').doc(msgId).delete();
      } catch (e) {
        // Ignorujeme — možná již smazána
      }
    }
  }, { threshold: 1.0 });

  obs.observe(wrapEl);
}


// ─────────────────────────────────────────────
// SWIPE-TO-DELETE
// ─────────────────────────────────────────────

/**
 * Nastaví swipe-to-delete gesto pro bublinu (admin).
 * Swipe doleva → potvrzovací lišta.
 * @param {HTMLElement} wrapEl - .bubble-wrap element
 * @param {string}      msgId  - ID zprávy
 * @private
 */
function _setupSwipe(wrapEl, msgId) {
  let startX = 0;
  let deltaX = 0;
  let active = false;

  wrapEl.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    deltaX = 0;
    active = startX > 60;
  }, { passive: true });

  wrapEl.addEventListener('touchmove', e => {
    if (!active) return;
    deltaX = e.touches[0].clientX - startX;
    if (deltaX < 0) {
      wrapEl.style.transform = `translateX(${Math.max(deltaX, -70)}px)`;
      const hint = wrapEl.querySelector('.swipe-hint');
      if (hint) hint.style.opacity = String(Math.min(-deltaX / 70, 1));
    }
  }, { passive: true });

  wrapEl.addEventListener('touchend', () => {
    if (active && deltaX < -60) {
      const bar = wrapEl.querySelector('.del-confirm-bar');
      if (bar) {
        bar.classList.add('show');
        setTimeout(() => bar.classList.remove('show'), 4_500);
      }
    }
    wrapEl.style.transform = '';
    const hint = wrapEl.querySelector('.swipe-hint');
    if (hint) hint.style.opacity = '0';
    active = false;
  }, { passive: true });
}


// ─────────────────────────────────────────────
// EXPORT KONVERZACE
// ─────────────────────────────────────────────

/**
 * Exportuje konverzaci jako .txt soubor.
 * Stáhne přes odkaz — funguje i na mobilu.
 */
async function exportConversation() {
  if (!S.roomId) return;
  closeM('m-room-settings');

  try {
    const snap = await db.collection('rooms').doc(S.roomId)
      .collection('messages')
      .orderBy('timestamp', 'asc')
      .get();

    const lines = [
      `=== RoomChat export ===`,
      `Místnost: ${S.roomData?.name || S.roomId}`,
      `Exportováno: ${new Date().toLocaleString('cs')}`,
      ``,
    ];

    snap.forEach(doc => {
      const d = doc.data();
      if (d.isSystem) {
        lines.push(`--- ${d.text} ---`);
        return;
      }
      const time = d.timestamp
        ? fmtDate(d.timestamp)
        : '?';
      const text = d.type === 'gif' ? '[GIF]' : (d.text || '');
      lines.push(`[${time}] ${d.username}: ${text}`);
      if (d.edited) lines.push(`  (upraveno)`);
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `roomchat-${S.roomId}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Export stažen 📤', 'ok');

  } catch (e) {
    toast('Chyba exportu: ' + e.message, 'err');
  }
}


// ─────────────────────────────────────────────
// PAGE UNLOAD — čistý odchod
// ─────────────────────────────────────────────

/**
 * Při zavření stránky se pokusíme odebrat slot z callParticipants.
 * Používáme sendBeacon protože fetch může být přerušen.
 */
window.addEventListener('pagehide', () => {
  if (!S.roomId || !S.slotId) return;

  // Heartbeat offline
  const slotRef =
    `projects/roomchat-6092c/databases/(default)/documents/rooms/${S.roomId}/slots/${S.slotId}`;
  navigator.sendBeacon?.(
    'https://firestore.googleapis.com/v1/' + slotRef + '?updateMask.fieldPaths=online',
    new Blob([JSON.stringify({ fields: { online: { booleanValue: false } } })],
      { type: 'application/json' })
  );
});
