import type { Sandbox } from './helpers.ts'
import { Buffer } from 'node:buffer'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../src/run.ts'
import { readTerminalLine } from '../src/terminal-input.ts'
import { createRepository, createSandbox, git, runYunBox } from './helpers.ts'

vi.mock('../src/terminal-input.ts', () => ({ readTerminalLine: vi.fn() }))
const sandboxes: Sandbox[] = []
afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(sandboxes.splice(0).map(sandbox => sandbox.cleanup()))
})

async function setup() {
  const sandbox = await createSandbox()
  sandboxes.push(sandbox)
  const repo = await createRepository(sandbox)
  await writeFile(join(repo, 'large.txt'), 'a'.repeat(8192))
  await git(sandbox, repo, 'add', '.')
  await git(sandbox, repo, 'commit', '-qm', 'test: add file')
  return { sandbox, repo }
}

describe('terminal reports and confirmation selection', () => {
  it('honors saved terminal mode, environment overrides, then the explicit CLI mode', async () => {
    const { sandbox, repo } = await setup()
    delete sandbox.env.YUNBOX_CONFIRM_UI
    await git(sandbox, repo, 'config', 'yunbox.confirmUI', 'terminal')
    vi.mocked(readTerminalLine).mockResolvedValue('y 美术已确认')
    const args = ['inspect', '--push', '--file-limit', '4k', '--confirm']
    const confirmed = await runYunBox(sandbox, repo, args)
    expect(confirmed.code).toBe(0)
    expect(confirmed.stderr).toContain('已确认，继续推送。原因：美术已确认')
    expect(readTerminalLine).toHaveBeenCalledOnce()

    sandbox.env.YUNBOX_CONFIRM_UI = 'none'
    expect((await runYunBox(sandbox, repo, args)).code).toBe(1)
    expect(readTerminalLine).toHaveBeenCalledOnce()
    vi.mocked(readTerminalLine).mockResolvedValue('n 先压缩图片')
    const cancelled = await runYunBox(sandbox, repo, [...args, '--confirm-ui', 'terminal'])
    expect(cancelled.code).toBe(1)
    expect(cancelled.stderr).toContain('先压缩图片')
    expect(readTerminalLine).toHaveBeenCalledTimes(2)
  })

  it('never mistakes pre-push stdin for an approval when no console can be read', async () => {
    const { sandbox, repo } = await setup()
    const oid = await git(sandbox, repo, 'rev-parse', 'HEAD')
    vi.mocked(readTerminalLine).mockResolvedValue(undefined)
    const result = await runYunBox(sandbox, repo, ['inspect', '--push', '--stdin', '--file-limit', '4k', '--confirm', '--confirm-ui', 'terminal'], `refs/heads/main ${oid} refs/heads/main ${'0'.repeat(40)}\n`)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('无法请求确认')
    expect(result.stderr).not.toContain('可提高限额')
  })

  it('colors the human report but keeps JSON clean even with a TTY', async () => {
    const { sandbox, repo } = await setup()
    const env = { ...sandbox.env, TERM: 'xterm-256color', NO_COLOR: '', CI: '', FORCE_COLOR: '1' }
    const run = async (args: string[]) => {
      const stdout = Object.assign(new PassThrough(), { isTTY: true })
      const chunks: Buffer[] = []
      stdout.on('data', chunk => chunks.push(chunk))
      const code = await runCli(args, { cwd: repo, env, stdin: Readable.from([]), stdout, stderr: new PassThrough() })
      return { code, text: Buffer.concat(chunks).toString() }
    }
    const human = await run(['inspect', '--push', '--file-limit', '4k'])
    expect(human.text).toContain('\u001B[31m')
    expect(human.text).toContain('云匣 · 推送检查')
    expect(human.text).toContain('素材目标')
    const json = await run(['inspect', '--push', '--file-limit', '4k', '--json'])
    expect(json.text).not.toContain('\u001B')
    expect(JSON.parse(json.text)).toMatchObject({ schemaVersion: 1, status: 'exceeded' })
    const pipe = await runYunBox(sandbox, repo, ['inspect', '--push', '--file-limit', '4k'])
    expect(pipe.stdout).not.toContain('\u001B')
  })
})
