/**
 * Career toolkit: résumé-grounded helpers for a job hunt. Each command builds a
 * focused prompt that the agent answers with the owner's profile (always in the
 * system prompt) and any ingested résumé (RAG) as the source of truth.
 *
 * This module is the pure part — turning a command + its argument into that
 * prompt. main.ts runs the agent; bot.ts wires the commands.
 */

/** The résumé-grounded tasks the career commands support. */
export type CareerTask = 'coverletter' | 'tailor' | 'interview';

const GROUND =
  'Use everything you know about me — my owner profile and any ingested résumé — ' +
  'as the source of truth about my experience, skills, and projects. Do not ' +
  'invent facts about me; if something is missing, make one reasonable assumption ' +
  'and note it briefly.';

/** Build the agent prompt for a career task and its free-text input (a JD, role…). */
export function buildCareerPrompt(task: CareerTask, input: string): string {
  const arg = input.trim();
  switch (task) {
    case 'coverletter':
      return (
        `${GROUND}\n\n` +
        'Write a concise, specific cover letter for the job below. Ground every ' +
        "claim in my real experience, match it to the role's needs, and keep it " +
        'under ~250 words — professional but human, no clichés.\n\n' +
        `JOB:\n${arg}`
      );
    case 'tailor':
      return (
        `${GROUND}\n\n` +
        'Tailor my résumé to the job description below: pick and rewrite my most ' +
        'relevant bullets (impact-first and quantified), propose a 2-line summary, ' +
        'list the top matching skills, and flag any gaps I should address. Be ' +
        'concrete and concise.\n\n' +
        `JOB DESCRIPTION:\n${arg}`
      );
    case 'interview':
      return (
        `${GROUND}\n\n` +
        `Prepare me for interviews for: ${arg === '' ? 'roles that match my background' : arg}. ` +
        'Give 8–10 likely questions (a mix of technical, system-design/security, ' +
        'and behavioural) and, for each, a tight answer grounded in MY projects and ' +
        'experience. Prioritise what fits my stack.'
      );
  }
}
