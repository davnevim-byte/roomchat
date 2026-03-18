/**
 * RoomChat — features.js
 * ─────────────────────────────────────────────
 * Zodpovědnost:
 *   • Emoji panel (kategorie + vyhledávání)
 *   • GIF vyhledávání (Giphy API)
 *   • @mention dropdown + autocomplete
 *   • Typing indikátor (odesílání stavu)
 *   • Media panel (tabs: emoji / GIF)
 *
 * Závislosti: config.js, utils.js
 * ─────────────────────────────────────────────
 */


// ─────────────────────────────────────────────
// MEDIA PANEL (wrapper pro emoji + GIF)
// ─────────────────────────────────────────────

/**
 * Přepne viditelnost media panelu.
 * Při otevření automaticky builduje emoji grid.
 */
function toggleMediaPanel() {
  const panel  = $('media-panel');
  const btn    = $('media-btn');
  if (!panel || !btn) return;

  const isOpen = panel.classList.toggle('show');

  if (isOpen) {
    buildEmoji();
    btn.classList.add('open');
  } else {
    btn.classList.remove('open');
  }
}

/**
 * Zavře media panel.
 */
function closeMediaPanel() {
  $('media-panel')?.classList.remove('show');
  $('media-btn')?.classList.remove('open');
}

/**
 * Přepne aktivní tab v media panelu.
 * @param {string} tab - 'emoji' | 'gif'
 */
function switchTab(tab) {
  // Zobraz správný obsah
  ['emoji', 'gif'].forEach(t => {
    const el = $('tab-' + t);
    if (el) el.style.display = t === tab ? '' : 'none';
  });

  // Zvýrazni aktivní tab tlačítko
  $all('.media-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
}


// ─────────────────────────────────────────────
// EMOJI PANEL
// ─────────────────────────────────────────────

/** True pokud byl emoji grid již sestaven (lazy build) */
let _emojiBuilt = false;

/**
 * Sestaví emoji grid z EMOJI_CATS konstant.
 * Lazy — volá se jen jednou při prvním otevření.
 */
function buildEmoji() {
  if (_emojiBuilt) return;
  _emojiBuilt = true;

  const container = $('emoji-container');
  if (!container) return;

  let html = '';
  for (const [cat, emojis] of Object.entries(EMOJI_CATS)) {
    html += `<span class="emoji-cat">${cat}</span>`;
    html += `<div class="emoji-grid">`;
    html += emojis.map(e =>
      `<div class="eg" onclick="insertEmoji('${e}')">${e}</div>`
    ).join('');
    html += `</div>`;
  }

  container.innerHTML = html;
}

/**
 * Filtruje emoji dle vyhledávacího dotazu.
 * Prohledává všechny emoji kategorií.
 * @param {string} query - hledaný výraz
 */
function filterEmoji(query) {
  buildEmoji();
  const container = $('emoji-container');
  if (!container) return;

  if (!query.trim()) {
    // Obnov plný grid
    _emojiBuilt = false;
    buildEmoji();
    return;
  }

  // Projdi všechny emoji a filtruj
  const all     = Object.values(EMOJI_CATS).flat();
  const matches = all.filter(e => e.includes(query));

  if (matches.length === 0) {
    container.innerHTML =
      `<div style="color:var(--muted);font-size:12px;padding:12px">
         Žádné emoji nenalezeno 😕
       </div>`;
    return;
  }

  container.innerHTML =
    `<div class="emoji-grid">
       ${matches.map(e =>
         `<div class="eg" onclick="insertEmoji('${e}')">${e}</div>`
       ).join('')}
     </div>`;
}

/**
 * Vloží emoji na aktuální pozici kurzoru v msg inputu.
 * @param {string} emoji
 */
function insertEmoji(emoji) {
  const inp = $('msg-inp');
  if (!inp) return;

  const start = inp.selectionStart;
  const end   = inp.selectionEnd;

  inp.value =
    inp.value.slice(0, start) +
    emoji +
    inp.value.slice(end);

  // Přesuň kurzor za vložené emoji
  inp.selectionStart = inp.selectionEnd = start + emoji.length;
  inp.focus();
}


// ─────────────────────────────────────────────
// GIF VYHLEDÁVÁNÍ (Giphy API)
// ─────────────────────────────────────────────

/** Debounce timer pro GIF vyhledávání */
let _gifDebounceTO = null;

/**
 * Debounced wrapper pro GIF vyhledávání.
 * Čeká 500ms po posledním stisku klávesy.
 * @param {string} query
 */
function debGif(query) {
  clearTimeout(_gifDebounceTO);

  if (!query.trim()) {
    $('gif-grid').innerHTML =
      '<div class="gif-msg">Zadej hledání 🎬</div>';
    return;
  }

  $('gif-grid').innerHTML = '<div class="gif-msg">Hledám…</div>';
  _gifDebounceTO = setTimeout(() => searchGifs(query), 500);
}

/**
 * Vyhledá GIFy přes Giphy API a zobrazí výsledky.
 * @param {string} query - hledaný výraz
 */
async function searchGifs(query) {
  const grid = $('gif-grid');
  if (!grid) return;

  try {
    const url = new URL('https://api.giphy.com/v1/gifs/search');
    url.searchParams.set('api_key', GIPHY_KEY);
    url.searchParams.set('q',       query);
    url.searchParams.set('limit',   '20');
    url.searchParams.set('rating',  'g');

    const res  = await fetch(url.toString());
    const data = await res.json();

    if (!data.data?.length) {
      grid.innerHTML = '<div class="gif-msg">Nic nenalezeno 😕</div>';
      return;
    }

    grid.innerHTML = data.data.map(gif => {
      const preview = gif.images.fixed_height_small.url;
      const full    = gif.images.original.url;
      return `
        <div class="gif-item"
             onclick="sendGif('${preview}','${full}')">
          <img src="${preview}" loading="lazy" alt="GIF">
        </div>
      `;
    }).join('');

  } catch (e) {
    grid.innerHTML =
      '<div class="gif-msg">Chyba načítání — zkus znovu</div>';
  }
}

/**
 * Odešle GIF zprávu do Firestore.
 * @param {string} previewUrl - URL náhledu (fixed_height_small)
 * @param {string} fullUrl    - URL plného GIFu (original)
 */
async function sendGif(previewUrl, fullUrl) {
  closeMediaPanel();
  if (!S.roomId) return;

  try {
    await db.collection('rooms').doc(S.roomId)
      .collection('messages').add({
        type:       'gif',
        mediaUrl:   fullUrl,
        previewUrl,
        slotId:     S.slotId,
        username:   S.username,
        color:      S.color,
        timestamp:  firebase.firestore.FieldValue.serverTimestamp(),
        reactions:  {},
        edited:     false,
        editHistory: [],
      });

    // Trigger push notifikace
    _triggerPush({ text: '', type: 'gif' });

  } catch (e) {
    toast('Chyba při odesílání GIF: ' + e.message, 'err');
  }
}


// ─────────────────────────────────────────────
// @MENTION DROPDOWN
// ─────────────────────────────────────────────

/**
 * Nastaví event listenery pro @mention funkcionalitu.
 * Volá se z enterChat() po inicializaci inputu.
 */
function setupMentions() {
  const inp = $('msg-inp');
  if (!inp) return;

  inp.addEventListener('input', _onMentionInput);
  inp.addEventListener('keydown', _onMentionKeydown);
}

/**
 * Handler pro input event — detekuje @mention a zobrazí dropdown.
 * @private
 */
function _onMentionInput() {
  const inp = $('msg-inp');
  if (!inp) return;

  const val = inp.value;
  const pos = inp.selectionStart;

  // Hledej @ zprava od kurzoru
  let atIdx = -1;
  for (let i = pos - 1; i >= 0; i--) {
    if (val[i] === '@') { atIdx = i; break; }
    if (val[i] === ' ' || val[i] === '\n') break;
  }

  if (atIdx < 0) {
    hideMentionDrop();
    return;
  }

  S.mentionStart = atIdx;
  const query    = val.slice(atIdx + 1, pos).toLowerCase();

  // Filtruj uživatele (kromě sebe)
  const matches = Object.values(S.slots).filter(slot =>
    slot.username &&
    slot.id !== S.slotId &&
    slot.username.toLowerCase().includes(query)
  );

  if (matches.length) {
    showMentionDrop(matches);
  } else {
    hideMentionDrop();
  }
}

/**
 * Handler pro keydown event v inputu — navigace dropdownem.
 * @param {KeyboardEvent} e
 * @private
 */
function _onMentionKeydown(e) {
  const dd = $('mention-drop');
  if (!dd?.classList.contains('show')) return;

  const items = dd.querySelectorAll('.mention-item');
  const sel   = dd.querySelector('.mention-item.sel');
  const idx   = Array.from(items).indexOf(sel);

  switch (e.key) {
    case 'ArrowDown': {
      e.preventDefault();
      const next = items[Math.min(idx + 1, items.length - 1)];
      if (next) {
        sel?.classList.remove('sel');
        next.classList.add('sel');
      }
      break;
    }
    case 'ArrowUp': {
      e.preventDefault();
      const prev = items[Math.max(idx - 1, 0)];
      if (prev) {
        sel?.classList.remove('sel');
        prev.classList.add('sel');
      }
      break;
    }
    case 'Enter':
    case 'Tab': {
      if (sel) {
        e.preventDefault();
        completeMention(sel.dataset.username);
      }
      break;
    }
    case 'Escape': {
      hideMentionDrop();
      break;
    }
  }
}

/**
 * Zobrazí mention dropdown se seznamem uživatelů.
 * @param {Object[]} users - filtrované sloty
 */
function showMentionDrop(users) {
  const dd = $('mention-drop');
  if (!dd) return;

  dd.innerHTML = users.slice(0, 5).map(slot => `
    <div class="mention-item"
         data-username="${escHtml(slot.username)}"
         onclick="completeMention('${escHtml(slot.username)}')">
      <div class="mention-av" style="background:${slot.color}">
        ${initials(slot.username)}
      </div>
      <span class="mention-name">@${escHtml(slot.username)}</span>
      <span style="font-size:10px;color:var(--muted);margin-left:auto">
        ${isOnline(slot) ? '🟢' : '⚫'}
      </span>
    </div>
  `).join('');

  dd.classList.add('show');

  // Automaticky označ první položku
  dd.querySelector('.mention-item')?.classList.add('sel');
}

/**
 * Skryje mention dropdown.
 */
function hideMentionDrop() {
  $('mention-drop')?.classList.remove('show');
  S.mentionStart = -1;
}

/**
 * Dokončí @mention — nahradí rozpracovanou zmínku v inputu.
 * @param {string} username - vybraná přezdívka
 */
function completeMention(username) {
  const inp = $('msg-inp');
  if (!inp || S.mentionStart < 0) return;

  const pos    = inp.selectionStart;
  const before = inp.value.slice(0, S.mentionStart);
  const after  = inp.value.slice(pos);

  inp.value = before + '@' + username + ' ' + after;

  // Přesuň kurzor za doplněnou zmínku
  const newPos = before.length + username.length + 2;
  inp.selectionStart = inp.selectionEnd = newPos;
  inp.focus();

  hideMentionDrop();
}


// ─────────────────────────────────────────────
// TYPING INDIKÁTOR (odesílání stavu)
// ─────────────────────────────────────────────

/**
 * Handler pro input event v msg inputu.
 * Nastaví typing:true v Firestore a spustí reset timer.
 * Volá se z enterChat() event listeneru.
 */
function onTyping() {
  clearTimeout(S.typingTO);

  // Nastav typing status
  if (S.roomId && S.slotId) {
    db.collection('rooms').doc(S.roomId)
      .collection('slots').doc(S.slotId)
      .update({
        typing:   true,
        typingAt: firebase.firestore.FieldValue.serverTimestamp(),
      })
      .catch(() => {});
  }

  // Reset po 3 sekundách nečinnosti
  S.typingTO = setTimeout(clearTyping, 3_000);
}

/**
 * Zruší typing status v Firestore.
 * Volá se po odeslání zprávy nebo po 3s nečinnosti.
 */
function clearTyping() {
  clearTimeout(S.typingTO);
  if (!S.roomId || !S.slotId) return;

  db.collection('rooms').doc(S.roomId)
    .collection('slots').doc(S.slotId)
    .update({ typing: false })
    .catch(() => {});
}
