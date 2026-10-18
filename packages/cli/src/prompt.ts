import type { CliContext } from './context.ts'
import { createInterface } from 'node:readline'
import { CliError, USAGE_EXIT_CODE } from './context.ts'

/** Asks questions one line at a time; `undefined` once input has ended. */
export interface LineReader {
  (question: string): Promise<string | undefined>
  /** Stop reading stdin. Always call it: an open reader keeps the process alive. */
  close: () => void
}

/**
 * Read answers line by line from the context's stdin, showing each question
 * first. Works on a terminal and with piped answers (tests, scripts). stdin is
 * only touched once a question is actually asked, so a command that needs no
 * answers never waits on it.
 */
export function createLineReader(context: CliContext): LineReader {
  let lines: ReturnType<typeof createInterface> | undefined
  let iterator: AsyncIterator<string> | undefined
  let ended = false
  const close = (): void => {
    ended = true
    lines?.close()
    lines = undefined
  }
  const ask = async (question: string): Promise<string | undefined> => {
    if (ended)
      return undefined
    if (lines === undefined) {
      lines = createInterface({ input: context.stdin, crlfDelay: Infinity })
      iterator = lines[Symbol.asyncIterator]()
    }
    context.stdout.write(question)
    const next = await iterator!.next()
    if (next.done) {
      close()
      context.stdout.write('\n')
      return undefined
    }
    if (!context.stdin.isTTY)
      context.stdout.write('\n')
    return next.value
  }
  return Object.assign(ask, { close })
}

/** Ask and require an answer; explains which option replaces the question when input has ended. */
export async function askRequired(ask: LineReader, question: string, option: string): Promise<string> {
  const answer = await ask(question)
  if (answer === undefined)
    throw new CliError(`没有可交互的输入。请改用 ${option} 参数`, USAGE_EXIT_CODE)
  return answer.trim()
}
