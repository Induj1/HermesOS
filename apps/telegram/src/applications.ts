/**
 * A lightweight job-application tracker: log where you applied, update status,
 * and get an automatic follow-up nudge. Pure parsing/formatting here; main.ts
 * persists the list and schedules the follow-up reminder.
 */

/** The lifecycle of an application. */
export const APP_STATUSES = [
  'applied',
  'screening',
  'interview',
  'offer',
  'rejected',
  'ghosted',
] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

/** A tracked application. */
export interface Application {
  readonly id: string;
  readonly chatId: number;
  readonly company: string;
  readonly role: string;
  status: AppStatus;
  readonly atMs: number;
}

/** Parse `Company | Role` (or `Company - Role`, or just `Company`) into parts. */
export function parseApply(
  input: string,
): { company: string; role: string } | undefined {
  const s = input.trim();
  if (s === '') return undefined;
  const sep = s.includes('|') ? '|' : s.includes(' - ') ? ' - ' : '';
  if (sep === '') return { company: s, role: '' };
  const [company, ...rest] = s.split(sep);
  return { company: (company ?? '').trim(), role: rest.join(sep).trim() };
}

/** Whether a string is a valid application status. */
export function isAppStatus(value: string): value is AppStatus {
  return (APP_STATUSES as readonly string[]).includes(value.toLowerCase());
}

/** A one-line summary of one application. */
export function formatApplication(app: Application): string {
  const role = app.role === '' ? '' : ` — ${app.role}`;
  return `• ${app.id}  [${app.status}]  ${app.company}${role}`;
}

/** A phone-friendly list of a chat's applications. */
export function formatApplications(apps: readonly Application[]): string {
  if (apps.length === 0) return 'No applications tracked yet. Add one with /apply.';
  return ['📋 Your applications:', ...apps.map(formatApplication)].join('\n');
}
