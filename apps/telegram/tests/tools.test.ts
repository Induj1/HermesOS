import { MemoryFileSystem } from '@hermes/tools-fs';
import { FakeHttpClient } from '@hermes/tools-http';
import { FakeShellExecutor } from '@hermes/tools-shell';
import { describe, expect, it } from 'vitest';
import { buildTools } from '../src/tools.js';

describe('buildTools', () => {
  it('includes filesystem and HTTP tools, and no shell tool by default', () => {
    const tools = buildTools({
      fs: new MemoryFileSystem(),
      http: FakeHttpClient.respondingWith(''),
    });
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('fs.read');
    expect(names.some((name) => name.startsWith('http.'))).toBe(true);
    expect(names.some((name) => name.startsWith('shell.'))).toBe(false);
  });

  it('includes shell tools when a shell executor is supplied', () => {
    const tools = buildTools({
      fs: new MemoryFileSystem(),
      http: FakeHttpClient.respondingWith(''),
      shell: FakeShellExecutor.succeedingWith(''),
    });

    expect(tools.map((tool) => tool.name)).toContain('shell.run');
  });

  it('includes the browser tool when a browse port is supplied', () => {
    const tools = buildTools({
      fs: new MemoryFileSystem(),
      http: FakeHttpClient.respondingWith(''),
      browse: () => Promise.resolve('text'),
    });
    expect(tools.map((tool) => tool.name)).toContain('web.browse');
  });

  it('includes doc and github tools when configured, and omits github with no token', () => {
    const names = buildTools({
      fs: new MemoryFileSystem(),
      http: FakeHttpClient.respondingWith(''),
      renderPdf: () => Promise.resolve('x.pdf'),
      githubToken: 'tok',
    }).map((tool) => tool.name);
    expect(names).toContain('doc.pdf');
    expect(names).toContain('github.repo');

    const noGithub = buildTools({
      fs: new MemoryFileSystem(),
      http: FakeHttpClient.respondingWith(''),
      githubToken: '',
    }).map((tool) => tool.name);
    expect(noGithub).not.toContain('github.repo');
  });
});
