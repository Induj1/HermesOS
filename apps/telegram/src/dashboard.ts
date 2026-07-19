/**
 * A tiny local dashboard — a read-only status page for the bot, served on
 * 127.0.0.1. Shows what it knows and has queued. `renderDashboard` is pure and
 * tested; main.ts wires an http server that gathers live data and serves it.
 */

export interface DashboardData {
  readonly bot: string;
  readonly model: string;
  readonly memoryCount: number;
  readonly subjects: readonly string[];
  readonly reminders: readonly {
    readonly message: string;
    readonly inMinutes: number;
  }[];
  readonly features: readonly string[];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render the dashboard as a self-contained HTML page. */
export function renderDashboard(data: DashboardData): string {
  const li = (items: readonly string[]): string =>
    items.length === 0
      ? '<li class="empty">none</li>'
      : items.map((i) => `<li>${escapeHtml(i)}</li>`).join('');

  const reminders = data.reminders.map(
    (r) => `${r.message} (in ${String(Math.max(0, Math.round(r.inMinutes)))} min)`,
  );

  return `<!doctype html><html><head><meta charset="utf-8">
<title>Hermes — ${escapeHtml(data.bot)}</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;
    background:#0f1115;color:#e6e6e6}
  h1{font-size:1.4rem} h2{font-size:1rem;color:#9ab;margin-top:1.5rem}
  .card{background:#171a21;border:1px solid #262b36;border-radius:10px;padding:1rem 1.25rem;margin:.75rem 0}
  ul{margin:.25rem 0;padding-left:1.2rem} li{margin:.15rem 0}
  .empty{color:#667;list-style:none;margin-left:-1.2rem}
  .badge{display:inline-block;background:#1f6feb22;color:#79c0ff;border-radius:6px;padding:.1rem .5rem;margin:.15rem;font-size:.85rem}
</style></head><body>
<h1>🤖 Hermes — ${escapeHtml(data.bot)}</h1>
<div class="card">Model: <b>${escapeHtml(data.model)}</b> · Memories: <b>${String(data.memoryCount)}</b></div>
<h2>Chats with memory</h2><div class="card"><ul>${li(data.subjects)}</ul></div>
<h2>Pending reminders</h2><div class="card"><ul>${li(reminders)}</ul></div>
<h2>Features</h2><div class="card">${data.features.map((f) => `<span class="badge">${escapeHtml(f)}</span>`).join('')}</div>
</body></html>`;
}
