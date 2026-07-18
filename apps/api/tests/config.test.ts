/**
 * The API config schema — defaults and environment overrides.
 */

import { loadConfig } from '@hermes/config';
import { describe, expect, it } from 'vitest';
import { API_VERSION, apiSchema } from '../src/config.js';

describe('apiSchema', () => {
  it('applies defaults when the environment is empty', () => {
    const result = loadConfig(apiSchema, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        port: 3000,
        host: '0.0.0.0',
        logLevel: 'info',
        serviceName: 'hermes-api',
      });
    }
  });

  it('reads overrides from the environment', () => {
    const result = loadConfig(apiSchema, {
      PORT: '8080',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'debug',
      SERVICE_NAME: 'custom',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.port).toBe(8080);
      expect(result.value.host).toBe('127.0.0.1');
      expect(result.value.logLevel).toBe('debug');
      expect(result.value.serviceName).toBe('custom');
    }
  });

  it('rejects an invalid port', () => {
    expect(loadConfig(apiSchema, { PORT: '70000' }).ok).toBe(false);
  });

  it('exposes a semver version', () => {
    expect(API_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
