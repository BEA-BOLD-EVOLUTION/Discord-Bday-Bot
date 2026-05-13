// Single source of truth for the four announcement regions.
//
// Each region fires at ~10am local time in its primary timezone. Cron
// expressions are written in UTC (the scheduler explicitly passes
// timezone: 'UTC') so daylight-saving shifts cause at most a 1-hour
// drift, which is acceptable for a birthday shoutout.
//
//   americas       15:00 UTC  →  10am EST / 11am EDT
//   europe_africa  10:00 UTC  →  10am GMT / 11am BST
//   south_asia     04:30 UTC  →  10am IST
//   east_asia      02:00 UTC  →  10am CST China / SGT

export const REGIONS = [
  {
    id: 'americas',
    label: 'Americas',
    emoji: '🌎',
    description: 'US, Canada, Latin America (~10am EST/EDT)',
    cron: '0 15 * * *',
    anchorTz: 'America/New_York',
  },
  {
    id: 'europe_africa',
    label: 'Europe & Africa',
    emoji: '🌍',
    description: 'UK, Europe, Africa (~10am GMT/BST)',
    cron: '0 10 * * *',
    anchorTz: 'Europe/London',
  },
  {
    id: 'south_asia',
    label: 'South Asia',
    emoji: '🌏',
    description: 'India and neighbors (10am IST)',
    cron: '30 4 * * *',
    anchorTz: 'Asia/Kolkata',
  },
  {
    id: 'east_asia',
    label: 'East Asia',
    emoji: '🌏',
    description: 'China, SE Asia, Singapore (10am local)',
    cron: '0 2 * * *',
    anchorTz: 'Asia/Singapore',
  },
];

export const REGION_BY_ID = Object.fromEntries(REGIONS.map((r) => [r.id, r]));

export function isValidRegion(id) {
  return Object.prototype.hasOwnProperty.call(REGION_BY_ID, id);
}

export function regionLabel(id) {
  const r = REGION_BY_ID[id];
  return r ? `${r.emoji} ${r.label}` : id;
}

// Map Discord interaction.locale -> region id. Defaults to 'americas' when
// the locale is unknown or absent. See:
// https://discord.com/developers/docs/reference#locales
const LOCALE_TO_REGION = {
  // Americas
  'en-US': 'americas',
  'es-419': 'americas',
  'es-ES': 'europe_africa', // Spain is in Europe; matches business hours
  'pt-BR': 'americas',
  // Europe & Africa
  'en-GB': 'europe_africa',
  de: 'europe_africa',
  fr: 'europe_africa',
  it: 'europe_africa',
  nl: 'europe_africa',
  pl: 'europe_africa',
  sv: 'europe_africa',
  'sv-SE': 'europe_africa',
  da: 'europe_africa',
  no: 'europe_africa',
  fi: 'europe_africa',
  cs: 'europe_africa',
  hu: 'europe_africa',
  ro: 'europe_africa',
  bg: 'europe_africa',
  uk: 'europe_africa',
  el: 'europe_africa',
  ru: 'europe_africa',
  tr: 'europe_africa',
  hr: 'europe_africa',
  lt: 'europe_africa',
  ar: 'europe_africa',
  he: 'europe_africa',
  // South Asia
  hi: 'south_asia',
  // East Asia / SE Asia
  ja: 'east_asia',
  ko: 'east_asia',
  'zh-CN': 'east_asia',
  'zh-TW': 'east_asia',
  th: 'east_asia',
  vi: 'east_asia',
  id: 'east_asia',
};

export function regionFromLocale(locale) {
  if (!locale) return 'americas';
  if (LOCALE_TO_REGION[locale]) return LOCALE_TO_REGION[locale];
  // Fall back on the language part (e.g. "en-AU" -> "en")
  const lang = String(locale).split('-')[0];
  if (LOCALE_TO_REGION[lang]) return LOCALE_TO_REGION[lang];
  return 'americas';
}
