// @env node

import type { MetadataStore, TokenPermission, TokenRecord } from './metadata.ts'
import { assertName, assertRepos, assertTokenRecord } from './metadata.ts'
import { DEFAULT_TOKEN_LIFETIME_MS, mergeGrants } from './tokens.ts'

/** Name of the G1 token document inside the private `_yunbox` metadata namespace. */
export const LEGACY_TOKEN_DOCUMENT_NAME = 'tokens.json'

/** A token as G1 stored it in `tokens.json`: its grants were part of the token. */
export interface LegacyTokenRecord {
  id: string
  name: string
  tokenHash: string
  repos: Record<string, TokenPermission>
  createdAt: string
}

/** Where a G1 `tokens.json` document can be read. */
export interface LegacyTokenSource {
  /** Location for humans, without secrets. */
  readonly description: string
  /** The document text, or `undefined` when there is none. */
  read: () => Promise<string | undefined>
}

/** Parse a G1 token document `{ "version": 1, "tokens": [...] }`, rejecting anything malformed. */
export function parseLegacyTokenDocument(text: string): LegacyTokenRecord[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    throw new TypeError('token document is not valid JSON')
  }
  const document = value as { version?: unknown, tokens?: unknown } | null
  if (typeof document !== 'object' || document === null || document.version !== 1 || !Array.isArray(document.tokens))
    throw new TypeError('token document must be { "version": 1, "tokens": [...] }')
  const records = document.tokens as LegacyTokenRecord[]
  for (const record of records) {
    if (typeof record !== 'object' || record === null)
      throw new TypeError('token record must be an object')
    assertName(record.name, 'token name')
    assertRepos(record.repos)
    if (Object.keys(record.repos).length === 0)
      throw new TypeError('a token must grant access to at least one repository')
    // The remaining fields have the same rules as today's token records.
    assertTokenRecord({ ...record, user: record.name, expiresAt: record.createdAt })
  }
  if (new Set(records.map(record => record.id)).size !== records.length)
    throw new TypeError('token document contains duplicate ids')
  return records
}

/** Options for {@link migrateLegacyTokens}. */
export interface MigrateTokensOptions {
  /** Lifetime given to migrated tokens, counted from `now` (default 90 days). */
  lifetimeMs?: number
  now?: Date
}

/** Audit actor of the events that mark migrated tokens. */
export const MIGRATION_ACTOR = 'migration'

/** What {@link migrateLegacyTokens} did with each G1 token. */
export interface MigrationReport {
  /** Tokens copied in this run. */
  migrated: LegacyTokenRecord[]
  /** Tokens migrated by an earlier run, left untouched even if revoked since. */
  skipped: LegacyTokenRecord[]
  /** Tokens whose id exists with a different hash; nothing was written for them. */
  conflicts: LegacyTokenRecord[]
}

/**
 * Copy G1 tokens into a {@link MetadataStore}. Safe to run again.
 *
 * Each G1 token becomes a token with the same id, name and hash, acting for
 * a user named after the token, whose grants receive the token's repositories
 * (merged, never reduced). Migrated tokens expire `lifetimeMs` after the
 * migration, since G1 tokens had no expiry.
 *
 * Every migrated token is marked with a `token.migrate` audit event, written
 * last. A later run skips marked tokens, so a token revoked after the
 * migration is not brought back; a run interrupted before the marker is
 * completed by the next one (the grant merge and token creation are both
 * idempotent).
 */
export async function migrateLegacyTokens(source: LegacyTokenSource, store: MetadataStore, options: MigrateTokensOptions = {}): Promise<MigrationReport> {
  const text = await source.read()
  const legacy = text === undefined ? [] : parseLegacyTokenDocument(text)
  const now = options.now ?? new Date()
  const expiresAt = new Date(now.getTime() + (options.lifetimeMs ?? DEFAULT_TOKEN_LIFETIME_MS)).toISOString()
  const report: MigrationReport = { migrated: [], skipped: [], conflicts: [] }
  if (legacy.length === 0)
    return report
  const marked = new Set((await store.audit.list({ actor: MIGRATION_ACTOR, limit: 100_000 }))
    .filter(event => event.action === 'token.migrate')
    .map(event => event.details?.tokenId))
  for (const record of legacy) {
    if (marked.has(record.id)) {
      report.skipped.push(record)
      continue
    }
    const existing = await store.tokens.get(record.id)
    if (existing !== undefined && existing.tokenHash !== record.tokenHash) {
      report.conflicts.push(record)
      continue
    }
    if (existing === undefined) {
      await store.grants.update(record.name, repos => mergeGrants(repos, record.repos))
      const migrated: TokenRecord = {
        id: record.id,
        name: record.name,
        user: record.name,
        tokenHash: record.tokenHash,
        createdAt: record.createdAt,
        expiresAt,
      }
      if (!await store.tokens.create(migrated) && (await store.tokens.get(record.id))?.tokenHash !== record.tokenHash) {
        report.conflicts.push(record)
        continue
      }
    }
    await store.audit.append({ action: 'token.migrate', actor: MIGRATION_ACTOR, at: now.toISOString(), details: { tokenId: record.id, name: record.name } })
    report.migrated.push(record)
  }
  return report
}
