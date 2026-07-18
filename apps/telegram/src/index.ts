/**
 * @hermes/telegram-app — a Telegram bot that drives a HermesOS task-executing
 * agent backed by a local Ollama model.
 *
 * The pure, composable pieces live here; `main.ts` (the `hermes-telegram` bin)
 * wires them to config, real ports, and the long-poll loop.
 */

export { telegramSchema, type TelegramConfig } from './config.js';
export { buildTools, type ToolDeps } from './tools.js';
export { toolExecutor, type ExecutorDeps } from './executor.js';
export {
  AGENT_NAME,
  buildAgentRuntime,
  replyText,
  type AgentRuntimeDeps,
} from './agent.js';
export {
  handleMessage,
  registerHandlers,
  type BotDeps,
  type CommandBot,
} from './bot.js';
