// Gregorian -> Jalali (Shamsi) conversion, no dependencies.
// Uses the well-known Birashk algorithm (verified against known reference dates,
// e.g. 2024-03-20 == 1403/01/01, the Nowruz epoch).

const JALALI_MONTHS = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'
];

const GREGORIAN_MONTH_OFFSETS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

function gregorianToJalaliParts(gy, gm, gd) {
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + (365 * gy) + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100)
    + Math.floor((gy2 + 399) / 400) + gd + GREGORIAN_MONTH_OFFSETS[gm - 1];

  let jy = -1595 + (33 * Math.floor(days / 12053));
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let jm, jd;
  if (days < 186) {
    jm = 1 + Math.floor(days / 31);
    jd = 1 + (days % 31);
  } else {
    jm = 7 + Math.floor((days - 186) / 30);
    jd = 1 + ((days - 186) % 30);
  }
  return { year: jy, month: jm, day: jd };
}

/**
 * Convert a JS Date (or parseable date string) to a Jalali {year, month, day} object.
 * Uses UTC components so results are stable regardless of the viewer's timezone.
 */
export function toJalali(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return gregorianToJalaliParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Format a date as a Jalali date string.
 * style "named"   -> "26 مهر 1404"
 * style "numeric" -> "1404/06/26"
 */
export function formatJalali(dateInput, style = 'named') {
  const { year, month, day } = toJalali(dateInput);
  if (style === 'numeric') {
    const pad = (n) => String(n).padStart(2, '0');
    return `${year}/${pad(month)}/${pad(day)}`;
  }
  return `${day} ${JALALI_MONTHS[month - 1]} ${year}`;
}

/**
 * Relative time (e.g. "3 hours ago").
 */
export function relativeTime(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  const units = [
    ['year', 31536000], ['month', 2592000], ['week', 604800],
    ['day', 86400], ['hour', 3600], ['minute', 60]
  ];
  for (const [name, secs] of units) {
    const val = Math.floor(sec / secs);
    if (val >= 1) return `${val} ${name}${val > 1 ? 's' : ''} ago`;
  }
  return 'just now';
}
