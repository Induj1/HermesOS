/**
 * The LLM reasoner, against the real model contract.
 *
 * `FakeChatModel` implements `@hermes/model`'s `ToolCallingModel` — the same
 * interface a provider will implement — so these exercise the reasoner through
 * the contract that will actually be in play. There is no provider to wait for.
 *
 * The claim that matters most: **a model asking for a tool produces a decision,
 * not a tool call.** If this reasoner ever ran one, that would be the framework's
 * central rule broken, and it is the first thing tested.
 */

import { describe, expect, it, vi } from 'vitest';
import { LlmReasoner, renderTranscript } from '../src/reasoners/llm-reasoner.js';
import {
  capability,
  chatOnlyModel,
  context,
  FakeChatModel,
  fakeMemory,
  request,
  response,
} from './helpers/fixtures.js';

const reasoner = (
  model: ConstructorParameters<typeof LlmReasoner>[0]['model'],
  rest = {},
) => new LlmReasoner({ model, ...rest });

describe('answering', () => {
  it('turns a model answer into an answer decision', async () => {
    const model = new FakeChatModel({ script: [response({ content: 'it is sunny' })] });

    const decision = await reasoner(model).reason(request(), context());

    expect(decision).toMatchObject({ kind: 'answer', content: 'it is sunny' });
  });

  it('reports what the model cost, when the model said', async () => {
    const model = new FakeChatModel({
      script: [response({ usage: { promptTokens: 10, completionTokens: 4 } })],
    });

    const decision = await reasoner(model).reason(request(), context());

    expect(decision).toMatchObject({
      usage: { promptTokens: 10, completionTokens: 4 },
    });
  });

  // Inventing a number — 0.9 because it sounded sure — would be the reasoner
  // lying in a field built for honesty.
  it('claims no confidence, because the model reported none', async () => {
    const model = new FakeChatModel({ script: [response()] });

    const decision = await reasoner(model).reason(request(), context());

    expect(decision).not.toHaveProperty('confidence');
  });
});

// The framework's central rule. If this ever failed, the design is broken.
describe('tools', () => {
  const toolCall = { id: 'call_1', name: 'search', args: { q: 'weather' } };

  it('turns a model tool call into a decision, and runs nothing', async () => {
    const model = new FakeChatModel({
      script: [
        response({ content: '', toolCalls: [toolCall], stopReason: 'tool_calls' }),
      ],
    });

    const decision = await reasoner(model).reason(
      request(),
      context({ capabilities: [capability('search')] }),
    );

    // A description of work, handed back. The reasoner has no executor and
    // AgentContext does not carry one — it could not have run this.
    expect(decision).toMatchObject({
      kind: 'tools',
      requests: [
        { id: 'call_1', name: 'search', kind: 'tool', args: { q: 'weather' } },
      ],
    });
  });

  it('tells the model what it may ask for', async () => {
    const model = new FakeChatModel({ script: [response()] });

    await reasoner(model).reason(
      request(),
      context({ capabilities: [capability('search', { description: 'Searches' })] }),
    );

    expect(model.calls[0]?.tools).toEqual([
      { name: 'search', description: 'Searches' },
    ]);
  });

  it('passes a capability parameter schema through untouched', async () => {
    const model = new FakeChatModel({ script: [response()] });
    const schema = { type: 'object', properties: { q: { type: 'string' } } };

    await reasoner(model).reason(
      request(),
      context({ capabilities: [capability('search', { parameters: schema })] }),
    );

    expect(model.calls[0]?.tools?.[0]?.parameters).toBe(schema);
  });

  // A model knows names, not the kernel's tool/agent split. Asking it to choose
  // would be asking it to guess at an implementation detail it cannot know.
  it('takes the capability kind from what is registered, not from the model', async () => {
    const model = new FakeChatModel({
      script: [response({ toolCalls: [{ id: 'c1', name: 'summariser', args: {} }] })],
    });

    const decision = await reasoner(model).reason(
      request(),
      context({ capabilities: [capability('summariser', { kind: 'agent' })] }),
    );

    expect(decision).toMatchObject({
      requests: [{ name: 'summariser', kind: 'agent' }],
    });
  });

  it('defaults an unknown capability to a tool rather than dropping the request', async () => {
    const model = new FakeChatModel({
      script: [response({ toolCalls: [{ id: 'c1', name: 'invented', args: {} }] })],
    });

    // The model hallucinated a tool. Reporting it as a request lets the executor
    // fail it honestly and the agent reason about the failure; dropping it here
    // would leave the model wondering why nothing happened.
    const decision = await reasoner(model).reason(request(), context());

    expect(decision).toMatchObject({ requests: [{ name: 'invented', kind: 'tool' }] });
  });

  it('carries the model reasoning onto the decision', async () => {
    const model = new FakeChatModel({
      script: [response({ content: 'I should look that up', toolCalls: [toolCall] })],
    });

    const decision = await reasoner(model).reason(
      request(),
      context({ capabilities: [capability('search')] }),
    );

    expect(decision).toMatchObject({
      rationale: 'I should look that up',
      requests: [{ reason: 'I should look that up' }],
    });
  });

  // Providers disagree about whether a response with tool calls stops with
  // `tool_calls` or `stop`. What matters is whether there is work to run.
  it('reads the calls rather than the stop reason', async () => {
    const model = new FakeChatModel({
      script: [response({ toolCalls: [toolCall], stopReason: 'stop' })],
    });

    const decision = await reasoner(model).reason(
      request(),
      context({ capabilities: [capability('search')] }),
    );

    expect(decision.kind).toBe('tools');
  });

  it('does not offer tools to a model that says it cannot use them', async () => {
    const model = new FakeChatModel({ script: [response()], supportsTools: false });

    await reasoner(model).reason(
      request(),
      context({ capabilities: [capability('search')] }),
    );

    // Asks the model what it can do rather than matching on its name.
    expect(model.calls[0]?.tools).toBeUndefined();
  });

  it('does not call chatWithTools on a model that does not implement it', async () => {
    // A ChatModel with no `chatWithTools` at all — the structural half of the
    // check, which a `supports.tools` flag alone would not catch.
    const model = chatOnlyModel([response()]);

    const decision = await reasoner(model).reason(
      request(),
      context({ capabilities: [capability('search')] }),
    );

    expect(decision.kind).toBe('answer');
  });

  it('does not ask for tools when none were selected', async () => {
    const model = new FakeChatModel({ script: [response()] });

    await reasoner(model).reason(request(), context({ capabilities: [] }));

    expect(model.calls[0]?.tools).toBeUndefined();
  });
});

describe('composing the prompt', () => {
  it('puts the system prompt first, built from the request', async () => {
    const model = new FakeChatModel({ script: [response()] });

    await reasoner(model, {
      systemPrompt: (req: { subject?: string }) =>
        `You are talking to ${req.subject ?? 'nobody'}`,
    }).reason(request('hi', { subject: 'ada' }), context());

    expect(model.calls[0]?.messages[0]).toEqual({
      role: 'system',
      content: 'You are talking to ada',
    });
  });

  it('omits an empty system prompt rather than sending a blank message', async () => {
    const model = new FakeChatModel({ script: [response()] });

    await reasoner(model, { systemPrompt: () => '   ' }).reason(request(), context());

    expect(model.calls[0]?.messages.every((message) => message.role !== 'system')).toBe(
      true,
    );
  });

  it('renders the request as the user message', async () => {
    const model = new FakeChatModel({ script: [response()] });

    await reasoner(model).reason(request('what is on today?'), context());

    expect(model.calls[0]?.messages).toContainEqual({
      role: 'user',
      content: 'what is on today?',
    });
  });

  it('renders a structured input as JSON by default', async () => {
    const model = new FakeChatModel({ script: [response()] });

    await reasoner(model).reason(request({ q: 'weather' }), context());

    expect(model.calls[0]?.messages).toContainEqual({
      role: 'user',
      content: '{"q":"weather"}',
    });
  });

  it('lets a host render a structured input its own way', async () => {
    const model = new FakeChatModel({ script: [response()] });

    await reasoner(model, {
      renderInput: (req: { input: unknown }) =>
        `Question: ${(req.input as { q: string }).q}`,
    }).reason(request({ q: 'weather' }), context());

    expect(model.calls[0]?.messages).toContainEqual({
      role: 'user',
      content: 'Question: weather',
    });
  });

  // On later turns the transcript already carries the request and the tool
  // results; repeating it would tell the model it had been asked twice.
  it('does not repeat the request once a transcript exists', async () => {
    const model = new FakeChatModel({ script: [response()] });
    const transcript = [{ role: 'user' as const, content: 'earlier' }];

    await reasoner(model).reason(request('do the thing'), context({ transcript }));

    const users =
      model.calls[0]?.messages.filter((message) => message.role === 'user') ?? [];
    expect(users).toEqual([{ role: 'user', content: 'earlier' }]);
  });
});

describe('memory', () => {
  // Recall costs an embedding call every turn, and memories in a prompt are
  // tokens on every turn after. An agent that wants it says so.
  it('does not recall unless asked to', async () => {
    const model = new FakeChatModel({ script: [response()] });
    const memory = { recall: vi.fn() };

    await reasoner(model).reason(
      request('hi', { subject: 'ada' }),
      context({ memory }),
    );

    expect(memory.recall).not.toHaveBeenCalled();
  });

  it('puts recalled memories in the prompt when asked', async () => {
    const model = new FakeChatModel({ script: [response()] });

    await reasoner(model, { recall: 2 }).reason(
      request('coffee?', { subject: 'ada' }),
      context({
        memory: fakeMemory(['Ada prefers dark roast', 'Ada lives in London']),
      }),
    );

    const system = model.calls[0]?.messages.find(
      (message) => message.role === 'system',
    );
    expect(system?.content).toContain('Ada prefers dark roast');
    expect(system?.content).toContain('Ada lives in London');
  });

  it('honours the recall limit', async () => {
    const model = new FakeChatModel({ script: [response()] });
    const recall = vi.fn().mockResolvedValue([]);

    await reasoner(model, { recall: 3 }).reason(
      request('hi', { subject: 'ada' }),
      context({ memory: { recall } }),
    );

    expect(recall).toHaveBeenCalledWith('ada', 'hi', { limit: 3 });
  });

  it('says nothing when there is nothing to recall', async () => {
    const model = new FakeChatModel({ script: [response()] });

    await reasoner(model, { recall: 2 }).reason(
      request('hi', { subject: 'ada' }),
      context({ memory: fakeMemory([]) }),
    );

    expect(model.calls[0]?.messages.every((message) => message.role !== 'system')).toBe(
      true,
    );
  });

  it.each([
    ['there is no memory adapter', { subject: 'ada' }, undefined],
    ['the request has no subject', {}, fakeMemory(['something'])],
  ])('skips recall when %s', async (_label, overrides, memory) => {
    const model = new FakeChatModel({ script: [response()] });

    await reasoner(model, { recall: 2 }).reason(
      request('hi', overrides),
      context(memory ? { memory } : {}),
    );

    expect(model.calls[0]?.messages.every((message) => message.role !== 'system')).toBe(
      true,
    );
  });
});

describe('when the model fails', () => {
  // Nothing is caught. A model being down is exactly what ReasonerChain handles
  // by falling through to the deterministic reasoner behind this one; catching
  // it to return an abstain would hide the failure from the chain's account of
  // itself and from the operator reading it.
  it('lets the failure out, for the chain to handle', async () => {
    const model = new FakeChatModel({ script: [new Error('model is down')] });

    await expect(reasoner(model).reason(request(), context())).rejects.toThrow(
      'model is down',
    );
  });

  it('passes the caller signal to the model', async () => {
    const model = new FakeChatModel({ script: [response()] });

    await expect(
      reasoner(model).reason(request(), context({ signal: AbortSignal.abort() })),
    ).rejects.toThrow();
  });
});

describe('renderTranscript', () => {
  const render = (req: { input: unknown }): string => String(req.input);

  it('is empty before anything has happened', () => {
    expect(renderTranscript(request('hi'), [], render)).toEqual([]);
  });

  it('replays a tool turn as an assistant call and its results', () => {
    const messages = renderTranscript(
      request('what is on today?'),
      [
        {
          decision: {
            kind: 'tools',
            rationale: 'looking it up',
            requests: [
              { id: 'c1', name: 'search', kind: 'tool', args: { q: 'today' } },
            ],
          },
          observations: [{ id: 'c1', name: 'search', ok: true, result: 'a standup' }],
        },
      ],
      render,
    );

    expect(messages).toEqual([
      { role: 'user', content: 'what is on today?' },
      {
        role: 'assistant',
        content: 'looking it up',
        toolCalls: [{ id: 'c1', name: 'search', args: { q: 'today' } }],
      },
      { role: 'tool', content: 'a standup', toolCallId: 'c1', name: 'search' },
    ]);
  });

  // A model that never learns a tool failed will ask for it again next turn.
  it('tells the model when a tool failed, rather than hiding it', () => {
    const messages = renderTranscript(
      request('hi'),
      [
        {
          decision: {
            kind: 'tools',
            requests: [{ id: 'c1', name: 'search', kind: 'tool', args: {} }],
          },
          observations: [
            { id: 'c1', name: 'search', ok: false, error: { message: 'timed out' } },
          ],
        },
      ],
      render,
    );

    expect(messages[2]).toMatchObject({ role: 'tool', content: 'Error: timed out' });
  });

  it('renders a structured tool result as JSON', () => {
    const messages = renderTranscript(
      request('hi'),
      [
        {
          decision: {
            kind: 'tools',
            requests: [{ id: 'c1', name: 'search', kind: 'tool', args: {} }],
          },
          observations: [{ id: 'c1', name: 'search', ok: true, result: { hits: 2 } }],
        },
      ],
      render,
    );

    expect(messages[2]?.content).toBe('{"hits":2}');
  });

  it('says so when a tool returned nothing', () => {
    const messages = renderTranscript(
      request('hi'),
      [
        {
          decision: {
            kind: 'tools',
            requests: [{ id: 'c1', name: 'noop', kind: 'tool', args: {} }],
          },
          observations: [{ id: 'c1', name: 'noop', ok: true }],
        },
      ],
      render,
    );

    expect(messages[2]?.content).toBe('(no output)');
  });

  it('replays an answer turn', () => {
    const messages = renderTranscript(
      request('hi'),
      [{ decision: { kind: 'answer', content: 'hello' } }],
      render,
    );

    expect(messages[1]).toEqual({ role: 'assistant', content: 'hello' });
  });

  it('ignores a turn a model has no vocabulary for', () => {
    // A delegation is a framework concept; a model has no idea what it means, and
    // rendering it would put a sentence in the transcript nobody said.
    const messages = renderTranscript(
      request('hi'),
      [{ decision: { kind: 'delegate', agent: 'other' } }],
      render,
    );

    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('the reasoner itself', () => {
  it('names itself, and takes a name', () => {
    const model = new FakeChatModel({ script: [] });

    expect(reasoner(model).name).toBe('llm');
    expect(new LlmReasoner({ model, name: 'planner-brain' }).name).toBe(
      'planner-brain',
    );
  });

  it('exposes its model, for a router logs', () => {
    const model = new FakeChatModel({ script: [] });

    expect(reasoner(model).model).toBe(model);
  });

  it('passes temperature and maxTokens through', async () => {
    const model = new FakeChatModel({ script: [response()] });
    const spy = vi.spyOn(model, 'chat');

    await new LlmReasoner({ model, temperature: 0.2, maxTokens: 100 }).reason(
      request(),
      context(),
    );

    expect(spy.mock.calls[0]?.[1]).toMatchObject({ temperature: 0.2, maxTokens: 100 });
  });
});
