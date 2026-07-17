import { describe, expect, it, vi } from 'vitest';

import { defineAgent } from '../src/agent.js';
import { TestClock } from '../src/clock.js';
import { PluginError, RuntimeStateError } from '../src/errors.js';
import { sequentialIds } from '../src/ids.js';
import { definePlugin, type Plugin } from '../src/plugin.js';
import { Runtime } from '../src/runtime.js';
import { defineTool, type AnyTool, type Validator } from '../src/tool.js';

const runtime = (options: Parameters<typeof Runtime.create>[0] = {}): Runtime =>
  Runtime.create({
    clock: new TestClock(1_000),
    ids: sequentialIds(),
    retryDelay: () => 0,
    ...options,
  });

/** A plugin that just contributes the given tools/agents. */
const pluginWith = (name: string, ...tools: AnyTool[]): Plugin =>
  definePlugin({
    name,
    setup: (ctx) => {
      for (const tool of tools) ctx.registerTool(tool);
    },
  });

const echo = defineTool<{ value: string }, string>({
  name: 'echo',
  description: 'Returns what it is given',
  execute: (input) => Promise.resolve(input.value),
});

const started = async (...plugins: Plugin[]): Promise<Runtime> => {
  const rt = runtime();
  for (const plugin of plugins) rt.use(plugin);
  await rt.start();
  return rt;
};

describe('Runtime lifecycle', () => {
  it('starts in created and reaches running', async () => {
    const rt = runtime();
    expect(rt.state).toBe('created');

    await rt.start();
    expect(rt.state).toBe('running');

    await rt.stop();
    expect(rt.state).toBe('stopped');
  });

  it('announces each lifecycle step', async () => {
    const rt = runtime();
    const events: string[] = [];
    rt.bus.onAny((event) => void events.push(event.type));

    await rt.start();
    await rt.stop();

    expect(events).toEqual([
      'runtime:starting',
      'runtime:started',
      'runtime:stopping',
      'runtime:stopped',
    ]);
  });

  it('refuses missions before start and after stop', async () => {
    const rt = runtime();
    const spec = {
      name: 'm',
      tasks: [{ name: 'a', handler: { kind: 'tool' as const, name: 'echo' } }],
    };

    await expect(rt.run(spec)).rejects.toThrow(RuntimeStateError);

    await rt.start();
    await rt.stop();

    await expect(rt.run(spec)).rejects.toThrow(
      /Runtime must be running to accept missions/,
    );
  });

  it('refuses plugins once started', async () => {
    const rt = await started();

    expect(() => rt.use(pluginWith('late'))).toThrow(
      /Plugins must be registered before start/,
    );
  });

  it('cannot be restarted', async () => {
    const rt = await started();
    await rt.stop();

    await expect(rt.start()).rejects.toThrow(
      /runtime cannot transition from "stopped"/,
    );
  });

  it('stopping is idempotent, and stopping an unstarted runtime is a no-op', async () => {
    const unstarted = runtime();
    await expect(unstarted.stop()).resolves.toBeUndefined();
    expect(unstarted.state).toBe('stopped');

    const rt = await started();
    await rt.stop();
    await expect(rt.stop()).resolves.toBeUndefined();
  });

  it('drains in-flight work before stopping', async () => {
    let release = (): void => undefined;
    const slow = defineTool({
      name: 'slow',
      description: 'blocks',
      execute: () =>
        new Promise<string>(
          (resolve) =>
            (release = () => {
              resolve('done');
            }),
        ),
    });
    const rt = await started(pluginWith('p', slow));

    const mission = rt.submit({
      name: 'm',
      tasks: [{ name: 'a', handler: { kind: 'tool', name: 'slow' } }],
    });
    await vi.waitFor(() => {
      expect(mission.taskByName('a')?.state).toBe('running');
    });

    const stopping = rt.stop();
    release();
    await stopping;

    expect(mission.taskByName('a')?.state).toBe('succeeded');
  });

  it('cancel mode abandons in-flight work instead of waiting', async () => {
    const blocking = defineTool({
      name: 'blocking',
      description: 'never finishes on its own',
      execute: (_input, ctx) =>
        new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    });
    const rt = await started(pluginWith('p', blocking));

    const mission = rt.submit({
      name: 'm',
      tasks: [{ name: 'a', handler: { kind: 'tool', name: 'blocking' } }],
    });
    await vi.waitFor(() => {
      expect(mission.taskByName('a')?.state).toBe('running');
    });

    await rt.stop({ mode: 'cancel' });

    expect(mission.taskByName('a')?.state).toBe('cancelled');
    expect(rt.state).toBe('stopped');
  });
});

describe('Runtime plugins', () => {
  it("registers a plugin's tools and agents", async () => {
    const agent = defineAgent({
      name: 'planner',
      description: 'plans',
      handle: () => Promise.resolve('planned'),
    });
    const rt = await started(
      definePlugin({
        name: 'p',
        setup: (ctx) => {
          ctx.registerTool(echo);
          ctx.registerAgent(agent);
        },
      }),
    );

    expect(rt.tools.has('echo')).toBe(true);
    expect(rt.agents.has('planner')).toBe(true);
  });

  it('emits plugin:registered with the version', async () => {
    const rt = runtime();
    const seen: unknown[] = [];
    rt.bus.on('plugin:registered', (payload) => void seen.push(payload));
    rt.use(definePlugin({ name: 'p', version: '1.2.3', setup: () => undefined }));

    await rt.start();

    expect(seen).toEqual([{ name: 'p', version: '1.2.3' }]);
  });

  it('sets plugins up in dependency order regardless of registration order', async () => {
    const order: string[] = [];
    const rt = runtime();
    rt.use(
      definePlugin({ name: 'b', dependsOn: ['a'], setup: () => void order.push('b') }),
    );
    rt.use(definePlugin({ name: 'a', setup: () => void order.push('a') }));

    await rt.start();

    expect(order).toEqual(['a', 'b']);
  });

  it('rejects a plugin that depends on one that is not registered', async () => {
    const rt = runtime();
    rt.use(definePlugin({ name: 'b', dependsOn: ['ghost'], setup: () => undefined }));

    await expect(rt.start()).rejects.toThrow(
      /Plugin "b" depends on "ghost", which is not registered/,
    );
  });

  it('rejects a plugin dependency cycle', async () => {
    const rt = runtime();
    rt.use(definePlugin({ name: 'a', dependsOn: ['b'], setup: () => undefined }));
    rt.use(definePlugin({ name: 'b', dependsOn: ['a'], setup: () => undefined }));

    await expect(rt.start()).rejects.toThrow(/Plugin dependency cycle/);
  });

  it('rejects two plugins with the same name', async () => {
    const rt = runtime();
    rt.use(pluginWith('dup'));
    rt.use(pluginWith('dup'));

    await expect(rt.start()).rejects.toThrow(/Duplicate plugin name "dup"/);
  });

  it('rejects two plugins contributing the same tool name, naming the culprit', async () => {
    const rt = runtime();
    rt.use(pluginWith('a', echo));
    rt.use(pluginWith('b', echo));

    const error = await rt.start().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    // The wrapper names which plugin failed; the cause says what it did wrong.
    // Both matter when a conflict shows up in a host with a dozen plugins.
    expect(error).toBeInstanceOf(PluginError);
    expect((error as PluginError).plugin).toBe('b');
    expect((error as PluginError).cause).toMatchObject({
      message: 'A tool named "echo" is already registered',
    });
  });

  it('a failing setup aborts start and unwinds what already came up', async () => {
    const disposed: string[] = [];
    const rt = runtime();
    rt.use(
      definePlugin({
        name: 'good',
        setup: (ctx) => {
          ctx.onDispose(() => void disposed.push('good'));
        },
      }),
    );
    rt.use(
      definePlugin({
        name: 'bad',
        dependsOn: ['good'],
        setup: () => {
          throw new Error('setup exploded');
        },
      }),
    );

    await expect(rt.start()).rejects.toThrow(PluginError);
    expect(rt.state).toBe('stopped');
    // The healthy plugin's resources are released rather than stranded.
    expect(disposed).toEqual(['good']);
  });

  it('disposes in reverse setup order', async () => {
    const disposed: string[] = [];
    const rt = runtime();
    rt.use(
      definePlugin({
        name: 'a',
        setup: (ctx) => {
          ctx.onDispose(() => void disposed.push('a'));
        },
      }),
    );
    rt.use(
      definePlugin({
        name: 'b',
        dependsOn: ['a'],
        setup: (ctx) => {
          ctx.onDispose(() => void disposed.push('b'));
        },
      }),
    );

    await rt.start();
    await rt.stop();

    expect(disposed).toEqual(['b', 'a']);
  });

  it("one plugin's failing dispose does not block another's", async () => {
    const disposed: string[] = [];
    const errors: unknown[] = [];
    const rt = runtime();
    rt.bus.on('kernel:error', (payload) => void errors.push(payload));
    rt.use(
      definePlugin({
        name: 'a',
        setup: (ctx) => {
          ctx.onDispose(() => void disposed.push('a'));
        },
      }),
    );
    rt.use(
      definePlugin({
        name: 'b',
        dependsOn: ['a'],
        setup: (ctx) => {
          ctx.onDispose(() => {
            throw new Error('dispose exploded');
          });
        },
      }),
    );

    await rt.start();
    await rt.stop();

    expect(disposed).toEqual(['a']);
    expect(errors).toHaveLength(1);
    expect(rt.state).toBe('stopped');
  });

  it('gives a plugin the bus, a namespaced logger, and the clock', async () => {
    const child = vi.fn().mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    });
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child,
    };
    const clock = new TestClock(42);
    const rt = Runtime.create({ logger, clock, ids: sequentialIds() });
    let captured: { hasBus: boolean; now: number } | undefined;
    rt.use(
      definePlugin({
        name: 'p',
        setup: (ctx) => {
          captured = { hasBus: ctx.bus === rt.bus, now: ctx.clock.now() };
        },
      }),
    );

    await rt.start();

    expect(captured).toEqual({ hasBus: true, now: 42 });
    expect(child).toHaveBeenCalledWith({ plugin: 'p' });
  });
});

describe('Runtime task execution', () => {
  it('runs a tool task and returns its output', async () => {
    const rt = await started(pluginWith('p', echo));

    const result = await rt.run({
      name: 'm',
      tasks: [
        { name: 'a', handler: { kind: 'tool', name: 'echo' }, input: { value: 'hi' } },
      ],
    });

    expect(result.state).toBe('succeeded');
    expect(result.tasks[0]?.result).toBe('hi');
  });

  it('passes a context naming the mission, task, and attempt', async () => {
    const seen: unknown[] = [];
    const probe = defineTool({
      name: 'probe',
      description: 'records its context',
      execute: (_input, ctx) => {
        seen.push({
          missionId: ctx.missionId,
          taskName: ctx.taskName,
          attempt: ctx.attempt,
        });
        return Promise.resolve(null);
      },
    });
    const rt = await started(pluginWith('p', probe));

    await rt.run({
      name: 'm',
      tasks: [{ name: 'a', handler: { kind: 'tool', name: 'probe' } }],
    });

    expect(seen).toEqual([{ missionId: 'mission_1', taskName: 'a', attempt: 1 }]);
  });

  it('feeds a task output into a dependent task', async () => {
    const rt = await started(pluginWith('p', echo));

    const result = await rt.run({
      name: 'm',
      tasks: [
        {
          name: 'first',
          handler: { kind: 'tool', name: 'echo' },
          input: { value: 'one' },
        },
        {
          name: 'second',
          handler: { kind: 'tool', name: 'echo' },
          input: { value: 'two' },
          dependsOn: ['first'],
        },
      ],
    });

    expect(result.tasks.map((t) => t.result)).toEqual(['one', 'two']);
  });

  it('fails a task that names a tool nobody registered', async () => {
    const rt = await started();

    const result = await rt.run({
      name: 'm',
      tasks: [{ name: 'a', handler: { kind: 'tool', name: 'ghost' } }],
    });

    expect(result.state).toBe('failed');
    expect(result.tasks[0]?.error?.message).toMatch(
      /No tool named "ghost" is registered/,
    );
  });

  it('fails a task that names an agent nobody registered', async () => {
    const rt = await started();

    const result = await rt.run({
      name: 'm',
      tasks: [{ name: 'a', handler: { kind: 'agent', name: 'ghost' } }],
    });

    expect(result.tasks[0]?.error?.message).toMatch(
      /No agent named "ghost" is registered/,
    );
  });

  describe('validation', () => {
    const strict: Validator<{ value: string }> = {
      parse: (input) => {
        if (
          typeof input !== 'object' ||
          input === null ||
          typeof (input as { value?: unknown }).value !== 'string'
        ) {
          throw new Error('expected { value: string }');
        }
        return input as { value: string };
      },
    };

    it('parses input before the tool sees it', async () => {
      const execute = vi.fn().mockResolvedValue('ok');
      const rt = await started(
        pluginWith('p', { name: 'strict', description: 'x', input: strict, execute }),
      );

      await rt.run({
        name: 'm',
        tasks: [
          {
            name: 'a',
            handler: { kind: 'tool', name: 'strict' },
            input: { value: 'good' },
          },
        ],
      });

      expect(execute.mock.calls[0]?.[0]).toEqual({ value: 'good' });
    });

    it('fails the task when input does not validate, without calling the tool', async () => {
      const execute = vi.fn().mockResolvedValue('ok');
      const rt = await started(
        pluginWith('p', { name: 'strict', description: 'x', input: strict, execute }),
      );

      const result = await rt.run({
        name: 'm',
        tasks: [
          { name: 'a', handler: { kind: 'tool', name: 'strict' }, input: { wrong: 1 } },
        ],
      });

      expect(result.tasks[0]?.state).toBe('failed');
      expect(result.tasks[0]?.error?.message).toBe('expected { value: string }');
      expect(execute).not.toHaveBeenCalled();
    });

    it('fails the task when the tool returns output that does not validate', async () => {
      const rt = await started(
        pluginWith('p', {
          name: 'liar',
          description: 'x',
          output: strict,
          execute: () => Promise.resolve('not an object'),
        }),
      );

      const result = await rt.run({
        name: 'm',
        tasks: [{ name: 'a', handler: { kind: 'tool', name: 'liar' } }],
      });

      expect(result.tasks[0]?.state).toBe('failed');
    });
  });

  describe('agents', () => {
    it('runs an agent task', async () => {
      const agent = defineAgent({
        name: 'greeter',
        description: 'greets',
        handle: () => Promise.resolve('hello'),
      });
      const rt = await started(
        definePlugin({
          name: 'p',
          setup: (ctx) => {
            ctx.registerAgent(agent);
          },
        }),
      );

      const result = await rt.run({
        name: 'm',
        tasks: [{ name: 'a', handler: { kind: 'agent', name: 'greeter' } }],
      });

      expect(result.tasks[0]?.result).toBe('hello');
    });

    it('lets an agent discover and invoke tools', async () => {
      const agent = defineAgent({
        name: 'user',
        description: 'uses a tool',
        handle: async (_input, ctx) => {
          expect(ctx.tools.has('echo')).toBe(true);
          expect(ctx.tools.list()).toEqual([
            { name: 'echo', description: 'Returns what it is given' },
          ]);
          return await ctx.tools.invoke('echo', { value: 'via agent' });
        },
      });
      const rt = await started(
        definePlugin({
          name: 'p',
          setup: (ctx) => {
            ctx.registerTool(echo);
            ctx.registerAgent(agent);
          },
        }),
      );

      const result = await rt.run({
        name: 'm',
        tasks: [{ name: 'a', handler: { kind: 'agent', name: 'user' } }],
      });

      expect(result.tasks[0]?.result).toBe('via agent');
    });

    it('surfaces a tool failure to the agent, which may handle it', async () => {
      const agent = defineAgent({
        name: 'resilient',
        description: 'copes',
        handle: async (_input, ctx) => {
          try {
            await ctx.tools.invoke('ghost', {});
            return 'unreachable';
          } catch {
            return 'recovered';
          }
        },
      });
      const rt = await started(
        definePlugin({
          name: 'p',
          setup: (ctx) => {
            ctx.registerAgent(agent);
          },
        }),
      );

      const result = await rt.run({
        name: 'm',
        tasks: [{ name: 'a', handler: { kind: 'agent', name: 'resilient' } }],
      });

      expect(result.tasks[0]?.result).toBe('recovered');
    });

    it('shares the task signal with the tools an agent invokes', async () => {
      const agent = defineAgent({
        name: 'canceller',
        description: 'invokes after cancellation',
        handle: async (_input, ctx) => {
          await ctx.tools.invoke('echo', { value: 'x' });
          return 'done';
        },
      });
      const rt = await started(
        definePlugin({
          name: 'p',
          setup: (ctx) => {
            ctx.registerTool(echo);
            ctx.registerAgent(agent);
          },
        }),
      );

      const result = await rt.run({
        name: 'm',
        tasks: [{ name: 'a', handler: { kind: 'agent', name: 'canceller' } }],
      });

      expect(result.tasks[0]?.result).toBe('done');
    });
  });

  it('retries a flaky tool and reports the attempt count', async () => {
    let calls = 0;
    const flaky = defineTool({
      name: 'flaky',
      description: 'fails once',
      execute: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('flake')) : Promise.resolve('ok');
      },
    });
    const rt = await started(pluginWith('p', flaky));

    const result = await rt.run({
      name: 'm',
      tasks: [{ name: 'a', handler: { kind: 'tool', name: 'flaky' }, maxAttempts: 2 }],
    });

    expect(result.state).toBe('succeeded');
    expect(result.tasks[0]?.attempts).toBe(2);
  });

  it('cancels a mission by id', async () => {
    const blocking = defineTool({
      name: 'blocking',
      description: 'waits for its signal',
      execute: (_input, ctx) =>
        new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    });
    const rt = await started(pluginWith('p', blocking));

    const mission = rt.submit({
      name: 'm',
      tasks: [{ name: 'a', handler: { kind: 'tool', name: 'blocking' } }],
    });
    await vi.waitFor(() => {
      expect(mission.taskByName('a')?.state).toBe('running');
    });

    await rt.cancelMission(mission.id, 'user asked');
    await rt.idle();

    expect(mission.state).toBe('cancelled');
    await rt.stop();
  });

  it('rejects an invalid mission spec up front, before anything runs', async () => {
    const rt = await started(pluginWith('p', echo));

    await expect(
      rt.run({
        name: 'm',
        tasks: [
          { name: 'a', handler: { kind: 'tool', name: 'echo' }, dependsOn: ['ghost'] },
        ],
      }),
    ).rejects.toThrow(/depends on unknown task "ghost"/);
  });

  it('keeps a throwing event listener from breaking a mission', async () => {
    const rt = await started(pluginWith('p', echo));
    const errors: unknown[] = [];
    rt.bus.on('kernel:error', (payload) => void errors.push(payload));
    rt.bus.on('task:started', () => {
      throw new Error('observer exploded');
    });

    const result = await rt.run({
      name: 'm',
      tasks: [
        { name: 'a', handler: { kind: 'tool', name: 'echo' }, input: { value: 'hi' } },
      ],
    });

    expect(result.state).toBe('succeeded');
    expect(errors).toHaveLength(1);
  });

  it('honours the concurrency limit across missions', async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const gated = defineTool({
      name: 'gated',
      description: 'blocks until released',
      execute: () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return new Promise<void>((resolve) =>
          release.push(() => {
            inFlight -= 1;
            resolve();
          }),
        );
      },
    });
    const rt = runtime({ concurrency: 1 });
    rt.use(pluginWith('p', gated));
    await rt.start();

    const first = rt.run({
      name: 'first',
      tasks: [{ name: 'a', handler: { kind: 'tool', name: 'gated' } }],
    });
    const second = rt.run({
      name: 'second',
      tasks: [{ name: 'b', handler: { kind: 'tool', name: 'gated' } }],
    });

    for (let i = 0; i < 2; i += 1) {
      await vi.waitFor(() => {
        expect(release.length).toBeGreaterThan(0);
      });
      release.shift()?.();
    }
    await Promise.all([first, second]);

    expect(peak).toBe(1);
  });
});
