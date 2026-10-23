import type { PushInspection } from '../src/inspect.ts'
import type { Sandbox } from './helpers.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeCosServer } from '../../core/test/fake-cos-server.ts'
import { createRepository, createSandbox, git, runYunBox } from './helpers.ts'

const keys = { secretId: 'AKIDTESTTESTTESTTESTTESTTESTTEST', secretKey: 'test-secret-key-test-secret-key' }
const prefix = 'yunbox/team/game'
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

function asset(name: string, bytes: number) {
  const oid = createHash('sha256').update(name).digest('hex')
  return { oid, bytes, key: `${prefix}/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`, pointer: `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes}\n` }
}

const hero = asset('hero', 40 * 1024)
const level = asset('level', 24 * 1024)
const music = asset('music', 8 * 1024)

/** A repository in direct COS mode with three committed LFS pointers, local keys and a fake bucket. */
async function setup(): Promise<{ sandbox: Sandbox, cos: FakeCosServer, repo: string }> {
  const sandbox = await createSandbox()
  cleanups.push(sandbox.cleanup)
  const cos = await new FakeCosServer(keys).start()
  cleanups.push(() => cos.close())
  const repo = await createRepository(sandbox, 'game')
  await mkdir(join(repo, '.yunbox'))
  await writeFile(join(repo, '.yunbox', 'config'), `[cos]\n\tbucket = team-assets-1250000000\n\tregion = ap-shanghai\n\tprefix = ${prefix}\n\tendpoint = ${cos.origin}\n`)
  await git(sandbox, repo, 'config', '--local', 'lfs.standalonetransferagent', 'yunbox')
  for (const [name, file] of [['hero.psd', hero], ['level.fbx', level], ['music.wav', music]] as const)
    await writeFile(join(repo, name), file.pointer)
  await git(sandbox, repo, 'add', '-A')
  await git(sandbox, repo, 'commit', '-qm', 'test(inspect): add assets')
  Object.assign(sandbox.env, { TENCENTCLOUD_SECRETID: keys.secretId, TENCENTCLOUD_SECRETKEY: keys.secretKey })
  return { sandbox, cos, repo }
}

function store(cos: FakeCosServer, file: { key: string, bytes: number }, bytes = file.bytes): void {
  cos.objects.set(file.key, { body: Buffer.alloc(bytes), etag: '"fake"' })
}

async function inspect(sandbox: Sandbox, repo: string, ...args: string[]) {
  const result = await runYunBox(sandbox, repo, ['inspect', '--push', '--json', '--lfs-limit', '32k', '--file-limit', '32k', ...args])
  expect(result.stderr).toBe('')
  return { code: result.code, stdout: result.stdout, report: JSON.parse(result.stdout) as PushInspection }
}

describe('push inspection in direct COS mode', () => {
  it('reports nothing to upload when COS already has every LFS candidate', async () => {
    const { sandbox, cos, repo } = await setup()
    for (const file of [hero, level, music])
      store(cos, file)
    const { code, stdout, report } = await inspect(sandbox, repo)
    expect(code).toBe(0)
    expect(report.status).toBe('ok')
    expect(report.lfs).toMatchObject({ candidateBytes: 72 * 1024, candidateCount: 3, remoteChecked: true, remoteStorage: 'COS', uploadBytes: 0, exceedsLimit: false })
    expect(report.lfs.files.every(file => file.onRemote && !file.exceedsFileLimit)).toBe(true)
    expect(report.changes.filter(change => change.storage === 'lfs').map(change => [change.versions, change.pushBytes])).toEqual([[0, 0], [0, 0], [0, 0]])
    expect(cos.requests.map(request => request.method)).toEqual(['HEAD', 'HEAD', 'HEAD'])
    expect(stdout).not.toContain(keys.secretKey)
    expect(stdout).not.toContain('q-signature')
    const text = await runYunBox(sandbox, repo, ['inspect', '--push', '--lfs-limit', '32k'])
    expect(text.stdout).toContain('LFS 上传：0 B · 0 个对象')
    expect(text.stdout).toContain('已存在：3 / 3 个对象')
    expect(text.stdout).not.toContain('尚未查询远端')
  })

  it('counts only the objects missing in COS, and a size mismatch as missing', async () => {
    const { sandbox, cos, repo } = await setup()
    store(cos, hero)
    store(cos, music, music.bytes - 1)
    const { code, report } = await inspect(sandbox, repo)
    expect(report.lfs).toMatchObject({ remoteChecked: true, uploadBytes: level.bytes + music.bytes, exceedsLimit: false })
    expect(report.lfs.files.map(file => [file.oid, file.onRemote, file.exceedsFileLimit])).toEqual([
      [hero.oid, true, false],
      [level.oid, false, false],
      [music.oid, false, false],
    ])
    expect(Object.fromEntries(report.changes.map(change => [change.path, change.pushBytes]))).toMatchObject({ 'hero.psd': 0, 'level.fbx': level.bytes, 'music.wav': music.bytes })
    expect(code).toBe(0)
    // Without the check, the 40 KiB hero alone is over both budgets.
    const unchecked = await inspect({ ...sandbox, env: { ...sandbox.env, YUNBOX_INSPECT_REMOTE_TIMEOUT_MS: '0' } }, repo)
    expect(unchecked.code).toBe(1)
    expect(unchecked.report.lfs).toMatchObject({ remoteChecked: false, uploadBytes: null, exceedsLimit: true })
  })

  it('falls back to unknown upload bytes when COS refuses the lookup', async () => {
    const { sandbox, cos, repo } = await setup()
    for (const file of [hero, level, music])
      store(cos, file)
    // A key without HeadObject: the lookup fails, which must not read as "already uploaded".
    cos.policy = { statement: [{ effect: 'allow', action: ['name/cos:GetObject'], resource: [`qcs::cos:ap-shanghai:uid/1250000000:team-assets-1250000000/${prefix}/*`] }] }
    const { code, stdout, report } = await inspect(sandbox, repo)
    expect(code).toBe(1)
    expect(report.lfs).toMatchObject({ remoteChecked: false, uploadBytes: null, exceedsLimit: true })
    expect(report.lfs.files.some(file => 'onRemote' in file)).toBe(false)
    expect(report.changes.find(change => change.path === 'hero.psd')?.pushBytes).toBe(hero.bytes)
    expect(report.warnings.join(' ')).toContain('HTTP 403')
    expect(stdout).not.toContain(keys.secretKey)
    expect(stdout).not.toContain(cos.origin)
  })

  it('falls back when COS is unreachable or there are no local keys', async () => {
    const { sandbox, cos, repo } = await setup()
    expect((await inspect(sandbox, repo)).report.lfs.remoteChecked).toBe(true)
    await cos.close()
    const closed = await inspect(sandbox, repo)
    expect(closed.code).toBe(1)
    expect(closed.report.lfs).toMatchObject({ remoteChecked: false, uploadBytes: null })
    expect(closed.report.warnings.join(' ')).toContain('无法连接 COS')
    delete sandbox.env.TENCENTCLOUD_SECRETID
    delete sandbox.env.TENCENTCLOUD_SECRETKEY
    const keyless = await inspect(sandbox, repo)
    expect(keyless.report.lfs).toMatchObject({ remoteChecked: false, uploadBytes: null })
    expect(keyless.report.warnings.join(' ')).not.toContain('COS')
  })

  it('gives up within the time budget and keeps the push check going', async () => {
    const { sandbox, cos, repo } = await setup()
    for (const file of [hero, level, music])
      store(cos, file)
    cos.responseDelayMs = 3000
    sandbox.env.YUNBOX_INSPECT_REMOTE_TIMEOUT_MS = '200'
    const started = Date.now()
    const { code, report } = await inspect(sandbox, repo)
    expect(Date.now() - started).toBeLessThan(2500)
    expect(code).toBe(1)
    expect(report.lfs).toMatchObject({ remoteChecked: false, uploadBytes: null, exceedsLimit: true })
    expect(report.warnings.join(' ')).toContain('0.2 秒')
  })

  it('leaves COS alone outside direct mode', async () => {
    const { sandbox, cos, repo } = await setup()
    await git(sandbox, repo, 'config', '--local', '--unset', 'lfs.standalonetransferagent')
    const { report } = await inspect(sandbox, repo)
    expect(report.lfs).toMatchObject({ remoteChecked: false, uploadBytes: null })
    expect(report.warnings.join(' ')).not.toContain('COS')
    expect(cos.requests).toEqual([])
  })
})
