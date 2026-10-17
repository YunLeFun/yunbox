// @env node

import type { Stats } from 'node:fs'
import type {
  ObjectStorage,
  PutObjectOptions,
  RepositoryId,
  StorageVerificationResult,
  StoredObjectBody,
  StoredObjectInfo,
} from './types.ts'
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MAX_OBJECT_SIZE } from './constants.ts'
import { assertOid, assertRepository } from './validation.ts'

interface VerificationMarker {
  oid: string
  size: number
  mtimeMs: number
  verifiedAt: string
}

/** Error raised when an upload body exceeds the configured byte limit. */
export class ObjectTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`object body exceeds the ${maxBytes} byte limit`)
    this.name = 'ObjectTooLargeError'
  }
}

/**
 * Local, repository-isolated object storage for development and protocol tests.
 *
 * Object writes use a temporary sibling followed by rename. Verification is
 * persisted in a sidecar JSON marker tied to the object's size and mtime.
 */
export class LocalFileObjectStorage implements ObjectStorage {
  readonly #rootDirectory: string

  constructor(rootDirectory: string) {
    this.#rootDirectory = resolve(rootDirectory)
  }

  /** Resolve the repository-isolated path for an object. */
  objectPath(repository: RepositoryId, oid: string): string {
    assertRepository(repository)
    assertOid(oid)
    return join(this.#rootDirectory, repository.owner, repository.repo, oid.slice(0, 2), oid.slice(2, 4), oid)
  }

  /** Inspect object size and whether its current bytes have a valid marker. */
  async inspectObject(repository: RepositoryId, oid: string): Promise<StoredObjectInfo | undefined> {
    const objectPath = this.objectPath(repository, oid)
    const objectStat = await statIfExists(objectPath)
    if (!objectStat?.isFile())
      return undefined

    const marker = await readMarker(this.#markerPath(objectPath))
    return {
      size: objectStat.size,
      verified: marker?.oid === oid
        && marker.size === objectStat.size
        && marker.mtimeMs === objectStat.mtimeMs,
    }
  }

  /** Atomically replace an object and invalidate any earlier verification. */
  async putObject(
    repository: RepositoryId,
    oid: string,
    body: AsyncIterable<Uint8Array>,
    options: PutObjectOptions = {},
  ): Promise<StoredObjectInfo> {
    const maxBytes = options.maxBytes ?? MAX_OBJECT_SIZE
    const objectPath = this.objectPath(repository, oid)
    const markerPath = this.#markerPath(objectPath)
    const temporaryPath = join(dirname(objectPath), `.${oid}.${randomUUID()}.upload`)
    await mkdir(dirname(objectPath), { recursive: true })
    await rm(markerPath, { force: true })

    try {
      await pipeline(
        Readable.from(limitBytes(body, maxBytes)),
        createWriteStream(temporaryPath, { flags: 'wx' }),
      )
      await replaceFile(temporaryPath, objectPath)
      await rm(markerPath, { force: true })
      const objectStat = await stat(objectPath)
      return { size: objectStat.size, verified: false }
    }
    catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
  }

  /** Open an object body without changing its verification state. */
  async readObject(repository: RepositoryId, oid: string): Promise<StoredObjectBody | undefined> {
    const objectPath = this.objectPath(repository, oid)
    const objectStat = await statIfExists(objectPath)
    if (!objectStat?.isFile())
      return undefined
    return { size: objectStat.size, body: createReadStream(objectPath) }
  }

  /** Compare object size and atomically persist a verification marker. */
  async verifyObject(
    repository: RepositoryId,
    oid: string,
    expectedSize: number,
  ): Promise<StorageVerificationResult> {
    const objectPath = this.objectPath(repository, oid)
    const firstStat = await statIfExists(objectPath)
    if (!firstStat?.isFile())
      return { status: 'missing' }
    if (firstStat.size !== expectedSize)
      return { status: 'size-mismatch', actualSize: firstStat.size }

    const markerPath = this.#markerPath(objectPath)
    const temporaryPath = `${markerPath}.${randomUUID()}.tmp`
    const marker: VerificationMarker = {
      oid,
      size: firstStat.size,
      mtimeMs: firstStat.mtimeMs,
      verifiedAt: new Date().toISOString(),
    }
    await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, { flag: 'wx' })
    await replaceFile(temporaryPath, markerPath)

    const secondStat = await statIfExists(objectPath)
    if (!secondStat?.isFile()) {
      await rm(markerPath, { force: true })
      return { status: 'missing' }
    }
    if (secondStat.size !== firstStat.size || secondStat.mtimeMs !== firstStat.mtimeMs) {
      await rm(markerPath, { force: true })
      return { status: 'changed', actualSize: secondStat.size }
    }
    return { status: 'verified', actualSize: secondStat.size }
  }

  #markerPath(objectPath: string): string {
    return `${objectPath}.verified.json`
  }
}

/**
 * Enforce a byte limit while iterating the body. Throwing from the iteration
 * (rather than from a Transform) ends the source promptly, so a caller such as
 * an HTTP handler can answer 413 while the client is still sending.
 */
async function* limitBytes(body: AsyncIterable<Uint8Array>, maxBytes: number): AsyncIterable<Uint8Array> {
  let receivedBytes = 0
  for await (const chunk of body) {
    receivedBytes += chunk.byteLength
    if (receivedBytes > maxBytes)
      throw new ObjectTooLargeError(maxBytes)
    yield chunk
  }
}

async function readMarker(path: string): Promise<VerificationMarker | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof value !== 'object' || value === null)
      return undefined
    const marker = value as Partial<VerificationMarker>
    if (typeof marker.oid !== 'string'
      || typeof marker.size !== 'number'
      || typeof marker.mtimeMs !== 'number'
      || typeof marker.verifiedAt !== 'string') {
      return undefined
    }
    return marker as VerificationMarker
  }
  catch (error) {
    if (isFileSystemError(error, 'ENOENT') || error instanceof SyntaxError)
      return undefined
    throw error
  }
}

async function statIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path)
  }
  catch (error) {
    if (isFileSystemError(error, 'ENOENT'))
      return undefined
    throw error
  }
}

async function replaceFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination)
  }
  catch (error) {
    if (!isFileSystemError(error, 'EEXIST') && !isFileSystemError(error, 'EPERM'))
      throw error
    await rm(destination, { force: true })
    await rename(source, destination)
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
