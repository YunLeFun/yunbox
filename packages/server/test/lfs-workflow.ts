import type { ObjectStorage, RepositoryId } from '@yunbox/core'
import type { RequestLogEntry } from '../src/logging.ts'
import type { TokenStore } from '../src/tokens.ts'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { expect } from 'vitest'
import { startYunBoxServer } from '../src/server.ts'
import { createToken, revokeToken } from '../src/tokens.ts'

/** The repository every workflow pushes to. */
export const WORKFLOW_REPOSITORY: RepositoryId = { owner: 'team', repo: 'assets' }

/** Backend-specific hooks the shared Git LFS workflow needs. */
export interface WorkflowHarness {
  storage: ObjectStorage
  /** Where the workflow creates and revokes its tokens. */
  tokens: TokenStore
  /** A value that changes whenever the object's bytes are written again. */
  writeStamp: (oid: string) => Promise<unknown>
  /** Optional fault injection; backends that cannot intercept uploads skip the retry step. */
  interruption?: {
    start: (oid: string) => void
    stop: () => void
    attempts: () => number
  }
}

/** Object ids written by {@link runGitLfsWorkflow}, for cleanup. */
export interface WorkflowResult {
  oids: string[]
}

/**
 * Push, clone, restore history, retry and repeat pushes with real `git` and
 * `git-lfs` against a YunBox server backed by the harness storage, then check
 * that read-only, unrelated, missing and revoked tokens are refused.
 *
 * Tokens reach git-lfs the way they would for a user: through a Git
 * credential helper (`credential.helper store`) rather than the URL.
 */
export async function runGitLfsWorkflow(harness: WorkflowHarness): Promise<WorkflowResult> {
  const root = await mkdtemp(join(tmpdir(), 'yunbox-e2e-test-'))
  const home = join(root, 'home')
  const source = join(root, 'source')
  const origin = join(root, 'origin.git')
  await Promise.all([mkdir(home), mkdir(source)])

  const writer = await createToken(harness.tokens, { name: 'writer', repos: { 'team/assets': 'write' } })
  const reader = await createToken(harness.tokens, { name: 'reader', repos: { 'team/*': 'read' } })
  const outsider = await createToken(harness.tokens, { name: 'outsider', repos: { 'other/*': 'write' } })
  const logs: RequestLogEntry[] = []
  const running = await startYunBoxServer({
    storage: harness.storage,
    tokens: harness.tokens,
    port: 0,
    tokenCacheTtlSeconds: 1,
    log: entry => logs.push(entry),
  })
  const credentialsFile = join(home, 'git-credentials')
  const useToken = async (secret: string | undefined): Promise<void> => {
    const { host } = new URL(running.url)
    await writeFile(credentialsFile, secret === undefined ? '' : `http://yunbox:${secret}@${host}\n`, { mode: 0o600 })
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_FORCE_PROGRESS: '0',
    GIT_LFS_SKIP_SMUDGE: '0',
    LC_ALL: 'C',
  }
  const oids: string[] = []
  const lfsPullIntoFreshClone = async (name: string): Promise<void> => {
    const directory = join(root, name)
    await git(root, { ...environment, GIT_LFS_SKIP_SMUDGE: '1' }, 'clone', origin, directory)
    await git(directory, environment, 'lfs', 'pull')
    expect(await hashFile(join(directory, 'asset.bin'))).toBe(oids[2])
  }

  try {
    await git(root, environment, 'lfs', 'version')
    await git(root, environment, 'lfs', 'install', '--skip-repo')
    await git(root, environment, 'config', '--global', 'credential.helper', `store --file='${credentialsFile}'`)
    await useToken(writer.secret)
    await git(root, environment, 'init', '--bare', '--initial-branch=main', origin)
    await git(source, environment, 'init', '--initial-branch=main')
    await git(source, environment, 'config', 'user.name', 'YunBox Test')
    await git(source, environment, 'config', 'user.email', 'yunbox-test@example.invalid')
    await git(source, environment, 'config', 'lfs.locksverify', 'false')
    await git(source, environment, 'config', 'lfs.transfer.maxretries', '1')
    await git(source, environment, 'config', 'lfs.transfer.maxretrydelay', '1')
    await git(source, environment, 'lfs', 'install', '--local')
    const { owner, repo } = WORKFLOW_REPOSITORY
    await writeFile(join(source, '.lfsconfig'), `[lfs]\n\turl = ${running.url}/${owner}/${repo}\n`)
    await writeFile(join(source, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
    await git(source, environment, 'remote', 'add', 'origin', origin)

    // git-lfs sends the first PUT of a fresh repository without credentials and
    // retries after the 401, so the first object is large enough that the
    // server rejects it before the body has been sent.
    const versionOne = Buffer.alloc(32 * 1024 * 1024, 0x11)
    oids.push(sha256(versionOne))
    await writeFile(join(source, 'asset.bin'), versionOne)
    await git(source, environment, 'add', '.gitattributes', '.lfsconfig', 'asset.bin')
    await git(source, environment, 'commit', '-m', 'add first asset')
    const firstCommit = (await git(source, environment, 'rev-parse', 'HEAD')).stdout.trim()
    await git(source, environment, 'push', '-u', 'origin', 'main')

    const versionTwo = Buffer.alloc(96 * 1024, 0x22)
    oids.push(sha256(versionTwo))
    await writeFile(join(source, 'asset.bin'), versionTwo)
    await git(source, environment, 'add', 'asset.bin')
    await git(source, environment, 'commit', '-m', 'update asset')
    await git(source, environment, 'push', 'origin', 'main')

    const freshClone = join(root, 'fresh-clone')
    await git(root, environment, 'clone', origin, freshClone)
    expect(await hashFile(join(freshClone, 'asset.bin'))).toBe(oids[1])
    await git(freshClone, environment, 'checkout', '--detach', firstCommit)
    expect(await hashFile(join(freshClone, 'asset.bin'))).toBe(oids[0])

    const stampBeforeRepeat = await harness.writeStamp(oids[1]!)
    await git(source, environment, 'lfs', 'push', '--all', 'origin')
    expect(await harness.writeStamp(oids[1]!)).toEqual(stampBeforeRepeat)

    const versionThree = Buffer.alloc(4 * 1024 * 1024, 0x33)
    const versionThreeOid = sha256(versionThree)
    oids.push(versionThreeOid)
    await writeFile(join(source, 'asset.bin'), versionThree)
    await git(source, environment, 'add', 'asset.bin')
    await git(source, environment, 'commit', '-m', 'add retry asset')
    if (harness.interruption !== undefined) {
      harness.interruption.start(versionThreeOid)
      await expect(git(source, environment, 'push', 'origin', 'main')).rejects.toThrow('Git command failed')
      expect(harness.interruption.attempts()).toBeGreaterThan(0)
      expect(await harness.storage.inspectObject(WORKFLOW_REPOSITORY, versionThreeOid)).toBeUndefined()
      harness.interruption.stop()
    }
    await git(source, environment, 'push', 'origin', 'main')
    const retryClone = join(root, 'retry-clone')
    await git(root, environment, 'clone', origin, retryClone)
    expect(await hashFile(join(retryClone, 'asset.bin'))).toBe(versionThreeOid)

    // A read-only token can clone and download, but cannot push new objects.
    await useToken(reader.secret)
    const readerClone = join(root, 'reader-clone')
    await git(root, environment, 'clone', origin, readerClone)
    expect(await hashFile(join(readerClone, 'asset.bin'))).toBe(versionThreeOid)
    const forbidden = Buffer.alloc(8 * 1024, 0x44)
    const forbiddenOid = sha256(forbidden)
    await writeFile(join(source, 'asset.bin'), forbidden)
    await git(source, environment, 'add', 'asset.bin')
    await git(source, environment, 'commit', '-m', 'read-only push attempt')
    await expect(git(source, environment, 'push', 'origin', 'main')).rejects.toThrow(/read-only access/)
    expect(await harness.storage.inspectObject(WORKFLOW_REPOSITORY, forbiddenOid)).toBeUndefined()

    // A token for other repositories is refused for both download and upload.
    await useToken(outsider.secret)
    await expect(lfsPullIntoFreshClone('outsider-clone')).rejects.toThrow(/no access to the repository/)
    await expect(git(source, environment, 'push', 'origin', 'main')).rejects.toThrow(/no access to the repository/)

    // Without credentials, the server asks for them and git-lfs gives up.
    await useToken(undefined)
    await expect(lfsPullIntoFreshClone('anonymous-clone')).rejects.toThrow(/Git credentials for .* not found/)

    // A revoked token stops working once the token cache TTL has passed.
    await useToken(writer.secret)
    await lfsPullIntoFreshClone('writer-clone')
    await revokeToken(harness.tokens, writer.token.id)
    await delay(1100)
    const logsBeforeRevokedPull = logs.length
    await expect(lfsPullIntoFreshClone('revoked-clone')).rejects.toThrow(/Git credentials for .* not found/)
    // No request authenticated as the revoked token, and because the server
    // answered 401 to the token Git presented, Git erased it from the helper.
    expect(logs.slice(logsBeforeRevokedPull).some(entry => entry.tokenId === writer.token.id)).toBe(false)
    expect(await readFile(credentialsFile, 'utf8')).not.toContain(writer.secret)

    expect(logs.some(entry => entry.tokenId === writer.token.id && entry.status === 200)).toBe(true)
    const serializedLogs = JSON.stringify(logs)
    for (const secret of [writer.secret, reader.secret, outsider.secret, 'ybx_', 'signature', 'Basic', '://'])
      expect(serializedLogs).not.toContain(secret)
    return { oids }
  }
  finally {
    await running.close()
    await rm(root, { recursive: true, force: true })
  }
}

interface CommandResult {
  stdout: string
  stderr: string
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Git command failed: git ${args.join(' ')}\n${stderr}`, { cause: error }))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function hashFile(path: string): Promise<string> {
  return sha256(await readFile(path))
}
