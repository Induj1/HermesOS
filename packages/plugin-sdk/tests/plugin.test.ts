/**
 * The plugin authoring contract — definePlugin, the manifest, and the guard.
 */

import type { PluginContext } from '@hermes/kernel';
import { describe, expect, it } from 'vitest';
import { SDK_API_VERSION, definePlugin, isHermesPlugin } from '../src/index.js';

const noopCtx = {} as PluginContext;

describe('definePlugin', () => {
  it('returns a plugin carrying the manifest and setup', async () => {
    let ran = false;
    const plugin = definePlugin(
      { name: 'weather', version: '1.2.0', apiVersion: SDK_API_VERSION },
      () => {
        ran = true;
      },
    );
    expect(plugin.manifest).toEqual({
      name: 'weather',
      version: '1.2.0',
      apiVersion: '1.0.0',
    });
    await plugin.setup(noopCtx);
    expect(ran).toBe(true);
  });
});

describe('SDK_API_VERSION', () => {
  it('is a semver string', () => {
    expect(SDK_API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('isHermesPlugin', () => {
  it('accepts a real plugin', () => {
    const plugin = definePlugin(
      { name: 'p', version: '1.0.0', apiVersion: SDK_API_VERSION },
      () => undefined,
    );
    expect(isHermesPlugin(plugin)).toBe(true);
  });

  it('rejects non-plugins', () => {
    expect(isHermesPlugin(null)).toBe(false);
    expect(isHermesPlugin('plugin')).toBe(false);
    expect(isHermesPlugin({ manifest: {} })).toBe(false); // no setup
    expect(isHermesPlugin({ setup: () => undefined })).toBe(false); // no manifest
    expect(isHermesPlugin({ manifest: null, setup: () => undefined })).toBe(false);
  });
});
