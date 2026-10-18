import type { FakeCamPolicy } from '../../core/test/fake-cos-server.ts'
import type { Sandbox } from './helpers.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeCosServer } from '../../core/test/fake-cos-server.ts'
import { credentialsFilePath, resolveCredentials } from '../src/cos/credentials.ts'
import { createRepository, createSandbox, git, runYunBox } from './helpers.ts'

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url))
const cliSource = join(workspaceRoot, 'packages', 'cli', 'src', 'cli.ts')
const tsxLoader = pathToFileURL(join(workspaceRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
const keys = { secretId: 'AKIDTESTTESTTESTTESTTESTTESTTEST', secretKey: 'test-secret-key-test-secret-key' }
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function objectKey(oid: string): string {
  return `yunbox/team/game/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`
}

/** A sandbox whose PATH has a `git-yunbox` that git-lfs can start, and a fake COS account. */
async function setup(): Promise<{ sandbox: Sandbox, cos: FakeCosServer }> {
  const sandbox = await createSandbox()
  cleanups.push(sandbox.cleanup)
  const cos = await new FakeCosServer(keys).start()
  cleanups.push(() => cos.close())
  cos.buckets.push({ name: 'team-assets-1250000000', region: 'ap-shanghai' })
  const bin = join(sandbox.root, 'bin')
  await mkdir(bin)
  // Stand-ins for the npm bins. git-lfs runs agents through sh, which needs the extension-less
  // script; npm also creates a .cmd for cmd.exe and PowerShell on Windows.
  const posix = (path: string): string => path.replaceAll('\\', '/')
  const shim = join(bin, 'git-yunbox')
  await writeFile(shim, `#!/bin/sh\nexec "${posix(process.execPath)}" --no-warnings --import "${tsxLoader}" "${posix(cliSource)}" "$@"\n`)
  await chmod(shim, 0o755)
  if (process.platform === 'win32')
    await writeFile(join(bin, 'git-yunbox.cmd'), `@"${process.execPath}" --no-warnings --import "${tsxLoader}" "${cliSource}" %*\r\n`)
  Object.assign(sandbox.env, {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
    TSX_TSCONFIG_PATH: join(workspaceRoot, 'tsconfig.json'),
    // Point both the account API and the bucket at the fake; real runs use the public COS origins.
    YUNBOX_COS_SERVICE_ENDPOINT: cos.origin,
    YUNBOX_COS_ENDPOINT: cos.origin,
    GIT_LFS_SKIP_SMUDGE: '0',
    // On Windows, show git-lfs's view of the transfer agent when a push fails.
    ...(process.platform === 'win32' ? { GIT_TRACE: '1', GIT_TRANSFER_TRACE: '1' } : {}),
  })
  delete sandbox.env.TENCENTCLOUD_SECRETID
  delete sandbox.env.TENCENTCLOUD_SECRETKEY
  return { sandbox, cos }
}

describe('git-lfs directly to COS, without a server', () => {
  it('logs in, sets up a repository interactively, pushes, clones, restores history and refuses tampered objects', async () => {
    const { sandbox, cos } = await setup()

    const login = await runYunBox(sandbox, sandbox.root, ['login', '--secret-id', keys.secretId, '--secret-key-stdin'], keys.secretKey)
    expect(login.stderr).toBe('')
    expect(login.code).toBe(0)
    const file = credentialsFilePath(sandbox.env)
    if (process.platform !== 'win32')
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await resolveCredentials(sandbox.env))?.source).toBe('file')

    const origin = join(sandbox.root, 'origin.git')
    await git(sandbox, sandbox.root, 'init', '--bare', '--quiet', origin)
    const repo = await createRepository(sandbox, 'game')
    await git(sandbox, repo, 'remote', 'add', 'origin', 'https://github.com/team/game.git')

    // Pick bucket 1 and accept the suggested prefix.
    const init = await runYunBox(sandbox, repo, ['init', '--types', 'model'], '1\n\n')
    expect(init.stderr).toBe('')
    expect(init.code).toBe(0)
    expect(init.stdout).toContain('可以在 team-assets-1250000000（ap-shanghai）/yunbox/team/game/ 写入和读取')
    const shared = await readFile(join(repo, '.yunboxconfig'), 'utf8')
    expect(shared).toContain('bucket = team-assets-1250000000')
    expect(shared).toContain('prefix = yunbox/team/game')
    expect(shared).not.toMatch(/secret|AKID/i)
    await expect(stat(join(repo, '.lfsconfig'))).rejects.toThrow()
    expect(await git(sandbox, repo, 'config', '--local', 'lfs.standalonetransferagent')).toBe('yunbox')
    expect(await git(sandbox, repo, 'config', '--local', 'lfs.customtransfer.yunbox.path')).toBe('git-yunbox')
    const doctor = await runYunBox(sandbox, repo, ['doctor'])
    expect(doctor.stdout).toContain('COS 权限')
    expect(doctor.code).toBe(0)

    const first = Buffer.alloc(3 * 1024 * 1024, 7)
    await writeFile(join(repo, 'car.fbx'), first)
    await git(sandbox, repo, 'add', '.')
    await git(sandbox, repo, 'commit', '--quiet', '-m', 'first car')
    const firstCommit = await git(sandbox, repo, 'rev-parse', 'HEAD')
    await git(sandbox, repo, 'remote', 'set-url', 'origin', origin)
    await git(sandbox, repo, 'push', '--quiet', 'origin', 'HEAD:main')
    const firstKey = objectKey(sha256(first))
    expect(cos.objects.get(firstKey)?.body.equals(first)).toBe(true)

    const second = Buffer.alloc(1024 * 1024, 9)
    await writeFile(join(repo, 'car.fbx'), second)
    await git(sandbox, repo, 'commit', '--quiet', '-am', 'second car')
    await git(sandbox, repo, 'push', '--quiet', 'origin', 'HEAD:main')
    await git(sandbox, repo, 'lfs', 'push', '--all', 'origin')
    expect(cos.putCount(firstKey)).toBe(1)

    // A collaborator with the same bucket access clones with one command.
    const clone = await runYunBox(sandbox, sandbox.root, ['clone', origin, 'teammate'])
    expect(clone.stderr).toBe('')
    expect(clone.code).toBe(0)
    const teammate = join(sandbox.root, 'teammate')
    expect(sha256(await readFile(join(teammate, 'car.fbx')))).toBe(sha256(second))
    // Joining an existing setup must not modify committed files such as .gitattributes.
    expect(await git(sandbox, teammate, 'status', '--porcelain')).toBe('')
    await git(sandbox, teammate, 'checkout', '--quiet', firstCommit)
    expect(sha256(await readFile(join(teammate, 'car.fbx')))).toBe(sha256(first))
    expect(cos.requests.every(request => request.status !== 403)).toBe(true)

    // From here the collaborator's sub-account only has what `yunbox policy` prints.
    const writePolicy = await runYunBox(sandbox, repo, ['policy'])
    expect(writePolicy.code).toBe(0)
    cos.policy = JSON.parse(writePolicy.stdout) as FakeCamPolicy
    const teammateDoctor = await runYunBox(sandbox, teammate, ['doctor'])
    expect(teammateDoctor.stdout).toContain('✓ COS 权限')
    expect(teammateDoctor.code).toBe(0)
    await git(sandbox, teammate, 'checkout', '--quiet', 'main')
    const third = Buffer.alloc(512 * 1024, 3)
    await writeFile(join(teammate, 'car.fbx'), third)
    await git(sandbox, teammate, 'commit', '--quiet', '-am', 'third car')
    await git(sandbox, teammate, 'push', '--quiet', 'origin', 'HEAD:main')
    expect(cos.objects.get(objectKey(sha256(third)))?.body.equals(third)).toBe(true)
    // Nothing outside the prefix, and no deleting.
    expect(cos.requests.some(request => request.method === 'DELETE')).toBe(false)
    const otherRepo = await createRepository(sandbox, 'other')
    const otherInit = await runYunBox(sandbox, otherRepo, ['init', '--bucket', 'team-assets-1250000000', '--region', 'ap-shanghai', '--prefix', 'yunbox/team/other'])
    expect(otherInit.code).toBe(1)

    // Read-only: pulls work, pushes are refused.
    const readPolicy = await runYunBox(sandbox, repo, ['policy', '--read-only'])
    cos.policy = JSON.parse(readPolicy.stdout) as FakeCamPolicy
    expect((await runYunBox(sandbox, teammate, ['doctor', '--read-only'])).code).toBe(0)
    const reader = await runYunBox(sandbox, sandbox.root, ['clone', origin, 'reader'])
    expect(reader.code).toBe(0)
    expect(sha256(await readFile(join(sandbox.root, 'reader', 'car.fbx')))).toBe(sha256(third))
    await writeFile(join(teammate, 'car.fbx'), Buffer.alloc(256 * 1024, 4))
    await git(sandbox, teammate, 'commit', '--quiet', '-am', 'fourth car')
    await expect(git(sandbox, teammate, 'push', '--quiet', 'origin', 'HEAD:main')).rejects.toThrow()
    cos.policy = undefined

    // Replace the stored bytes: the agent must refuse to hand them to git-lfs.
    cos.objects.set(firstKey, { body: Buffer.alloc(first.byteLength, 1), etag: '"tampered"' })
    await expect(runYunBox(sandbox, sandbox.root, ['clone', origin, 'victim']).then((run) => {
      if (run.code !== 0)
        throw new Error(run.stderr)
      return git(sandbox, join(sandbox.root, 'victim'), 'checkout', '--quiet', firstCommit)
    })).rejects.toThrow(/SHA-256/)
  }, 180_000)

  it('refuses keys without access and changes nothing', async () => {
    const { sandbox } = await setup()
    sandbox.env.TENCENTCLOUD_SECRETID = keys.secretId
    sandbox.env.TENCENTCLOUD_SECRETKEY = 'wrong-secret-key-wrong-secret'
    const repo = await createRepository(sandbox)
    const run = await runYunBox(sandbox, repo, ['init', '--bucket', 'team-assets-1250000000', '--region', 'ap-shanghai', '--prefix', 'yunbox/x'])
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('不能访问 team-assets-1250000000（ap-shanghai）/yunbox/x/')
    await expect(stat(join(repo, '.yunboxconfig'))).rejects.toThrow()
    await expect(git(sandbox, repo, 'config', '--local', 'lfs.standalonetransferagent')).rejects.toThrow()
  })

  it('never accepts a SecretKey on the command line and explains missing keys', async () => {
    const { sandbox } = await setup()
    const inline = await runYunBox(sandbox, sandbox.root, ['login', '--secret-id', keys.secretId, `--secret-key=${keys.secretKey}`])
    expect(inline.code).toBe(2)
    expect(inline.stderr).not.toContain(keys.secretKey)
    const repo = await createRepository(sandbox)
    const noKeys = await runYunBox(sandbox, repo, ['init'])
    expect(noKeys.code).toBe(1)
    expect(noKeys.stderr).toContain('yunbox login')
  })

  it('reports buckets and doctor results as JSON for graphical clients', async () => {
    const { sandbox } = await setup()
    const repo = await createRepository(sandbox)
    const noKeys = JSON.parse((await runYunBox(sandbox, repo, ['buckets', '--json'])).stdout) as { status: string, error: { code: string } }
    expect(noKeys).toMatchObject({ status: 'error', error: { code: 'NO_CREDENTIALS' } })

    sandbox.env.TENCENTCLOUD_SECRETID = keys.secretId
    sandbox.env.TENCENTCLOUD_SECRETKEY = keys.secretKey
    const buckets = await runYunBox(sandbox, repo, ['buckets', '--json'])
    expect(buckets.code).toBe(0)
    expect(JSON.parse(buckets.stdout)).toEqual({ schemaVersion: 1, status: 'ok', buckets: [{ name: 'team-assets-1250000000', region: 'ap-shanghai' }] })

    const before = await runYunBox(sandbox, repo, ['doctor', '--json'])
    expect(before.code).toBe(1)
    const unset = JSON.parse(before.stdout) as { mode: string, status: string, steps: Array<{ title: string, status: string }> }
    expect(unset).toMatchObject({ schemaVersion: 1, status: 'failed', mode: 'none' })
    expect(unset.steps.some(step => step.title === 'YunBox' && step.status === 'fail')).toBe(true)

    expect((await runYunBox(sandbox, repo, ['init', '--bucket', 'team-assets-1250000000', '--prefix', 'yunbox/json'])).code).toBe(0)
    const after = await runYunBox(sandbox, repo, ['doctor', '--json'])
    expect(after.stdout.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(after.stdout)).toMatchObject({
      schemaVersion: 1,
      status: 'ok',
      mode: 'cos',
      location: { bucket: 'team-assets-1250000000', region: 'ap-shanghai', prefix: 'yunbox/json' },
    })
    expect(after.stdout).not.toContain(keys.secretKey)
  })
})
