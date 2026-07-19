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

  it('includes python.run only when a run port is supplied', () => {
    const base = {
      fs: new MemoryFileSystem(),
      http: FakeHttpClient.respondingWith(''),
    };
    expect(buildTools(base).map((tool) => tool.name)).not.toContain('python.run');
    const withPy = buildTools({ ...base, pythonRun: () => Promise.resolve('ok') });
    expect(withPy.map((tool) => tool.name)).toContain('python.run');
  });

  it('includes image.ocr and text.translate only when their ports are supplied', () => {
    const base = {
      fs: new MemoryFileSystem(),
      http: FakeHttpClient.respondingWith(''),
    };
    const none = buildTools(base).map((tool) => tool.name);
    expect(none).not.toContain('image.ocr');
    expect(none).not.toContain('text.translate');

    const both = buildTools({
      ...base,
      ocrRun: () => Promise.resolve('text'),
      translate: () => Promise.resolve('translated'),
    }).map((tool) => tool.name);
    expect(both).toContain('image.ocr');
    expect(both).toContain('text.translate');
  });

  it('includes diagram.render only when a render port is supplied', () => {
    const base = {
      fs: new MemoryFileSystem(),
      http: FakeHttpClient.respondingWith(''),
    };
    expect(buildTools(base).map((tool) => tool.name)).not.toContain('diagram.render');
    const withDiagram = buildTools({
      ...base,
      renderDiagram: (_m, f) => Promise.resolve(f),
    });
    expect(withDiagram.map((tool) => tool.name)).toContain('diagram.render');
  });

  it('includes security.cve and research.arxiv only when their ports are supplied', () => {
    const base = {
      fs: new MemoryFileSystem(),
      http: FakeHttpClient.respondingWith(''),
    };
    const none = buildTools(base).map((tool) => tool.name);
    expect(none).not.toContain('security.cve');
    expect(none).not.toContain('research.arxiv');

    const both = buildTools({
      ...base,
      cveSearch: () => Promise.resolve('cves'),
      arxivSearch: () => Promise.resolve('papers'),
    }).map((tool) => tool.name);
    expect(both).toContain('security.cve');
    expect(both).toContain('research.arxiv');
  });
});
