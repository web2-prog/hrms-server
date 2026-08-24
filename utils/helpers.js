export function parseListQuery(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const rawLimit = String(query.limit || '8').toLowerCase();
  const limit =
    rawLimit === 'all' || rawLimit === '0'
      ? 10000
      : Math.min(10000, Math.max(1, parseInt(query.limit, 10) || 8));
  const skip = (page - 1) * limit;
  const search = (query.search || '').trim();
  return { page, limit, skip, search };
}

export function listResponse(data, total, page, limit) {
  return { data, total, page, limit, pages: Math.ceil(total / limit) || 0 };
}

/** Parse "HH:MM", "HH:MM:SS", or 12h "h:mm[:ss] AM/PM" → { h, m, s } */
export function parseTimeParts(t) {
  if (!t || typeof t !== 'string') return null;
  const str = t.trim();
  const ampm = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (ampm) {
    let h = Number(ampm[1]);
    const m = Number(ampm[2]);
    const s = ampm[3] != null ? Number(ampm[3]) : 0;
    const period = ampm[4].toUpperCase();
    if (h < 1 || h > 12 || m > 59 || s > 59) return null;
    if (period === 'AM') {
      if (h === 12) h = 0;
    } else if (h !== 12) {
      h += 12;
    }
    return { h, m, s };
  }
  const parts = str.split(':').map(Number);
  if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return null;
  const [h, m, s = 0] = parts;
  if (h > 23 || m > 59 || s > 59) return null;
  return { h, m, s };
}

/** Convert "HH:MM" or "HH:MM:SS" to total seconds from midnight */
export function timeToSeconds(t) {
  const p = parseTimeParts(t);
  if (!p) return 0;
  return p.h * 3600 + p.m * 60 + p.s;
}

/** Convert "HH:MM" or "HH:MM:SS" to decimal hours */
export function timeToDecimal(t) {
  return timeToSeconds(t) / 3600;
}

/** Decimal hours to "H:MM:SS" */
export function decimalToHM(d) {
  const sign = d < 0 ? '-' : '';
  const totalSec = Math.round(Math.abs(Number(d) || 0) * 3600);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${sign}${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Seconds between two "HH:MM" / "HH:MM:SS" times (can be fractional-safe integer) */
export function secondsBetween(start, end) {
  if (!start || !end) return 0;
  return timeToSeconds(end) - timeToSeconds(start);
}

/** Fractional minutes between two times (second precision) */
export function minutesBetween(start, end) {
  return secondsBetween(start, end) / 60;
}

/** Add fractional minutes to HH:MM / HH:MM:SS → HH:MM:SS */
export function addMinutesToTime(t, mins) {
  const p = parseTimeParts(t);
  if (!p) return t;
  let total = Math.round(p.h * 3600 + p.m * 60 + p.s + Number(mins || 0) * 60);
  if (total < 0) total = 0;
  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Fixed late check-in penalty (minutes). Work counted from check-in + this when late. */
export const LATE_CHECKIN_PENALTY_MINUTES = 15;
/**
 * Default grace after shift start. With company shift 08:45 this is through 09:05
 * (inclusive of that minute); 09:06 applies the late penalty.
 */
export const DEFAULT_LATE_BUFFER_MINUTES = 20;
/** Company-wide default late-until clock (used when seeding / backfilling). */
export const DEFAULT_LATE_BUFFER_UNTIL = '09:05';

export function normalizeLateBufferMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return DEFAULT_LATE_BUFFER_MINUTES;
  return Math.max(0, Math.min(240, Math.floor(minutes)));
}

/**
 * The department buffer is inclusive to the whole cutoff minute.
 * Example: 08:45 shift + 20m buffer permits check-in through 09:05:59;
 * 09:06:00 and later is late.
 */
export function isLateCheckIn(checkIn, shiftStart, bufferMinutes = DEFAULT_LATE_BUFFER_MINUTES) {
  if (!checkIn || !shiftStart) return false;
  const checkInSeconds = timeToSeconds(checkIn);
  const shiftSeconds = timeToSeconds(shiftStart);
  if (checkInSeconds == null || shiftSeconds == null) return false;
  const firstPenaltySecond = shiftSeconds + (normalizeLateBufferMinutes(bufferMinutes) + 1) * 60;
  return checkInSeconds >= firstPenaltySecond;
}

/** HH:MM when late buffer ends (shift start + buffer minutes). */
export function lateBufferUntil(shiftStart, bufferMinutes = DEFAULT_LATE_BUFFER_MINUTES) {
  if (!shiftStart) return DEFAULT_LATE_BUFFER_UNTIL;
  return addMinutesToTime(shiftStart, normalizeLateBufferMinutes(bufferMinutes)).slice(0, 5);
}

/** Minutes from shift start to a late-until clock (clamped 0–240). */
export function lateBufferMinutesFromUntil(shiftStart, untilClock) {
  if (!shiftStart || !untilClock) return DEFAULT_LATE_BUFFER_MINUTES;
  const mins = Math.round(minutesBetween(shiftStart, untilClock));
  if (!Number.isFinite(mins) || mins < 0) return 0;
  return Math.max(0, Math.min(240, mins));
}

/** Clamp HR/admin penalty override to whole minutes (0–480). */
export function normalizePenaltyMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return null;
  return Math.max(0, Math.min(480, Math.floor(minutes)));
}

/**
 * Effective late-check-in penalty minutes for a day.
 * Waive wins; otherwise HR override; otherwise the fixed default rule.
 */
export function resolvePenaltyMinutes(penaltyWaived = false, overrideMinutes = null) {
  if (penaltyWaived) return 0;
  const override = normalizePenaltyMinutes(overrideMinutes);
  if (override != null) return override;
  return LATE_CHECKIN_PENALTY_MINUTES;
}

/**
 * Work clock start: if late, count from check-in + effective penalty minutes.
 */
export function effectiveWorkStart(
  checkIn,
  shiftStart,
  penaltyWaived = false,
  bufferMinutes = DEFAULT_LATE_BUFFER_MINUTES,
  penaltyMinutesOverride = null
) {
  if (!checkIn) return null;
  if (isLateCheckIn(checkIn, shiftStart, bufferMinutes)) {
    const mins = resolvePenaltyMinutes(penaltyWaived, penaltyMinutesOverride);
    if (mins > 0) return addMinutesToTime(checkIn, mins);
  }
  return normalizeTime(checkIn) || checkIn;
}

export function lateCheckInPenalty(
  checkIn,
  shiftStart,
  penaltyWaived = false,
  bufferMinutes = DEFAULT_LATE_BUFFER_MINUTES,
  penaltyMinutesOverride = null
) {
  const normalizedBuffer = normalizeLateBufferMinutes(bufferMinutes);
  if (!isLateCheckIn(checkIn, shiftStart, normalizedBuffer)) {
    return { late: false, late_minutes: 0, penalty_minutes: 0, buffer_minutes: normalizedBuffer };
  }
  const late_minutes = Math.round(minutesBetween(shiftStart, checkIn) * 100) / 100;
  return {
    late: true,
    late_minutes,
    penalty_minutes: resolvePenaltyMinutes(penaltyWaived, penaltyMinutesOverride),
    buffer_minutes: normalizedBuffer,
  };
}

/** Business timezone for attendance clock times and "today". Vercel/UTC hosts must not use process local time. */
export const APP_TIMEZONE = process.env.APP_TZ || 'Asia/Kolkata';

function zonedParts(d = new Date(), timeZone = APP_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  if (map.hour === '24') map.hour = '00';
  map.hour = String(map.hour ?? '0').padStart(2, '0');
  map.minute = String(map.minute ?? '0').padStart(2, '0');
  map.second = String(map.second ?? '0').padStart(2, '0');
  map.month = String(map.month ?? '1').padStart(2, '0');
  map.day = String(map.day ?? '1').padStart(2, '0');
  return map;
}

/**
 * Calendar date YYYY-MM-DD.
 * No argument: current business date in APP_TIMEZONE (Asia/Kolkata).
 * With a Date: that Date's local calendar parts (used for date iteration).
 */
export function todayISO(d) {
  if (arguments.length === 0 || d == null) {
    const p = zonedParts(new Date());
    return `${p.year}-${p.month}-${p.day}`;
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Current business time as HH:MM:SS in APP_TIMEZONE (Asia/Kolkata) */
export function nowTime(d = new Date()) {
  const p = zonedParts(d);
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** Current business year/month in APP_TIMEZONE */
export function nowYearMonth(d = new Date()) {
  const p = zonedParts(d);
  return { year: Number(p.year), month: Number(p.month) };
}

/** Normalize free-text time to HH:MM:SS (accepts HH:MM or HH:MM:SS) */
export function normalizeTime(t) {
  if (t == null || t === '') return null;
  const p = parseTimeParts(String(t));
  if (!p) return String(t).trim();
  return `${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}:${String(p.s).padStart(2, '0')}`;
}

/**
 * Parse break duration from number (minutes, may be fractional) or "M:SS" / "H:MM:SS" string.
 * Returns fractional minutes.
 */
export function parseBreakMinutes(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Math.max(0, value);
  const str = String(value).trim();
  if (!str) return 0;
  if (/^\d+(\.\d+)?$/.test(str)) return Math.max(0, Number(str));
  const parts = str.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 2) {
    const [m, s] = parts;
    return Math.max(0, m + s / 60);
  }
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return Math.max(0, h * 60 + m + s / 60);
  }
  return 0;
}

export function datesInRange(from, to) {
  const out = [];
  const cur = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  while (cur <= end) {
    out.push(todayISO(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

export async function nextEmployeeId(Employee) {
  const year = new Date().getFullYear();
  const prefix = `EMP-${year}-`;
  const last = await Employee.findOne({ employee_id: new RegExp(`^${prefix}`) })
    .sort({ employee_id: -1 })
    .select('employee_id')
    .lean();
  let n = 1;
  if (last?.employee_id) {
    const parts = last.employee_id.split('-');
    n = (parseInt(parts[2], 10) || 0) + 1;
  }
  return `${prefix}${String(n).padStart(4, '0')}`;
}
