import type { CliContext } from './context.ts'
import { createInterface } from 'node:readline'
import { CliError, USAGE_EXIT_CODE } from './context.ts'

/** Asks questions one line at a time; `undefined` once input has ended. */
export type LineReader = (question: string) => Promise<string | undefined>

/**
 * Read answers line by line from the context's stdin, showing each question
 * first. Works on a terminal and with piped answers (tests, scripts).
 */
export function createLineReader(context: CliContext): LineReader {
  const lines = createInterface({ input: context.stdin, crlfDelay: Infinity })
  const iterator = lines[Symbol.asyncIterator]()
  let ended = false
  return async (question) => {
    if (ended)
      return undefined
    context.stdout.write(question)
    const next = await iterator.next()
    if (next.done) {
      ended = true
      lines.close()
      context.stdout.write('\n')
      return undefined
    }
    if (!context.stdin.isTTY)
      context.stdout.write('\n')
    return next.value
  }
}

/** Ask and require an answer; explains which option replaces the question when input has ended. */
export async function askRequired(ask: LineReader, question: string, option: string): Promise<string> {
  const answer = await ask(question)
  if (answer === undefined)
    throw new CliError(`没有可交互的输入。请改用 ${option} 参数`, USAGE_EXIT_CODE)
  return answer.trim()
}
