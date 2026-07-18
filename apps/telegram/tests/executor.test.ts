import type { ToolRequest } from '@hermes/agent';
import { describe, expect, it } from 'vitest';
import { toolExecutor } from '../src/executor.js';
import { boomTool, echoTool, spyLogger } from './helpers.js';

const request = (name: string, args: unknown, id = 'r1'): ToolRequest => ({
  id,
  name,
  kind: 'tool',
  args,
});

describe('toolExecutor', () => {
  it('describes its tools as capabilities', () => {
    const executor = toolExecutor([echoTool, boomTool]);
    const capabilities = executor.available();

    expect(capabilities.map((capability) => capability.name)).toEqual(['echo', 'boom']);
    expect(capabilities[0]?.kind).toBe('tool');
    expect(capabilities[0]?.parameters).toBeDefined();
  });

  it('runs a tool and reports the result', async () => {
    const executor = toolExecutor([echoTool]);
    const [observation] = await executor.execute([request('echo', { text: 'hello' })]);

    expect(observation).toMatchObject({
      id: 'r1',
      name: 'echo',
      ok: true,
      result: 'hello',
    });
  });

  it('reports an unknown tool as a failed observation, not a throw', async () => {
    const executor = toolExecutor([echoTool]);
    const [observation] = await executor.execute([request('missing', {})]);

    expect(observation?.ok).toBe(false);
    expect(observation?.error?.message).toMatch(/unknown tool/);
  });

  it('turns a throwing tool into a failed observation', async () => {
    const executor = toolExecutor([boomTool]);
    const [observation] = await executor.execute([request('boom', {})]);

    expect(observation?.ok).toBe(false);
    expect(observation?.error?.message).toBe('boom');
  });

  it('passes a logger through to the tool and logs a failure', async () => {
    const logger = spyLogger();
    const ok = toolExecutor([echoTool], { logger });
    const [good] = await ok.execute([request('echo', { text: 'hi' })]);
    expect(good?.ok).toBe(true);

    const failing = toolExecutor([boomTool], { logger });
    const [bad] = await failing.execute([request('boom', {})]);
    expect(bad?.ok).toBe(false);
    expect(logger.warns).toContain('tool failed');
  });

  it('runs a batch, preserving order', async () => {
    const executor = toolExecutor([echoTool]);
    const observations = await executor.execute([
      request('echo', { text: 'one' }, 'a'),
      request('echo', { text: 'two' }, 'b'),
    ]);

    expect(observations.map((observation) => observation.id)).toEqual(['a', 'b']);
    expect(observations.map((observation) => observation.result)).toEqual([
      'one',
      'two',
    ]);
  });
});
