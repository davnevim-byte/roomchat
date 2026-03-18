/**
 * RoomChat — dm.js
 * ─────────────────────────────────────────────
 * Zodpovědnost:
 *   • Soukromé zprávy (DM) mezi dvěma uživateli
 *   • DM kolekce v Firestore pod rooms/{id}/dms/
 *   • Real-time listener pro otevřený DM
 *   • Notifikace pro nové DM zprávy
 *   • Unread badge na DM tlačítku
 *
 * Firestore struktura:
 *   rooms/{roomId}/dms/{dmId}/messages/{msgId}
 *     text        string
 *     fromSlotId  string
 *     fromUsername string
 *     timestamp   Timestamp
 *
 *   dmId = seřazená kombinace slotId1_slotId2
 *   (vždy stejné ID pro daný pár, bez ohledu na pořadí)
 *
 * Závislosti: config.js, utils.js, notifications.js
 * ─────────────────────────────────────────────
 */


// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/**
 * Generuje konzistentní DM ID pro pár uživatelů.
 * Seřadí slotId abecedně → vždy stejné ID bez ohledu na pořadí.
 * @param {string} slotIdA
 * @param {string} slotIdB
 * @returns {string} dmId ve formátu "aaa_bbb"
 */
function _getDmId(slotIdA, slotIdB) {
  return [slotIdA, slotIdB].sort().join('_');
}

/**
 * Vrátí Firestore referenci na DM kolekci zpráv.
 * @param {string} dmId
 * @returns {firebase.firestore.CollectionReference}
 */
function _dmMsgsRef(dmId) {
  return db
    .collection('rooms').doc(S.roomId)
    .collection('dms').doc(dmId)
    .collection('messages');
}


// ─────────────────────────────────────────────
// OTEVŘENÍ DM MODALU
// ─────────────────────────────────────────────

/**
 * Otevře DM modal pro konkrétního uživatele.
 * Přihlásí real-time listener na zprávy.
 * @param {string} targetSlotId - slotId příjemce
 */
function openDmModal(targetSlotId) {
  const target = S.slots[targetSlotId];
  if (!target?.username) return;

  // Nastav DM target do stavu
  S.dmTarget = {
    slotId:   targetSlotId,
    username: target.username,
    color:    target.color,
  };

  // Nastav UI modalu
  const avatar = $('dm-avatar');
  if (avatar) {
    avatar.textContent      = initials(target.username);
    avatar.style.background = target.color;
  }
  $('dm-name').textContent = escHtml(target.username);
  $('dm-msgs').innerHTML   = '';
  $('dm-inp').value        = '';

  openM('m-dm');
  setTimeout(() => $('dm-inp')?.focus(), 200);

  // Odhlás předchozí DM listener
  if (S.dmUnsub) {
    S.dmUnsub();
    S.dmUnsub = null;
  }

  // Přihlas nový listener
  _subscribeDm(targetSlotId);
}

/**
 * Zavře DM modal a odhlásí listener.
 */
function closeDmModal() {
  closeM('m-dm');
  if (S.dmUnsub) {
    S.dmUnsub();
    S.dmUnsub = null;
  }
  S.dmTarget = null;
}


// ─────────────────────────────────────────────
// REAL-TIME LISTENER
// ─────────────────────────────────────────────

/**
 * Přihlásí real-time Firestore listener na DM zprávy.
 * Zobrazuje posledních 100 zpráv, řazeno od nejstarší.
 * @param {string} targetSlotId
 * @private
 */
function _subscribeDm(targetSlotId) {
  const dmId  = _getDmId(S.slotId, targetSlotId);
  let   first = true;

  S.dmUnsub = _dmMsgsRef(dmId)
    .orderBy('timestamp', 'asc')
    .limitToLast(100)
    .onSnapshot(snap => {
      _renderDmMessages(snap, targetSlotId, first);
      first = false;
    });
}

/**
 * Renderuje DM zprávy do modalu.
 * @param {firebase.firestore.QuerySnapshot} snap
 * @param {string}  targetSlotId
 * @param {boolean} isFirst - true = první načtení (scrolluj dolů)
 * @private
 */
function _renderDmMessages(snap, targetSlotId, isFirst) {
  const box       = $('dm-msgs');
  if (!box) return;

  const atBottom  =
    box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const prevCount = box.querySelectorAll('.dm-bubble').length;
  const hasNew    = snap.size > prevCount && !isFirst;

  box.innerHTML = '';

  if (snap.empty) {
    box.innerHTML =
      `<div style="text-align:center;color:var(--muted);font-size:12px;
                   padding:20px">
         Žádné zprávy. Začni konverzaci! 👋
       </div>`;
    return;
  }

  snap.forEach(doc => {
    const msg  = doc.data();
    const own  = msg.fromSlotId === S.slotId;
    const nick = own
      ? S.username
      : (getNick(S.roomId, msg.fromSlotId) || msg.fromUsername || '?');

    const bubble = document.createElement('div');
    bubble.className = `dm-bubble ${own ? 'own' : 'other'}`;

    // Čas zprávy jako title (hover)
    bubble.title    = fmtDate(msg.timestamp);
    bubble.innerHTML = escHtml(msg.text || '');

    // Malý časový label pod skupinou zpráv
    const timeEl = document.createElement('div');
    timeEl.style.cssText =
      `font-size:9px;color:var(--muted);
       margin-${own ? 'right' : 'left'}:4px;
       text-align:${own ? 'right' : 'left'};
       margin-bottom:2px`;
    timeEl.textContent = fmtTime(msg.timestamp);

    box.appendChild(bubble);
    box.appendChild(timeEl);
  });

  // Scroll
  if (isFirst || atBottom) {
    box.scrollTop = box.scrollHeight;
  }

  // Notifikace pro nové DM zprávy (pokud modal není otevřený nebo není fokus)
  if (hasNew) {
    const lastMsg = snap.docs[snap.docs.length - 1]?.data();
    if (lastMsg?.fromSlotId !== S.slotId) {
      // Zpráva od druhé strany
      if (document.hidden || !document.hasFocus()) {
        _showDmNotification(lastMsg.fromUsername || '?', lastMsg.text || '');
      }
      if (!isDnd()) playNotifSound();
    }
  }
}


// ─────────────────────────────────────────────
// ODESÍLÁNÍ DM ZPRÁV
// ─────────────────────────────────────────────

/**
 * Odešle DM zprávu aktuálnímu DM targetu.
 * Volá se z tlačítka nebo Enter v DM inputu.
 */
async function sendDm() {
  if (!S.dmTarget || !S.roomId) return;

  const inp  = $('dm-inp');
  const text = inp?.value.trim();
  if (!text) return;

  inp.value = '';

  const dmId = _getDmId(S.slotId, S.dmTarget.slotId);

  try {
    await _dmMsgsRef(dmId).add({
      text,
      fromSlotId:   S.slotId,
      fromUsername: S.username,
      timestamp:    firebase.firestore.FieldValue.serverTimestamp(),
    });

    // Trigger push notifikace pro příjemce
    _triggerDmPush(text);

  } catch (e) {
    toast('Chyba při odesílání DM: ' + e.message, 'err');
    // Vrať text
    if (inp) inp.value = text;
  }
}

/**
 * Trigger push notifikace pro DM příjemce.
 * Používá stejný /api/notify endpoint s označením jako DM.
 * @param {string} text - text zprávy
 * @private
 */
function _triggerDmPush(text) {
  if (!S.roomId || !S.slotId || !S.dmTarget) return;
  fetch('/api/notify', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomId:       S.roomId,
      senderSlotId: S.slotId,
      targetSlotId: S.dmTarget.slotId,  // jen tento příjemce
      username:     S.username,
      text:         `🔒 DM: ${text.slice(0, 80)}`,
      type:         'dm',
    }),
  }).catch(() => {});
}


// ─────────────────────────────────────────────
// DM NOTIFIKACE
// ─────────────────────────────────────────────

/**
 * Zobrazí push notifikaci pro příchozí DM.
 * @param {string} fromUsername - jméno odesílatele
 * @param {string} text         - text zprávy
 * @private
 */
async function _showDmNotification(fromUsername, text) {
  if (isDnd()) return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const body = `💬 ${escHtml(fromUsername)}: ${text.slice(0, 80)}`;

  try {
    if (_swReg) {
      await _swReg.showNotification('PUP — soukromá zpráva', {
        body,
        icon:    '/icons/icon-192x192.png',
        badge:   '/icons/icon-72x72.png',
        tag:     `dm-${S.roomId}-${fromUsername}`,
        silent:  false,
        vibrate: [100, 50, 100],
        data:    { url: location.href, roomId: S.roomId },
      });
    } else {
      new Notification('PUP — soukromá zpráva', { body });
    }
  } catch {}
}


// ─────────────────────────────────────────────
// GLOBÁLNÍ DM LISTENER (nové DM i při zavřeném modalu)
// ─────────────────────────────────────────────

/**
 * Přihlásí listener na všechny DM konverzace tohoto uživatele.
 * Slouží k detekci nových zpráv i když není DM modal otevřený.
 * Volá se z enterChat() po inicializaci slotů.
 *
 * Poznámka: Firestore neumožňuje přímý query na všechny DM —
 * sledujeme každý pár zvlášť při prvním načtení slotů.
 */
function setupDmListeners() {
  // Odhlás předchozí listenery
  if (S._dmGlobalUnsubs) {
    S._dmGlobalUnsubs.forEach(u => u());
  }
  S._dmGlobalUnsubs = [];

  // Pro každý slot (kromě sebe) nastav DM listener
  Object.values(S.slots).forEach(slot => {
    if (!slot.username || slot.id === S.slotId) return;

    const dmId = _getDmId(S.slotId, slot.id);

    // Načti jen nové zprávy (od teď)
    const since = firebase.firestore.Timestamp.now();

    const unsub = _dmMsgsRef(dmId)
      .where('timestamp', '>', since)
      .orderBy('timestamp', 'asc')
      .onSnapshot(snap => {
        snap.docChanges().forEach(ch => {
          if (ch.type !== 'added') return;
          const msg = ch.doc.data();
          if (msg.fromSlotId === S.slotId) return; // vlastní zpráva

          // Pokud je DM modal otevřený pro tohoto uživatele — neignoruj
          if (S.dmTarget?.slotId === slot.id) return; // listener v modalu to zpracuje

          // Notifikace pro zprávu mimo modal
          _showDmNotification(msg.fromUsername || slot.username, msg.text || '');
          if (!isDnd()) playNotifSound();
          toast(
            `💬 DM od ${msg.fromUsername || slot.username}: ${(msg.text || '').slice(0, 40)}`,
            'ok'
          );
        });
      });

    S._dmGlobalUnsubs.push(unsub);
    S.unsubs.push(unsub); // přidej do hlavního cleanup pole
  });
}
