import { describe, expect, it } from 'vitest';
import { formatCves, nvdUrl, parseNvd } from '../src/cve.js';

describe('nvdUrl', () => {
  it('builds an NVD search URL with an encoded keyword', () => {
    expect(nvdUrl('log4j', 3)).toBe(
      'https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=log4j&resultsPerPage=3',
    );
    expect(nvdUrl('a b')).toContain('keywordSearch=a%20b');
  });
});

describe('parseNvd', () => {
  it('distils id, description, and severity', () => {
    const cves = parseNvd({
      vulnerabilities: [
        {
          cve: {
            id: 'CVE-2021-44228',
            descriptions: [
              { lang: 'es', value: 'ignored' },
              { lang: 'en', value: 'Log4j RCE' },
            ],
            metrics: {
              cvssMetricV31: [
                { cvssData: { baseScore: 10, baseSeverity: 'CRITICAL' } },
              ],
            },
          },
        },
      ],
    });
    expect(cves).toEqual([
      { id: 'CVE-2021-44228', summary: 'Log4j RCE', severity: 'CRITICAL', score: 10 },
    ]);
  });

  it('tolerates missing fields and an empty response', () => {
    expect(parseNvd({})).toEqual([]);
    const [cve] = parseNvd({ vulnerabilities: [{ cve: { id: 'CVE-1' } }] });
    expect(cve?.severity).toBe('UNKNOWN');
    expect(cve?.summary).toBe('(no description)');
  });

  it('reads V2 metrics, a non-English fallback, and truncates long text', () => {
    const [cve] = parseNvd({
      vulnerabilities: [
        {
          cve: {
            id: 'CVE-2',
            descriptions: [{ lang: 'fr', value: 'x'.repeat(300) }],
            metrics: { cvssMetricV2: [{ baseSeverity: 'MEDIUM' }] },
          },
        },
      ],
    });
    expect(cve?.severity).toBe('MEDIUM');
    expect(cve?.summary.endsWith('...')).toBe(true); // truncated
    expect(cve?.summary.startsWith('x')).toBe(true); // fell back to first description
  });
});

describe('formatCves', () => {
  it('summarises hits and reports none found', () => {
    expect(formatCves('x', [])).toMatch(/No CVEs/);
    const text = formatCves('log4j', [
      { id: 'CVE-1', summary: 'boom', severity: 'HIGH', score: 8 },
    ]);
    expect(text).toContain('CVE-1');
    expect(text).toContain('HIGH');
  });
});
