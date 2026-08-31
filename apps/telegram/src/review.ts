/**
 * Code review: build a prompt that has the agent review a snippet the way the
 * owner would want — correctness, security, and clarity first. Pure; bot.ts
 * wires /review and main.ts runs the agent.
 */

/** Build a code-review prompt for the given code (or a workspace path to read). */
export function buildReviewPrompt(codeOrPath: string): string {
  const arg = codeOrPath.trim();
  const looksLikePath = /^[\w./-]+\.\w{1,6}$/.test(arg) && !arg.includes('\n');
  const target = looksLikePath
    ? `Read the workspace file "${arg}" with your file tools, then review it.`
    : `Review this code:\n\n${arg}`;
  return (
    `${target}\n\n` +
    'Give a focused review: call out correctness bugs and edge cases first, then ' +
    'security issues (injection, authz, secrets, unsafe deserialisation), then ' +
    'clarity/maintainability. Be specific — quote the line and suggest the fix. ' +
    'End with a one-line verdict. Keep it tight enough to read on a phone.'
  );
}
