/**
 * Reminders: `/remind 30m call mom` schedules a one-off DM.
 *
 * The pure pieces — parsing a duration and wording the acknowledgement — live
 * here and are tested. main.ts owns persistence (a JSON file) and the Scheduler
 * integration that actually fires the reminder.
 */

export interface Reminder {
  readonly id: string;
  readonly chatId: number;
  readonly atMs: number;
  readonly message: string;
}

const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse a duration like `30m`, `2h`, `90s`, `1d` into milliseconds. */
export function parseDuration(token: string): number | undefined {
  const match = /^(\d+)\s*(s|m|h|d)$/i.exec(token.trim());
  if (match === null) return undefined;
  const unit = UNIT_MS[(match[2] ?? '').toLowerCase()];
  if (unit === undefined) return undefined;
  return Number(match[1]) * unit;
}

/** Parse `<duration> <message>` (e.g. "30m call mom"). */
export function parseReminder(
  text: string,
): { ms: number; message: string } | undefined {
  const trimmed = text.trim();
  const space = trimmed.indexOf(' ');
  if (space === -1) return undefined;
  const ms = parseDuration(trimmed.slice(0, space));
  const message = trimmed.slice(space + 1).trim();
  if (ms === undefined || message === '') return undefined;
  return { ms, message };
}

/** A short human duration for the acknowledgement. */
export function humanDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  return `${String(Math.round(hours / 24))}d`;
}
