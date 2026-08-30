/**
 * Telling a model that a call will need a person.
 *
 * `approval.ts` decides whether an effect happens. This decides whether the
 * thing *planning* the effect knows that in advance — a different question, and
 * the one a model can actually act on. A model that learns about the gate only
 * by hitting it reads the pause as a hang and the denial as its own mistake, and
 * its repair for both is to send the same call again.
 */

import { describe as describeSuite, expect, it } from 'vitest';
import { catalog, describe, toModelDefinition } from '../src/catalog.js';
import * as s from '../src/schema.js';
import { defineTool } from '../src/tool.js';

const deploy = defineTool({
  name: 'deploy',
  description: 'Deploy the service to an environment.',
  requiresApproval: 'replaces the running production service',
  input: s.object({ environment: s.string() }),
  execute: ({ environment }) => Promise.resolve(`deployed to ${environment}`),
});

const readFile = defineTool({
  name: 'fs.read',
  description: 'Read a UTF-8 text file from disk.',
  execute: () => Promise.resolve('contents'),
});

describeSuite('describing a gated tool', () => {
  it('carries the requirement as a field an operator can read', () => {
    expect(describe(deploy).requiresApproval).toBe(
      'replaces the running production service',
    );
  });

  it('folds the requirement into the prose a model reads', () => {
    expect(describe(deploy).description).toContain(
      'Requires human approval before it runs: replaces the running production service',
    );
  });

  it('keeps the tool description first', () => {
    // The tool still does what it says. The gate is a consequence of calling it,
    // not a correction to what it is — unlike `deprecated`, which leads.
    expect(describe(deploy).description).toMatch(
      /^Deploy the service to an environment\./,
    );
  });

  it('says nothing about approval for a tool that asked for none', () => {
    const described = describe(readFile);

    expect(described.requiresApproval).toBeUndefined();
    expect(described.description).not.toContain('approval');
  });

  it('can be switched off for a host that renders the gate itself', () => {
    const described = describe(deploy, { approval: false });

    expect(described.description).not.toContain('Requires human approval');
    // The field survives. Only the prose is suppressed — a host that turns this
    // off is taking over the rendering, not discarding the fact.
    expect(described.requiresApproval).toBe('replaces the running production service');
  });

  it('reaches the model definition, which has nowhere else to put it', () => {
    expect(toModelDefinition(deploy).description).toContain(
      'Requires human approval before it runs',
    );
  });

  it('survives alongside examples and deprecation', () => {
    const both = defineTool({
      name: 'deploy.legacy',
      description: 'Deploy using the old pipeline.',
      requiresApproval: 'replaces the running production service',
      deprecated: 'use deploy instead',
      examples: [{ description: 'Ship to prod', input: { environment: 'production' } }],
      input: s.object({ environment: s.string() }),
      execute: () => Promise.resolve('ok'),
    });

    const text = describe(both).description;

    expect(text).toMatch(/^DEPRECATED: use deploy instead/);
    expect(text).toContain('Requires human approval before it runs');
    expect(text).toContain('Examples:');
    // Approval before examples: a model that stops reading early should still
    // have met the gate.
    expect(text.indexOf('Requires human approval')).toBeLessThan(
      text.indexOf('Examples:'),
    );
  });
});

describeSuite('cataloguing gated tools', () => {
  it('describes gated and ungated tools side by side', () => {
    const registry = {
      list: () => [deploy, readFile],
    };

    const described = catalog(registry as never);

    expect(described.map((entry) => entry.name)).toEqual(['deploy', 'fs.read']);
    expect(described[0]?.requiresApproval).toBe(
      'replaces the running production service',
    );
    expect(described[1]?.requiresApproval).toBeUndefined();
  });
});
