import type { PushInspection } from '../src/inspect.ts'
import type { Sandbox } from './helpers.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { createRepository, createSandbox, git, runYunBox } from './helpers.ts'

const sandboxes: Sandbox[] = []
const zero = '0'.repeat(40)

async function fixture() {
  const sandbox = await createSandbox()
  sandboxes.push(sandbox)
  const repo = await createRepository(sandbox)
  return { sandbox, repo }
}

async function commit(sandbox: Sandbox, repo: string) {
  await git(sandbox, repo, 'add', '-A')
  await git(sandbox, repo, 'commit', '-qm', 'test(inspect): record fixture')
  return git(sandbox, repo, 'rev-parse', 'HEAD')
}

function pointer(bytes: number, name = 'asset') {
  const oid = createHash('sha256').update(name).digest('hex')
  return { oid, text: `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes}\n` }
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(sandbox => sandbox.cleanup()))
})

describe('push inspection', () => {
  it('works offline without an LFS service and returns versioned JSON', async () => {
    const { sandbox, repo } = await fixture()
    await writeFile(join(repo, 'small.txt'), 'hello\n')
    await commit(sandbox, repo)
    const result = await runYunBox(sandbox, repo, ['inspect', '--push', '--json'])
    const report = JSON.parse(result.stdout) as PushInspection
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(report.schemaVersion).toBe(1)
    expect(report.git.packBytes).toBeGreaterThan(0)
    expect(report.git.packComplete).toBe(true)
    expect(report.git.files[0]).toMatchObject({ bytes: 6, paths: ['small.txt'] })
    expect(report.lfs).toMatchObject({ candidateCount: 0, candidateBytes: 0, uploadBytes: null, remoteChecked: false })
    expect(report.warnings.join(' ')).toContain('upstream')
  })

  it('separates Git bytes and LFS payloads and retains deleted historical versions', async () => {
    const { sandbox, repo } = await fixture()
    const asset = pointer(64 * 1024)
    await writeFile(join(repo, 'asset.psd'), asset.text)
    await writeFile(join(repo, 'alias.psd'), asset.text)
    await writeFile(join(repo, 'bundle.bin'), randomBytes(32 * 1024))
    await commit(sandbox, repo)
    await writeFile(join(repo, 'bundle.bin'), randomBytes(8 * 1024))
    await rm(join(repo, 'asset.psd'))
    await commit(sandbox, repo)
    await writeFile(join(repo, 'bundle.bin'), randomBytes(128 * 1024))
    await writeFile(join(repo, 'untracked.bin'), randomBytes(128 * 1024))
    await git(sandbox, repo, 'add', 'bundle.bin')
    const result = await runYunBox(sandbox, repo, ['inspect', '--push', '--json', '--git-limit', '1g', '--lfs-limit', '32k', '--file-limit', '16k'])
    const report = JSON.parse(result.stdout) as PushInspection
    expect(result.code).toBe(1)
    expect(report.git.exceedsLimit).toBe(false)
    expect(report.git.files.map(file => file.bytes)).toEqual([32 * 1024, 8 * 1024])
    expect(report.git.pointerBytes).toBe(Buffer.byteLength(asset.text))
    expect(report.git.blobBytes).toBe(40 * 1024 + Buffer.byteLength(asset.text))
    expect(report.lfs.exceedsLimit).toBe(true)
    expect(report.lfs.files).toEqual([{ oid: asset.oid, bytes: 64 * 1024, paths: ['alias.psd', 'asset.psd'], exceedsFileLimit: true }])
    expect(result.stdout).not.toContain('untracked.bin')
  })

  it('reports each changed path with its status, sizes before and after, and uploaded versions', async () => {
    const { sandbox, repo } = await fixture()
    await writeFile(join(repo, 'edited.bin'), randomBytes(1000))
    await writeFile(join(repo, 'removed.txt'), 'old\n')
    await writeFile(join(repo, 'art.psd'), pointer(4096, 'v1').text)
    const base = await commit(sandbox, repo)
    await writeFile(join(repo, 'edited.bin'), randomBytes(3000))
    await writeFile(join(repo, 'art.psd'), pointer(8192, 'v2').text)
    await writeFile(join(repo, 'scratch.bin'), randomBytes(5000))
    await rm(join(repo, 'removed.txt'))
    await commit(sandbox, repo)
    await writeFile(join(repo, 'edited.bin'), randomBytes(2000))
    await writeFile(join(repo, 'added.txt'), 'new\n')
    await rm(join(repo, 'scratch.bin'))
    await commit(sandbox, repo)
    const result = await runYunBox(sandbox, repo, ['inspect', '--push', '--base', base, '--json', '--file-limit', '4k'])
    const report = JSON.parse(result.stdout) as PushInspection
    expect(report.changes).toEqual([
      { path: 'art.psd', status: 'modified', storage: 'lfs', beforeBytes: 4096, afterBytes: 8192, versions: 1, pushBytes: 8192, exceedsFileLimit: true },
      { path: 'edited.bin', status: 'modified', storage: 'git', beforeBytes: 1000, afterBytes: 2000, versions: 2, pushBytes: 5000, exceedsFileLimit: false },
      { path: 'scratch.bin', status: 'transient', storage: 'git', beforeBytes: null, afterBytes: null, versions: 1, pushBytes: 5000, exceedsFileLimit: true },
      { path: 'added.txt', status: 'added', storage: 'git', beforeBytes: null, afterBytes: 4, versions: 1, pushBytes: 4, exceedsFileLimit: false },
      { path: 'removed.txt', status: 'deleted', storage: 'git', beforeBytes: 4, afterBytes: null, versions: 0, pushBytes: 0, exceedsFileLimit: false },
    ])
    const text = await runYunBox(sandbox, repo, ['inspect', '--push', '--base', base, '--file-limit', '4k'])
    expect(text.stdout).toContain('[超限] 修改')
    expect(text.stdout).toContain('"edited.bin"  1000 B → 1.95 KiB（+1000 B）  2 个版本')
    expect(text.stdout).toContain('临时')
    // Nothing of a deleted path is uploaded, so the ranking leaves it out.
    expect(text.stdout).not.toContain('removed.txt')
  })

  it('asks before an exceeded push and blocks when nobody can confirm', async () => {
    const { sandbox, repo } = await fixture()
    await writeFile(join(repo, 'big.bin'), randomBytes(8192))
    await commit(sandbox, repo)
    const blocked = await runYunBox(sandbox, repo, ['inspect', '--push', '--file-limit', '4k', '--confirm'])
    expect(blocked.code).toBe(1)
    expect(blocked.stdout).toContain('"big.bin"')
    expect(blocked.stderr).toContain('无法请求确认')
    expect((await runYunBox(sandbox, repo, ['inspect', '--push', '--confirm'])).code).toBe(0)
    const json = await runYunBox(sandbox, repo, ['inspect', '--push', '--confirm', '--json'])
    expect(json.code).toBe(2)
    expect(JSON.parse(json.stdout).error.message).toContain('--confirm')
  })

  it('excludes the supplied base from both Git and LFS ranges', async () => {
    const { sandbox, repo } = await fixture()
    await writeFile(join(repo, 'old.bin'), randomBytes(32 * 1024))
    await writeFile(join(repo, 'old.psd'), pointer(500 * 1024).text)
    const base = await commit(sandbox, repo)
    await writeFile(join(repo, 'new.txt'), 'new\n')
    await commit(sandbox, repo)
    const result = await runYunBox(sandbox, repo, ['inspect', '--push', '--base', base, '--json'])
    const report = JSON.parse(result.stdout) as PushInspection
    expect(result.code).toBe(0)
    expect(report.git.files.map(file => file.paths)).toEqual([['new.txt']])
    expect(report.lfs.candidateCount).toBe(0)
  })

  it('uses advertised Git history for a new branch but keeps conservative LFS candidates', async () => {
    const { sandbox, repo } = await fixture()
    await writeFile(join(repo, 'old.bin'), randomBytes(32 * 1024))
    await writeFile(join(repo, 'asset.psd'), pointer(64 * 1024).text)
    await commit(sandbox, repo)
    const remote = join(sandbox.root, 'remote.git')
    await git(sandbox, repo, 'init', '--bare', '-q', remote)
    await git(sandbox, repo, 'push', remote, 'HEAD:refs/heads/main')
    await writeFile(join(repo, 'small.txt'), 'small\n')
    const tip = await commit(sandbox, repo)
    const input = `refs/heads/feature ${tip} refs/heads/feature ${zero}\n`
    const result = await runYunBox(sandbox, repo, ['inspect', '--push', '--stdin', '--remote', remote, '--json'], input + input)
    const report = JSON.parse(result.stdout) as PushInspection
    expect(result.code).toBe(0)
    expect(report.git.files.map(file => file.paths)).toEqual([['small.txt']])
    expect(report.lfs.candidateCount).toBe(1)
    expect(report.lfs.candidateBytes).toBe(64 * 1024)
  })

  it('handles deletions and an empty hook stream without inspecting HEAD', async () => {
    const { sandbox, repo } = await fixture()
    for (const input of ['', `refs/heads/old ${zero} refs/heads/old ${'a'.repeat(40)}\n`]) {
      const result = await runYunBox(sandbox, repo, ['inspect', '--push', '--stdin', '--json'], input)
      const report = JSON.parse(result.stdout) as PushInspection
      expect(result.code).toBe(0)
      expect(report.git.packBytes).toBe(0)
      expect(report.git.files).toEqual([])
      expect(report.lfs.candidateBytes).toBe(0)
    }
  })

  // Windows file names cannot contain quotes or control characters.
  it.skipIf(process.platform === 'win32')('keeps full JSON details while limiting terminal rankings and escaping paths', async () => {
    const { sandbox, repo } = await fixture()
    const unusualPath = '素材 "one"\n\t\x1B.bin'
    await writeFile(join(repo, unusualPath), randomBytes(4096))
    await writeFile(join(repo, 'smaller.bin'), randomBytes(2048))
    await commit(sandbox, repo)
    const json = await runYunBox(sandbox, repo, ['inspect', '--push', '--top', '1', '--json'])
    expect((JSON.parse(json.stdout) as PushInspection).git.files).toHaveLength(2)
    expect((JSON.parse(json.stdout) as PushInspection).git.files[0]?.paths).toEqual([unusualPath])
    const text = await runYunBox(sandbox, repo, ['inspect', '--push', '--top', '1'])
    expect(text.stdout).toContain(JSON.stringify(unusualPath))
    expect(text.stdout).not.toContain('smaller.bin')
    expect(text.stdout).not.toContain('\x1B')
  })

  it('enforces separate total and per-file budgets, including compressible files', async () => {
    const { sandbox, repo } = await fixture()
    await writeFile(join(repo, 'compressible.txt'), 'x'.repeat(64 * 1024))
    await commit(sandbox, repo)
    await git(sandbox, repo, 'config', 'yunbox.inspectFileBytes', '32k')
    const result = await runYunBox(sandbox, repo, ['inspect', '--push', '--json'])
    const report = JSON.parse(result.stdout) as PushInspection
    expect(result.code).toBe(1)
    expect(report.git.exceedsLimit).toBe(false)
    expect(report.git.files[0]?.exceedsFileLimit).toBe(true)
    const overridden = await runYunBox(sandbox, repo, ['inspect', '--push', '--file-limit', '64KiB', '--json'])
    expect(overridden.code).toBe(0)
  })

  it('caps pack estimation and still reports large file sizes', async () => {
    const { sandbox, repo } = await fixture()
    await writeFile(join(repo, 'large.bin'), randomBytes(11 * 1024 * 1024))
    await commit(sandbox, repo)
    const result = await runYunBox(sandbox, repo, ['inspect', '--push', '--json'])
    const report = JSON.parse(result.stdout) as PushInspection
    expect(result.code).toBe(1)
    expect(report.git.packComplete).toBe(false)
    expect(report.git.packBytes).toBe(10 * 1024 * 1024 + 1)
    expect(report.git.files[0]?.bytes).toBe(11 * 1024 * 1024)
  })

  it('accepts pointers produced by real git-lfs without reading cached payloads', async () => {
    const { sandbox, repo } = await fixture()
    await git(sandbox, repo, 'lfs', 'install', '--local')
    await git(sandbox, repo, 'lfs', 'track', '*.bin')
    await writeFile(join(repo, 'real.bin'), randomBytes(2048))
    await commit(sandbox, repo)
    await rm(join(repo, '.git', 'lfs', 'objects'), { recursive: true, force: true })
    const result = await runYunBox(sandbox, repo, ['inspect', '--push', '--json'])
    const report = JSON.parse(result.stdout) as PushInspection
    expect(result.code).toBe(0)
    expect(report.lfs.candidateBytes).toBe(2048)
    expect(report.lfs.files[0]?.paths).toEqual(['real.bin'])
    expect(report.git.files.some(file => file.paths.includes('real.bin'))).toBe(false)
  })

  it('returns JSON errors without echoing credentials or invalid parameter values', async () => {
    const { sandbox, repo } = await fixture()
    for (const args of [
      ['--unknown=https://user:secret@example.test/a?token=secret'],
      ['--git-limit', 'NaN'],
      ['--stdin', '--base', 'HEAD'],
      ['--base', '--bad-ref'],
    ]) {
      const result = await runYunBox(sandbox, repo, ['inspect', '--push', '--json', ...args])
      expect(result.code).toBe(2)
      expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, status: 'error' })
      expect(result.stdout + result.stderr).not.toContain('secret')
      expect(result.stderr).toBe('')
    }
    const invalid = await runYunBox(sandbox, repo, ['inspect', '--push', '--stdin', '--json'], 'invalid input')
    expect(invalid.code).toBe(2)
    expect(JSON.parse(invalid.stdout).status).toBe('error')
  })

  it('fails on malformed LFS sizes instead of silently undercounting them', async () => {
    const { sandbox, repo } = await fixture()
    await writeFile(join(repo, 'bad.psd'), pointer(123).text.replace('size 123', 'size -1'))
    await commit(sandbox, repo)
    const result = await runYunBox(sandbox, repo, ['inspect', '--push', '--json'])
    expect(result.code).toBe(2)
    expect(JSON.parse(result.stdout).error.message).toContain('LFS 指针')
  })
})
