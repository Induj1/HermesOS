/**
 * A standard 5-field cron parser and next-time computation — pure, UTC, and
 * deterministic.
 *
 * Fields: `minute hour day-of-month month day-of-week`. Each supports `*`, a value
 * (`5`), a range (`1-5`), a step (star-slash-15, or `1-30/2`), and a list of those
 * (`1,15,30`). Day-of-week is `0-6` with `0` = Sunday (and `7` accepted too).
 *
 * ## Two decisions worth stating
 *
 * - **UTC, always.** Timezone-aware scheduling means DST, which means "02:30 ran
 *   twice / never ran" bugs that are a nightmare to reason about. The scheduler
 *   computes in UTC and a caller who wants a local time converts at the edge. This
 *   keeps `nextAfter` a pure function of two numbers.
 * - **Vixie day-of-month/day-of-week OR-semantics.** When *both* the day-of-month
 *   and day-of-week fields are restricted, a time matches if it satisfies
 *   *either* — this is the historical cron behaviour (`0 0 1 * 1` = "on the 1st and
 *   on Mondays"), surprising but correct, so it is implemented deliberately rather
 *   than as an AND that would silently drop runs.
 */

export interface Cron {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** Whether day-of-month / day-of-week were restricted (not `*`), for OR-semantics. */
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

/** Parse a 5-field cron expression, or throw on a malformed one. */
export function parseCron(expression: string): Cron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron expression must have 5 fields, got ${String(fields.length)}: "${expression}"`,
    );
  }
  const [minute, hour, dom, month, dow] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    daysOfMonth: parseField(dom, 1, 31),
    months: parseField(month, 1, 12),
    daysOfWeek: normaliseDow(parseField(dow, 0, 7)),
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  };
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr === undefined ? 1 : toInt(stepStr, `step in "${field}"`);
    if (step < 1) throw new Error(`cron step must be >= 1 in "${field}"`);

    let lo: number;
    let hi: number;
    if (range === '*' || range === undefined || range === '') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = toInt(a ?? '', `range in "${field}"`);
      hi = toInt(b ?? '', `range in "${field}"`);
    } else {
      lo = toInt(range, `value in "${field}"`);
      hi = lo;
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(
        `cron field "${field}" out of range ${String(min)}-${String(max)}`,
      );
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

function toInt(text: string, what: string): number {
  if (!/^\d+$/.test(text)) throw new Error(`invalid ${what}: "${text}"`);
  return Number(text);
}

/** Collapse `7` to `0` (both mean Sunday). */
function normaliseDow(values: Set<number>): Set<number> {
  if (values.has(7)) {
    values.delete(7);
    values.add(0);
  }
  return values;
}

/**
 * The next time (epoch ms, at a minute boundary) strictly after `afterMs` that
 * matches the cron. Throws if none is found within four years (an impossible
 * expression like Feb 30).
 */
export function nextAfter(cron: Cron, afterMs: number): number {
  // Start at the next whole minute after `afterMs`.
  let t = Math.floor(afterMs / 60000) * 60000 + 60000;
  const limit = afterMs + 4 * 366 * 24 * 60 * 60 * 1000;

  while (t <= limit) {
    const d = new Date(t);
    const month = d.getUTCMonth() + 1;
    if (!cron.months.has(month)) {
      t = startOfNextMonth(d);
      continue;
    }
    if (!dayMatches(cron, d)) {
      t = startOfNextDay(d);
      continue;
    }
    if (!cron.hours.has(d.getUTCHours())) {
      t = startOfNextHour(d);
      continue;
    }
    if (!cron.minutes.has(d.getUTCMinutes())) {
      t += 60000;
      continue;
    }
    return t;
  }
  throw new Error('cron expression has no matching time within four years');
}

function dayMatches(cron: Cron, d: Date): boolean {
  const dom = cron.daysOfMonth.has(d.getUTCDate());
  const dow = cron.daysOfWeek.has(d.getUTCDay());
  // Vixie semantics: both restricted → OR; otherwise the restricted one decides.
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  if (cron.domRestricted) return dom;
  if (cron.dowRestricted) return dow;
  return true;
}

function startOfNextHour(d: Date): number {
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours() + 1,
    0,
    0,
    0,
  );
}

function startOfNextDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

function startOfNextMonth(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0, 0);
}
