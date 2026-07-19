/**
 * @hermes/telegram-app — a Telegram bot that drives a HermesOS task-executing
 * agent backed by a local Ollama model.
 *
 * The pure, composable pieces live here; `main.ts` (the `hermes-telegram` bin)
 * wires them to config, real ports, and the long-poll loop.
 */

export { telegramSchema, type TelegramConfig } from './config.js';
export { buildTools, type ToolDeps } from './tools.js';
export { browserTools, type BrowsePort } from './browser.js';
export { lenientWorkspaceFs } from './workspace-fs.js';
export {
  MemoryStore,
  cosineSimilarity,
  type EmbedFn,
  type MemoryItem,
  type MemoryKind,
  type NewMemory,
  type ScoredItem,
} from './memory-store.js';
export { DOCS_SUBJECT, chunkText, htmlToText, ingestDocs, type Doc } from './rag.js';
export {
  formatBriefing,
  formatCiAlert,
  formatStandup,
  isCiFailing,
  type Briefing,
  type CiStatus,
  type RepoActivity,
  type WeatherSummary,
} from './briefing.js';
export {
  COORDINATOR,
  RouterReasoner,
  buildTeamRuntime,
  routeTo,
  type Specialist,
  type TeamRuntimeDeps,
} from './team.js';
export { largestPhoto, visionPrompt, type PhotoSize } from './vision.js';
export {
  humanDuration,
  parseDuration,
  parseReminder,
  type Reminder,
} from './reminders.js';
export {
  formatResults,
  parseDuckDuckGo,
  searchTools,
  type SearchResult,
} from './search.js';
export { toolExecutor, type ExecutorDeps } from './executor.js';
export {
  AGENT_NAME,
  buildAgentRuntime,
  replyText,
  type AgentRuntimeDeps,
} from './agent.js';
export {
  handleMessage,
  isAllowed,
  registerHandlers,
  type BotDeps,
  type CommandBot,
} from './bot.js';
