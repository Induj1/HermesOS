import { describe, expect, it } from 'vitest';
import { buildCareerPrompt } from '../src/career.js';

describe('buildCareerPrompt', () => {
  it('grounds every task in the owner profile / résumé', () => {
    for (const task of ['coverletter', 'tailor', 'interview'] as const) {
      expect(buildCareerPrompt(task, 'x')).toContain('source of truth');
    }
  });

  it('builds a cover-letter prompt embedding the job text', () => {
    const p = buildCareerPrompt('coverletter', 'Senior Security Engineer at Acme');
    expect(p).toContain('cover letter');
    expect(p).toContain('Senior Security Engineer at Acme');
  });

  it('builds a tailoring prompt embedding the JD', () => {
    const p = buildCareerPrompt('tailor', 'React + Node role');
    expect(p).toMatch(/tailor my résumé/i);
    expect(p).toContain('React + Node role');
  });

  it('defaults the interview target when no input is given', () => {
    expect(buildCareerPrompt('interview', '')).toContain(
      'roles that match my background',
    );
    expect(buildCareerPrompt('interview', 'SDE at Google')).toContain('SDE at Google');
  });
});
