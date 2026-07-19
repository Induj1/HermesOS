/**
 * A Python tool: run Python 3 (pandas / numpy / matplotlib) in the workspace.
 *
 * This makes the bot a data analyst — it can compute, and save charts the user
 * downloads with /get. The actual execution is injected as a `run` port so this
 * stays a testable unit; main.ts runs the venv Python with the workspace as cwd.
 */

import { defineTool, s } from '@hermes/tools';
import type { HermesTool } from '@hermes/tools';

/** Run a Python snippet and return its combined stdout/stderr. */
export type PythonRunPort = (code: string) => Promise<string>;

/** A `python.run` tool over the given run port. */
export function pythonTools(run: PythonRunPort): readonly HermesTool[] {
  const tool = defineTool({
    name: 'python.run',
    description:
      'Run Python 3 in the workspace. pandas, numpy, and matplotlib are available. ' +
      'To make a chart, use matplotlib and save it with ' +
      "plt.savefig('chart.png'), then tell the user to download it with /get " +
      "chart.png. print() what you want to report. Returns the script's output.",
    tags: ['python', 'data'],
    input: s.object({ code: s.string({ description: 'The Python 3 source to run.' }) }),
    output: s.string(),
    execute: ({ code }) => run(code),
  });
  return [tool];
}
