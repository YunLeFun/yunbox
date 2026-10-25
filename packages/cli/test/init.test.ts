import type { Sandbox } from './helpers.ts'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ASSET_CATEGORIES } from '../src/gitattributes.ts'
import { createRepository, createSandbox, git, runYunBox } from './helpers.ts'

const SERVICE_URL = 'http://127.0.0.1:8080/team/assets'
const sandboxes: Sandbox[] = []

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(sandbox => sandbox.cleanup()))
})

async function setup(options?: { credentialHelper?: boolean }): Promise<{ sandbox: Sandbox, repo: string }> {
  const sandbox = await createSandbox(options)
  sandboxes.push(sandbox)
  return { sandbox, repo: await createRepository(sandbox) }
}

function fakeToken(): string {
  return `ybx_${randomBytes(32).toString('base64url')}`
}

async function snapshot(repo: string): Promise<Record<string, string>> {
  const files = ['.gitattributes', '.lfsconfig', '.git/config']
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(repo, file), 'utf8')])))
}

describe('git yunbox init', () => {
  it('installs confirmation by default, can opt out, and can explicitly opt into global protection', async () => {
    const { sandbox, repo } = await setup()
    const args = ['init', '--url', SERVICE_URL, '--skip-credential']
    expect((await runYunBox(sandbox, repo, [...args, '--no-hook'])).code).toBe(0)
    expect(await readFile(join(repo, '.git/hooks/pre-push'), 'utf8')).not.toContain('yunbox-pre-push')
    expect((await runYunBox(sandbox, repo, args)).code).toBe(0)
    expect(await readFile(join(repo, '.git/hooks/pre-push'), 'utf8')).toContain(' --confirm')
    expect(await readFile(join(repo, '.git/hooks/pre-push.yunbox-original'), 'utf8')).toContain('git lfs pre-push')
    expect((await runYunBox(sandbox, repo, args)).code).toBe(0)
    expect((await runYunBox(sandbox, repo, ['hook', 'uninstall'])).code).toBe(0)
    expect((await runYunBox(sandbox, repo, [...args, '--global-hook'])).code).toBe(0)
    const status = JSON.parse((await runYunBox(sandbox, repo, ['hook', 'status', '--json'])).stdout)
    expect(status).toMatchObject({ scope: 'global', confirm: true, globalInstalled: true })
    // LFS initialization must keep the global dispatcher and the local upload hook intact.
    expect((await runYunBox(sandbox, repo, args)).code).toBe(0)
    expect(await readFile(join(repo, '.git/hooks/pre-push'), 'utf8')).toContain('git lfs pre-push')
  })

  it('adds LFS to a repository protected before storage setup', async () => {
    const { sandbox, repo } = await setup()
    expect((await runYunBox(sandbox, repo, ['hook', 'install'])).code).toBe(0)
    expect((await runYunBox(sandbox, repo, ['init', '--url', SERVICE_URL, '--skip-credential'])).code).toBe(0)
    expect(await readFile(join(repo, '.git/hooks/pre-push.yunbox-original'), 'utf8')).toContain('git lfs pre-push')
    expect((await runYunBox(sandbox, repo, ['hook', 'uninstall'])).code).toBe(0)
    expect(await readFile(join(repo, '.git/hooks/pre-push'), 'utf8')).toContain('git lfs pre-push')
  })

  it('initializes through compatible Husky hooks without changing team scripts or the dispatcher', async () => {
    const { sandbox, repo } = await setup()
    await mkdir(join(repo, '.husky/_'), { recursive: true })
    await git(sandbox, repo, 'config', 'core.hooksPath', '.husky/_')
    const dispatcher = '#!/bin/sh\nexec sh "$(dirname "$(dirname "$0")")/pre-push" "$@"\n'
    const teamHook = '#!/bin/sh\ngit lfs pre-push "$@"\n'
    await writeFile(join(repo, '.husky/_/pre-push'), dispatcher, { mode: 0o755 })
    await writeFile(join(repo, '.husky/pre-push'), teamHook)
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--compatible'])).code).toBe(0)
    const managedPath = await git(sandbox, repo, 'config', 'core.hooksPath')
    const managed = await readFile(join(managedPath, 'pre-push'), 'utf8')
    const args = ['init', '--url', SERVICE_URL, '--skip-credential']
    expect((await runYunBox(sandbox, repo, args)).code).toBe(0)
    expect((await runYunBox(sandbox, repo, args)).code).toBe(0)
    expect(await readFile(join(managedPath, 'pre-push'), 'utf8')).toBe(managed)
    expect(await readFile(join(repo, '.husky/_/pre-push'), 'utf8')).toBe(dispatcher)
    expect(await readFile(join(repo, '.husky/pre-push'), 'utf8')).toBe(teamHook)
    await writeFile(join(repo, '.husky/pre-push'), '#!/bin/sh\necho checks\n')
    const result = await runYunBox(sandbox, repo, args)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('git lfs update --manual')
    expect(await readFile(join(repo, '.husky/pre-push'), 'utf8')).toBe('#!/bin/sh\necho checks\n')
    expect(await readFile(join(managedPath, 'pre-push'), 'utf8')).toBe(managed)
  })

  it('configures LFS, .lfsconfig, locksverify and the credential, and is idempotent', async () => {
    const { sandbox, repo } = await setup()
    const token = fakeToken()

    const first = await runYunBox(sandbox, repo, ['init', '--url', `${SERVICE_URL}/`, '--token-stdin'], `${token}\n`)
    expect(first.stderr).toBe('')
    expect(first.code).toBe(0)
    expect(first.stdout).toContain('Locks API')
    expect(first.stdout).toContain('token 已存入 Git 凭据管理器')

    // .lfsconfig holds only the normalized URL.
    expect(await readFile(join(repo, '.lfsconfig'), 'utf8')).toBe(`[lfs]\n\turl = ${SERVICE_URL}\n`)
    expect(await git(sandbox, repo, 'config', 'lfs.locksverify')).toBe('false')
    expect(await git(sandbox, repo, 'config', '--global', 'filter.lfs.process')).toContain('git-lfs')
    await access(join(repo, '.git', 'hooks', 'pre-push'))

    const attributes = await readFile(join(repo, '.gitattributes'), 'utf8')
    for (const category of ASSET_CATEGORIES) {
      for (const extension of category.extensions)
        expect(attributes).toMatch(new RegExp(`^\\*\\.${extension} +filter=lfs diff=lfs merge=lfs -text$`, 'm'))
    }
    for (const file of ['hero.psd', 'Characters/hero.fbx', 'audio/hit.wav', 'intro.mp4', 'ui/icon.png'])
      expect(await git(sandbox, repo, 'check-attr', 'filter', '--', file)).toBe(`${file}: filter: lfs`)
    expect(await git(sandbox, repo, 'check-attr', 'filter', '--', 'src/main.ts')).toBe('src/main.ts: filter: unspecified')

    // The token is in the credential helper exactly once and nowhere else.
    const credentials = await readFile(sandbox.credentialsFile, 'utf8')
    expect(credentials).toBe(`http://yunbox:${token}@127.0.0.1%3a8080\n`)
    for (const file of Object.values(await snapshot(repo)))
      expect(file).not.toContain(token)
    expect(first.stdout).not.toContain(token)

    // Re-running changes nothing and keeps the stored credential.
    const before = await snapshot(repo)
    const second = await runYunBox(sandbox, repo, ['init'])
    expect(second.code).toBe(0)
    expect(second.stdout).toContain('已包含全部素材规则，未修改')
    expect(second.stdout).toContain(`lfs.url 已是 ${SERVICE_URL}，未修改`)
    expect(second.stdout).toContain('已有 127.0.0.1:8080 的凭据，未修改')
    expect(await snapshot(repo)).toEqual(before)
    expect(await readFile(sandbox.credentialsFile, 'utf8')).toBe(credentials)

    // Replacing the token keeps a single credential entry.
    const replacement = fakeToken()
    const third = await runYunBox(sandbox, repo, ['init', '--url', SERVICE_URL, '--token-stdin'], replacement)
    expect(third.code).toBe(0)
    expect(await snapshot(repo)).toEqual(before)
    expect(await readFile(sandbox.credentialsFile, 'utf8')).toBe(`http://yunbox:${replacement}@127.0.0.1%3a8080\n`)
  })

  it('merges into an existing .gitattributes without duplicating or overriding rules', async () => {
    const { sandbox, repo } = await setup()
    const existing = '# project rules\r\n*.png filter=lfs diff=lfs merge=lfs -text\r\n*.txt text eol=crlf\r\n*.wav binary\r\n'
    await writeFile(join(repo, '.gitattributes'), existing)

    const result = await runYunBox(sandbox, repo, ['init', '--url', SERVICE_URL, '--types', 'texture,audio', '--skip-credential'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('*.wav')
    const merged = await readFile(join(repo, '.gitattributes'), 'utf8')
    expect(merged.startsWith(existing)).toBe(true)
    expect(merged.replaceAll('\r\n', '')).not.toContain('\n')
    expect(merged.match(/^\*\.png /gm)).toHaveLength(1)
    expect(merged.match(/^\*\.wav /gm)).toHaveLength(1)
    expect(merged).toContain('*.ogg  filter=lfs diff=lfs merge=lfs -text\r\n')
    expect(merged).not.toContain('*.fbx')
    expect(await git(sandbox, repo, 'check-attr', 'filter', '--', 'a.wav')).toBe('a.wav: filter: unspecified')

    // Adding another category later appends only that category.
    const again = await runYunBox(sandbox, repo, ['init', '--types', 'model', '--types', 'texture', '--skip-credential'])
    expect(again.code).toBe(0)
    const extended = await readFile(join(repo, '.gitattributes'), 'utf8')
    expect(extended.startsWith(merged)).toBe(true)
    expect(extended).toContain('*.fbx')
    expect(extended.match(/^# YunBox：/gm)).toHaveLength(1)
    expect(extended.match(/^\*\.jpg /gm)).toHaveLength(1)
  })

  it('does not add rules that would catch files already committed outside LFS', async () => {
    const { sandbox, repo } = await setup()
    await writeFile(join(repo, '.gitattributes'), '*.psd filter=lfs diff=lfs merge=lfs -text\n')
    await mkdir(join(repo, 'build'))
    await writeFile(join(repo, 'build', 'pack.zip'), 'zip')
    await writeFile(join(repo, 'Logo.PNG'), 'png')
    await git(sandbox, repo, 'add', '.')
    await git(sandbox, repo, 'commit', '--quiet', '-m', 'plain files')

    // Whether *.png catches Logo.PNG depends on core.ignorecase; git decides either way.
    const result = await runYunBox(sandbox, repo, ['init', '--url', SERVICE_URL, '--types', 'archive,texture', '--skip-credential'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('*.zip（build/pack.zip）')
    const attributes = await readFile(join(repo, '.gitattributes'), 'utf8')
    expect(attributes).not.toContain('*.zip')
    expect(attributes).toContain('*.7z')
    expect(attributes).toContain('*.jpg')
    expect(await git(sandbox, repo, 'status', '--porcelain', '--untracked-files=no')).toBe('M .gitattributes')

    // Nothing to add at all: the file is left exactly as it was.
    await git(sandbox, repo, 'checkout', '--', '.gitattributes')
    await writeFile(join(repo, 'a.7z'), '7z')
    await writeFile(join(repo, 'a.rar'), 'rar')
    await git(sandbox, repo, 'add', 'a.7z', 'a.rar')
    await git(sandbox, repo, 'commit', '--quiet', '-m', 'more plain files')
    expect((await runYunBox(sandbox, repo, ['init', '--types', 'archive', '--skip-credential'])).code).toBe(0)
    expect(await git(sandbox, repo, 'status', '--porcelain', '--untracked-files=no')).toBe('')

    // The suggested commands move such files to LFS from the next commit on.
    await git(sandbox, repo, 'lfs', 'track', '*.zip')
    await git(sandbox, repo, 'add', '.gitattributes')
    await git(sandbox, repo, 'add', '--renormalize', '--', '*.zip')
    await git(sandbox, repo, 'commit', '--quiet', '-m', 'zip in LFS')
    expect(await git(sandbox, repo, 'lfs', 'ls-files', '--name-only')).toBe('build/pack.zip')
    expect(await git(sandbox, repo, 'status', '--porcelain', '--untracked-files=no')).toBe('')
  })

  it('refuses unsafe or conflicting input before changing anything', async () => {
    const { sandbox, repo } = await setup()
    const cases: Array<[string[], string, RegExp]> = [
      [['init', '--url', 'http://lfs.example.com/team/assets'], '', /必须使用 https/],
      [['init', '--url', 'https://alice:secret@lfs.example.com/team/assets'], '', /不能包含用户名、密码或 token/],
      [['init', '--url', 'https://lfs.example.com/team'], '', /<owner>\/<repo>/],
      [['init', '--url', 'https://lfs.example.com/team/../x'], '', /<owner>\/<repo>|owner 和 repo/],
      [['init', '--url', SERVICE_URL, '--token', fakeToken()], '', /不要在命令行参数里传 token/],
      [['init', '--url', SERVICE_URL, '--token-stdin'], 'not a token', /token 不能包含空白字符/],
      [['init', '--url', SERVICE_URL, '--token-stdin'], 'password123', /ybx_/],
      [['init', '--url', SERVICE_URL, '--types', 'texture,unknown'], '', /未知的素材类型：unknown/],
      [['init', '--url', SERVICE_URL, '--bucket', 'assets-1250000000'], '', /--url（服务端模式）和 --cos（直连 COS）只能选一个/],
    ]
    for (const [argv, stdin, message] of cases) {
      const result = await runYunBox(sandbox, repo, argv, stdin)
      expect(result.code, argv.join(' ')).toBe(2)
      expect(result.stderr).toMatch(message)
    }
    // Without --url, init sets up direct COS access and needs the user's own keys first.
    const noKeys = await runYunBox(sandbox, repo, ['init'])
    expect(noKeys.code).toBe(1)
    expect(noKeys.stderr).toContain('yunbox login')
    await expect(access(join(repo, '.gitattributes'))).rejects.toThrow()
    await expect(access(join(repo, '.lfsconfig'))).rejects.toThrow()

    const outside = await runYunBox(sandbox, sandbox.root, ['init', '--url', SERVICE_URL])
    expect(outside.code).toBe(1)
    expect(outside.stderr).toContain('不在 Git 仓库里')
  })

  it('keeps a different existing lfs.url unless --force is given', async () => {
    const { sandbox, repo } = await setup()
    expect((await runYunBox(sandbox, repo, ['init', '--url', SERVICE_URL, '--skip-credential'])).code).toBe(0)

    const other = 'https://lfs.example.com/team/assets'
    const refused = await runYunBox(sandbox, repo, ['init', '--url', other, '--skip-credential'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('--force')
    expect(await git(sandbox, repo, 'config', '--file', '.lfsconfig', 'lfs.url')).toBe(SERVICE_URL)

    const forced = await runYunBox(sandbox, repo, ['init', '--url', other, '--force', '--skip-credential'])
    expect(forced.code).toBe(0)
    expect(await git(sandbox, repo, 'config', '--file', '.lfsconfig', 'lfs.url')).toBe(other)
  })

  it('explains how to configure a credential helper when none is set', async () => {
    const { sandbox, repo } = await setup({ credentialHelper: false })
    const result = await runYunBox(sandbox, repo, ['init', '--url', SERVICE_URL, '--token-stdin'], fakeToken())
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('没有配置 Git 凭据管理器')
    expect(result.stderr).toContain('git config --global credential.helper')
    // The repository configuration is still in place; rerunning after configuring a helper finishes the job.
    expect(await git(sandbox, repo, 'config', '--file', '.lfsconfig', 'lfs.url')).toBe(SERVICE_URL)
  })

  it('without a terminal or --token-stdin, leaves the credential for later', async () => {
    const { sandbox, repo } = await setup()
    const result = await runYunBox(sandbox, repo, ['init', '--url', SERVICE_URL])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('还没有保存 127.0.0.1:8080 的 token')
    expect(result.stdout).toContain('--token-stdin')
    expect(await readFile(sandbox.credentialsFile, 'utf8').catch(() => '')).toBe('')
  })
})

describe('yunbox status', () => {
  it('counts LFS objects and their size from local information', async () => {
    const { sandbox, repo } = await setup()
    const empty = await runYunBox(sandbox, repo, ['status'])
    expect(empty.code).toBe(0)
    expect(empty.stdout).toContain('Git 远端默认 LFS 服务（未接入 YunBox）')
    expect(empty.stdout).toContain('LFS 对象（当前提交）：0 个')

    await runYunBox(sandbox, repo, ['init', '--url', SERVICE_URL, '--skip-credential'])
    await writeFile(join(repo, 'a.png'), Buffer.alloc(3000, 1))
    await writeFile(join(repo, 'b.png'), Buffer.alloc(3000, 1))
    await writeFile(join(repo, 'hero.psd'), Buffer.alloc(2 * 1024 * 1024, 2))
    await writeFile(join(repo, 'notes.txt'), 'not an asset\n')
    await git(sandbox, repo, 'add', '.')
    await git(sandbox, repo, 'commit', '--quiet', '-m', 'add assets')

    const status = await runYunBox(sandbox, repo, ['status'])
    expect(status.code).toBe(0)
    expect(status.stdout).toContain(`lfs.url：${SERVICE_URL}（来自 .lfsconfig）`)
    expect(status.stdout).toContain('LFS 对象（当前提交）：2 个，共 2.00 MiB（2,100,152 字节），对应 3 个文件')
    expect(status.stdout).toContain('本地已下载：2 个')

    await writeFile(join(repo, 'hero.psd'), Buffer.alloc(1024, 3))
    await git(sandbox, repo, 'commit', '--quiet', '-am', 'shrink psd')
    const all = await runYunBox(sandbox, repo, ['status', '--all'])
    expect(all.stdout).toContain('LFS 对象（所有分支和历史）：3 个，共 2.00 MiB（2,101,176 字节）')
    const head = await runYunBox(sandbox, repo, ['status'])
    expect(head.stdout).toContain('LFS 对象（当前提交）：2 个，共 3.93 KiB（4,024 字节），对应 3 个文件')

    const outside = await runYunBox(sandbox, sandbox.root, ['status'])
    expect(outside.code).toBe(1)
  })
})
