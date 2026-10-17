// @env node

import type { RepositoryId } from '@yunbox/core'
import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { assertRepository, ValidationError } from '@yunbox/core'

/** Access granted to one repository or owner wildcard. `write` implies `read`. */
export type TokenPermission = 'read' | 'write'

/**
 * A stored personal token. Only the SHA-256 hash of the secret is kept.
 *
 * A token acts for `user`; what it may access comes from that user's
 * {@link RepositoryGrant}, so every token of a user has the same access.
 */
export interface TokenRecord {
  id: string
  name: string
  user: string
  tokenHash: string
  createdAt: string
  /** The token is rejected from this instant on. */
  expiresAt: string
  /** When the token last authenticated a request, recorded at a throttled rate. */
  lastUsedAt?: string
}

/**
 * Repositories a user may access.
 *
 * `repos` maps `<owner>/<repo>` or `<owner>/*` to a permission. An exact
 * repository entry takes precedence over the owner wildcard, so
 * `{ "team/*": "write", "team/secret": "read" }` grants read-only access to
 * `team/secret`.
 */
export interface RepositoryGrant {
  user: string
  repos: Record<string, TokenPermission>
  updatedAt: string
}

/** A Git LFS file lock. At most one lock exists per repository and path. */
export interface LockRecord {
  /** Opaque id given to clients; a new lock on the same path gets a new id. */
  id: string
  /** `<owner>/<repo>`. */
  repository: string
  path: string
  /** User holding the lock. */
  owner: string
  lockedAt: string
}

/** Values allowed in {@link AuditEvent.details}. */
export type AuditDetail = string | number | boolean

/** One audit log entry. Entries are only ever appended. */
export interface AuditEvent {
  /** Sortable id: later events have larger ids. */
  id: string
  at: string
  /** What happened, such as `token.create` or `lock.create`. */
  action: string
  /** User or token that did it, when known. */
  actor?: string
  /** `<owner>/<repo>` the event concerns, when any. */
  repository?: string
  details?: Record<string, AuditDetail>
}

/** Fields the caller supplies when appending an {@link AuditEvent}. */
export type AuditEventInput = Omit<AuditEvent, 'id' | 'at'> & { at?: string }

/** Personal tokens. Every token is its own document, so concurrent writes never overwrite each other. */
export interface TokenRepository {
  /** Store a new token. Returns `false` when a token with the same id already exists. */
  create: (record: TokenRecord) => Promise<boolean>
  get: (id: string) => Promise<TokenRecord | undefined>
  list: () => Promise<TokenRecord[]>
  /** Delete a token. Returns `false` when it did not exist. */
  delete: (id: string) => Promise<boolean>
  /** Record when a token was last used. A missing token is ignored; an older time never replaces a newer one. */
  touch: (id: string, lastUsedAt: string) => Promise<void>
}

/** Repository grants, one document per user. */
export interface GrantRepository {
  get: (user: string) => Promise<RepositoryGrant | undefined>
  list: () => Promise<RepositoryGrant[]>
  /**
   * Atomically change a user's grants. `change` receives the current entries
   * (empty when the user has none) and returns the new ones; it runs again if
   * another writer changed the grants in between, so it must not have side
   * effects. Returning no entries deletes the grant.
   *
   * @returns The stored grant, or `undefined` when it was deleted.
   */
  update: (user: string, change: (repos: Record<string, TokenPermission>) => Record<string, TokenPermission>) => Promise<RepositoryGrant | undefined>
}

/** Result of {@link LockRepository.create}. */
export type CreateLockResult
  = | { created: true, lock: LockRecord }
    | { created: false, existing: LockRecord }

/** File locks. Creating a lock is atomic: of two concurrent requests for the same path, exactly one wins. */
export interface LockRepository {
  /** Create a lock unless the path is already locked, in which case the existing lock is returned. */
  create: (input: { repository: RepositoryId, path: string, owner: string, lockedAt?: string }) => Promise<CreateLockResult>
  get: (repository: RepositoryId, id: string) => Promise<LockRecord | undefined>
  /** Locks of a repository, optionally only the one on `path`, ordered by path. */
  list: (repository: RepositoryId, options?: { path?: string }) => Promise<LockRecord[]>
  /**
   * Delete the lock with this id. A lock that was released and re-created
   * under a new id is left alone.
   *
   * @returns The deleted lock, or `undefined` when no lock had this id.
   */
  delete: (repository: RepositoryId, id: string) => Promise<LockRecord | undefined>
}

/** Append-only audit log. */
export interface AuditLog {
  append: (event: AuditEventInput) => Promise<AuditEvent>
  /** Newest events first, optionally filtered. `limit` defaults to 100. */
  list: (options?: { repository?: string, actor?: string, limit?: number }) => Promise<AuditEvent[]>
}

/**
 * Storage for server metadata: tokens, repository grants, file locks and the
 * audit log. Objects and their verification markers stay in object storage.
 *
 * Reads that fail, or find malformed data, throw; callers fail closed.
 */
export interface MetadataStore {
  /** Where the metadata lives, for humans. Never contains secrets. */
  readonly description: string
  readonly tokens: TokenRepository
  readonly grants: GrantRepository
  readonly locks: LockRepository
  readonly audit: AuditLog
}

/** Metadata collections. Backends may prefix the names. */
export const METADATA_COLLECTIONS = ['tokens', 'grants', 'locks', 'audit'] as const

/** One of {@link METADATA_COLLECTIONS}. */
export type MetadataCollection = typeof METADATA_COLLECTIONS[number]

/** A stored document: its id, an opaque etag that changes on every write, and its fields. */
export interface StoredDocument {
  id: string
  etag: string
  data: Record<string, unknown>
}

/** Options for {@link DocumentBackend.list}. */
export interface ListDocumentsOptions {
  /** Only documents whose top-level fields equal these strings. */
  where?: Record<string, string>
  /** Return at most this many documents. */
  limit?: number
  /** Sort by id descending instead of ascending. */
  descending?: boolean
}

/**
 * Minimal document database a {@link DocumentMetadataStore} is built on.
 *
 * Document ids match {@link DOCUMENT_ID_PATTERN}. Field names must not start
 * with `_` or `$` and must not be `etag`, which backends use themselves.
 */
export interface DocumentBackend {
  readonly description: string
  get: (collection: MetadataCollection, id: string) => Promise<StoredDocument | undefined>
  /** Documents ordered by id. */
  list: (collection: MetadataCollection, options?: ListDocumentsOptions) => Promise<StoredDocument[]>
  /** Create a document unless the id exists. Atomic. Returns the new etag, or `undefined` when the id exists. */
  create: (collection: MetadataCollection, id: string, data: Record<string, unknown>) => Promise<string | undefined>
  /**
   * Set fields of a document if its etag is still `expectedEtag`. Atomic.
   * Returns the new etag, or `undefined` when the document is missing or changed.
   */
  update: (collection: MetadataCollection, id: string, expectedEtag: string, fields: Record<string, unknown>) => Promise<string | undefined>
  /** Delete a document, only if its etag is `expectedEtag` when given. Atomic. Returns whether it was deleted. */
  delete: (collection: MetadataCollection, id: string, expectedEtag?: string) => Promise<boolean>
}

/** Document ids accepted by every backend. */
export const DOCUMENT_ID_PATTERN = /^[\w.@-]{1,128}$/

/** User and token names: letters, digits, `.`, `_`, `@` and `-`, at most 64. */
export const NAME_PATTERN = /^[\w.@-]{1,64}$/

/** Error raised when a write keeps losing to concurrent writers. */
export class MetadataConflictError extends Error {
  constructor(what: string) {
    super(`${what} kept changing concurrently; try again`)
    this.name = 'MetadataConflictError'
  }
}

/** Create a new random etag. */
export function newEtag(): string {
  return randomBytes(12).toString('hex')
}

/** Throw unless `id` is a valid document id. */
export function assertDocumentId(id: string): void {
  if (!DOCUMENT_ID_PATTERN.test(id))
    throw new TypeError('document id may only contain letters, digits, ".", "_", "@" and "-" (at most 128)')
}

/** Throw unless every field name is allowed in a document. */
export function assertFieldNames(fields: Record<string, unknown>): void {
  for (const name of Object.keys(fields)) {
    if (name === 'etag' || name.startsWith('_') || name.startsWith('$') || name.includes('.'))
      throw new TypeError(`field name is reserved: ${name}`)
  }
}

const MAX_CONFLICT_RETRIES = 16

/**
 * {@link MetadataStore} on top of a {@link DocumentBackend}.
 *
 * Tokens are keyed by token id and grants by user, locks by a hash of
 * repository and path (so the backend's atomic create enforces one lock per
 * path), and audit events by a time-ordered random id.
 */
export class DocumentMetadataStore implements MetadataStore {
  readonly backend: DocumentBackend
  readonly tokens: TokenRepository
  readonly grants: GrantRepository
  readonly locks: LockRepository
  readonly audit: AuditLog

  constructor(backend: DocumentBackend) {
    this.backend = backend
    this.tokens = createTokenRepository(backend)
    this.grants = createGrantRepository(backend)
    this.locks = createLockRepository(backend)
    this.audit = createAuditLog(backend)
  }

  get description(): string {
    return this.backend.description
  }
}

function createTokenRepository(backend: DocumentBackend): TokenRepository {
  return {
    async create(record) {
      assertTokenRecord(record)
      return await backend.create('tokens', record.id, { ...record }) !== undefined
    },
    async get(id) {
      if (!DOCUMENT_ID_PATTERN.test(id))
        return undefined
      const document = await backend.get('tokens', id)
      return document === undefined ? undefined : toTokenRecord(document)
    },
    async list() {
      return (await backend.list('tokens')).map(toTokenRecord)
    },
    async delete(id) {
      return DOCUMENT_ID_PATTERN.test(id) && await backend.delete('tokens', id)
    },
    async touch(id, lastUsedAt) {
      for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
        const document = await backend.get('tokens', id)
        if (document === undefined)
          return
        const current = toTokenRecord(document).lastUsedAt
        if (current !== undefined && Date.parse(current) >= Date.parse(lastUsedAt))
          return
        if (await backend.update('tokens', id, document.etag, { lastUsedAt }) !== undefined)
          return
      }
      throw new MetadataConflictError(`token ${id}`)
    },
  }
}

function createGrantRepository(backend: DocumentBackend): GrantRepository {
  return {
    async get(user) {
      if (!NAME_PATTERN.test(user))
        return undefined
      const document = await backend.get('grants', user)
      return document === undefined ? undefined : toGrant(document)
    },
    async list() {
      return (await backend.list('grants')).map(toGrant)
    },
    async update(user, change) {
      assertName(user, 'user')
      for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
        if (attempt > 0)
          await backoff(attempt)
        const document = await backend.get('grants', user)
        const current = document === undefined ? undefined : toGrant(document)
        const repos = change({ ...current?.repos })
        if (Object.keys(repos).length === 0) {
          if (document === undefined || await backend.delete('grants', user, document.etag))
            return undefined
          continue
        }
        const grant: RepositoryGrant = { user, repos: { ...repos }, updatedAt: new Date().toISOString() }
        assertGrant(grant)
        const fields = { repos: toGrantEntries(grant.repos), updatedAt: grant.updatedAt }
        const etag = document === undefined
          ? await backend.create('grants', user, { user, ...fields })
          : await backend.update('grants', user, document.etag, fields)
        if (etag !== undefined)
          return grant
      }
      throw new MetadataConflictError(`grants of ${user}`)
    },
  }
}

function createLockRepository(backend: DocumentBackend): LockRepository {
  const find = async (repository: RepositoryId, id: string): Promise<StoredDocument | undefined> => {
    const [document] = await backend.list('locks', { where: { repository: repositoryKey(repository), id } })
    return document
  }
  return {
    async create(input) {
      assertRepository(input.repository)
      const lock: LockRecord = {
        id: `lock_${randomBytes(12).toString('hex')}`,
        repository: repositoryKey(input.repository),
        path: input.path,
        owner: input.owner,
        lockedAt: input.lockedAt ?? new Date().toISOString(),
      }
      assertLock(lock)
      const key = lockDocumentId(input.repository, input.path)
      for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
        if (await backend.create('locks', key, { ...lock }) !== undefined)
          return { created: true, lock }
        const existing = await backend.get('locks', key)
        if (existing !== undefined)
          return { created: false, existing: toLock(existing) }
      }
      throw new MetadataConflictError(`lock on ${input.path}`)
    },
    async get(repository, id) {
      const document = await find(repository, id)
      return document === undefined ? undefined : toLock(document)
    },
    async list(repository, options = {}) {
      const where: Record<string, string> = { repository: repositoryKey(repository) }
      if (options.path !== undefined)
        where.path = options.path
      const locks = (await backend.list('locks', { where })).map(toLock)
      return locks.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    },
    async delete(repository, id) {
      const document = await find(repository, id)
      if (document === undefined)
        return undefined
      return await backend.delete('locks', document.id, document.etag) ? toLock(document) : undefined
    },
  }
}

function createAuditLog(backend: DocumentBackend): AuditLog {
  return {
    async append(input) {
      const at = input.at ?? new Date().toISOString()
      const event: AuditEvent = { ...input, at, id: auditEventId(Date.parse(at)) }
      assertAuditEvent(event)
      if (await backend.create('audit', event.id, { ...event }) === undefined)
        throw new MetadataConflictError(`audit event ${event.id}`)
      return event
    },
    async list(options = {}) {
      const where: Record<string, string> = {}
      if (options.repository !== undefined)
        where.repository = options.repository
      if (options.actor !== undefined)
        where.actor = options.actor
      const documents = await backend.list('audit', { where, limit: options.limit ?? 100, descending: true })
      return documents.map(toAuditEvent)
    },
  }
}

/** Randomized wait before retrying a write that lost to a concurrent writer. */
async function backoff(attempt: number): Promise<void> {
  await sleep(Math.random() * Math.min(200, 5 * 2 ** attempt))
}

/** `<owner>/<repo>` for a repository. */
export function repositoryKey(repository: RepositoryId): string {
  return `${repository.owner}/${repository.repo}`
}

/** Document id of the lock on a path; the same path always maps to the same id. */
export function lockDocumentId(repository: RepositoryId, path: string): string {
  return `lk_${createHash('sha256').update(`${repositoryKey(repository)}\n${path}`, 'utf8').digest('hex')}`
}

function auditEventId(time: number): string {
  // Fixed-width decimal milliseconds keep lexicographic order equal to time order.
  return `evt_${String(Number.isFinite(time) ? time : Date.now()).padStart(15, '0')}_${randomBytes(6).toString('hex')}`
}

/** Throw unless `value` is a valid user or token name. */
export function assertName(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value))
    throw new ValidationError(`${what} may only contain letters, digits, ".", "_", "@" and "-" (at most 64)`)
}

function assertTimestamp(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)))
    throw new TypeError(`${what} is not a valid timestamp`)
}

const TOKEN_ID_PATTERN = /^tok_[a-f\d]{16}$/
const HASH_PATTERN = /^sha256:[a-f\d]{64}$/

/** Throw unless `value` is a well-formed {@link TokenRecord}. */
export function assertTokenRecord(value: unknown): asserts value is TokenRecord {
  const record = value as Partial<TokenRecord> | null
  if (typeof record !== 'object' || record === null)
    throw new TypeError('token record must be an object')
  if (typeof record.id !== 'string' || !TOKEN_ID_PATTERN.test(record.id))
    throw new TypeError('token id is invalid')
  assertName(record.name, 'token name')
  assertName(record.user, 'token user')
  if (typeof record.tokenHash !== 'string' || !HASH_PATTERN.test(record.tokenHash))
    throw new TypeError('token hash is invalid')
  assertTimestamp(record.createdAt, 'token createdAt')
  assertTimestamp(record.expiresAt, 'token expiresAt')
  if (record.lastUsedAt !== undefined)
    assertTimestamp(record.lastUsedAt, 'token lastUsedAt')
}

/** Throw unless `value` is a well-formed {@link RepositoryGrant}. */
export function assertGrant(value: unknown): asserts value is RepositoryGrant {
  const grant = value as Partial<RepositoryGrant> | null
  if (typeof grant !== 'object' || grant === null)
    throw new TypeError('grant must be an object')
  assertName(grant.user, 'user')
  assertTimestamp(grant.updatedAt, 'grant updatedAt')
  assertRepos(grant.repos)
}

/** Throw unless `value` maps valid repository patterns to `read` or `write`. */
export function assertRepos(value: unknown): asserts value is Record<string, TokenPermission> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('repos must be an object')
  for (const [pattern, permission] of Object.entries(value)) {
    assertRepositoryPattern(pattern)
    if (permission !== 'read' && permission !== 'write')
      throw new ValidationError(`permission for ${pattern} must be read or write`)
  }
}

/** Validate a repository key such as `team/assets` or the owner wildcard `team/*`. */
export function assertRepositoryPattern(pattern: string): void {
  const [owner, repo, ...rest] = pattern.split('/')
  if (owner === undefined || repo === undefined || rest.length > 0)
    throw new ValidationError(`repository must look like <owner>/<repo> or <owner>/*: ${pattern}`)
  assertRepository({ owner, repo: repo === '*' ? 'placeholder' : repo })
}

function assertLock(value: unknown): asserts value is LockRecord {
  const lock = value as Partial<LockRecord> | null
  if (typeof lock !== 'object' || lock === null)
    throw new TypeError('lock must be an object')
  if (typeof lock.id !== 'string' || !/^lock_[a-f\d]{24}$/.test(lock.id))
    throw new TypeError('lock id is invalid')
  if (typeof lock.repository !== 'string')
    throw new TypeError('lock repository is invalid')
  const [owner = '', repo = ''] = lock.repository.split('/')
  assertRepository({ owner, repo })
  if (typeof lock.path !== 'string' || lock.path === '' || lock.path.length > 4096 || lock.path.includes('\0'))
    throw new TypeError('lock path is invalid')
  assertName(lock.owner, 'lock owner')
  assertTimestamp(lock.lockedAt, 'lock lockedAt')
}

function assertAuditEvent(value: unknown): asserts value is AuditEvent {
  const event = value as Partial<AuditEvent> | null
  if (typeof event !== 'object' || event === null)
    throw new TypeError('audit event must be an object')
  if (typeof event.id !== 'string' || !/^evt_\d{15}_[a-f\d]{12}$/.test(event.id))
    throw new TypeError('audit event id is invalid')
  assertTimestamp(event.at, 'audit event time')
  if (typeof event.action !== 'string' || !/^[a-z][\w.-]{0,63}$/.test(event.action))
    throw new TypeError('audit action is invalid')
  for (const field of ['actor', 'repository'] as const) {
    const fieldValue = event[field]
    if (fieldValue !== undefined && (typeof fieldValue !== 'string' || fieldValue.length > 256))
      throw new TypeError(`audit ${field} is invalid`)
  }
  if (event.details !== undefined) {
    if (typeof event.details !== 'object' || event.details === null || Array.isArray(event.details))
      throw new TypeError('audit details must be an object')
    assertFieldNames(event.details)
    for (const detail of Object.values(event.details)) {
      if (!['string', 'number', 'boolean'].includes(typeof detail))
        throw new TypeError('audit details may only contain strings, numbers and booleans')
    }
  }
}

function pick<T>(document: StoredDocument, keys: readonly (keyof T & string)[]): Partial<T> {
  const picked: Record<string, unknown> = {}
  for (const key of keys) {
    if (document.data[key] !== undefined && document.data[key] !== null)
      picked[key] = document.data[key]
  }
  return picked as Partial<T>
}

function toTokenRecord(document: StoredDocument): TokenRecord {
  const record = pick<TokenRecord>(document, ['id', 'name', 'user', 'tokenHash', 'createdAt', 'expiresAt', 'lastUsedAt'])
  assertTokenRecord(record)
  if (record.id !== document.id)
    throw new TypeError('token id does not match its document')
  return record
}

/**
 * Grants are stored as `[{ pattern, permission }]` rather than an object keyed
 * by pattern, because repository names may contain `.`, which document
 * databases treat as a path separator in field names.
 */
function toGrantEntries(repos: Record<string, TokenPermission>): Array<{ pattern: string, permission: TokenPermission }> {
  return Object.entries(repos).map(([pattern, permission]) => ({ pattern, permission }))
}

function toGrant(document: StoredDocument): RepositoryGrant {
  const { user, updatedAt, repos: entries } = document.data
  if (!Array.isArray(entries))
    throw new TypeError('grant repos must be a list')
  const repos: Record<string, unknown> = {}
  for (const entry of entries as Array<{ pattern?: unknown, permission?: unknown } | null>) {
    if (typeof entry !== 'object' || entry === null || typeof entry.pattern !== 'string' || Object.hasOwn(repos, entry.pattern))
      throw new TypeError('grant repos entry is malformed')
    repos[entry.pattern] = entry.permission
  }
  const grant = { user, repos, updatedAt }
  assertGrant(grant)
  if (grant.user !== document.id)
    throw new TypeError('grant user does not match its document')
  return grant
}

function toLock(document: StoredDocument): LockRecord {
  const lock = pick<LockRecord>(document, ['id', 'repository', 'path', 'owner', 'lockedAt'])
  assertLock(lock)
  return lock
}

function toAuditEvent(document: StoredDocument): AuditEvent {
  const event = pick<AuditEvent>(document, ['id', 'at', 'action', 'actor', 'repository', 'details'])
  assertAuditEvent(event)
  return event
}
