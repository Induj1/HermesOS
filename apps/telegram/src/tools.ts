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
import { docTools, type RenderPdfPort } from './doc.js';
import { githubTools } from './github.js';
import { pythonTools, type PythonRunPort } from './python.js';
import { searchTools } from './search.js';

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
  return tools;
}
