// @env node

import type { DocumentBackend, ListDocumentsOptions, MetadataCollection, StoredDocument } from './metadata.ts'
import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { assertDocumentId, assertFieldNames, DocumentMetadataStore, newEtag } from './metadata.ts'

/** A lock file older than this is assumed to be left behind by a crashed process. */
const STALE_LOCK_MS = 10_000
/** Give up acquiring a document lock after this long. */
const LOCK_TIMEOUT_MS = 15_000

/**
 * {@link DocumentBackend} storing one JSON file per document under
 * `<directory>/<collection>/`, for tests and local development.
 *
 * Safe for concurrent use by several processes on one machine: creation uses
 * `link`, which fails if the file exists, and conditional updates and deletes
 * hold a per-document lock file while they check the etag and replace the
 * file with an atomic rename. Directories are `0700` and files `0600`.
 */
export class LocalDocumentBackend implements DocumentBackend {
  readonly directory: string

  constructor(directory: string) {
    this.directory = resolve(directory)
  }

  get description(): string {
    return `local files in ${this.directory}`
  }

  async get(collection: MetadataCollection, id: string): Promise<StoredDocument | undefined> {
    assertDocumentId(id)
    return await this.#read(this.#path(collection, id))
  }

  async list(collection: MetadataCollection, options: ListDocumentsOptions = {}): Promise<StoredDocument[]> {
    let names: string[]
    try {
      names = await readdir(join(this.directory, collection))
    }
    catch (error) {
      if (isNotFound(error))
        return []
      throw error
    }
    const documents: StoredDocument[] = []
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const document = await this.#read(join(this.directory, collection, name))
      if (document !== undefined && matches(document, options.where))
        documents.push(document)
    }
    documents.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    if (options.descending)
      documents.reverse()
    return options.limit === undefined ? documents : documents.slice(0, options.limit)
  }

  async create(collection: MetadataCollection, id: string, data: Record<string, unknown>): Promise<string | undefined> {
    assertDocumentId(id)
    assertFieldNames(data)
    const path = this.#path(collection, id)
    const etag = newEtag()
    const temporary = await this.#writeTemporary(collection, { id, etag, data })
    try {
      await link(temporary, path)
      return etag
    }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
        return undefined
      throw error
    }
    finally {
      await rm(temporary, { force: true })
    }
  }

  async update(collection: MetadataCollection, id: string, expectedEtag: string, fields: Record<string, unknown>): Promise<string | undefined> {
    assertDocumentId(id)
    assertFieldNames(fields)
    const path = this.#path(collection, id)
    return await this.#withLock(path, async () => {
      const current = await this.#read(path)
      if (current === undefined || current.etag !== expectedEtag)
        return undefined
      const etag = newEtag()
      const temporary = await this.#writeTemporary(collection, { id, etag, data: { ...current.data, ...fields } })
      try {
        await rename(temporary, path)
      }
      catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
      return etag
    })
  }

  async delete(collection: MetadataCollection, id: string, expectedEtag?: string): Promise<boolean> {
    assertDocumentId(id)
    const path = this.#path(collection, id)
    return await this.#withLock(path, async () => {
      const current = await this.#read(path)
      if (current === undefined || (expectedEtag !== undefined && current.etag !== expectedEtag))
        return false
      await rm(path)
      return true
    })
  }

  #path(collection: MetadataCollection, id: string): string {
    return join(this.directory, collection, `${fileName(id)}.json`)
  }

  async #read(path: string): Promise<StoredDocument | undefined> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    }
    catch (error) {
      if (isNotFound(error))
        return undefined
      throw error
    }
    const value = JSON.parse(text) as Partial<StoredDocument> | null
    if (typeof value !== 'object' || value === null || typeof value.id !== 'string' || typeof value.etag !== 'string'
      || typeof value.data !== 'object' || value.data === null || Array.isArray(value.data)) {
      throw new TypeError('metadata document is malformed')
    }
    return { id: value.id, etag: value.etag, data: value.data }
  }

  async #writeTemporary(collection: MetadataCollection, document: StoredDocument): Promise<string> {
    const directory = join(this.directory, collection)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = join(directory, `.${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`)
      await handle.sync()
    }
    finally {
      await handle.close()
    }
    return temporary
  }

  async #withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
    const lockPath = `${path}.lock`
    const deadline = Date.now() + LOCK_TIMEOUT_MS
    for (let attempt = 0; ; attempt++) {
      try {
        const handle = await open(lockPath, 'wx', 0o600)
        await handle.close()
        break
      }
      catch (error) {
        if (isNotFound(error)) {
          await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
          continue
        }
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
          throw error
      }
      const age = await stat(lockPath).then(info => Date.now() - info.mtimeMs, () => 0)
      if (age > STALE_LOCK_MS) {
        await rm(lockPath, { force: true })
        continue
      }
      if (Date.now() > deadline)
        throw new Error('timed out waiting for a metadata document lock')
      await sleep(Math.min(50, 2 + attempt * 2) * (0.5 + Math.random()))
    }
    try {
      return await action()
    }
    finally {
      await rm(lockPath, { force: true })
    }
  }
}

/** {@link MetadataStore} kept in local files; see {@link LocalDocumentBackend}. */
export class LocalMetadataStore extends DocumentMetadataStore {
  constructor(directory: string) {
    super(new LocalDocumentBackend(directory))
  }
}

/**
 * File name for a document id. Characters other than lowercase letters,
 * digits, `_`, `@` and `-` (and a leading dot) are percent-encoded, so ids
 * differing only in case stay distinct on case-insensitive file systems.
 */
function fileName(id: string): string {
  return id.replace(/[^a-z\d_@.-]|^\./g, character => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

function matches(document: StoredDocument, where: Record<string, string> | undefined): boolean {
  return Object.entries(where ?? {}).every(([field, value]) => document.data[field] === value)
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
