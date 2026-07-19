/**
 * The tool set the agent is offered — assembled over injected ports so the whole
 * thing is testable with in-memory fakes and no disk, network, or process.
 *
 * `main.ts` supplies the real ports: a `NodeFileSystem` rooted at the workspace,
 * a `guarded` HTTP client, and (opt-in) an allowlisted shell executor. A test
 * supplies `MemoryFileSystem` / `FakeHttpClient` / `FakeShellExecutor`.
 */

import type { HermesTool } from '@hermes/tools';
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
  return tools;
}
