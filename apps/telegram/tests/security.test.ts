import { describe, expect, it } from 'vitest';
import { analyzeSecurityHeaders, formatSecurityReport } from '../src/security.js';

describe('analyzeSecurityHeaders', () => {
  it('grades a fully-hardened response as A', () => {
    const report = analyzeSecurityHeaders({
      'Strict-Transport-Security': 'max-age=63072000',
      'Content-Security-Policy': "default-src 'self'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'geolocation=()',
    });
    expect(report.grade).toBe('A');
    expect(report.score).toBe(1);
    expect(report.findings.every((f) => f.present)).toBe(true);
  });

  it('flags missing headers and info disclosure', () => {
    const report = analyzeSecurityHeaders({
      Server: 'nginx/1.18.0',
      'X-Powered-By': 'Express',
    });
    expect(report.grade).toBe('F');
    expect(
      report.findings.some((f) => f.header === 'content-security-policy' && !f.present),
    ).toBe(true);
    expect(report.disclosures.length).toBe(2);
  });

  it('formats a phone-friendly report', () => {
    const text = formatSecurityReport(
      'https://x.test',
      analyzeSecurityHeaders({ 'x-frame-options': 'DENY' }),
    );
    expect(text).toContain('https://x.test');
    expect(text).toContain('✅ x-frame-options');
    expect(text).toContain('❌ content-security-policy');
  });
});
