import type { DocumentBackend, ListDocumentsOptions, MetadataCollection, StoredDocument } from '../src/metadata.ts'
import { DocumentMetadataStore, newEtag } from '../src/metadata.ts'

/** In-memory {@link DocumentBackend} for tests, with call counting and failure injection. */
export class MemoryDocumentBackend implements DocumentBackend {
  readonly description = 'memory'
  readonly collections = new Map<MetadataCollection, Map<string, StoredDocument>>()
  /** Number of token listings, which is one per authenticator snapshot. */
  reads = 0
  /** Number of successful updates per collection. */
  readonly updates = new Map<MetadataCollection, number>()
  failReads = false

  async get(collection: MetadataCollection, id: string): Promise<StoredDocument | undefined> {
    this.#checkRead()
    return structuredClone(this.#collection(collection).get(id))
  }

  async list(collection: MetadataCollection, options: ListDocumentsOptions = {}): Promise<StoredDocument[]> {
    if (collection === 'tokens')
      this.reads += 1
    this.#checkRead()
    const documents = [...this.#collection(collection).values()]
      .filter(document => Object.entries(options.where ?? {}).every(([field, value]) => document.data[field] === value))
      .sort((a, b) => a.id < b.id ? -1 : 1)
    if (options.descending)
      documents.reverse()
    return structuredClone(documents.slice(0, options.limit))
  }

  async create(collection: MetadataCollection, id: string, data: Record<string, unknown>): Promise<string | undefined> {
    const documents = this.#collection(collection)
    if (documents.has(id))
      return undefined
    const etag = newEtag()
    documents.set(id, { id, etag, data: structuredClone(data) })
    return etag
  }

  async update(collection: MetadataCollection, id: string, expectedEtag: string, fields: Record<string, unknown>): Promise<string | undefined> {
    const current = this.#collection(collection).get(id)
    if (current?.etag !== expectedEtag)
      return undefined
    const etag = newEtag()
    this.#collection(collection).set(id, { id, etag, data: { ...current.data, ...structuredClone(fields) } })
    this.updates.set(collection, (this.updates.get(collection) ?? 0) + 1)
    return etag
  }

  async delete(collection: MetadataCollection, id: string, expectedEtag?: string): Promise<boolean> {
    const current = this.#collection(collection).get(id)
    if (current === undefined || (expectedEtag !== undefined && current.etag !== expectedEtag))
      return false
    return this.#collection(collection).delete(id)
  }

  #collection(collection: MetadataCollection): Map<string, StoredDocument> {
    let documents = this.collections.get(collection)
    if (documents === undefined) {
      documents = new Map()
      this.collections.set(collection, documents)
    }
    return documents
  }

  #checkRead(): void {
    if (this.failReads)
      throw new Error('simulated metadata store outage')
  }
}

/** In-memory metadata store; `memory` exposes the backend's counters and switches. */
export class MemoryMetadataStore extends DocumentMetadataStore {
  readonly memory: MemoryDocumentBackend

  constructor() {
    const backend = new MemoryDocumentBackend()
    super(backend)
    this.memory = backend
  }

  get reads(): number {
    return this.memory.reads
  }

  get failReads(): boolean {
    return this.memory.failReads
  }

  set failReads(value: boolean) {
    this.memory.failReads = value
  }
}
