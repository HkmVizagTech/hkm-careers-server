const crypto = require('crypto');
const Application = require('../models/Application');

// Delivery progress only ever moves forward (webhooks can arrive out of order).
const RANK = { submitted: 0, sent: 1, delivered: 2, read: 3 };
const EVENT_TO_STATUS = { enqueued: 'submitted', sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };

function tokenMatches(provided) {
  const secret = process.env.GUPSHUP_WEBHOOK_KEY;
  if (!secret || typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Next stored status for a message, or null if the event should be ignored. */
function nextStatus(current, event) {
  const next = EVENT_TO_STATUS[event];
  if (!next || next === 'submitted') return null; // "enqueued" adds nothing over "submitted"
  if (current === 'failed' || current === 'skipped') return null;
  if (next === 'failed') return (RANK[current] ?? 0) >= RANK.delivered ? null : 'failed';
  return (RANK[next] ?? 0) > (RANK[current] ?? 0) ? next : null;
}

async function findByMessageId(ids) {
  return Application.findOne({ 'whatsappMessages.messageId': { $in: ids } }).select('whatsappMessages');
}

async function applyEvent(payload) {
  const ids = [payload.gsId, payload.id].filter(Boolean).map(String);
  if (!ids.length) return;

  let application = await findByMessageId(ids);
  if (!application) {
    // The webhook can beat our own "log the send" write by a few milliseconds.
    await new Promise((r) => setTimeout(r, 1500));
    application = await findByMessageId(ids);
  }
  if (!application) return;

  const message = application.whatsappMessages.find((m) => ids.includes(m.messageId));
  const next = nextStatus(message.status, payload.type);
  if (!next) return;

  const set = { 'whatsappMessages.$.status': next, 'whatsappMessages.$.updatedAt': new Date() };
  if (next === 'failed') {
    const inner = payload.payload || {};
    set['whatsappMessages.$.error'] = [inner.code, inner.reason].filter(Boolean).join(': ').slice(0, 300) || 'Delivery failed';
  }
  await Application.updateOne(
    { _id: application._id, 'whatsappMessages._id': message._id },
    { $set: set }
  );
}

/**
 * POST /api/webhooks/gupshup?key=<GUPSHUP_WEBHOOK_KEY>
 * Always answers 200 for authenticated calls so Gupshup doesn't keep retrying.
 */
const gupshupWebhook = async (req, res) => {
  if (!tokenMatches(req.query.key)) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  res.sendStatus(200);

  try {
    const body = req.body || {};
    if (body.type === 'message-event' && body.payload) {
      await applyEvent(body.payload);
    }
  } catch (err) {
    console.error('[webhook] gupshup event failed:', err.message);
  }
};

/**
 * GET /api/webhooks/gupshup?key=...
 * Gupshup pings the URL when you save it in the dashboard; answer 200 so it is accepted.
 */
const gupshupWebhookCheck = (req, res) => {
  if (!tokenMatches(req.query.key)) return res.status(401).json({ message: 'Unauthorized' });
  res.status(200).json({ ok: true });
};

module.exports = { gupshupWebhook, gupshupWebhookCheck, nextStatus, tokenMatches };
