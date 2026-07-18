/**
 * Loading — env-var derivation, all-errors-at-once, docs, and redaction.
 */

import { describe, expect, it } from 'vitest';
import { boolean, oneOf, port, string, url } from '../src/field.js';
import {
  ConfigError,
  describeSchema,
  envVarName,
  loadConfig,
  loadConfigOrThrow,
  redactedView,
} from '../src/load.js';

const schema = {
  port: port().default(3000),
  databaseUrl: url().secret().describe('Postgres connection string'),
  logLevel: oneOf(['debug', 'info', 'warn', 'error']).default('info'),
  featureFlag: boolean().optional(),
  serviceName: string().from('SVC_NAME'),
};

describe('envVarName', () => {
  it('converts camelCase to SCREAMING_SNAKE_CASE', () => {
    expect(envVarName('databaseUrl')).toBe('DATABASE_URL');
    expect(envVarName('port')).toBe('PORT');
    expect(envVarName('maxRetries2')).toBe('MAX_RETRIES2');
    expect(envVarName('log.level')).toBe('LOG_LEVEL');
  });
});

describe('loadConfig', () => {
  it('produces a fully typed value from a valid environment', () => {
    const result = loadConfig(schema, {
      PORT: '8080',
      DATABASE_URL: 'postgres://localhost/db',
      LOG_LEVEL: 'debug',
      FEATURE_FLAG: 'true',
      SVC_NAME: 'api',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        port: 8080,
        databaseUrl: 'postgres://localhost/db',
        logLevel: 'debug',
        featureFlag: true,
        serviceName: 'api',
      },
    });
  });

  it('applies defaults and optionals when variables are unset', () => {
    const result = loadConfig(schema, {
      DATABASE_URL: 'postgres://localhost/db',
      SVC_NAME: 'api',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.port).toBe(3000);
      expect(result.value.logLevel).toBe('info');
      expect(result.value.featureFlag).toBeUndefined();
    }
  });

  it('reports every error in one pass', () => {
    const result = loadConfig(schema, {
      PORT: '99999',
      LOG_LEVEL: 'verbose',
      // DATABASE_URL and SVC_NAME missing entirely.
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const byVar = Object.fromEntries(result.errors.map((e) => [e.envVar, e.message]));
      expect(Object.keys(byVar).sort()).toEqual([
        'DATABASE_URL',
        'LOG_LEVEL',
        'PORT',
        'SVC_NAME',
      ]);
      expect(byVar['DATABASE_URL']).toMatch(/required/);
      expect(byVar['PORT']).toMatch(/1\.\.65535/);
    }
  });

  it('honours an explicit .from() variable name', () => {
    const result = loadConfig(schema, {
      DATABASE_URL: 'postgres://x/y',
      SVC_NAME: 'named',
    });
    expect(result.ok && result.value.serviceName).toBe('named');
  });
});

describe('loadConfigOrThrow', () => {
  it('returns the value when valid', () => {
    const value = loadConfigOrThrow({ name: string() }, { NAME: 'hermes' });
    expect(value.name).toBe('hermes');
  });

  it('throws a ConfigError listing every problem', () => {
    try {
      loadConfigOrThrow(schema, {});
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const err = e as ConfigError;
      expect(err.name).toBe('ConfigError');
      expect(err.errors.length).toBe(2); // databaseUrl + serviceName required
      expect(err.message).toMatch(/DATABASE_URL/);
    }
  });
});

describe('describeSchema', () => {
  it('renders one doc row per field, purely from the schema', () => {
    const docs = describeSchema(schema);
    const db = docs.find((d) => d.key === 'databaseUrl');
    expect(db).toEqual({
      key: 'databaseUrl',
      envVar: 'DATABASE_URL',
      type: 'url',
      required: true,
      default: undefined,
      secret: true,
      description: 'Postgres connection string',
    });
    const portDoc = docs.find((d) => d.key === 'port');
    expect(portDoc?.required).toBe(false);
    expect(portDoc?.default).toBe('3000');
  });
});

describe('redactedView', () => {
  it('masks secret fields and renders the rest', () => {
    const value = loadConfigOrThrow(schema, {
      DATABASE_URL: 'postgres://secret@host/db',
      SVC_NAME: 'api',
      FEATURE_FLAG: 'true',
    });
    const view = redactedView(schema, value);
    expect(view['databaseUrl']).toBe('***');
    expect(view['port']).toBe('3000');
    expect(view['featureFlag']).toBe('true');
    expect(view['serviceName']).toBe('api');
  });

  it('leaves an unset secret blank rather than masking nothing', () => {
    const s = { token: string().secret().optional() };
    const value = loadConfigOrThrow(s, {});
    expect(redactedView(s, value)['token']).toBe('');
  });

  it('renders a non-secret unset field as blank', () => {
    const s = { note: string().optional() };
    const value = loadConfigOrThrow(s, {});
    expect(redactedView(s, value)['note']).toBe('');
  });

  it('renders list values as comma-joined', () => {
    const s = { hosts: oneOf(['a', 'b']).optional() };
    const value = loadConfigOrThrow(s, { HOSTS: 'a' });
    expect(redactedView(s, value)['hosts']).toBe('a');
  });
});
