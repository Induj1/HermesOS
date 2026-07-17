/**
 * LlmReasoner — decides by asking a model.
 *
 * ## It is real, and it has no provider
 *
 * This is written entirely against `@hermes/model`'s `ChatModel` /
 * `ToolCallingModel` interfaces. No Ollama, no Claude, no OpenAI, no HTTP, no
 * keys. It is not a stub or a sketch: it is the finished reasoner, and the day a
 * provider ships, it is constructed with one and works. Its tests run against a
 * fake model that implements the same interface — which is not a compromise,
 * because the interface is the contract a real provider will satisfy too.
 *
 * That is the payoff for `@hermes/model` being its own package with no
 * dependencies (RFC-0005 §4): the reasoning layer can be finished and tested
 * before the provider layer exists.
 *
 * ## What it does, and the one thing it must not
 *
 * It renders the request, the transcript and the offered capabilities into
 * messages, calls the model, and **translates the model's answer into a
 * decision**. A model asking for tools becomes a `ToolsDecision`; a model
 * answering becomes an `AnswerDecision`.
 *
 * It never runs a tool. It cannot: it has no executor, `AgentContext` does not
 * carry one, and `@hermes/model` has nothing that executes. The model *requests*
 * (`ToolCall`), the reasoner *decides* (`ToolRequest`), and something else acts.
 * The two types are one-to-one here and still distinct, because the reasoner is
 * entitled to drop a call, rewrite it, or refuse — see §5.3.
 */

import type {
  ChatModel,
  ModelMessage,
  ModelResponse,
  ToolCallingModel,
  ToolDefinition,
} from '@hermes/model';
import { assistant, system, user, wantsTools } from '@hermes/model';
import type { AgentContext } from '../context.js';
import type { AgentDecision, AgentRequest, ToolRequest } from '../model.js';
import type { Reasoner } from '../ports/reasoner.js';

export interface LlmReasonerOptions {
  readonly name?: string;
  /**
   * The model. A `ToolCallingModel` gets tools; a plain `ChatModel` does not.
   *
   * One field rather than two, and the reasoner asks the model what it is. The
   * alternative — a `tools: boolean` the host sets — would let the host claim a
   * model supports tools when it does not, and the failure would arrive from
   * inside a provider as a shape nobody could read.
   */
  readonly model: ChatModel | ToolCallingModel;
  /**
   * Prepended to every conversation.
   *
   * A function rather than a string, so it can be built from the request — which
   * is what makes "you are talking to {subject}" possible without a template
   * language. A host that wants a constant returns one.
   */
  systemPrompt?(request: AgentRequest, ctx: AgentContext): string;
  /**
   * Turn the request into what the user "said".
   *
   * Defaults to rendering `request.input`. Overridden by a host whose input is
   * structured and wants it presented in a particular way — because the default
   * is `JSON.stringify`, and a model reads prose better than it reads JSON.
   */
  renderInput?(request: AgentRequest, ctx: AgentContext): string;
  /**
   * How many memories to recall and put in the prompt. Default 0 — off.
   *
   * Off by default deliberately. Recall costs an embedding call on every turn,
   * and memories in a prompt are tokens on every turn after that. An agent that
   * wants memory says so; one that does not should not pay for it.
   */
  readonly recall?: number;
  readonly temperature?: number;
  readonly maxTokens?: number;
}

export class LlmReasoner implements Reasoner {
  readonly name: string;
  readonly #options: LlmReasonerOptions;

  constructor(options: LlmReasonerOptions) {
    this.name = options.name ?? 'llm';
    this.#options = options;
  }

  /** The model this reasoner asks. For diagnostics and for a router's logs. */
  get model(): ChatModel | ToolCallingModel {
    return this.#options.model;
  }

  async reason(request: AgentRequest, ctx: AgentContext): Promise<AgentDecision> {
    const messages = await this.#compose(request, ctx);
    const tools = toToolDefinitions(ctx);

    // Nothing is caught here, and that is deliberate. A model being down, rate
    // limited, or returning nonsense is exactly what `ReasonerChain` handles by
    // falling through to the deterministic reasoner behind this one. Catching it
    // to return an `abstain` would look tidier and would hide the failure from
    // the chain's account of itself, and from the operator reading it.
    const response = await this.#ask(messages, tools, ctx);

    return this.#decide(response, ctx);
  }

  /** Ask the model, using tools only if it actually supports them. */
  async #ask(
    messages: readonly ModelMessage[],
    tools: readonly ToolDefinition[],
    ctx: AgentContext,
  ): Promise<ModelResponse> {
    const options = {
      ...(this.#options.temperature === undefined
        ? {}
        : { temperature: this.#options.temperature }),
      ...(this.#options.maxTokens === undefined
        ? {}
        : { maxTokens: this.#options.maxTokens }),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    };

    // Asks the model what it can do rather than matching on its name — a table of
    // model-name prefixes is wrong the day a provider ships a new one
    // (`ModelFeatures`).
    if (
      tools.length > 0 &&
      this.#options.model.info.supports.tools &&
      isToolCalling(this.#options.model)
    ) {
      return await this.#options.model.chatWithTools(messages, tools, options);
    }
    return await this.#options.model.chat(messages, options);
  }

  /** Build the conversation: system, memories, transcript, request. */
  async #compose(
    request: AgentRequest,
    ctx: AgentContext,
  ): Promise<readonly ModelMessage[]> {
    const messages: ModelMessage[] = [];

    const prompt = this.#options.systemPrompt?.(request, ctx);
    if (prompt !== undefined && prompt.trim() !== '') messages.push(system(prompt));

    const memories = await this.#recall(request, ctx);
    if (memories !== undefined) messages.push(system(memories));

    // The session built the transcript, so every reasoner in a chain agrees on
    // what was said rather than each rebuilding it from `history`.
    messages.push(...ctx.transcript);

    // Only on the first turn. On later turns the transcript already carries the
    // request and the tool results, and repeating it would tell the model it had
    // been asked twice.
    if (ctx.transcript.length === 0) {
      messages.push(user(this.#render(request, ctx)));
    }

    return messages;
  }

  async #recall(request: AgentRequest, ctx: AgentContext): Promise<string | undefined> {
    const limit = this.#options.recall ?? 0;
    if (limit <= 0 || ctx.memory === undefined || request.subject === undefined)
      return undefined;

    const found = await ctx.memory.recall(request.subject, this.#render(request, ctx), {
      limit,
    });
    if (found.length === 0) return undefined;

    return [
      'What you already know about this subject:',
      ...found.map((scored) => `- ${scored.memory.content}`),
    ].join('\n');
  }

  #render(request: AgentRequest, ctx: AgentContext): string {
    if (this.#options.renderInput) return this.#options.renderInput(request, ctx);
    return typeof request.input === 'string'
      ? request.input
      : JSON.stringify(request.input);
  }

  /**
   * Turn the model's answer into a decision.
   *
   * `wantsTools` reads the calls rather than the stop reason, because providers
   * disagree about whether a response carrying tool calls stops with
   * `tool_calls` or `stop`, and some emit both text and calls.
   */
  #decide(response: ModelResponse, ctx: AgentContext): AgentDecision {
    if (wantsTools(response)) {
      const requests = (response.toolCalls ?? []).map((call): ToolRequest => {
        // The kind comes from what is registered, not from the model. A model
        // knows names, not the kernel's tool/agent split — and asking it to
        // choose would be asking it to guess at an implementation detail it has
        // no way to know.
        const known = ctx.capabilities.find(
          (capability) => capability.name === call.name,
        );
        return {
          id: call.id,
          name: call.name,
          kind: known?.kind ?? 'tool',
          args: call.args,
          ...(response.content.trim() === '' ? {} : { reason: response.content }),
        };
      });

      return {
        kind: 'tools',
        requests,
        ...(response.content.trim() === '' ? {} : { rationale: response.content }),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      };
    }

    return {
      kind: 'answer',
      content: response.content,
      // No confidence. The model did not report one, and inventing a number —
      // 0.9 because it sounded sure — would be this reasoner lying in a field
      // built for honesty (`AnswerDecision.confidence`). A reasoner that can
      // genuinely measure it sets it; this one cannot, so it says nothing.
      ...(response.usage === undefined ? {} : { usage: response.usage }),
    };
  }
}

/** What the model is told exists. Descriptions only; nothing runnable. */
function toToolDefinitions(ctx: AgentContext): readonly ToolDefinition[] {
  return ctx.capabilities.map((capability) => ({
    name: capability.name,
    description: capability.description,
    ...(capability.parameters === undefined
      ? {}
      : { parameters: capability.parameters }),
  }));
}

/** Does this model implement the tool-calling half of the contract? */
function isToolCalling(model: ChatModel | ToolCallingModel): model is ToolCallingModel {
  return typeof (model as ToolCallingModel).chatWithTools === 'function';
}

/**
 * Render a session's turns as a model conversation.
 *
 * Exported and used by `AgentSession` rather than living inside this reasoner,
 * because the *session* owns the transcript — a chain of three reasoners must
 * agree on what was said, and each building its own from `history` would be three
 * chances to disagree.
 *
 * It is here rather than in `session.ts` because this is where the model
 * vocabulary lives. The session knows about turns; this file knows how a turn
 * looks to a model.
 */
export function renderTranscript(
  request: AgentRequest,
  history: readonly {
    readonly decision: AgentDecision;
    readonly observations?: readonly {
      readonly id: string;
      readonly name: string;
      readonly ok: boolean;
      readonly result?: unknown;
      readonly error?: { readonly message: string };
    }[];
  }[],
  renderInput: (request: AgentRequest) => string,
): readonly ModelMessage[] {
  if (history.length === 0) return [];

  const messages: ModelMessage[] = [user(renderInput(request))];

  for (const turn of history) {
    if (turn.decision.kind === 'tools') {
      messages.push(
        assistant(
          turn.decision.rationale ?? '',
          turn.decision.requests.map((toolRequest) => ({
            id: toolRequest.id,
            name: toolRequest.name,
            args: toolRequest.args,
          })),
        ),
      );

      for (const observation of turn.observations ?? []) {
        messages.push({
          role: 'tool',
          // A failed tool is reported to the model as text rather than hidden or
          // thrown: a tool failing is information the agent should reason about
          // — retry differently, try another approach, explain — and a model that
          // never learns a tool failed will ask for it again on the next turn.
          content: observation.ok
            ? renderResult(observation.result)
            : `Error: ${observation.error?.message ?? 'the tool failed'}`,
          toolCallId: observation.id,
          name: observation.name,
        });
      }
      continue;
    }

    if (turn.decision.kind === 'answer') {
      messages.push(assistant(renderResult(turn.decision.content)));
    }
  }

  return messages;
}

function renderResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return '(no output)';
  try {
    // TypeScript types `JSON.stringify` as returning `string`. It does not: for a
    // function or a symbol it returns `undefined`, and a hand-written executor
    // can hand back either. The annotation restores the type the runtime
    // actually has, so the guard below is honest rather than dead.
    const json = JSON.stringify(result) as string | undefined;
    return json ?? '(no output)';
  } catch {
    /* c8 ignore next 3 -- A circular tool result. Unreachable through the
       execution engine, which requires results to be JSON (RFC-0004 §7.6);
       reachable through a hand-written executor, and a transcript that threw
       would take down a session over a tool's return value. */
    return '(unserialisable output)';
  }
}
