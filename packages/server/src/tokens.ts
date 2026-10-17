// @env node

import type { CosObjectStorage, RepositoryId } from '@yunbox/core'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assertRepository, ValidationError } from '@yunbox/core'

/** Access granted to one repository or owner wildcard. `write` implies `read`. */
export type TokenPermission = 'read' | 'write'

/**
 * A stored personal token. Only the SHA-256 hash of the secret is kept.
 *
 * `repos` maps `<owner>/<repo>` or `<owner>/*` to a permission. An exact
 * repository entry takes precedence over the owner wildcard, so
 * `{ "team/*": "write", "team/secret": "read" }` grants read-only access to
 * `team/secret`.
 */
export interface TokenRecord {
  id: string
  name: string
  tokenHash: string
  repos: Record<string, TokenPermission>
  createdAt: string
}

/** Token metadata that is safe to display: everything except the hash. */
export type TokenSummary = Omit<TokenRecord, 'tokenHash'>

/**
 * Persistence for hashed personal tokens.
 *
 * Implementations store a single JSON document. `read` returns an empty list
 * when nothing is stored yet and throws when the document is unreadable, so
 * callers fail closed.
 */
export interface TokenStore {
  read: () => Promise<TokenRecord[]>
  write: (records: TokenRecord[]) => Promise<void>
}

/** Name of the token document inside the private metadata namespace. */
export const TOKEN_DOCUMENT_NAME = 'tokens.json'

const TOKEN_PREFIX = 'ybx_'
const HASH_PREFIX = 'sha256:'
const NAME_PATTERN = /^[\w.@-]{1,64}$/
const ID_PATTERN = /^tok_[a-f\d]{16}$/
const HASH_PATTERN = /^sha256:[a-f\d]{64}$/

interface TokenDocument {
  version: 1
  tokens: TokenRecord[]
}

/** Generate a new random token secret (256 bits, base64url, `ybx_` prefix). */
export function generateTokenSecret(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** Hash a token secret for storage. Tokens carry 256 random bits, so a fast hash is sufficient. */
export function hashTokenSecret(secret: string): string {
  return `${HASH_PREFIX}${createHash('sha256').update(secret, 'utf8').digest('hex')}`
}

/** Validate a repository key such as `team/assets` or the owner wildcard `team/*`. */
export function assertRepositoryPattern(pattern: string): void {
  const [owner, repo, ...rest] = pattern.split('/')
  if (owner === undefined || repo === undefined || rest.length > 0)
    throw new ValidationError(`repository must look like <owner>/<repo> or <owner>/*: ${pattern}`)
  assertRepository({ owner, repo: repo === '*' ? 'placeholder' : repo })
}

/** Resolve the permission a token grants on a repository, if any. */
export function resolvePermission(record: Pick<TokenRecord, 'repos'>, repository: RepositoryId): TokenPermission | undefined {
  return record.repos[`${repository.owner}/${repository.repo}`] ?? record.repos[`${repository.owner}/*`]
}

/** Whether a granted permission satisfies the required one. */
export function permits(granted: TokenPermission | undefined, required: TokenPermission): boolean {
  return granted === 'write' || (granted === 'read' && required === 'read')
}

/** Options for {@link createToken}. */
export interface CreateTokenOptions {
  name: string
  repos: Record<string, TokenPermission>
  now?: Date
}

/** Create and persist a token. The returned secret is the only copy of it. */
export async function createToken(store: TokenStore, options: CreateTokenOptions): Promise<{ secret: string, token: TokenSummary }> {
  const records = await store.read()
  if (records.some(record => record.name === options.name))
    throw new ValidationError(`a token named ${options.name} already exists`)
  const secret = generateTokenSecret()
  const record: TokenRecord = {
    id: `tok_${randomBytes(8).toString('hex')}`,
    name: options.name,
    tokenHash: hashTokenSecret(secret),
    repos: { ...options.repos },
    createdAt: (options.now ?? new Date()).toISOString(),
  }
  assertTokenRecord(record)
  await store.write([...records, record])
  return { secret, token: summarize(record) }
}

/** List stored tokens without their hashes. */
export async function listTokens(store: TokenStore): Promise<TokenSummary[]> {
  return (await store.read()).map(summarize)
}

/** Delete a token by id or name. Returns the revoked token, or `undefined` when none matched. */
export async function revokeToken(store: TokenStore, idOrName: string): Promise<TokenSummary | undefined> {
  const records = await store.read()
  const revoked = records.find(record => record.id === idOrName || record.name === idOrName)
  if (revoked === undefined)
    return undefined
  await store.write(records.filter(record => record !== revoked))
  return summarize(revoked)
}

/** Parse a token document, rejecting anything malformed. */
export function parseTokenDocument(text: string): TokenRecord[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    throw new TypeError('token document is not valid JSON')
  }
  const document = value as Partial<TokenDocument> | null
  if (typeof document !== 'object' || document === null || document.version !== 1 || !Array.isArray(document.tokens))
    throw new TypeError('token document must be { "version": 1, "tokens": [...] }')
  for (const record of document.tokens)
    assertTokenRecord(record)
  const ids = new Set(document.tokens.map(record => record.id))
  if (ids.size !== document.tokens.length)
    throw new TypeError('token document contains duplicate ids')
  return document.tokens
}

/** Serialize token records into the stored document format. */
export function serializeTokenDocument(records: TokenRecord[]): string {
  const document: TokenDocument = { version: 1, tokens: records }
  return `${JSON.stringify(document, null, 2)}\n`
}

/** Token store backed by a local JSON file, written atomically with owner-only permissions. */
export class FileTokenStore implements TokenStore {
  readonly path: string

  constructor(path: string) {
    this.path = path
  }

  async read(): Promise<TokenRecord[]> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return []
      throw error
    }
    return parseTokenDocument(text)
  }

  async write(records: TokenRecord[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, serializeTokenDocument(records), { flag: 'wx', mode: 0o600 })
      await chmod(temporaryPath, 0o600)
      await rename(temporaryPath, this.path)
    }
    catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }
  }
}

/** Token store kept as a private metadata document, `<prefix>/_yunbox/tokens.json`, in COS. */
export class CosTokenStore implements TokenStore {
  readonly #storage: CosObjectStorage

  constructor(storage: CosObjectStorage) {
    this.#storage = storage
  }

  async read(): Promise<TokenRecord[]> {
    const text = await this.#storage.readMetadataDocument(TOKEN_DOCUMENT_NAME)
    return text === undefined ? [] : parseTokenDocument(text)
  }

  async write(records: TokenRecord[]): Promise<void> {
    await this.#storage.writeMetadataDocument(TOKEN_DOCUMENT_NAME, serializeTokenDocument(records))
  }
}

/** Error raised when the token store cannot be read; requests fail closed. */
export class TokenStoreUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('token store is unavailable', options)
    this.name = 'TokenStoreUnavailableError'
  }
}

/** Result of {@link TokenAuthenticator.authenticate}. */
export interface Authentication {
  /** The matching token, or `undefined` when the secret is unknown or revoked. */
  token?: TokenSummary
  /**
   * When the token snapshot used for this decision started loading, in
   * milliseconds. Actions authorized by it must expire relative to this time.
   */
  snapshotAt: number
}

/** Options for {@link TokenAuthenticator}. */
export interface TokenAuthenticatorOptions {
  /** How long a loaded snapshot of the store is reused. `0` reads the store on every request. */
  cacheTtlMs: number
  now?: () => number
}

interface TokenSnapshot {
  loadedAt: number
  records: Array<{ hash: Buffer, token: TokenSummary }>
}

/**
 * Check presented secrets against a {@link TokenStore} snapshot.
 *
 * Snapshots are cached for `cacheTtlMs`, so a revocation reaches every
 * request within that time. Each comparison hashes the presented secret and
 * compares it with every stored hash using a timing-safe comparison.
 */
export class TokenAuthenticator {
  readonly #store: TokenStore
  readonly #cacheTtlMs: number
  readonly #now: () => number
  #snapshot: TokenSnapshot | undefined
  #loading: Promise<TokenSnapshot> | undefined

  constructor(store: TokenStore, options: TokenAuthenticatorOptions) {
    this.#store = store
    this.#cacheTtlMs = options.cacheTtlMs
    this.#now = options.now ?? Date.now
  }

  async authenticate(secret: string | undefined): Promise<Authentication> {
    const snapshot = await this.#currentSnapshot()
    if (secret === undefined)
      return { snapshotAt: snapshot.loadedAt }
    const presented = Buffer.from(hashTokenSecret(secret).slice(HASH_PREFIX.length), 'hex')
    let match: TokenSummary | undefined
    for (const record of snapshot.records) {
      if (timingSafeEqual(record.hash, presented) && match === undefined)
        match = record.token
    }
    return { token: match, snapshotAt: snapshot.loadedAt }
  }

  async #currentSnapshot(): Promise<TokenSnapshot> {
    const current = this.#snapshot
    if (current !== undefined && this.#now() - current.loadedAt < this.#cacheTtlMs)
      return current
    this.#loading ??= this.#load().finally(() => {
      this.#loading = undefined
    })
    return await this.#loading
  }

  async #load(): Promise<TokenSnapshot> {
    const loadedAt = this.#now()
    let records: TokenRecord[]
    try {
      records = await this.#store.read()
    }
    catch (error) {
      this.#snapshot = undefined
      throw new TokenStoreUnavailableError({ cause: error })
    }
    const snapshot: TokenSnapshot = {
      loadedAt,
      records: records.map(record => ({
        hash: Buffer.from(record.tokenHash.slice(HASH_PREFIX.length), 'hex'),
        token: summarize(record),
      })),
    }
    this.#snapshot = snapshot
    return snapshot
  }
}

function assertTokenRecord(value: unknown): asserts value is TokenRecord {
  const record = value as Partial<TokenRecord> | null
  if (typeof record !== 'object' || record === null)
    throw new TypeError('token record must be an object')
  if (typeof record.id !== 'string' || !ID_PATTERN.test(record.id))
    throw new TypeError('token id is invalid')
  if (typeof record.name !== 'string' || !NAME_PATTERN.test(record.name))
    throw new ValidationError('token name may only contain letters, digits, ".", "_", "@" and "-" (at most 64)')
  if (typeof record.tokenHash !== 'string' || !HASH_PATTERN.test(record.tokenHash))
    throw new TypeError('token hash is invalid')
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt)))
    throw new TypeError('token createdAt is invalid')
  if (typeof record.repos !== 'object' || record.repos === null || Array.isArray(record.repos))
    throw new TypeError('token repos must be an object')
  const entries = Object.entries(record.repos)
  if (entries.length === 0)
    throw new ValidationError('a token must grant access to at least one repository')
  for (const [pattern, permission] of entries) {
    assertRepositoryPattern(pattern)
    if (permission !== 'read' && permission !== 'write')
      throw new ValidationError(`permission for ${pattern} must be read or write`)
  }
}

function summarize(record: TokenRecord): TokenSummary {
  return {
    id: record.id,
    name: record.name,
    repos: { ...record.repos },
    createdAt: record.createdAt,
  }
}
