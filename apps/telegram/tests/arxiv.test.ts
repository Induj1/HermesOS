import { describe, expect, it } from 'vitest';
import { arxivUrl, formatPapers, parseArxiv } from '../src/arxiv.js';

const FEED = `<?xml version="1.0"?>
<feed>
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <title>Quantum RL at the Edge</title>
    <summary>  We study   quantum reinforcement learning. </summary>
    <published>2024-01-02T00:00:00Z</published>
    <author><name>Induj Gupta</name></author>
    <author><name>A Coauthor</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00002v1</id>
    <title>Second Paper</title>
    <summary>Another abstract.</summary>
    <published>2024-01-01T00:00:00Z</published>
    <author><name>Someone</name></author>
  </entry>
</feed>`;

describe('arxivUrl', () => {
  it('builds a newest-first query URL', () => {
    const url = arxivUrl('quantum edge', 5);
    expect(url).toContain('search_query=all%3Aquantum%20edge');
    expect(url).toContain('sortBy=submittedDate');
    expect(url).toContain('max_results=5');
  });
});

describe('parseArxiv', () => {
  it('parses entries into papers', () => {
    const papers = parseArxiv(FEED);
    expect(papers).toHaveLength(2);
    expect(papers[0]).toMatchObject({
      title: 'Quantum RL at the Edge',
      authors: ['Induj Gupta', 'A Coauthor'],
      link: 'http://arxiv.org/abs/2401.00001v1',
      published: '2024-01-02',
    });
    expect(papers[0]?.summary).toBe('We study quantum reinforcement learning.');
  });

  it('returns nothing for a feed with no entries', () => {
    expect(parseArxiv('<feed></feed>')).toEqual([]);
  });

  it('handles long summaries, missing fields, and >3 authors', () => {
    const long = 'z'.repeat(300);
    const entry =
      `<entry><summary>${long}</summary>` +
      '<author><name>A</name></author><author><name>B</name></author>' +
      '<author><name>C</name></author><author><name>D</name></author></entry>';
    const [p] = parseArxiv(`<feed>${entry}</feed>`);
    expect(p?.title).toBe('(untitled)'); // missing <title>
    expect(p?.link).toBe(''); // missing <id>
    expect(p?.published).toBe(''); // missing <published>
    expect(p?.summary.endsWith('...')).toBe(true); // truncated
    expect(formatPapers('q', p === undefined ? [] : [p])).toContain('et al.'); // >3 authors
  });
});

describe('formatPapers', () => {
  it('summarises and reports none', () => {
    expect(formatPapers('x', [])).toMatch(/No recent arXiv/);
    expect(formatPapers('quantum', parseArxiv(FEED))).toContain(
      'Quantum RL at the Edge',
    );
  });
});
