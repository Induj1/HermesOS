/**
 * Recurring agent tasks: let the user say "every weekday at 9am, summarise my
 * repo's new issues" and have the bot run the agent on that schedule and message
 * back the result.
 *
 * This module is the pure part: parsing a friendly schedule into a cron
 * expression (in the user's LOCAL time) plus the task text, and converting a
 * local-time cron to the UTC cron the scheduler evaluates against. main.ts owns
 * persistence, arming, and running the agent.
 */

/** A parsed recurring task before it is armed. `cron` is in LOCAL time. */
export interface ParsedSchedule {
  readonly cron: string;
  readonly task: string;
}

/** A persisted recurring agent task. `cron` is stored in LOCAL time. */
export interface ScheduledTask {
  readonly id: string;
  readonly chatId: number;
  readonly cron: string;
  readonly prompt: string;
}

/** Parse `HH`, `H:MM`, `9am`, `9:30pm`, or `14:00` into 24h fields. */
function parseTime(token: string): { hour: number; minute: number } | undefined {
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/i.exec(token);
  if (m === null) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const ap = m[3]?.toLowerCase();
  if (minute > 59) return undefined;
  if (ap === 'pm' && hour < 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  if (hour > 23) return undefined;
  return { hour, minute };
}

/** Day-of-week cron field for each friendly recurrence keyword. */
function dowFor(keyword: string): string {
  const k = keyword.toLowerCase();
  if (k.startsWith('weekday') || k === 'every weekday') return '1-5';
  if (k.startsWith('weekend')) return '0,6';
  return '*'; // daily / every day
}

/**
 * Parse a `/every` argument into a local-time cron plus the task. Accepts a raw
 * 5-field cron (`30 9 * * 1-5 do the thing`), `hourly <task>`, or
 * `daily|weekdays|weekends [at] <time> <task>`. Returns undefined if malformed.
 */
export function parseSchedule(input: string): ParsedSchedule | undefined {
  const s = input.trim().replace(/\s+/g, ' ');
  if (s === '') return undefined;

  // Raw 5-field cron followed by the task.
  const cron = /^([\d*,/-]+ [\d*,/-]+ [\d*,/-]+ [\d*,/-]+ [\d*,/-]+) (.+)$/.exec(s);
  if (cron?.[1] !== undefined && cron[2] !== undefined) {
    return { cron: cron[1], task: cron[2].trim() };
  }

  const hourly = /^hourly (.+)$/i.exec(s);
  if (hourly?.[1] !== undefined) {
    return { cron: '0 * * * *', task: hourly[1].trim() };
  }

  const friendly =
    /^(daily|every day|weekdays?|every weekday|weekends?) (?:at )?(\S+) (.+)$/i.exec(s);
  if (
    friendly?.[1] !== undefined &&
    friendly[2] !== undefined &&
    friendly[3] !== undefined
  ) {
    const time = parseTime(friendly[2]);
    if (time === undefined) return undefined;
    return {
      cron: `${String(time.minute)} ${String(time.hour)} * * ${dowFor(friendly[1])}`,
      task: friendly[3].trim(),
    };
  }
  return undefined;
}

/** Shift a comma/range day-of-week field by whole days, wrapping 0–6. */
function shiftDow(field: string, days: number): string {
  if (field === '*' || days === 0) return field;
  const wrap = (n: number): number => (((n + days) % 7) + 7) % 7;
  return field
    .split(',')
    .map((part) => {
      const range = /^(\d)-(\d)$/.exec(part);
      if (range?.[1] !== undefined && range[2] !== undefined) {
        return `${String(wrap(Number(range[1])))}-${String(wrap(Number(range[2])))}`;
      }
      return /^\d$/.test(part) ? String(wrap(Number(part))) : part;
    })
    .join(',');
}

/**
 * Convert a local-time cron to the UTC cron the scheduler needs, given the local
 * offset in minutes (as from `Date.prototype.getTimezoneOffset()`: negative for
 * zones ahead of UTC). Only shifts when the minute and hour are plain integers;
 * otherwise (e.g. `0 * * * *`) it is returned unchanged.
 */
export function localCronToUtc(cron: string, offsetMinutes: number): string {
  const parts = cron.split(' ');
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return cron;

  const localTotal = Number(hour) * 60 + Number(min);
  const utcTotal = localTotal + offsetMinutes;
  const dayShift = Math.floor(utcTotal / 1440);
  const norm = ((utcTotal % 1440) + 1440) % 1440;
  const utcHour = Math.floor(norm / 60);
  const utcMin = norm % 60;
  return `${String(utcMin)} ${String(utcHour)} ${dom} ${mon} ${shiftDow(dow, dayShift)}`;
}

/** A one-line human summary of a scheduled task, for `/schedules`. */
export function formatSchedule(task: ScheduledTask): string {
  return `• ${task.id} — [${task.cron}] ${task.prompt}`;
}
