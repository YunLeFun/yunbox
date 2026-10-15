import type {
  ObjectStorage,
  PutObjectOptions,
  RepositoryId,
  StorageVerificationResult,
  StoredObjectBody,
  StoredObjectInfo,
} from '@yunbox/core'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFileObjectStorage } from '@yunbox/core'
import { afterEach, describe, expect, it } from 'vitest'
import { startYunBoxServer } from '../src/server.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('git LFS end-to-end workflow', () => {
  it('pushes, clones, restores history, retries and remains idempotent', async () => {
    const root = await createTemporaryDirectory()
    const home = join(root, 'home')
    const source = join(root, 'source')
    const origin = join(root, 'origin.git')
    const storageDirectory = join(root, 'objects')
    await Promise.all([mkdir(home), mkdir(source)])

    const localStorage = new LocalFileObjectStorage(storageDirectory)
    const storage = new InterruptingStorage(localStorage)
    const running = await startYunBoxServer({ storage, port: 0 })
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
      await writeFile(join(source, '.lfsconfig'), `[lfs]\n\turl = ${running.url}/team/assets\n`)
      await writeFile(join(source, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n')
      await git(source, environment, 'remote', 'add', 'origin', origin)

      const versionOne = Buffer.alloc(64 * 1024, 0x11)
      const versionOneOid = sha256(versionOne)
      await writeFile(join(source, 'asset.bin'), versionOne)
      await git(source, environment, 'add', '.gitattributes', '.lfsconfig', 'asset.bin')
      await git(source, environment, 'commit', '-m', 'add first asset')
      const firstCommit = (await git(source, environment, 'rev-parse', 'HEAD')).stdout.trim()
      await git(source, environment, 'push', '-u', 'origin', 'main')

      const versionTwo = Buffer.alloc(96 * 1024, 0x22)
      const versionTwoOid = sha256(versionTwo)
      await writeFile(join(source, 'asset.bin'), versionTwo)
      await git(source, environment, 'add', 'asset.bin')
      await git(source, environment, 'commit', '-m', 'update asset')
      await git(source, environment, 'push', 'origin', 'main')

      const freshClone = join(root, 'fresh-clone')
      await git(root, environment, 'clone', origin, freshClone)
      expect(await hashFile(join(freshClone, 'asset.bin'))).toBe(versionTwoOid)
      await git(freshClone, environment, 'checkout', '--detach', firstCommit)
      expect(await hashFile(join(freshClone, 'asset.bin'))).toBe(versionOneOid)

      const storedPath = localStorage.objectPath({ owner: 'team', repo: 'assets' }, versionTwoOid)
      const modifiedBeforeRepeat = (await stat(storedPath)).mtimeMs
      await git(source, environment, 'lfs', 'push', '--all', 'origin')
      expect((await stat(storedPath)).mtimeMs).toBe(modifiedBeforeRepeat)

      const versionThree = Buffer.alloc(4 * 1024 * 1024, 0x33)
      const versionThreeOid = sha256(versionThree)
      await writeFile(join(source, 'asset.bin'), versionThree)
      await git(source, environment, 'add', 'asset.bin')
      await git(source, environment, 'commit', '-m', 'add retry asset')
      storage.interruptUploads(versionThreeOid)
      await expect(git(source, environment, 'push', 'origin', 'main')).rejects.toThrow('Git command failed')
      expect(storage.interruptedAttempts).toBeGreaterThan(0)
      expect(await localStorage.inspectObject({ owner: 'team', repo: 'assets' }, versionThreeOid)).toBeUndefined()

      storage.resumeUploads()
      await git(source, environment, 'push', 'origin', 'main')
      const retryClone = join(root, 'retry-clone')
      await git(root, environment, 'clone', origin, retryClone)
      expect(await hashFile(join(retryClone, 'asset.bin'))).toBe(versionThreeOid)
    }
    finally {
      await running.close()
    }
  }, 120_000)
})

class InterruptingStorage implements ObjectStorage {
  readonly #delegate: ObjectStorage
  #interruptedOid: string | undefined
  interruptedAttempts = 0

  constructor(delegate: ObjectStorage) {
    this.#delegate = delegate
  }

  interruptUploads(oid: string): void {
    this.#interruptedOid = oid
  }

  resumeUploads(): void {
    this.#interruptedOid = undefined
  }

  inspectObject(repository: RepositoryId, oid: string): Promise<StoredObjectInfo | undefined> {
    return this.#delegate.inspectObject(repository, oid)
  }

  putObject(
    repository: RepositoryId,
    oid: string,
    body: AsyncIterable<Uint8Array>,
    options?: PutObjectOptions,
  ): Promise<StoredObjectInfo> {
    if (oid !== this.#interruptedOid)
      return this.#delegate.putObject(repository, oid, body, options)
    this.interruptedAttempts += 1
    return this.#delegate.putObject(repository, oid, interrupt(body), options)
  }

  readObject(repository: RepositoryId, oid: string): Promise<StoredObjectBody | undefined> {
    return this.#delegate.readObject(repository, oid)
  }

  verifyObject(repository: RepositoryId, oid: string, expectedSize: number): Promise<StorageVerificationResult> {
    return this.#delegate.verifyObject(repository, oid, expectedSize)
  }
}

async function* interrupt(body: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (!first.done)
    yield first.value
  await iterator.return?.()
  throw new Error('simulated interrupted upload')
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

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'yunbox-e2e-test-'))
  temporaryDirectories.push(directory)
  return directory
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function hashFile(path: string): Promise<string> {
  return sha256(await readFile(path))
}
