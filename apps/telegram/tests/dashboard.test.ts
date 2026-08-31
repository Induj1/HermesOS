import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../src/dashboard.js';

describe('renderDashboard', () => {
  it('renders bot, model, subjects, reminders, and features', () => {
    const html = renderDashboard({
      bot: 'indujassist_bot',
      model: 'qwen2.5-coder:32b',
      memoryCount: 12,
      subjects: ['1226592458'],
      reminders: [{ message: 'call mom', inMinutes: 29.6 }],
      features: ['agent', 'memory'],
    });
    expect(html).toContain('indujassist_bot');
    expect(html).toContain('qwen2.5-coder:32b');
    expect(html).toContain('12');
    expect(html).toContain('1226592458');
    expect(html).toContain('call mom (in 30 min)');
    expect(html).toContain('agent');
  });

  it('escapes HTML and shows "none" for empty lists', () => {
    const html = renderDashboard({
      bot: '<x>',
      model: 'm',
      memoryCount: 0,
      subjects: [],
      reminders: [],
      features: [],
    });
    expect(html).toContain('&lt;x&gt;');
    expect(html).toContain('none');
  });
});
