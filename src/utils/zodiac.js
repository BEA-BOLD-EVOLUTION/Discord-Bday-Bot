// Western (tropical) zodiac. Sign is fully derived from month + day, so no
// schema changes are needed — we can compute it everywhere we already have a
// birthday row.
//
// Date ranges follow the conventional astrological boundaries used by most
// English-language sources. Feb 29 falls in Pisces (Feb 19 – Mar 20).

const SIGNS = [
  { id: 'capricorn',   name: 'Capricorn',   emoji: '♑', element: 'Earth', start: [12, 22], end: [1, 19] },
  { id: 'aquarius',    name: 'Aquarius',    emoji: '♒', element: 'Air',   start: [1, 20],  end: [2, 18] },
  { id: 'pisces',      name: 'Pisces',      emoji: '♓', element: 'Water', start: [2, 19],  end: [3, 20] },
  { id: 'aries',       name: 'Aries',       emoji: '♈', element: 'Fire',  start: [3, 21],  end: [4, 19] },
  { id: 'taurus',      name: 'Taurus',      emoji: '♉', element: 'Earth', start: [4, 20],  end: [5, 20] },
  { id: 'gemini',      name: 'Gemini',      emoji: '♊', element: 'Air',   start: [5, 21],  end: [6, 20] },
  { id: 'cancer',      name: 'Cancer',      emoji: '♋', element: 'Water', start: [6, 21],  end: [7, 22] },
  { id: 'leo',         name: 'Leo',         emoji: '♌', element: 'Fire',  start: [7, 23],  end: [8, 22] },
  { id: 'virgo',       name: 'Virgo',       emoji: '♍', element: 'Earth', start: [8, 23],  end: [9, 22] },
  { id: 'libra',       name: 'Libra',       emoji: '♎', element: 'Air',   start: [9, 23],  end: [10, 22] },
  { id: 'scorpio',     name: 'Scorpio',     emoji: '♏', element: 'Water', start: [10, 23], end: [11, 21] },
  { id: 'sagittarius', name: 'Sagittarius', emoji: '♐', element: 'Fire',  start: [11, 22], end: [12, 21] },
];

/**
 * @param {number} month 1-12
 * @param {number} day 1-31
 * @returns {{id:string,name:string,emoji:string,element:string}|null}
 */
export function zodiacFor(month, day) {
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  for (const s of SIGNS) {
    const [sm, sd] = s.start;
    const [em, ed] = s.end;
    // Range may wrap year-end (Capricorn).
    if (sm <= em) {
      if ((m === sm && d >= sd) || (m === em && d <= ed) || (m > sm && m < em)) return s;
    } else {
      if ((m === sm && d >= sd) || (m === em && d <= ed) || m > sm || m < em) return s;
    }
  }
  return null;
}

/** "♒ Aquarius" — for inline use next to a name or date. */
export function formatZodiac(month, day) {
  const z = zodiacFor(month, day);
  return z ? `${z.emoji} ${z.name}` : '';
}
