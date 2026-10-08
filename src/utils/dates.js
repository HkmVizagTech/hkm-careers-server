// Dates for the admin team are shown and entered in India time.
const TZ = 'Asia/Kolkata';

/** "2026-10-31" -> Date at 23:59:59 IST that day. Full ISO strings / Dates pass through. Empty -> null. */
function endOfDayIST(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T23:59:59.999+05:30`);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** YYYY-MM-DD of a moment in India time. */
function istDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** "Fri, 9 Oct, 10:30 am" in India time (withYear: "Fri, 9 Oct 2026, 10:30 am"). */
function formatIST(date, withTime = true, withYear = false) {
  const opts = { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' };
  if (withYear) opts.year = 'numeric';
  if (withTime) Object.assign(opts, { hour: 'numeric', minute: '2-digit', hour12: true });
  return new Intl.DateTimeFormat('en-IN', opts).format(new Date(date));
}

module.exports = { TZ, endOfDayIST, istDateKey, formatIST };
