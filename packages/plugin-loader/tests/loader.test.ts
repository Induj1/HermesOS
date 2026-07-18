/**
 * The loader — validation, compatibility enforcement, and kernel adaptation.
 */

import type { PluginContext } from '@hermes/kernel';
import { definePlugin, type HermesPlugin } from '@hermes/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import { PluginLoadError, PluginLoader, toKernelPlugin } from '../src/loader.js';

const noopCtx = {} as PluginContext;

function plugin(
  manifest: Partial<HermesPlugin['manifest']> & { name: string },
  setup: HermesPlugin['setup'] = () => undefined,
): HermesPlugin {
  return definePlugin({ version: '1.0.0', apiVersion: '1.0.0', ...manifest }, setup);
}

const loader = new PluginLoader({ hostApiVersion: '1.2.0' });

describe('load', () => {
  it('adapts a valid plugin to a kernel plugin', () => {
    const { loaded, rejected } = loader.load([
      plugin({ name: 'a', apiVersion: '1.0.0', dependsOn: ['b'] }),
    ]);
    expect(rejected).toHaveLength(0);
    expect(loaded[0]?.name).toBe('a');
    expect(loaded[0]?.version).toBe('1.0.0');
    expect(loaded[0]?.dependsOn).toEqual(['b']);
    expect(typeof loaded[0]?.setup).toBe('function');
  });

  it('rejects an incompatible apiVersion', () => {
    const { loaded, rejected } = loader.load([
      plugin({ name: 'future', apiVersion: '1.9.0' }), // host is 1.2.0
      plugin({ name: 'major', apiVersion: '2.0.0' }),
    ]);
    expect(loaded).toHaveLength(0);
    expect(rejected.map((r) => r.name)).toEqual(['future', 'major']);
    expect(rejected[0]?.reasons[0]).toMatch(/incompatible/);
  });

  it('collects every reason for one plugin', () => {
    const { rejected } = loader.load([
      plugin({ name: '', version: 'bad', apiVersion: 'also-bad' }),
    ]);
    expect(rejected[0]?.reasons).toEqual(
      expect.arrayContaining([
        'manifest name is empty',
        expect.stringMatching(/invalid version/),
        expect.stringMatching(/invalid apiVersion/),
      ]),
    );
  });

  it('rejects a duplicate name, keeping the first', () => {
    const { loaded, rejected } = loader.load([
      plugin({ name: 'dup' }),
      plugin({ name: 'dup' }),
    ]);
    expect(loaded).toHaveLength(1);
    expect(rejected[0]?.reasons[0]).toMatch(/duplicate/);
  });

  it('reports an invalid host apiVersion against a valid plugin', () => {
    const bad = new PluginLoader({ hostApiVersion: 'not-semver' });
    const { rejected } = bad.load([plugin({ name: 'a' })]);
    expect(rejected[0]?.reasons[0]).toMatch(/host apiVersion .* not valid semver/);
  });

  it('omits dependsOn on the kernel plugin when absent', () => {
    const { loaded } = loader.load([plugin({ name: 'solo' })]);
    expect('dependsOn' in (loaded[0] ?? {})).toBe(false);
  });
});

describe('loadOrThrow', () => {
  it('returns loaded plugins when all pass', () => {
    const loaded = loader.loadOrThrow([plugin({ name: 'ok' })]);
    expect(loaded).toHaveLength(1);
  });

  it('throws a PluginLoadError listing rejections', () => {
    try {
      loader.loadOrThrow([plugin({ name: 'x', apiVersion: '9.0.0' })]);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PluginLoadError);
      const err = e as PluginLoadError;
      expect(err.rejected).toHaveLength(1);
      expect(err.message).toMatch(/rejected 1 plugin/);
    }
  });
});

describe('toKernelPlugin', () => {
  it('delegates setup to the SDK plugin', async () => {
    const setup = vi.fn();
    const kernelPlugin = toKernelPlugin(plugin({ name: 'p' }, setup));
    await kernelPlugin.setup(noopCtx);
    expect(setup).toHaveBeenCalledWith(noopCtx);
  });
});
