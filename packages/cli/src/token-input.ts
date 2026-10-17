import type { CliContext } from './context.ts'
import { Buffer } from 'node:buffer'
import { CliError } from './context.ts'

const MAX_TOKEN_INPUT_BYTES = 4096

/** Read a token piped on stdin (`--token-stdin`), trimming surrounding whitespace. */
export async function readTokenFromStdin(context: CliContext): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of context.stdin) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > MAX_TOKEN_INPUT_BYTES)
      throw new CliError('标准输入太长，--token-stdin 只接受一个 token')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

/**
 * Ask for a token on an interactive terminal without echoing it. Returns
 * `undefined` when the user enters nothing.
 */
export function promptForToken(context: CliContext, prompt: string): Promise<string | undefined> {
  const { stdin } = context
  if (!stdin.isTTY || stdin.setRawMode === undefined)
    return Promise.resolve(undefined)
  context.stderr.write(prompt)
  return new Promise((resolve, reject) => {
    let value = ''
    function onData(chunk: Buffer | string): void {
      for (const character of chunk.toString()) {
        if (character === '\r' || character === '\n' || character === '\u0004') {
          finish()
          return
        }
        if (character === '\u0003') {
          finish(new CliError('已取消', 130))
          return
        }
        if (character === '\u007F' || character === '\b')
          value = value.slice(0, -1)
        else if (character >= ' ')
          value += character
      }
    }
    function finish(error?: Error): void {
      stdin.setRawMode!(false)
      stdin.removeListener('data', onData)
      stdin.pause()
      context.stderr.write('\n')
      if (error === undefined)
        resolve(value.trim() === '' ? undefined : value.trim())
      else
        reject(error)
    }
    stdin.setRawMode!(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}
