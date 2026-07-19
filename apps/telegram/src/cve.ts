/**
 * CVE lookups against the NVD public API. Pure parsing/formatting here; main.ts
 * fetches. Used both by the /cve command and as an agent tool so a recurring
 * /every task can run a security digest.
 */

/** A single vulnerability, distilled from an NVD record. */
export interface Cve {
  readonly id: string;
  readonly summary: string;
  readonly severity: string;
  readonly score: number;
}

/** The NVD 2.0 API URL for a keyword search. */
export function nvdUrl(keyword: string, limit = 5): string {
  return (
    'https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=' +
    `${encodeURIComponent(keyword)}&resultsPerPage=${String(limit)}`
  );
}

interface NvdMetric {
  readonly cvssData?: { readonly baseScore?: number; readonly baseSeverity?: string };
  readonly baseSeverity?: string;
}

interface NvdItem {
  readonly cve?: {
    readonly id?: string;
    readonly descriptions?: readonly {
      readonly lang: string;
      readonly value: string;
    }[];
    readonly metrics?: Record<string, readonly NvdMetric[]>;
  };
}

/** Pull the highest-version CVSS metric out of an NVD record. */
function severityOf(item: NvdItem): { severity: string; score: number } {
  const metrics = item.cve?.metrics ?? {};
  for (const key of ['cvssMetricV31', 'cvssMetricV30', 'cvssMetricV2']) {
    const entry = metrics[key]?.[0];
    if (entry !== undefined) {
      return {
        severity: entry.cvssData?.baseSeverity ?? entry.baseSeverity ?? 'UNKNOWN',
        score: entry.cvssData?.baseScore ?? 0,
      };
    }
  }
  return { severity: 'UNKNOWN', score: 0 };
}

/** Parse an NVD 2.0 response body into a list of CVEs. */
export function parseNvd(body: unknown): Cve[] {
  const vulns =
    (body as { vulnerabilities?: readonly NvdItem[] }).vulnerabilities ?? [];
  return vulns.map((item) => {
    const en =
      item.cve?.descriptions?.find((d) => d.lang === 'en')?.value ??
      item.cve?.descriptions?.[0]?.value ??
      '(no description)';
    const { severity, score } = severityOf(item);
    return {
      id: item.cve?.id ?? 'CVE-????',
      summary: en.length > 220 ? `${en.slice(0, 217)}...` : en,
      severity,
      score,
    };
  });
}

/** A phone-friendly digest of CVEs for a keyword. */
export function formatCves(keyword: string, cves: readonly Cve[]): string {
  if (cves.length === 0) return `No CVEs found for "${keyword}".`;
  const lines = [`🛡 Recent CVEs for "${keyword}":`];
  for (const c of cves) {
    lines.push(`• ${c.id} [${c.severity} ${String(c.score)}] — ${c.summary}`);
  }
  return lines.join('\n');
}
