// Vercel Serverless Function — RoomChat Push Notifications
// POST /api/notify
// Body: { roomId, senderSlotId, username, text, type }

const webpush = require('web-push');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// ── VAPID config ──
webpush.setVapidDetails(
  'mailto:davnevim@gmail.com',
  process.env.VAPID_PUBLIC,
  process.env.VAPID_PRIVATE
);

// ── Firebase Admin init (singleton) ──
function getDb() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { roomId, senderSlotId, username, text, type } = req.body || {};
  if (!roomId || !senderSlotId) return res.status(400).json({ error: 'Missing params' });

  try {
    const db = getDb();

    // Get all slots with push subscriptions (excluding sender)
    const slotsSnap = await db.collection('rooms').doc(roomId).collection('slots').get();
    const targets = [];
    slotsSnap.forEach(doc => {
      const d = doc.data();
      if (doc.id === senderSlotId || !d.pushSub || !d.username) return;
      targets.push({ slotId: doc.id, pushSub: d.pushSub });
    });

    if (!targets.length) return res.status(200).json({ sent: 0 });

    const body = type === 'gif'
      ? `${username} poslal/a GIF 🎬`
      : `${username}: ${(text || '').slice(0, 100)}`;

    const payload = JSON.stringify({
      title: 'PUP',
      body,
      tag: `roomchat-${roomId}`,
      url: `https://roomchat-eight.vercel.app/?room=${roomId}`,
      roomId,
    });

    // Send to all targets
    await Promise.allSettled(
      targets.map(async t => {
        let sub;
        try { sub = JSON.parse(t.pushSub); } catch(e) { return; }
        try {
          await webpush.sendNotification(sub, payload);
        } catch (err) {
          // Remove expired subscriptions
          if (err.statusCode === 410 || err.statusCode === 404) {
            db.collection('rooms').doc(roomId).collection('slots')
              .doc(t.slotId).update({ pushSub: null }).catch(() => {});
          }
        }
      })
    );

    return res.status(200).json({ sent: targets.length });
  } catch (err) {
    console.error('Push notify error:', err);
    return res.status(500).json({ error: err.message });
  }
};
