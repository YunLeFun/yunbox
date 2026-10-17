import type { MetadataStore, TokenRecord } from '../src/metadata.ts'
import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashTokenSecret } from '../src/tokens.ts'

/** A store under test, plus a second handle on the same data that shares no in-process state (like another process). */
export interface ContractSubject {
  store: MetadataStore
  other: MetadataStore
  cleanup: () => Promise<void>
}

const repository = { owner: 'team', repo: 'assets' }

/** A token record with fresh random id and hash. */
export function sampleToken(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    id: `tok_${randomBytes(8).toString('hex')}`,
    name: `token-${randomBytes(4).toString('hex')}`,
    user: 'alice',
    tokenHash: hashTokenSecret(randomBytes(16).toString('hex')),
    createdAt: '2026-10-17T00:00:00.000Z',
    expiresAt: '2027-01-15T00:00:00.000Z',
    ...overrides,
  }
}

/**
 * Behaviour every {@link MetadataStore} must have. The concurrent cases split
 * writes between `store` and `other`, so in-process coordination alone
 * cannot make them pass.
 */
export function describeMetadataStoreContract(name: string, setup: () => Promise<ContractSubject>): void {
  describe(`metadata store contract: ${name}`, () => {
    let subject: ContractSubject
    let store: MetadataStore
    let other: MetadataStore

    beforeEach(async () => {
      subject = await setup()
      store = subject.store
      other = subject.other
    })

    afterEach(async () => {
      await subject.cleanup()
    })

    it('creates, reads, lists, touches and deletes tokens', async () => {
      const token = sampleToken()
      expect(await store.tokens.create(token)).toBe(true)
      expect(await other.tokens.create({ ...sampleToken(), id: token.id })).toBe(false)
      expect(await other.tokens.get(token.id)).toEqual(token)
      expect(await store.tokens.get('tok_0000000000000000')).toBeUndefined()

      await store.tokens.touch(token.id, '2026-10-18T00:00:00.000Z')
      await other.tokens.touch(token.id, '2026-10-17T12:00:00.000Z')
      expect((await store.tokens.get(token.id))?.lastUsedAt).toBe('2026-10-18T00:00:00.000Z')
      await store.tokens.touch('tok_0000000000000000', '2026-10-18T00:00:00.000Z')

      expect((await store.tokens.list()).map(record => record.id)).toEqual([token.id])
      expect(await other.tokens.delete(token.id)).toBe(true)
      expect(await store.tokens.delete(token.id)).toBe(false)
      expect(await store.tokens.list()).toEqual([])
    })

    it('keeps every token when tokens are created and revoked concurrently', async () => {
      const kept = Array.from({ length: 12 }, () => sampleToken())
      const revoked = Array.from({ length: 6 }, () => sampleToken())
      await Promise.all(revoked.map(token => store.tokens.create(token)))
      await Promise.all([
        ...kept.map((token, index) => (index % 2 === 0 ? store : other).tokens.create(token)),
        ...revoked.map((token, index) => (index % 2 === 0 ? other : store).tokens.delete(token.id)),
      ])
      const ids = (await store.tokens.list()).map(token => token.id).sort()
      expect(ids).toEqual(kept.map(token => token.id).sort())
    })

    it('updates grants atomically, including concurrent changes for one user', async () => {
      expect(await store.grants.get('alice')).toBeUndefined()
      const created = await store.grants.update('alice', repos => ({ ...repos, 'team/*': 'read' }))
      expect(created?.repos).toEqual({ 'team/*': 'read' })
      // Repository names may contain dots, which document databases treat specially in field names.
      await Promise.all(Array.from({ length: 8 }, (_, index) =>
        (index % 2 === 0 ? store : other).grants.update('alice', repos => ({ ...repos, [`team/repo.${index}`]: 'write' }))))
      const grant = await other.grants.get('alice')
      expect(Object.keys(grant?.repos ?? {}).sort()).toEqual(['team/*', ...Array.from({ length: 8 }, (_, index) => `team/repo.${index}`)].sort())

      await other.grants.update('bob', () => ({ 'art/library': 'write' }))
      expect((await store.grants.list()).map(item => item.user).sort()).toEqual(['alice', 'bob'])
      expect(await store.grants.update('bob', () => ({}))).toBeUndefined()
      expect(await other.grants.get('bob')).toBeUndefined()
    })

    it('creates at most one lock per path, even under concurrent requests', async () => {
      const attempts = await Promise.all(Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? store : other).locks.create({ repository, path: 'art/hero.psd', owner: `user${index}` })))
      const winners = attempts.filter(result => result.created)
      expect(winners).toHaveLength(1)
      const lock = winners[0]!.created ? winners[0]!.lock : undefined
      for (const result of attempts.filter(result => !result.created))
        expect(result.created ? undefined : result.existing).toEqual(lock)

      await store.locks.create({ repository, path: 'art/a.psd', owner: 'bob' })
      await store.locks.create({ repository: { owner: 'team', repo: 'other' }, path: 'art/hero.psd', owner: 'bob' })
      expect((await other.locks.list(repository)).map(item => item.path)).toEqual(['art/a.psd', 'art/hero.psd'])
      expect(await other.locks.list(repository, { path: 'art/hero.psd' })).toEqual([lock])
      expect(await other.locks.get(repository, lock!.id)).toEqual(lock)
      expect(await other.locks.get({ owner: 'team', repo: 'other' }, lock!.id)).toBeUndefined()

      expect(await other.locks.delete(repository, lock!.id)).toEqual(lock)
      const again = await store.locks.create({ repository, path: 'art/hero.psd', owner: 'carol' })
      expect(again.created && again.lock.id).not.toBe(lock!.id)
      // Unlocking with the old id must not remove the new lock.
      expect(await store.locks.delete(repository, lock!.id)).toBeUndefined()
      expect(await other.locks.list(repository, { path: 'art/hero.psd' })).toHaveLength(1)
    })

    it('appends audit events and lists them newest first', async () => {
      const first = await store.audit.append({ action: 'token.create', actor: 'admin', at: '2026-10-17T00:00:01.000Z', details: { tokenId: 'tok_1' } })
      await other.audit.append({ action: 'lock.create', actor: 'alice', repository: 'team/assets', at: '2026-10-17T00:00:02.000Z' })
      const third = await store.audit.append({ action: 'lock.delete', actor: 'alice', repository: 'team/assets', at: '2026-10-17T00:00:03.000Z', details: { force: false, count: 1 } })
      expect(first.id < third.id).toBe(true)
      expect((await other.audit.list()).map(event => event.action)).toEqual(['lock.delete', 'lock.create', 'token.create'])
      expect(await other.audit.list({ repository: 'team/assets', limit: 1 })).toEqual([third])
      expect((await other.audit.list({ actor: 'admin' }))[0]).toEqual(first)
      expect(Object.keys(store.audit)).toEqual(['append', 'list'])
    })
  })
}
