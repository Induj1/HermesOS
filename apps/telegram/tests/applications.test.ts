import { describe, expect, it } from 'vitest';
import {
  formatApplication,
  formatApplications,
  isAppStatus,
  parseApply,
  type Application,
} from '../src/applications.js';

describe('parseApply', () => {
  it('splits company and role on a pipe or dash', () => {
    expect(parseApply('Acme | Security Engineer')).toEqual({
      company: 'Acme',
      role: 'Security Engineer',
    });
    expect(parseApply('Acme - SDE')).toEqual({ company: 'Acme', role: 'SDE' });
    expect(parseApply('Just Company')).toEqual({ company: 'Just Company', role: '' });
  });
  it('returns undefined for blank input', () => {
    expect(parseApply('   ')).toBeUndefined();
  });
});

describe('isAppStatus', () => {
  it('accepts known statuses (case-insensitive) and rejects others', () => {
    expect(isAppStatus('applied')).toBe(true);
    expect(isAppStatus('INTERVIEW')).toBe(true);
    expect(isAppStatus('maybe')).toBe(false);
  });
});

describe('formatApplication(s)', () => {
  const app: Application = {
    id: 'app_1',
    chatId: 42,
    company: 'Acme',
    role: 'SDE',
    status: 'applied',
    atMs: 0,
  };
  it('formats one and many, and the empty case', () => {
    expect(formatApplication(app)).toBe('• app_1  [applied]  Acme — SDE');
    expect(formatApplication({ ...app, role: '' })).toBe('• app_1  [applied]  Acme');
    expect(formatApplications([])).toMatch(/No applications/);
    expect(formatApplications([app])).toContain('app_1');
  });
});
