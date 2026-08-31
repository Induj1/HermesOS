import { describe, expect, it } from 'vitest';
import { buildReviewPrompt } from '../src/review.js';

describe('buildReviewPrompt', () => {
  it('asks the agent to read a file when given a path', () => {
    const p = buildReviewPrompt('src/main.ts');
    expect(p).toContain('Read the workspace file "src/main.ts"');
    expect(p).toContain('security issues');
  });

  it('embeds a snippet directly when given code', () => {
    const p = buildReviewPrompt('const x = eval(userInput)');
    expect(p).toContain('Review this code:');
    expect(p).toContain('eval(userInput)');
  });
});
