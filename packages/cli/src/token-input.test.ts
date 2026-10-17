import type { Buffer } from 'node:buffer'
import type { CliContext } from './context.ts'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { promptForToken } from './token-input.ts'

function terminal(): { context: CliContext, stdin: PassThrough & { isTTY: boolean, setRawMode: (mode: boolean) => void }, rawModes: boolean[], stderr: () => string } {
  const rawModes: boolean[] = []
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (mode: boolean) => void rawModes.push(mode) })
  const stderr = new PassThrough()
  let written = ''
  stderr.on('data', (chunk: Buffer) => {
    written += chunk.toString()
  })
  return { context: { cwd: '.', env: {}, stdin, stdout: new PassThrough(), stderr }, stdin, rawModes, stderr: () => written }
}

describe('promptForToken', () => {
  it('reads a line in raw mode without echoing it', async () => {
    const { context, stdin, rawModes, stderr } = terminal()
    const answer = promptForToken(context, 'token: ')
    stdin.write('ybx_abc')
    stdin.write('X\u007F_def\r')
    expect(await answer).toBe('ybx_abc_def')
    expect(rawModes).toEqual([true, false])
    expect(stderr()).toBe('token: \n')
  })

  it('returns undefined for an empty answer and rejects on Ctrl-C', async () => {
    const empty = terminal()
    const answer = promptForToken(empty.context, '> ')
    empty.stdin.write('\n')
    expect(await answer).toBeUndefined()

    const cancelled = terminal()
    const cancel = promptForToken(cancelled.context, '> ')
    cancelled.stdin.write('ybx\u0003')
    await expect(cancel).rejects.toThrow('已取消')
    expect(cancelled.rawModes).toEqual([true, false])
  })

  it('does not prompt without a terminal', async () => {
    const { context, stdin } = terminal()
    stdin.isTTY = false
    expect(await promptForToken(context, '> ')).toBeUndefined()
  })
})
