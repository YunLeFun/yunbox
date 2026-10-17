import type { RunningYunBoxServer } from '@yunbox/server'
import type { Sandbox } from './helpers.ts'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFileObjectStorage } from '@yunbox/core'
import { createToken, FileTokenStore, startYunBoxServer } from '@yunbox/server'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createRepository, createSandbox, git, runYunBox } from './helpers.ts'

let storageDirectory: string
let running: RunningYunBoxServer
let serviceUrl: string
const secrets: Record<'writer' | 'reader' | 'outsider', string> = { writer: '', reader: '', outsider: '' }
const sandboxes: Sandbox[] = []

beforeAll(async () => {
  storageDirectory = await mkdtemp(join(tmpdir(), 'yunbox-cli-doctor-'))
  const tokens = new FileTokenStore(join(storageDirectory, '_yunbox', 'tokens.json'))
  secrets.writer = (await createToken(tokens, { name: 'writer', repos: { 'team/assets': 'write' } })).secret
  secrets.reader = (await createToken(tokens, { name: 'reader', repos: { 'team/*': 'read' } })).secret
  secrets.outsider = (await createToken(tokens, { name: 'outsider', repos: { 'other/*': 'write' } })).secret
  running = await startYunBoxServer({ storage: new LocalFileObjectStorage(storageDirectory), tokens, port: 0 })
  serviceUrl = `${running.url}/team/assets`
})

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(sandbox => sandbox.cleanup()))
})

afterAll(async () => {
  await running.close()
  await rm(storageDirectory, { recursive: true, force: true })
})

/** A repository set up by `git yunbox init`, optionally with a token in the credential helper. */
async function initializedRepository(token: string | undefined, url = serviceUrl): Promise<{ sandbox: Sandbox, repo: string }> {
  const sandbox = await createSandbox()
  sandboxes.push(sandbox)
  const repo = await createRepository(sandbox)
  const init = await runYunBox(sandbox, repo, ['init', '--url', url, ...(token === undefined ? ['--skip-credential'] : ['--token-stdin'])], token)
  expect(init.code, init.stderr).toBe(0)
  return { sandbox, repo }
}

function expectNoSecrets(output: string): void {
  for (const secret of Object.values(secrets))
    expect(output).not.toContain(secret)
  expect(output).not.toContain('ybx_')
}

describe('yunbox doctor', () => {
  it('passes every check with a write token', async () => {
    const { sandbox, repo } = await initializedRepository(secrets.writer)
    const result = await runYunBox(sandbox, repo, ['doctor'])
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    for (const line of ['✓ git：', '✓ git-lfs：', '✓ Git 仓库：', '✓ LFS 过滤器：', `✓ lfs.url：${serviceUrl}（来自 .lfsconfig）`, '✓ HTTPS：本机地址', '✓ lfs.locksverify：', '✓ 凭据：', '✓ 服务连通性：', '✓ 读权限：', '✓ 写权限：'])
      expect(result.stdout).toContain(line)
    expect(result.stdout).not.toMatch(/^[✗!]/m)
    expect(result.stdout).toContain('全部检查通过')
    expectNoSecrets(result.stdout)

    // Running from a subdirectory checks the enclosing repository.
    await mkdir(join(repo, 'art'))
    const fromSubdirectory = await runYunBox(sandbox, join(repo, 'art'), ['doctor'])
    expect(fromSubdirectory.code).toBe(0)
  })

  it('fails with a fix when the credential is missing', async () => {
    const { sandbox, repo } = await initializedRepository(undefined)
    const result = await runYunBox(sandbox, repo, ['doctor'])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('✓ 服务连通性：')
    expect(result.stdout).toMatch(/✗ 凭据：凭据管理器（store --file=.*）里没有 127\.0\.0\.1:\d+ 的 token/)
    expect(result.stdout).toContain('      git yunbox init   # 按提示输入 token')
    expect(result.stdout).toContain('- 读写权限：缺少凭据')
    expect(result.stdout).toContain('1 项检查未通过')
  })

  it('reports a read-only token as missing write access, and passes with --read-only', async () => {
    const { sandbox, repo } = await initializedRepository(secrets.reader)
    const result = await runYunBox(sandbox, repo, ['doctor'])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('✓ 读权限：可以从 team/assets 拉取素材')
    expect(result.stdout).toMatch(/✗ 写权限：token 对 team\/assets 只有读权限（HTTP 403）。服务端返回：.*read-only access.*（request_id=[\w-]+）$/m)
    expect(result.stdout).toContain('yunbox doctor --read-only')
    expect(result.stdout).toContain('yunbox-server token create --name <你的名字> --write team/assets')
    expectNoSecrets(result.stdout)

    const readOnly = await runYunBox(sandbox, repo, ['doctor', '--read-only'])
    expect(readOnly.code).toBe(0)
    expect(readOnly.stdout).toContain('✓ 写权限：没有（--read-only 模式不要求）')
    expect(readOnly.stdout).toContain('全部检查通过，可以拉取素材')
  })

  it('distinguishes an invalid token (401) from a token without access (403)', async () => {
    const bogus = `ybx_${randomBytes(32).toString('base64url')}`
    const invalid = await initializedRepository(bogus)
    const unauthorized = await runYunBox(invalid.sandbox, invalid.repo, ['doctor'])
    expect(unauthorized.code).toBe(1)
    expect(unauthorized.stdout).toContain('✗ 读权限：token 无效或已被吊销（HTTP 401）')
    expect(unauthorized.stdout).toMatch(/printf 'protocol=http\\nhost=127\.0\.0\.1:\d+\\n\\n' \| git credential reject/)
    expect(unauthorized.stdout).toContain('- 写权限：读权限检查没有通过')
    expectNoSecrets(unauthorized.stdout)
    expect(unauthorized.stdout).not.toContain(bogus)
    // doctor only diagnoses: unlike git-lfs after a 401, it leaves the credential in place.
    expect(await readFile(invalid.sandbox.credentialsFile, 'utf8')).toContain(bogus)

    const outsider = await initializedRepository(secrets.outsider)
    const forbidden = await runYunBox(outsider.sandbox, outsider.repo, ['doctor'])
    expect(forbidden.code).toBe(1)
    expect(forbidden.stdout).toContain('✗ 读权限：token 没有 team/assets 的权限（HTTP 403）')
  })

  it('never sends credentials to a plain-HTTP remote host', async () => {
    const { sandbox, repo } = await initializedRepository(secrets.writer)
    await git(sandbox, repo, 'config', '--file', '.lfsconfig', 'lfs.url', 'http://yunbox.invalid/team/assets')
    const result = await runYunBox(sandbox, repo, ['doctor'])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('✗ HTTPS：yunbox.invalid 不是本机地址却使用 http')
    expect(result.stdout).toContain('git yunbox init --force --url https://yunbox.invalid/team/assets')
    expect(result.stdout).toContain('- 凭据、连通性和读写权限：为避免明文发送 token')
    expect(result.stdout).not.toContain('服务连通性：')
  })

  it('reports an unreachable service, a missing lfs.url and a directory outside any repository', async () => {
    const closed = createServer()
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const { port } = closed.address() as { port: number }
    await new Promise<void>(resolve => closed.close(() => resolve()))
    const down = await initializedRepository(secrets.writer, `http://127.0.0.1:${port}/team/assets`)
    const unreachable = await runYunBox(down.sandbox, down.repo, ['doctor'])
    expect(unreachable.code).toBe(1)
    expect(unreachable.stdout).toContain(`✗ 服务连通性：http://127.0.0.1:${port} 连接被拒绝`)
    expect(unreachable.stdout).not.toContain('读权限')

    const notFound = await initializedRepository(secrets.writer, `${running.url}/team/assets`)
    await git(notFound.sandbox, notFound.repo, 'config', '--file', '.lfsconfig', '--unset', 'lfs.url')
    const missing = await runYunBox(notFound.sandbox, notFound.repo, ['doctor'])
    expect(missing.code).toBe(1)
    expect(missing.stdout).toContain('✗ lfs.url：没有配置')
    expect(missing.stdout).toContain('git yunbox init --url https://<YunBox 服务地址>/<owner>/<repo>')

    const outside = await runYunBox(notFound.sandbox, notFound.sandbox.root, ['doctor'])
    expect(outside.code).toBe(1)
    expect(outside.stdout).toContain('✗ Git 仓库：当前目录不在 Git 仓库里')
  })
})
