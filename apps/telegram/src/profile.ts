/**
 * Owner personalisation: a free-text profile of the person the bot serves, woven
 * into every agent's system prompt so the assistant always knows who it is
 * helping — their name, stack, background, and how they like to be helped.
 *
 * Pure and tiny on purpose: main.ts supplies the profile text from config
 * (OWNER_PROFILE), and both the single-agent and team runtimes route their
 * system prompts through here.
 */

/** Append an "about your user" block to a base system prompt, if a profile is set. */
export function withOwnerProfile(basePrompt: string, ownerProfile?: string): string {
  const profile = ownerProfile?.trim() ?? '';
  if (profile === '') return basePrompt;
  return (
    `${basePrompt}\n\n` +
    `ABOUT YOUR USER — the person you are assisting:\n${profile}\n\n` +
    'Tailor everything to them: address them by name when natural, assume their ' +
    'stack and expertise, honour their stated preferences, and skip basics they ' +
    'already know.'
  );
}
