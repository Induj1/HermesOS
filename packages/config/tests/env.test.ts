/**
 * The process-environment adapter — the one module that reads `process.env`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { list, port, string } from '../src/field.js';
import { redactedView } from '../src/load.js';
import { loadConfigFromEnv, processEnv } from '../src/env.js';

const saved = { ...process.env };
afterEach(() => {
  // Restore whatever the test touched, so tests stay independent.
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) Reflect.deleteProperty(process.env, key);
  }
  Object.assign(process.env, saved);
});

describe('processEnv', () => {
  it('snapshots process.env into a plain record', () => {
    process.env['HERMES_TEST_VAR'] = 'present';
    const env = processEnv();
    expect(env['HERMES_TEST_VAR']).toBe('present');
  });
});

describe('loadConfigFromEnv', () => {
  it('loads a schema from the real environment', () => {
    process.env['HERMES_NAME'] = 'from-env';
    const cfg = loadConfigFromEnv({ hermesName: string() });
    expect(cfg.hermesName).toBe('from-env');
  });

  it('throws when the environment is invalid', () => {
    delete process.env['HERMES_MISSING'];
    expect(() => loadConfigFromEnv({ hermesMissing: port() })).toThrow(
      /invalid configuration/,
    );
  });
});

describe('redactedView with list values', () => {
  it('renders an array as a comma-joined string', () => {
    const schema = { tags: list().default(['x', 'y']) };
    const cfg = loadConfigFromEnv(schema);
    expect(redactedView(schema, cfg)['tags']).toBe('x,y');
  });
});
