/**
 * Scheduled messages the bot pushes on its own: a morning briefing and a CI
 * watcher. These are the pure, testable pieces — how a briefing or an alert is
 * worded. main.ts owns the network fetches (weather, Hacker News, GitHub) and
 * drives a `@hermes/scheduler` Scheduler that decides *when* they fire.
 */

export interface WeatherSummary {
  readonly tempNow: number;
  readonly tempMax: number;
  readonly tempMin: number;
}

export interface Briefing {
  readonly city: string;
  readonly date: string;
  readonly weather: WeatherSummary;
  readonly headlines: readonly string[];
}

/** Render a morning briefing as a phone-friendly message. */
export function formatBriefing(briefing: Briefing): string {
  const { weather } = briefing;
  const lines = [
    `☀️ Good morning! Briefing for ${briefing.date}`,
    '',
    `📍 ${briefing.city}: ${String(Math.round(weather.tempNow))}°C now, ` +
      `${String(Math.round(weather.tempMin))}–${String(Math.round(weather.tempMax))}°C today`,
    '',
    '📰 Top stories:',
    ...briefing.headlines.map((headline, index) => `${String(index + 1)}. ${headline}`),
  ];
  return lines.join('\n');
}

export interface CiStatus {
  readonly repo: string;
  readonly branch: string;
  readonly conclusion: string | null;
  readonly url: string;
}

/** A run conclusion counts as "needs attention" for the CI watcher. */
export function isCiFailing(conclusion: string | null): boolean {
  return (
    conclusion === 'failure' ||
    conclusion === 'timed_out' ||
    conclusion === 'startup_failure'
  );
}

/** Render a CI-failure alert. */
export function formatCiAlert(status: CiStatus): string {
  return [
    `🔴 CI is failing on ${status.repo} (${status.branch})`,
    `Latest run: ${status.conclusion ?? 'unknown'}`,
    status.url,
  ].join('\n');
}
