/**
 * Where an interview happens, as two parts: a name/details text and a link.
 *   in-person: venue = "Chaitanya Bhavan", link = Google Maps link
 *   video:     link = meeting link (Meet/Zoom/any URL)
 *   phone:     venue = call details text
 * Older interviews only have `location` (name and link in one string); this splits it.
 */
const URL_RE = /https?:\/\/\S+/;

function interviewPlace(iv = {}) {
  let venue = String(iv.venue || '').trim();
  let link = String(iv.link || '').trim();
  if (!venue && !link && iv.location) {
    const text = String(iv.location).trim();
    link = text.match(URL_RE)?.[0] || '';
    venue = text.replace(URL_RE, '').replace(/\s{2,}/g, ' ').trim();
  }
  return { venue, link };
}

/** Accepts "meet.google.com/abc" or "https://..." -> https URL, or null if it isn't a link. */
function normalizeLink(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

module.exports = { interviewPlace, normalizeLink };
