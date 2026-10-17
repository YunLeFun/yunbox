// @env node

import type { RepositoryId } from '@yunbox/core'
import type { MetadataStore, RepositoryGrant, TokenPermission, TokenRecord } from './metadata.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { ValidationError } from '@yunbox/core'
import { assertName, assertRepos } from './metadata.ts'

export type { TokenPermission } from './metadata.ts'

/** Token metadata that is safe to display: everything except the hash. */
export type TokenSummary = Omit<TokenRecord, 'tokenHash'>

/** Default token lifetime: 90 days. */
export const DEFAULT_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000

/** Default minimum time between two writes of a token's `lastUsedAt`: 1 hour. */
export const DEFAULT_LAST_USED_WRITE_INTERVAL_MS = 60 * 60 * 1000

const TOKEN_PREFIX = 'ybx_'
const HASH_PREFIX = 'sha256:'

/** Generate a new random token secret (256 bits, base64url, `ybx_` prefix). */
export function generateTokenSecret(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** Hash a token secret for storage. Tokens carry 256 random bits, so a fast hash is sufficient. */
export function hashTokenSecret(secret: string): string {
  return `${HASH_PREFIX}${createHash('sha256').update(secret, 'utf8').digest('hex')}`
}

/** Resolve the permission a set of grants gives on a repository, if any. */
export function resolvePermission(grant: Pick<RepositoryGrant, 'repos'> | undefined, repository: RepositoryId): TokenPermission | undefined {
  if (grant === undefined)
    return undefined
  const exact = `${repository.owner}/${repository.repo}`
  const wildcard = `${repository.owner}/*`
  return Object.hasOwn(grant.repos, exact)
    ? grant.repos[exact]
    : Object.hasOwn(grant.repos, wildcard) ? grant.repos[wildcard] : undefined
}

/** Whether a granted permission satisfies the required one. */
export function permits(granted: TokenPermission | undefined, required: TokenPermission): boolean {
  return granted === 'write' || (granted === 'read' && required === 'read')
}

/**
 * Parse a duration such as `90d`, `12h` or `30m` into milliseconds.
 *
 * @throws {ValidationError} for anything else, or more than 10 years.
 */
export function parseDuration(text: string): number {
  const match = /^(\d{1,6})([dhm])$/.exec(text)
  const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }
  const value = match === null ? 0 : Number(match[1]) * unit[match[2] as keyof typeof unit]
  if (value <= 0 || value > 3650 * unit.d)
    throw new ValidationError('duration must look like 90d, 12h or 30m (at most 3650d)')
  return value
}

/** Options for {@link createToken}. */
export interface CreateTokenOptions {
  name: string
  /** User the token acts for (default: `name`). */
  user?: string
  /**
   * Repositories to add to the user's grants first (see {@link mergeGrants}).
   * Without them the user must already have grants.
   */
  repos?: Record<string, TokenPermission>
  /** Lifetime in milliseconds (default {@link DEFAULT_TOKEN_LIFETIME_MS}). */
  lifetimeMs?: number
  now?: Date
}

/**
 * Create and store a token. The returned secret is the only copy of it.
 *
 * Token names should be unique; the check is advisory (two administrators
 * racing could create two tokens with one name), and {@link revokeToken}
 * refuses to guess between them.
 */
export async function createToken(store: MetadataStore, options: CreateTokenOptions): Promise<{ secret: string, token: TokenSummary }> {
  const user = options.user ?? options.name
  assertName(options.name, 'token name')
  assertName(user, 'user')
  const lifetimeMs = options.lifetimeMs ?? DEFAULT_TOKEN_LIFETIME_MS
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0)
    throw new ValidationError('token lifetime must be a positive number of milliseconds')
  if (options.repos !== undefined)
    assertRepos(options.repos)
  if ((await store.tokens.list()).some(record => record.name === options.name))
    throw new ValidationError(`a token named ${options.name} already exists`)

  if (options.repos !== undefined && Object.keys(options.repos).length > 0) {
    const added = options.repos
    await store.grants.update(user, repos => mergeGrants(repos, added))
  }
  const grant = await store.grants.get(user)
  if (grant === undefined || Object.keys(grant.repos).length === 0)
    throw new ValidationError(`user ${user} has no repository grants; grant access first`)

  const now = options.now ?? new Date()
  const secret = generateTokenSecret()
  const record: TokenRecord = {
    id: `tok_${randomBytes(8).toString('hex')}`,
    name: options.name,
    user,
    tokenHash: hashTokenSecret(secret),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + lifetimeMs).toISOString(),
  }
  if (!await store.tokens.create(record))
    throw new Error('token id collision; try again')
  return { secret, token: summarize(record) }
}

/** List stored tokens without their hashes, oldest first. */
export async function listTokens(store: MetadataStore): Promise<TokenSummary[]> {
  const records = await store.tokens.list()
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(summarize)
}

/**
 * Delete a token by id, or by name when no id matches.
 *
 * @returns The revoked token, or `undefined` when none matched.
 * @throws {ValidationError} when several tokens share the name.
 */
export async function revokeToken(store: MetadataStore, idOrName: string): Promise<TokenSummary | undefined> {
  let target = await store.tokens.get(idOrName)
  if (target === undefined) {
    const named = (await store.tokens.list()).filter(record => record.name === idOrName)
    if (named.length > 1)
      throw new ValidationError(`several tokens are named ${idOrName}; revoke by id: ${named.map(record => record.id).join(', ')}`)
    target = named[0]
  }
  if (target === undefined || !await store.tokens.delete(target.id))
    return undefined
  return summarize(target)
}

/**
 * Replace the repositories a user may access. An empty map removes the
 * user's grants, which disables all of the user's tokens.
 */
export async function setGrant(store: MetadataStore, user: string, repos: Record<string, TokenPermission>): Promise<RepositoryGrant | undefined> {
  assertName(user, 'user')
  assertRepos(repos)
  return await store.grants.update(user, () => ({ ...repos }))
}

/**
 * Add grants without reducing existing ones: a pattern keeps `write` if
 * either side has it.
 */
export function mergeGrants(current: Record<string, TokenPermission>, added: Record<string, TokenPermission>): Record<string, TokenPermission> {
  const merged = { ...current }
  for (const [pattern, permission] of Object.entries(added)) {
    if (merged[pattern] !== 'write')
      merged[pattern] = permission
  }
  return merged
}

/** Error raised when the metadata store cannot be read; requests fail closed. */
export class TokenStoreUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('token store is unavailable', options)
    this.name = 'TokenStoreUnavailableError'
  }
}

/** Result of {@link TokenAuthenticator.authenticate}. */
export interface Authentication {
  /** The matching token, or `undefined` when the secret is unknown, revoked or expired. */
  token?: TokenSummary
  /** Grants of the token's user. */
  grant?: RepositoryGrant
  /**
   * When the snapshot used for this decision started loading, in
   * milliseconds. Actions authorized by it must expire relative to this time.
   */
  snapshotAt: number
}

/** Options for {@link TokenAuthenticator}. */
export interface TokenAuthenticatorOptions {
  /** How long a loaded snapshot of tokens and grants is reused. `0` reads the store on every request. */
  cacheTtlMs: number
  /** Minimum time between two `lastUsedAt` writes of one token (default {@link DEFAULT_LAST_USED_WRITE_INTERVAL_MS}). */
  lastUsedWriteIntervalMs?: number
  now?: () => number
}

interface TokenSnapshot {
  loadedAt: number
  records: Array<{ hash: Buffer, token: TokenSummary }>
  grants: Map<string, RepositoryGrant>
}

/**
 * Check presented secrets against a snapshot of the tokens and grants in a
 * {@link MetadataStore}.
 *
 * Snapshots are cached for `cacheTtlMs`, so a revocation reaches every
 * request within that time; expiry is checked against the current time on
 * every request. Each comparison hashes the presented secret and compares it
 * with every stored hash using a timing-safe comparison.
 *
 * A successful authentication records the token's `lastUsedAt` in the
 * background, at most once per `lastUsedWriteIntervalMs` per token (also
 * counting the time already stored), so the store sees few writes.
 */
export class TokenAuthenticator {
  readonly #store: MetadataStore
  readonly #cacheTtlMs: number
  readonly #lastUsedIntervalMs: number
  readonly #now: () => number
  readonly #lastUsedWrites = new Map<string, number>()
  readonly #pendingWrites = new Set<Promise<void>>()
  #snapshot: TokenSnapshot | undefined
  #loading: Promise<TokenSnapshot> | undefined

  constructor(store: MetadataStore, options: TokenAuthenticatorOptions) {
    this.#store = store
    this.#cacheTtlMs = options.cacheTtlMs
    this.#lastUsedIntervalMs = options.lastUsedWriteIntervalMs ?? DEFAULT_LAST_USED_WRITE_INTERVAL_MS
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
    const now = this.#now()
    if (match === undefined || now >= Date.parse(match.expiresAt))
      return { snapshotAt: snapshot.loadedAt }
    this.#recordUse(match, now)
    return { token: match, grant: snapshot.grants.get(match.user), snapshotAt: snapshot.loadedAt }
  }

  /** Wait for background `lastUsedAt` writes, for example before shutting down. */
  async flush(): Promise<void> {
    await Promise.all(this.#pendingWrites)
  }

  #recordUse(token: TokenSummary, now: number): void {
    const stored = token.lastUsedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(token.lastUsedAt)
    const last = Math.max(this.#lastUsedWrites.get(token.id) ?? Number.NEGATIVE_INFINITY, stored)
    if (now - last < this.#lastUsedIntervalMs)
      return
    this.#lastUsedWrites.set(token.id, now)
    const write = this.#store.tokens.touch(token.id, new Date(now).toISOString())
      // A failed write is retried on the token's next request.
      .catch(() => {
        if (this.#lastUsedWrites.get(token.id) === now)
          this.#lastUsedWrites.delete(token.id)
      })
      .finally(() => this.#pendingWrites.delete(write))
    this.#pendingWrites.add(write)
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
    let grants: RepositoryGrant[]
    try {
      [records, grants] = await Promise.all([this.#store.tokens.list(), this.#store.grants.list()])
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
      grants: new Map(grants.map(grant => [grant.user, grant])),
    }
    this.#snapshot = snapshot
    return snapshot
  }
}

function summarize(record: TokenRecord): TokenSummary {
  const { tokenHash: _, ...summary } = record
  return summary
}
