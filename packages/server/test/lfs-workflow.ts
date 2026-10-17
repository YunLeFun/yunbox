import type { ObjectStorage, RepositoryId } from '@yunbox/core'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { expect } from 'vitest'
import { startYunBoxServer } from '../src/server.ts'

/** The repository every workflow pushes to. */
export const WORKFLOW_REPOSITORY: RepositoryId = { owner: 'team', repo: 'assets' }

/** Backend-specific hooks the shared Git LFS workflow needs. */
export interface WorkflowHarness {
  storage: ObjectStorage
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
 * `git-lfs` against a YunBox server backed by the harness storage.
 */
export async function runGitLfsWorkflow(harness: WorkflowHarness): Promise<WorkflowResult> {
  const root = await mkdtemp(join(tmpdir(), 'yunbox-e2e-test-'))
  const home = join(root, 'home')
  const source = join(root, 'source')
  const origin = join(root, 'origin.git')
  await Promise.all([mkdir(home), mkdir(source)])

  const running = await startYunBoxServer({ storage: harness.storage, port: 0 })
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

  try {
    await git(root, environment, 'lfs', 'version')
    await git(root, environment, 'lfs', 'install', '--skip-repo')
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

    const versionOne = Buffer.alloc(64 * 1024, 0x11)
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
