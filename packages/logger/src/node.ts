/**
 * The console adapter — the one place this package writes to a real stream.
 * Kept out of the core so records and formatting stay pure and testable.
 */

import type { LogRecord } from './logger.js';
import { formatJsonLine } from './sink.js';

/**
 * A sink that writes JSON lines to the process streams: `warn`/`error` to
 * stderr, `debug`/`info` to stdout — the split that lets an operator separate
 * problems from chatter with a redirect.
 */
export function consoleSink(): { write(record: LogRecord): void } {
  return {
    write: (record) => {
      const line = formatJsonLine(record);
      if (record.level === 'warn' || record.level === 'error') {
        process.stderr.write(`${line}\n`);
      } else {
        process.stdout.write(`${line}\n`);
      }
    },
  };
}
