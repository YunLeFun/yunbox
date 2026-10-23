import type { CliContext } from './context.ts'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { terminalFor, terminalText } from './terminal.ts'

function context(tty: boolean, env: NodeJS.ProcessEnv = {}): CliContext {
  return { cwd: '.', env, stdin: Readable.from([]), stdout: Object.assign(new PassThrough(), { isTTY: tty }), stderr: new PassThrough() }
}

describe('terminal emphasis', () => {
  it('uses semantic color on a terminal, never in pipes, CI or NO_COLOR output', () => {
    expect(terminalFor(context(true)).paint('error', '! 超限')).toBe('\u001B[31m! 超限\u001B[0m')
    for (const env of [{ NO_COLOR: '1' }, { TERM: 'dumb' }, { CI: 'true' }, { FORCE_COLOR: '0' }])
      expect(terminalFor(context(true, env)).paint('error', '! 超限')).toBe('! 超限')
    expect(terminalFor(context(false, { FORCE_COLOR: '1' })).title('推送检查')).toBe('云匣 · 推送检查')
    expect(terminalFor(context(true), 'stderr').paint('warning', '? 确认')).toBe('? 确认')
  })

  it('makes repository-provided terminal controls visible', () => {
    expect(terminalText('art/\u001B[31m\n\u009B\u202E.png')).toBe('art/\\u001b[31m\\u000a\\u009b\\u202e.png')
    expect(terminalText('素材/英雄.png')).toBe('素材/英雄.png')
  })
})
