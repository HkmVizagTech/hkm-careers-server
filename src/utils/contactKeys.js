/** Normalised email / phone used to spot the same person applying again. */
function emailKey(email) {
  const e = String(email || '').trim().toLowerCase();
  return e || undefined;
}

/** Last 10 digits, so "+91 98765 43210", "098765-43210" and "9876543210" all match. */
function phoneKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-10) : undefined;
}

module.exports = { emailKey, phoneKey };
