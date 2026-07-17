/**
 * The testing utilities, tested.
 *
 * They are shipped API — a plugin author outside this repository is their main
 * user — so they get the same treatment as anything else that ships. Untested
 * test helpers are a special kind of embarrassing: they fail by making *other*
 * people's tests wrong.
 *
 * `auditTool` carries most of the weight. It checks the things that are
 * technically legal and always mistakes, none of which the type system can catch
 * and all of which surface as a model behaving badly — the hardest failure to
 * trace back to its cause.
 */

import { describe, expect, it } from 'vitest';
import { defineTool as defineKernelTool } from '@hermes/kernel';
import { auditTool, spyTool, testContext } from '../src/testing.js';
import { defineTool } from '../src/tool.js';
import * as s from '../src/schema.js';
import { ToolNotFoundError, toError } from '../src/errors.js';

describe('auditTool', () => {
  const good = defineTool({
    name: 'fs.read',
    description: 'Read a UTF-8 text file from disk.',
    input: s.object({ path: s.string() }),
    examples: [{ description: 'Read a config', input: { path: '/etc/hosts' } }],
    execute: () => Promise.resolve('ok'),
  });

  it('finds nothing wrong with a well-formed tool', () => {
    expect(auditTool(good)).toEqual([]);
  });

  // The check that earns this function: an example violating the schema is
  // documentation actively teaching a model to make a call that will be rejected.
  it('catches an example that violates the tool own schema', () => {
    const lying = defineTool({
      name: 'fs.read',
      description: 'Read a UTF-8 text file from disk.',
      input: s.object({ path: s.string() }),
      examples: [{ description: 'Wrong shape', input: { file: '/etc/hosts' } }],
      execute: () => Promise.resolve('ok'),
    });

    const issues = auditTool(lying);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(
      'example 0 ("Wrong shape") does not match the input schema',
    );
    expect(issues[0]).toContain('"path" is required');
  });

  it('names the failing example among several', () => {
    const partly = defineTool({
      name: 'fs.read',
      description: 'Read a UTF-8 text file from disk.',
      input: s.object({ path: s.string() }),
      examples: [
        { description: 'Fine', input: { path: '/a' } },
        { description: 'Broken', input: { path: 2 } },
      ],
      execute: () => Promise.resolve('ok'),
    });

    expect(auditTool(partly)[0]).toContain('example 1 ("Broken")');
  });

  // A model reads the description to choose this tool over another.
  it('catches a description too short to choose by', () => {
    const terse = defineTool({
      name: 'x',
      description: 'Reads.',
      input: s.nothing(),
      execute: () => Promise.resolve('ok'),
    });

    expect(auditTool(terse)[0]).toContain('a model reads it to choose this tool');
  });

  // "No schema" and "no arguments" read identically to a host and differently to
  // a model, which is why `nothing()` exists.
  it('catches a tool that tells a model nothing about its arguments', () => {
    const bare = defineKernelTool<unknown, string>({
      name: 'bare',
      description: 'A tool with no input schema at all',
      execute: () => Promise.resolve('ok'),
    });

    expect(auditTool(bare)[0]).toContain('use `nothing()` if it truly takes none');
  });

  it('is happy with a tool that declares it takes nothing', () => {
    const empty = defineTool({
      name: 'ping',
      description: 'Check that the service is reachable.',
      input: s.nothing(),
      execute: () => Promise.resolve('pong'),
    });

    expect(auditTool(empty)).toEqual([]);
  });

  it('skips example checks for a tool with no schema to check against', () => {
    const bare = defineKernelTool<unknown, string>({
      name: 'bare',
      description: 'A tool with no input schema at all',
      execute: () => Promise.resolve('ok'),
    });

    // One issue — the missing schema — not one per example as well.
    expect(auditTool(bare)).toHaveLength(1);
  });

  // Returned rather than thrown, so a test can assert on the list and a host can
  // log it at boot without refusing to start.
  it('reports every problem at once', () => {
    const bad = defineKernelTool<unknown, string>({
      name: 'bad',
      description: 'Short.',
      execute: () => Promise.resolve('ok'),
    });

    expect(auditTool(bad).length).toBeGreaterThan(1);
  });
});

describe('spyTool', () => {
  it('records what it was called with', async () => {
    const spy = spyTool('search', ['a hit']);

    await spy.execute({ q: 'hermes' } as never, testContext());
    await spy.execute({ q: 'again' } as never, testContext());

    expect(spy.calls).toEqual([{ q: 'hermes' }, { q: 'again' }]);
  });

  it('returns what it was told to', async () => {
    const spy = spyTool('search', ['a hit']);

    expect(await spy.execute({} as never, testContext())).toEqual(['a hit']);
  });

  it('is a real tool, with a name and a description', () => {
    const spy = spyTool('search', 1);

    expect(spy.name).toBe('search');
    expect(spy.description).toContain('search');
  });

  it('takes overrides, so it can stand in for a tool with a schema', () => {
    const spy = spyTool('search', 1, { description: 'A custom description' });

    expect(spy.description).toBe('A custom description');
  });
});

describe('ToolNotFoundError', () => {
  it('lists the tools that do exist', () => {
    const error = new ToolNotFoundError('ghost', ['fs.read', 'fs.write']);

    expect(error.tool).toBe('ghost');
    expect(error.message).toContain('Known tools: fs.read, fs.write');
    expect(error.code).toBe('TOOL_NOT_FOUND');
  });

  // A different problem with a different fix: nothing is registered at all.
  it('says so when nothing is registered', () => {
    expect(new ToolNotFoundError('ghost', []).message).toMatch(
      /no tools are registered at all/,
    );
  });
});

describe('toError', () => {
  it('passes an Error through, preserving its identity', () => {
    const original = new TypeError('boom');

    expect(toError(original)).toBe(original);
  });

  it('promotes a thrown string', () => {
    expect(toError('just a string').message).toBe('just a string');
  });

  it('wraps anything else without losing it', () => {
    const error = toError({ weird: true });

    expect(error.message).toContain('Non-Error thrown');
    expect(error.cause).toEqual({ weird: true });
  });
});
