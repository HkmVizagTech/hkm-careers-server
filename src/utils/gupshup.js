/**
 * Minimal Gupshup WhatsApp client (self-serve "template/msg" API).
 *
 * Required env:
 *   GUPSHUP_API_KEY    – API key of the Gupshup app
 *   GUPSHUP_SOURCE     – the WhatsApp business number registered on the app (digits, with country code)
 *   GUPSHUP_APP_NAME   – the Gupshup app name (sent as `src.name`)
 * Optional:
 *   GUPSHUP_API_URL    – override the endpoint (defaults to the public template endpoint)
 *   GUPSHUP_TIMEOUT_MS – request timeout, default 10000
 *
 * Nothing in here ever throws: callers get `{ ok, messageId, error }` so a WhatsApp
 * outage can never break an application submission or a status change.
 */

const DEFAULT_URL = 'https://api.gupshup.io/wa/api/v1/template/msg';

function isConfigured() {
  return Boolean(
    process.env.GUPSHUP_API_KEY && process.env.GUPSHUP_SOURCE && process.env.GUPSHUP_APP_NAME
  );
}

/**
 * Normalise a user-typed phone number to WhatsApp format (digits only, with country code).
 * Defaults to India (+91) for bare 10-digit numbers. Returns null when it can't be valid.
 */
function normalizePhone(raw, defaultCountry = process.env.DEFAULT_COUNTRY_CODE || '91') {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;

  // 00 international prefix
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.length === 10) {
    digits = defaultCountry + digits;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    // trunk prefix, e.g. 098765 43210
    digits = defaultCountry + digits.slice(1);
  }

  // E.164 allows at most 15 digits; anything shorter than 11 can't include a country code.
  if (digits.length < 11 || digits.length > 15) return null;
  return digits;
}

/** Meta rejects template params containing newlines/tabs or runs of 5+ spaces. */
function cleanParam(value, max = 900) {
  const s = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  const out = s.length > max ? `${s.slice(0, max - 1)}…` : s;
  return out || '-'; // empty params are rejected too
}

const maskPhone = (p) => (p ? `***${String(p).slice(-4)}` : 'n/a');

/**
 * Send an approved template message.
 * @param {{ to: string, templateId: string, params: (string|number)[], buttonParam?: string }} opts
 * `buttonParam` fills the {{1}} of a dynamic URL button (the part after the fixed URL prefix).
 * @returns {Promise<{ ok: boolean, messageId?: string, error?: string }>}
 */
async function sendTemplate({ to, templateId, params = [], buttonParam }) {
  if (!isConfigured()) return { ok: false, error: 'Gupshup is not configured' };
  if (!to) return { ok: false, error: 'Missing destination number' };
  if (!templateId) return { ok: false, error: 'Missing template id' };

  const body = new URLSearchParams({
    channel: 'whatsapp',
    source: String(process.env.GUPSHUP_SOURCE).replace(/\D/g, ''),
    destination: to,
    'src.name': process.env.GUPSHUP_APP_NAME,
    template: JSON.stringify({ id: templateId, params: params.map((p) => cleanParam(p)) }),
  });

  // Dynamic "Visit website" button: Gupshup takes its variable in the `message` field.
  if (buttonParam) {
    body.set('message', JSON.stringify({ buttons: [{ type: 'url', index: 0, parameter: String(buttonParam) }] }));
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Number(process.env.GUPSHUP_TIMEOUT_MS) || 10000
  );

  try {
    const res = await fetch(process.env.GUPSHUP_API_URL || DEFAULT_URL, {
      method: 'POST',
      headers: {
        apikey: process.env.GUPSHUP_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: controller.signal,
    });

    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* non-JSON error page */
    }

    if (res.ok && data.status === 'submitted' && data.messageId) {
      return { ok: true, messageId: String(data.messageId) };
    }

    const error = data.message || data.error || `HTTP ${res.status}: ${text.slice(0, 200)}`;
    console.error(`[gupshup] send to ${maskPhone(to)} failed: ${error}`);
    return { ok: false, error: String(error).slice(0, 300) };
  } catch (err) {
    const error = err.name === 'AbortError' ? 'Gupshup request timed out' : err.message;
    console.error(`[gupshup] send to ${maskPhone(to)} errored: ${error}`);
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isConfigured, normalizePhone, cleanParam, sendTemplate, maskPhone };
