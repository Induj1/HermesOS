/**
 * The tool set the agent is offered — assembled over injected ports so the whole
 * thing is testable with in-memory fakes and no disk, network, or process.
 *
 * `main.ts` supplies the real ports: a `NodeFileSystem` rooted at the workspace,
 * a `guarded` HTTP client, and (opt-in) an allowlisted shell executor. A test
 * supplies `MemoryFileSystem` / `FakeHttpClient` / `FakeShellExecutor`.
 */

import { defineTool, s, type HermesTool } from '@hermes/tools';
import { filesystemTools } from '@hermes/tools-fs';
import type { FileSystem } from '@hermes/tools-fs';
import { httpTools } from '@hermes/tools-http';
import type { HttpClient } from '@hermes/tools-http';
import { shellTools } from '@hermes/tools-shell';
import type { ShellExecutor } from '@hermes/tools-shell';
import { browserTools, type BrowsePort } from './browser.js';
import { diagramTools, type DiagramRenderPort } from './diagram.js';
import { docTools, type RenderPdfPort } from './doc.js';
import { githubTools } from './github.js';
import { ocrTools, type OcrRunPort } from './ocr.js';
import { pythonTools, type PythonRunPort } from './python.js';
import { searchTools } from './search.js';
import { translateTools, type TranslatePort } from './translate.js';

export interface ToolDeps {
  readonly fs: FileSystem;
  readonly http: HttpClient;
  /** When present, shell tools are included. Omitted disables them entirely. */
  readonly shell?: ShellExecutor;
  /** When present, a web.browse tool (headless browser) is included. */
  readonly browse?: BrowsePort;
  /** When present, a doc.pdf tool (HTML → PDF) is included. */
  readonly renderPdf?: RenderPdfPort;
  /** When set, GitHub tools (repo/issues/createIssue) are included. */
  readonly githubToken?: string;
  /** When present, a python.run tool (data analysis + charts) is included. */
  readonly pythonRun?: PythonRunPort;
  /** When present, an image.ocr tool (read text from an image) is included. */
  readonly ocrRun?: OcrRunPort;
  /** When present, a text.translate tool is included. */
  readonly translate?: TranslatePort;
  /** When present, a diagram.render tool (Mermaid → PNG) is included. */
  readonly renderDiagram?: DiagramRenderPort;
  /** When present, a security.cve tool (NVD lookup) is included. */
  readonly cveSearch?: (keyword: string) => Promise<string>;
  /** When present, a research.arxiv tool (paper search) is included. */
  readonly arxivSearch?: (query: string) => Promise<string>;
}

/** Build the agent's tools over the given ports. Filesystem and HTTP always;
 *  shell only when an executor is supplied. */
export function buildTools(deps: ToolDeps): readonly HermesTool[] {
  const tools: HermesTool[] = [
    ...filesystemTools(deps.fs),
    ...httpTools(deps.http),
    ...searchTools(deps.http),
  ];
  if (deps.shell !== undefined) tools.push(...shellTools(deps.shell));
  if (deps.browse !== undefined) tools.push(...browserTools(deps.browse));
  if (deps.renderPdf !== undefined) tools.push(...docTools(deps.renderPdf));
  if (deps.githubToken !== undefined && deps.githubToken !== '') {
    tools.push(...githubTools(deps.http, deps.githubToken));
  }
  if (deps.pythonRun !== undefined) tools.push(...pythonTools(deps.pythonRun));
  if (deps.ocrRun !== undefined) tools.push(...ocrTools(deps.ocrRun));
  if (deps.translate !== undefined) tools.push(...translateTools(deps.translate));
  if (deps.renderDiagram !== undefined) {
    tools.push(...diagramTools(deps.renderDiagram));
  }
  if (deps.cveSearch !== undefined) {
    const search = deps.cveSearch;
    tools.push(
      defineTool({
        name: 'security.cve',
        description:
          'Look up recent CVEs (vulnerabilities) by keyword — a product, library, ' +
          'or technology (e.g. "nginx", "log4j", "react"). Returns a short digest.',
        tags: ['security', 'cve'],
        input: s.object({ keyword: s.string({ description: 'What to search for.' }) }),
        output: s.string(),
        execute: ({ keyword }) => search(keyword),
      }),
    );
  }
  if (deps.arxivSearch !== undefined) {
    const search = deps.arxivSearch;
    tools.push(
      defineTool({
        name: 'research.arxiv',
        description:
          'Search arXiv for recent papers on a topic (e.g. "quantum reinforcement ' +
          'learning edge"). Returns the newest matches with titles, authors, links.',
        tags: ['research', 'arxiv'],
        input: s.object({ query: s.string({ description: 'The research topic.' }) }),
        output: s.string(),
        execute: ({ query }) => search(query),
      }),
    );
  }
  return tools;
}
