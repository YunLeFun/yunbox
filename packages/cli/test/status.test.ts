import type { Sandbox } from './helpers.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRepository, createSandbox, git, runYunBox } from './helpers.ts'

const sandboxes: Sandbox[] = []
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(sandbox => sandbox.cleanup()))
})

async function setup(config: string) {
  const sandbox = await createSandbox()
  sandboxes.push(sandbox)
  const repo = await createRepository(sandbox)
  await mkdir(join(repo, '.yunbox'))
  await writeFile(join(repo, '.yunbox/config'), config)
  await git(sandbox, repo, 'remote', 'add', 'origin', 'https://user:secret@github.com/team/game.git?token=hidden')
  return { sandbox, repo }
}

const cos = '[cos]\n bucket = team-assets-1250000000\n region = ap-shanghai\n prefix = yunbox/team/game\n'

describe('local transfer status', () => {
  it.each([
    ['COS', cos],
    ['S3', '[storage]\n provider = s3\n[s3]\n endpoint = https://s3.example.com\n bucket = game-assets\n region = auto\n prefix = team/game\n'],
  ])('shows %s direct mode without credentials, including when an old LFS URL remains', async (label, config) => {
    const { sandbox, repo } = await setup(config)
    await git(sandbox, repo, 'config', 'lfs.standalonetransferagent', 'yunbox')
    await git(sandbox, repo, 'config', 'lfs.customtransfer.yunbox.path', 'git-yunbox')
    await git(sandbox, repo, 'config', '--file', '.lfsconfig', 'lfs.url', 'https://old.example.com/team/game')
    const result = await runYunBox(sandbox, repo, ['status'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`素材目标：${label} ·`)
    expect(result.stdout).toContain('（直连）')
    expect(result.stdout).toContain('代码目标：github.com/team/game')
    expect(result.stdout).toContain('当前独立传输代理不会使用')
    expect(result.stdout).not.toMatch(/未配置|secret|hidden|old.example/)
    expect(result.stdout).not.toContain('\u001B')
  })

  it('does not claim direct mode for a new clone until its agent is registered', async () => {
    const { sandbox, repo } = await setup(cos)
    const check = async () => {
      const result = await runYunBox(sandbox, repo, ['status'])
      expect(result.stdout).toContain('YunBox 直连尚未就绪')
      expect(result.stdout).toContain('git yunbox init')
      expect(result.stdout).not.toContain('（直连）')
    }
    await check()
    await git(sandbox, repo, 'config', 'lfs.standalonetransferagent', 'yunbox')
    await check() // Still missing the custom agent command.
    await git(sandbox, repo, 'config', 'lfs.standalonetransferagent', 'other')
    await check()
  })

  it('uses the push URL and redacts LFS credentials and query strings', async () => {
    const { sandbox, repo } = await setup('')
    await git(sandbox, repo, 'remote', 'set-url', '--push', 'origin', 'https://user:secret@push.example.com/team/game.git?token=hidden')
    await git(sandbox, repo, 'config', 'lfs.url', 'https://user:secret@lfs.example.com/team/game?signature=hidden')
    const result = await runYunBox(sandbox, repo, ['status'])
    expect(result.stdout).toContain('代码目标：push.example.com/team/game')
    expect(result.stdout).toContain('lfs.url：https://lfs.example.com/team/game（来自 git config）')
    expect(result.stdout).not.toMatch(/secret|hidden|signature|user:/)
  })

  it('reports invalid storage configuration instead of suggesting an active route', async () => {
    const { sandbox, repo } = await setup('[cos]\n bucket = invalid\n')
    const result = await runYunBox(sandbox, repo, ['status'])
    expect(result.stdout).toContain('存储配置无效')
    expect(result.stdout).toContain('yunbox doctor')
    expect(result.stdout).not.toContain('（直连）')
  })
})
