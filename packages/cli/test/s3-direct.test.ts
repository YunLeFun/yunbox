import type { PushInspection } from '../src/inspect.ts'
import type { Sandbox } from './helpers.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeS3Server } from '../../core/test/fake-s3-server.ts'
import { credentialsFilePath } from '../src/cos/credentials.ts'
import { createRepository, createSandbox, git, installGitYunbox, runYunBox } from './helpers.ts'

const keys = { accessKeyId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', secretAccessKey: 'r2-secret-access-key-0123456789abcdef0123456789abcdef' }
const reader = { accessKeyId: 'readonly-key-0000000000000000000', secretAccessKey: 'readonly-secret-0123456789abcdef0123456789abcd' }
const bucket = 'team-assets'
const prefix = 'yunbox/team/game'
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function objectKey(oid: string): string {
  return `${prefix}/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`
}

/** A sandbox with git-yunbox on PATH and a fake S3 service that signs like R2 (region `auto`). */
async function setup(): Promise<{ sandbox: Sandbox, s3: FakeS3Server, outputs: string[] }> {
  const sandbox = await createSandbox()
  cleanups.push(sandbox.cleanup)
  const s3 = await new FakeS3Server(bucket, 'auto', keys, reader).start()
  cleanups.push(() => s3.close())
  s3.readOnlyKeys.add(reader.accessKeyId)
  await installGitYunbox(sandbox)
  return { sandbox, s3, outputs: [] }
}

/** Run the CLI and keep its output, so the test can check that no secret was ever printed. */
async function run(sandbox: Sandbox, outputs: string[], cwd: string, argv: string[], stdin = ''): ReturnType<typeof runYunBox> {
  const result = await runYunBox(sandbox, cwd, argv, stdin)
  outputs.push(result.stdout, result.stderr)
  return result
}

function initArgs(s3: FakeS3Server, extra: string[] = []): string[] {
  return ['init', '--provider', 's3', '--endpoint', s3.origin, '--region', 'auto', '--bucket', bucket, '--prefix', prefix, '--types', 'model', ...extra]
}

describe('git-lfs directly to S3-compatible storage', () => {
  it('logs in, sets up, pushes, clones, restores history and never uploads twice', async () => {
    const { sandbox, s3, outputs } = await setup()

    // Outside a repository there is no bucket to check the keys against; they are saved anyway.
    const login = await run(sandbox, outputs, sandbox.root, ['login', '--provider', 's3', '--access-key-id', keys.accessKeyId, '--secret-key-stdin'], keys.secretAccessKey)
    expect(login.stderr).toBe('')
    expect(login.code).toBe(0)
    expect(login.stdout).toContain('不在接入了 S3 的仓库里')
    const file = credentialsFilePath(sandbox.env, 's3')
    expect(file.endsWith('credentials-s3.json')).toBe(true)
    if (process.platform !== 'win32')
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    // COS keys are stored separately and stay untouched.
    await expect(stat(credentialsFilePath(sandbox.env))).rejects.toThrow()

    const origin = join(sandbox.root, 'origin.git')
    await git(sandbox, sandbox.root, 'init', '--bare', '--quiet', origin)
    const repo = await createRepository(sandbox, 'game')
    await git(sandbox, repo, 'remote', 'add', 'origin', origin)
    const init = await run(sandbox, outputs, repo, initArgs(s3))
    expect(init.stderr).toBe('')
    expect(init.code).toBe(0)
    expect(init.stdout).toContain(`可以在 ${bucket}（${new URL(s3.origin).host}）/${prefix}/ 写入和读取`)
    const shared = await readFile(join(repo, '.yunbox', 'config'), 'utf8')
    expect(shared).toContain('provider = s3')
    expect(shared).toContain(`endpoint = ${s3.origin}`)
    expect(shared).toContain('addressingStyle = path')
    expect(shared).not.toContain('[cos]')
    expect(shared).not.toContain(keys.secretAccessKey)
    expect(shared).not.toContain(keys.accessKeyId)

    const doctor = await run(sandbox, outputs, repo, ['doctor'])
    expect(doctor.stdout).toContain('✓ S3 权限：可以写入和读取')
    expect(doctor.code).toBe(0)
    const json = await run(sandbox, outputs, repo, ['doctor', '--json'])
    expect(JSON.parse(json.stdout)).toMatchObject({
      schemaVersion: 1,
      status: 'ok',
      mode: 'cos',
      provider: 's3',
      location: { bucket, region: 'auto', prefix, endpoint: s3.origin },
    })

    const first = Buffer.alloc(3 * 1024 * 1024, 7)
    await writeFile(join(repo, 'car.fbx'), first)
    await git(sandbox, repo, 'add', '.')
    await git(sandbox, repo, 'commit', '--quiet', '-m', 'first car')
    const firstCommit = await git(sandbox, repo, 'rev-parse', 'HEAD')
    await git(sandbox, repo, 'push', '--quiet', 'origin', 'HEAD:main')
    const firstKey = objectKey(sha256(first))
    expect(s3.objects.get(firstKey)?.body.equals(first)).toBe(true)
    expect(s3.requests.find(request => request.method === 'PUT' && request.key === firstKey)?.ifNoneMatch).toBe('*')

    // The push check asks S3 which objects it already has.
    await writeFile(join(repo, 'car-copy.fbx'), first)
    await git(sandbox, repo, 'add', '.')
    await git(sandbox, repo, 'commit', '--quiet', '-m', 'same bytes again')
    const inspect = await run(sandbox, outputs, repo, ['inspect', '--push', '--json'])
    const report = JSON.parse(inspect.stdout) as PushInspection
    expect(report.lfs).toMatchObject({ remoteChecked: true, remoteStorage: 'S3', uploadBytes: 0 })

    const second = Buffer.alloc(1024 * 1024, 9)
    await writeFile(join(repo, 'car.fbx'), second)
    await git(sandbox, repo, 'commit', '--quiet', '-am', 'second car')
    await git(sandbox, repo, 'push', '--quiet', 'origin', 'HEAD:main')
    await git(sandbox, repo, 'lfs', 'push', '--all', 'origin')
    await git(sandbox, repo, 'lfs', 'push', '--all', 'origin')
    expect(s3.putCount(firstKey)).toBe(1)
    expect(s3.putCount(objectKey(sha256(second)))).toBe(1)

    // A collaborator logs in inside the clone, where the keys are checked against the bucket.
    const collaborator = await createSandbox()
    cleanups.push(collaborator.cleanup)
    await installGitYunbox(collaborator)
    const clone = await run(collaborator, outputs, collaborator.root, ['clone', origin, 'teammate'])
    expect(clone.code).toBe(1)
    expect(clone.stderr).toContain('yunbox login --provider s3')
    const teammate = join(collaborator.root, 'teammate')
    const wrong = await run(collaborator, outputs, teammate, ['login', '--access-key-id', keys.accessKeyId, '--secret-key-stdin'], 'not-the-right-secret-access-key-at-all')
    expect(wrong.code).toBe(1)
    expect(wrong.stderr).toContain('SignatureDoesNotMatch')
    const right = await run(collaborator, outputs, teammate, ['login', '--access-key-id', keys.accessKeyId, '--secret-key-stdin'], keys.secretAccessKey)
    expect(right.code).toBe(0)
    expect(right.stdout).toContain('✓ 密钥有效')
    const joined = await run(collaborator, outputs, teammate, ['init'])
    expect(joined.code).toBe(0)
    await git(collaborator, teammate, 'lfs', 'pull')
    expect(sha256(await readFile(join(teammate, 'car.fbx')))).toBe(sha256(second))
    expect(await git(collaborator, teammate, 'status', '--porcelain')).toBe('')
    await git(collaborator, teammate, 'checkout', '--quiet', firstCommit)
    expect(sha256(await readFile(join(teammate, 'car.fbx')))).toBe(sha256(first))

    // A fresh clone with one command.
    const fresh = await run(collaborator, outputs, collaborator.root, ['clone', origin, 'fresh'])
    expect(fresh.stderr).toBe('')
    expect(fresh.code).toBe(0)
    expect(sha256(await readFile(join(collaborator.root, 'fresh', 'car.fbx')))).toBe(sha256(second))

    // Replace the stored bytes: the agent must refuse to hand them to git-lfs.
    s3.objects.set(firstKey, { body: Buffer.alloc(first.byteLength, 1), etag: '"tampered"' })
    // car-copy.fbx at the tip has the same bytes, so the clone itself refuses them.
    const victim = await run(collaborator, outputs, collaborator.root, ['clone', origin, 'victim'])
    expect(victim.code).toBe(1)
    expect(victim.stderr).toContain('SHA-256')

    for (const output of outputs) {
      expect(output).not.toContain(keys.secretAccessKey)
      expect(output).not.toContain('Signature=')
    }
  }, 180_000)

  it('falls back to HEAD before PUT when the service does not support If-None-Match', async () => {
    const { sandbox, s3, outputs } = await setup()
    s3.conditionalWrites = 'not-implemented'
    Object.assign(sandbox.env, { YUNBOX_S3_ACCESS_KEY_ID: keys.accessKeyId, YUNBOX_S3_SECRET_ACCESS_KEY: keys.secretAccessKey })
    const origin = join(sandbox.root, 'origin.git')
    await git(sandbox, sandbox.root, 'init', '--bare', '--quiet', origin)
    const repo = await createRepository(sandbox)
    await git(sandbox, repo, 'remote', 'add', 'origin', origin)
    expect((await run(sandbox, outputs, repo, initArgs(s3))).code).toBe(0)
    const assets = [Buffer.alloc(200 * 1024, 1), Buffer.alloc(300 * 1024, 2)]
    await writeFile(join(repo, 'a.fbx'), assets[0]!)
    await writeFile(join(repo, 'b.fbx'), assets[1]!)
    await git(sandbox, repo, 'add', '.')
    await git(sandbox, repo, 'commit', '--quiet', '-m', 'assets')
    await git(sandbox, repo, 'push', '--quiet', 'origin', 'HEAD:main')
    for (const asset of assets)
      expect(s3.objects.get(objectKey(sha256(asset)))?.body.equals(asset)).toBe(true)
    const puts = s3.requests.filter(request => request.method === 'PUT' && request.key.endsWith(sha256(assets[0]!)))
    // At most one rejected attempt per agent process, then plain PUTs.
    expect(puts.some(request => request.status === 200 && request.ifNoneMatch === undefined)).toBe(true)
    await git(sandbox, repo, 'lfs', 'push', '--all', 'origin')
    expect(s3.putCount(objectKey(sha256(assets[0]!)))).toBe(1)
  }, 60_000)

  it('tells read-only keys from writable ones and refuses keys that do not work', async () => {
    const { sandbox, s3, outputs } = await setup()
    const repo = await createRepository(sandbox)
    Object.assign(sandbox.env, { YUNBOX_S3_ACCESS_KEY_ID: keys.accessKeyId, YUNBOX_S3_SECRET_ACCESS_KEY: 'wrong-secret-access-key-0123456789' })
    const refused = await run(sandbox, outputs, repo, initArgs(s3))
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain(`不能访问 ${bucket}`)
    await expect(stat(join(repo, '.yunbox'))).rejects.toThrow()
    await expect(git(sandbox, repo, 'config', '--local', 'lfs.standalonetransferagent')).rejects.toThrow()

    Object.assign(sandbox.env, { YUNBOX_S3_ACCESS_KEY_ID: reader.accessKeyId, YUNBOX_S3_SECRET_ACCESS_KEY: reader.secretAccessKey })
    const readOnly = await run(sandbox, outputs, repo, initArgs(s3, ['--read-only']))
    expect(readOnly.code).toBe(0)
    expect(readOnly.stdout).toContain('只能读取')
    expect((await run(sandbox, outputs, repo, ['doctor', '--read-only'])).code).toBe(0)
    const doctor = await run(sandbox, outputs, repo, ['doctor'])
    expect(doctor.code).toBe(1)
    expect(doctor.stdout).toContain('✗ S3 权限：只能读取，不能推送')

    // COS-only capabilities say so instead of printing a COS policy for an S3 bucket.
    const policy = await run(sandbox, outputs, repo, ['policy'])
    expect(policy.code).toBe(1)
    expect(policy.stderr).toContain('只支持腾讯云 COS')
    for (const output of outputs)
      expect(output).not.toContain(reader.secretAccessKey)
  })

  it('validates S3 settings before touching the repository', async () => {
    const { sandbox, s3, outputs } = await setup()
    Object.assign(sandbox.env, { YUNBOX_S3_ACCESS_KEY_ID: keys.accessKeyId, YUNBOX_S3_SECRET_ACCESS_KEY: keys.secretAccessKey })
    const repo = await createRepository(sandbox)
    const cases: Array<[string[], RegExp]> = [
      [['init', '--endpoint', 'http://s3.example.com', '--bucket', bucket, '--prefix', 'p'], /必须用 https/],
      [['init', '--endpoint', `${s3.origin}/path`, '--bucket', bucket, '--prefix', 'p'], /不能带路径/],
      [['init', '--preset', 'r2', '--account-id', 'not-an-id', '--bucket', bucket, '--prefix', 'p'], /32 位十六进制/],
      [['init', '--preset', 'gcs', '--bucket', bucket], /--preset 只能是/],
      [['init', '--provider', 'cos', '--endpoint', s3.origin], /只用于 S3 兼容存储/],
      [['init', '--provider', 's3', '--endpoint', s3.origin, '--bucket', bucket, '--create'], /不支持用 --create/],
      [['init', '--endpoint', 'https://s3.example.com', '--addressing', 'virtual', '--bucket', 'a.b.c', '--prefix', 'p'], /虚拟主机风格/],
    ]
    for (const [argv, message] of cases) {
      const result = await run(sandbox, outputs, repo, argv)
      expect(result.code, argv.join(' ')).toBe(2)
      expect(result.stderr).toMatch(message)
    }
    await expect(stat(join(repo, '.yunbox'))).rejects.toThrow()
  })
})
