/**
 * arXiv paper search — a research radar for the owner's fields. Pure parsing of
 * the Atom feed here; main.ts fetches. Exposed as a command and an agent tool so
 * a recurring /every task can surface fresh papers.
 */

/** A single paper from an arXiv search. */
export interface Paper {
  readonly title: string;
  readonly authors: readonly string[];
  readonly summary: string;
  readonly link: string;
  readonly published: string;
}

/** The arXiv API URL for a query, newest first. */
export function arxivUrl(query: string, limit = 5): string {
  return (
    'https://export.arxiv.org/api/query?search_query=' +
    encodeURIComponent(`all:${query}`) +
    `&sortBy=submittedDate&sortOrder=descending&max_results=${String(limit)}`
  );
}

function tag(entry: string, name: string): string[] {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(entry)) !== null) {
    out.push((m[1] ?? '').replace(/\s+/g, ' ').trim());
  }
  return out;
}

/** Parse an arXiv Atom feed into a list of papers. */
export function parseArxiv(xml: string): Paper[] {
  const entries = xml.split('<entry>').slice(1);
  return entries.map((raw) => {
    const entry = raw.split('</entry>')[0] ?? '';
    const summary = tag(entry, 'summary')[0] ?? '';
    const linkMatch = /<id>([\s\S]*?)<\/id>/.exec(entry);
    return {
      title: tag(entry, 'title')[0] ?? '(untitled)',
      authors: tag(entry, 'name'),
      summary: summary.length > 240 ? `${summary.slice(0, 237)}...` : summary,
      link: (linkMatch?.[1] ?? '').trim(),
      published: tag(entry, 'published')[0]?.slice(0, 10) ?? '',
    };
  });
}

/** A phone-friendly digest of papers for a query. */
export function formatPapers(query: string, papers: readonly Paper[]): string {
  if (papers.length === 0) return `No recent arXiv papers for "${query}".`;
  const lines = [`📚 Recent arXiv papers on "${query}":`];
  for (const p of papers) {
    const who =
      p.authors.slice(0, 3).join(', ') + (p.authors.length > 3 ? ' et al.' : '');
    lines.push(`• ${p.title} (${p.published}) — ${who}\n  ${p.link}`);
  }
  return lines.join('\n');
}
