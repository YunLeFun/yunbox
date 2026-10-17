import type {
  ObjectStorage,
  PutObjectOptions,
  RepositoryId,
  StorageVerificationResult,
  StoredObjectBody,
  StoredObjectInfo,
} from '@yunbox/core'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CosObjectStorage, LocalFileObjectStorage } from '@yunbox/core'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeCosServer } from '../../core/test/fake-cos-server.ts'
import { runGitLfsWorkflow, WORKFLOW_REPOSITORY } from './lfs-workflow.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

describe('git LFS end-to-end workflow', () => {
  it('pushes, clones, restores history, retries and remains idempotent with local storage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yunbox-e2e-objects-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const localStorage = new LocalFileObjectStorage(directory)
    const storage = new InterruptingStorage(localStorage)

    await runGitLfsWorkflow({
      storage,
      writeStamp: async oid => (await stat(localStorage.objectPath(WORKFLOW_REPOSITORY, oid))).mtimeMs,
      interruption: {
        start: oid => storage.interruptUploads(oid),
        stop: () => storage.resumeUploads(),
        attempts: () => storage.interruptedAttempts,
      },
    })
  }, 120_000)

  it('transfers objects directly to COS through presigned URLs', async () => {
    const credentials = {
      secretId: 'AKIDTESTTESTTESTTESTTESTTESTTEST',
      secretKey: 'test-secret-key-test-secret-key',
      sessionToken: 'temporary-session-token',
    }
    const cos = await new FakeCosServer(credentials).start()
    cleanups.push(() => cos.close())
    const storage = new CosObjectStorage({
      bucket: 'assets-1250000000',
      region: 'ap-guangzhou',
      prefix: 'yunbox',
      endpoint: cos.origin,
      credentials,
    })

    const { oids } = await runGitLfsWorkflow({
      storage,
      writeStamp: async oid => cos.putCount(storage.objectKey(WORKFLOW_REPOSITORY, oid)),
      interruption: {
        start: oid => cos.interruptPuts(storage.objectKey(WORKFLOW_REPOSITORY, oid)),
        stop: () => cos.resumePuts(),
        attempts: () => cos.interruptedAttempts,
      },
    })

    for (const oid of oids) {
      const key = storage.objectKey(WORKFLOW_REPOSITORY, oid)
      expect(cos.putCount(key)).toBe(1)
      expect(cos.requests.some(request => request.key === key && request.method === 'GET' && request.presigned && request.status === 200)).toBe(true)
    }
    expect(cos.requests.every(request => request.status !== 403)).toBe(true)
  }, 120_000)
})

class InterruptingStorage implements ObjectStorage {
  readonly #delegate: LocalFileObjectStorage
  #interruptedOid: string | undefined
  interruptedAttempts = 0

  constructor(delegate: LocalFileObjectStorage) {
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
