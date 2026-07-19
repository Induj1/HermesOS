import { loadConfigOrThrow } from '@hermes/config';
import { describe, expect, it } from 'vitest';
import { telegramSchema } from '../src/config.js';

describe('telegramSchema', () => {
  it('applies defaults when only the token is set', () => {
    const config = loadConfigOrThrow(telegramSchema, { TELEGRAM_BOT_TOKEN: 'secret' });

    expect(config.telegramBotToken).toBe('secret');
    expect(config.ollamaBaseUrl).toBe('http://localhost:11434/v1');
    expect(config.ollamaModel).toBe('qwen2.5:0.5b');
    expect(config.workspaceDir).toBe('./hermes-workspace');
    expect(config.enableShell).toBe(false);
    expect(config.maxTurns).toBe(12);
    expect(config.pollIntervalMs).toBe(1_000);
    expect(config.logLevel).toBe('info');
    expect(config.serviceName).toBe('hermes-telegram');
    expect(config.shellAllowlist).toContain('ls');
  });

  it('throws when the required token is missing', () => {
    expect(() => loadConfigOrThrow(telegramSchema, {})).toThrow();
  });

  it('parses overrides, including the comma-separated shell allowlist', () => {
    const config = loadConfigOrThrow(telegramSchema, {
      TELEGRAM_BOT_TOKEN: 'secret',
      OLLAMA_MODEL: 'qwen2.5:7b',
      ENABLE_SHELL: 'true',
      SHELL_ALLOWLIST: 'ls,cat,git',
      MAX_TURNS: '10',
    });

    expect(config.ollamaModel).toBe('qwen2.5:7b');
    expect(config.enableShell).toBe(true);
    expect(config.shellAllowlist).toEqual(['ls', 'cat', 'git']);
    expect(config.maxTurns).toBe(10);
  });
});
