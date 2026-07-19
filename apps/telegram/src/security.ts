/**
 * A defensive security audit of a URL's HTTP response headers — the read-only,
 * always-safe kind of check. Pure analysis here (given the headers, grade the
 * posture); main.ts does the fetch.
 */

/** One security-header check. */
export interface HeaderFinding {
  readonly header: string;
  readonly present: boolean;
  readonly note: string;
}

/** The result of grading a response's headers. */
export interface SecurityReport {
  readonly findings: readonly HeaderFinding[];
  readonly disclosures: readonly string[];
  readonly score: number;
  readonly grade: string;
}

const EXPECTED: readonly { header: string; note: string }[] = [
  { header: 'strict-transport-security', note: 'enforce HTTPS (HSTS)' },
  { header: 'content-security-policy', note: 'restrict sources (CSP)' },
  { header: 'x-frame-options', note: 'prevent clickjacking' },
  { header: 'x-content-type-options', note: 'stop MIME sniffing (nosniff)' },
  { header: 'referrer-policy', note: 'limit referrer leakage' },
  { header: 'permissions-policy', note: 'restrict browser features' },
];

/** Headers that leak stack/version info and are better removed. */
const DISCLOSING = ['server', 'x-powered-by', 'x-aspnet-version', 'x-generator'];

function grade(score: number): string {
  if (score >= 0.9) return 'A';
  if (score >= 0.75) return 'B';
  if (score >= 0.5) return 'C';
  if (score >= 0.25) return 'D';
  return 'F';
}

/** Grade a response's security headers. Keys are matched case-insensitively. */
export function analyzeSecurityHeaders(
  headers: Record<string, string>,
): SecurityReport {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;

  const findings = EXPECTED.map(({ header, note }) => ({
    header,
    present: lower[header] !== undefined && lower[header] !== '',
    note,
  }));
  const disclosures = DISCLOSING.flatMap((h) => {
    const value = lower[h];
    return value === undefined || value === '' ? [] : [`${h}: ${value}`];
  });

  const present = findings.filter((f) => f.present).length;
  const score = present / findings.length;
  return { findings, disclosures, score, grade: grade(score) };
}

/** Pull the first URL (or bare domain) out of free text, e.g. a /scan message. */
export function extractUrl(text: string): string | undefined {
  const withScheme = /https?:\/\/[^\s)<>"']+/i.exec(text);
  if (withScheme !== null) return withScheme[0];
  const bare = /(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s)<>"']*)?/i.exec(text);
  return bare?.[0];
}

/** A phone-friendly summary of a security report for a URL. */
export function formatSecurityReport(url: string, report: SecurityReport): string {
  const lines = [`🔒 Security headers for ${url} — grade ${report.grade}`];
  for (const f of report.findings) {
    lines.push(`${f.present ? '✅' : '❌'} ${f.header} — ${f.note}`);
  }
  if (report.disclosures.length > 0) {
    lines.push(`⚠️ Info disclosure: ${report.disclosures.join('; ')}`);
  }
  return lines.join('\n');
}
