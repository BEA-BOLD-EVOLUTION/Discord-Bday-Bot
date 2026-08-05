import { CronExpressionParser } from 'cron-parser';

// Returns the next ISO timestamp the given cron expression will fire at, or
// null if the expression cannot be parsed. `tz` should be an IANA timezone.
export function nextRunAt(expr, tz) {
  try {
    const it = CronExpressionParser.parse(expr, tz ? { tz } : undefined);
    return it.next().toDate().toISOString();
  } catch {
    return null;
  }
}
