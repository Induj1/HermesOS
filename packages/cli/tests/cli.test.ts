/**
 * The CLI — dispatch, built-ins, exit codes, and command argument threading.
 */

import { describe, expect, it } from 'vitest';
import { CLI, type Command, type IO } from '../src/cli.js';

/** A buffer IO that records stdout and stderr separately. */
function captureIO(): IO & { out: string; err: string } {
  const state = { out: '', err: '' };
  return {
    out: '',
    err: '',
    write(text) {
      state.out += text;
      this.out = state.out;
    },
    writeError(text) {
      state.err += text;
      this.err = state.err;
    },
  };
}

const echo: Command = {
  name: 'echo',
  description: 'Echo the positionals',
  run: ({ args, io }) => {
    io.write(`${args.positionals.join(' ')}\n`);
    return 0;
  },
};

const failing: Command = {
  name: 'fail',
  description: 'Always fails',
  run: () => 2,
};

function cli(): CLI {
  return new CLI({ name: 'hermes', version: '1.2.3', commands: [echo, failing] });
}

describe('dispatch', () => {
  it('runs a command and returns its exit code', async () => {
    const io = captureIO();
    const code = await cli().run(['echo', 'hello', 'world'], io);
    expect(code).toBe(0);
    expect(io.out).toBe('hello world\n');
  });

  it('propagates a non-zero exit code', async () => {
    const io = captureIO();
    expect(await cli().run(['fail'], io)).toBe(2);
  });

  it('threads the command arguments (after the name) to the command', async () => {
    const io = captureIO();
    const seen: string[] = [];
    const c = new CLI({
      name: 'x',
      commands: [
        {
          name: 'cmd',
          description: 'd',
          run: ({ argv, args }) => {
            seen.push(...argv);
            return args.options['n'] === '5' ? 0 : 1;
          },
        },
      ],
    });
    expect(await c.run(['cmd', '--n', '5', 'pos'], io)).toBe(0);
    expect(seen).toEqual(['--n', '5', 'pos']);
  });
});

describe('built-ins', () => {
  it('prints usage for help and returns 0', async () => {
    const io = captureIO();
    expect(await cli().run(['help'], io)).toBe(0);
    expect(io.out).toContain('hermes <command>');
    expect(io.out).toContain('echo');
    expect(io.out).toContain('Echo the positionals');
  });

  it('treats --help and -h like help', async () => {
    for (const token of ['--help', '-h']) {
      const io = captureIO();
      expect(await cli().run([token], io)).toBe(0);
      expect(io.out).toContain('Commands:');
    }
  });

  it('prints the version for --version', async () => {
    const io = captureIO();
    expect(await cli().run(['--version'], io)).toBe(0);
    expect(io.out).toBe('1.2.3\n');
  });

  it('defaults the version to 0.0.0', async () => {
    const io = captureIO();
    await new CLI({ name: 'x' }).run(['--version'], io);
    expect(io.out).toBe('0.0.0\n');
  });
});

describe('errors', () => {
  it('prints usage and returns 1 for an empty invocation', async () => {
    const io = captureIO();
    expect(await cli().run([], io)).toBe(1);
    expect(io.out).toContain('Commands:');
  });

  it('reports an unknown command and returns 1', async () => {
    const io = captureIO();
    expect(await cli().run(['nope'], io)).toBe(1);
    expect(io.err).toContain('unknown command: nope');
    expect(io.out).toContain('Commands:');
  });

  it('throws on a duplicate command registration', () => {
    expect(() => new CLI({ name: 'x', commands: [echo, echo] })).toThrow(
      /already registered/,
    );
  });

  it('supports incremental add()', async () => {
    const io = captureIO();
    const c = new CLI({ name: 'x' }).add(echo);
    expect(await c.run(['echo', 'hi'], io)).toBe(0);
    expect(io.out).toBe('hi\n');
  });
});
