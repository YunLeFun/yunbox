import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main } from '../src/cli.ts'
import { migrateLegacyTokens, parseLegacyTokenDocument } from '../src/legacy-tokens.ts'
import { LocalMetadataStore } from '../src/metadata-local.ts'
import { parseBasicPassword } from '../src/request-handler.ts'
import {
  createToken,
  DEFAULT_TOKEN_LIFETIME_MS,
  generateTokenSecret,
  hashTokenSecret,
  listTokens,
  mergeGrants,
  parseDuration,
  permits,
  resolvePermission,
  revokeToken,
  setGrant,
  TokenAuthenticator,
  TokenStoreUnavailableError,
} from '../src/tokens.ts'
import { MemoryMetadataStore } from './memory-metadata.ts'

const DAY = 24 * 60 * 60 * 1000

describe('personal tokens', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'yunbox-tokens-test-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('generates random secrets and stores only their hashes, owner-readable', async () => {
    const secret = generateTokenSecret()
    expect(secret).toMatch(/^ybx_[\w-]{43}$/)
    expect(generateTokenSecret()).not.toBe(secret)
    expect(hashTokenSecret(secret)).toMatch(/^sha256:[a-f\d]{64}$/)

    const store = new LocalMetadataStore(join(directory, 'metadata'))
    expect(await listTokens(store)).toEqual([])
    const now = new Date('2026-10-17T00:00:00.000Z')
    const created = await createToken(store, { name: 'alice', repos: { 'team/assets': 'write' }, now })
    expect(created.token).toEqual({
      id: created.token.id,
      name: 'alice',
      user: 'alice',
      createdAt: '2026-10-17T00:00:00.000Z',
      expiresAt: new Date(now.getTime() + 90 * DAY).toISOString(),
    })
    const path = join(directory, 'metadata', 'tokens', `${created.token.id}.json`)
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain(created.secret)
    expect(text).toContain(hashTokenSecret(created.secret))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await listTokens(store)).toEqual([created.token])
    expect(JSON.stringify(await listTokens(store))).not.toContain('sha256:')
  })

  it('validates names, users, grants and lifetimes', async () => {
    const store = new MemoryMetadataStore()
    await createToken(store, { name: 'alice', repos: { 'team/*': 'read' } })
    await expect(createToken(store, { name: 'alice', repos: { 'team/*': 'read' } })).rejects.toThrow(/already exists/)
    await expect(createToken(store, { name: 'bad name', repos: { 'team/*': 'read' } })).rejects.toThrow(/name/)
    await expect(createToken(store, { name: 'bob', user: 'bad user', repos: { 'team/*': 'read' } })).rejects.toThrow(/user/)
    await expect(createToken(store, { name: 'bob', repos: {} })).rejects.toThrow(/no repository grants/)
    await expect(createToken(store, { name: 'bob' })).rejects.toThrow(/no repository grants/)
    await expect(createToken(store, { name: 'bob', repos: { '*/*': 'read' } })).rejects.toThrow(/owner/)
    await expect(createToken(store, { name: 'bob', repos: { 'team/../x': 'read' } })).rejects.toThrow()
    await expect(createToken(store, { name: 'bob', repos: { 'team/x': 'admin' as 'read' } })).rejects.toThrow(/read or write/)
    await expect(createToken(store, { name: 'bob', repos: { 'team/x': 'read' }, lifetimeMs: 0 })).rejects.toThrow(/lifetime/)
    // A second token of an existing user needs no repositories of its own.
    expect((await createToken(store, { name: 'alice-laptop', user: 'alice' })).token.user).toBe('alice')

    expect(parseDuration('90d')).toBe(90 * DAY)
    expect(parseDuration('12h')).toBe(12 * 60 * 60 * 1000)
    expect(parseDuration('30m')).toBe(30 * 60 * 1000)
    for (const invalid of ['0d', '90', '1w', '-1d', '3651d', ' 1d'])
      expect(() => parseDuration(invalid)).toThrow(/duration/)
  })

  it('resolves permissions with exact entries overriding owner wildcards', () => {
    const grant = { repos: { 'team/*': 'write', 'team/locked': 'read', 'art/library': 'read' } as const }
    expect(resolvePermission(grant, { owner: 'team', repo: 'anything' })).toBe('write')
    expect(resolvePermission(grant, { owner: 'team', repo: 'locked' })).toBe('read')
    expect(resolvePermission(grant, { owner: 'art', repo: 'library' })).toBe('read')
    expect(resolvePermission(grant, { owner: 'art', repo: 'other' })).toBeUndefined()
    expect(resolvePermission(undefined, { owner: 'team', repo: 'anything' })).toBeUndefined()
    expect(resolvePermission({ repos: {} }, { owner: 'team', repo: 'constructor' })).toBeUndefined()
    expect(permits('write', 'read')).toBe(true)
    expect(permits('read', 'write')).toBe(false)
    expect(permits(undefined, 'read')).toBe(false)
    // Adding grants never reduces them.
    expect(mergeGrants({ 'team/*': 'write', 'a/b': 'read' }, { 'team/*': 'read', 'a/b': 'write', 'c/*': 'read' }))
      .toEqual({ 'team/*': 'write', 'a/b': 'write', 'c/*': 'read' })
  })

  it('caches tokens and grants for the TTL, then sees revocations and grant changes, and fails closed', async () => {
    let now = 1_000_000
    const store = new MemoryMetadataStore()
    const { secret, token } = await createToken(store, { name: 'alice', repos: { 'team/*': 'read' } })
    const authenticator = new TokenAuthenticator(store, { cacheTtlMs: 30_000, now: () => now })
    const readsBefore = store.reads

    const first = await authenticator.authenticate(secret)
    expect(first).toEqual({ token, grant: await store.grants.get('alice'), snapshotAt: 1_000_000 })
    expect((await authenticator.authenticate('ybx_wrong')).token).toBeUndefined()
    expect((await authenticator.authenticate(undefined)).token).toBeUndefined()
    expect(store.reads - readsBefore).toBe(1)

    await setGrant(store, 'alice', { 'team/*': 'write' })
    await revokeToken(store, 'alice')
    now += 29_999
    expect(await authenticator.authenticate(secret)).toMatchObject({ token, grant: { repos: { 'team/*': 'read' } } })
    now += 1
    expect(await authenticator.authenticate(secret)).toEqual({ snapshotAt: 1_030_000 })

    store.failReads = true
    now += 30_000
    await expect(authenticator.authenticate(secret)).rejects.toBeInstanceOf(TokenStoreUnavailableError)
  })

  it('keeps the revocation bound: actions authorized after a revocation expire within the action TTL of it', async () => {
    const actionTtlMs = 300_000
    let now = 5_000_000
    const store = new MemoryMetadataStore()
    const { secret } = await createToken(store, { name: 'alice', repos: { 'team/*': 'write' } })
    const authenticator = new TokenAuthenticator(store, { cacheTtlMs: 30_000, now: () => now })
    await authenticator.authenticate(secret)

    now += 1000
    const revokedAt = now
    await revokeToken(store, 'alice')
    // Requests within the cache TTL still pass, but with the old snapshot time,
    // so every action they get expires at most actionTtl after the revocation.
    for (const elapsed of [0, 10_000, 28_999]) {
      now = revokedAt + elapsed
      const authentication = await authenticator.authenticate(secret)
      expect(authentication.token).toBeDefined()
      expect(authentication.snapshotAt + actionTtlMs).toBeLessThanOrEqual(revokedAt + actionTtlMs)
    }
    now = revokedAt + 29_000
    expect((await authenticator.authenticate(secret)).token).toBeUndefined()
  })

  it('rejects tokens from their expiry time on, even from a cached snapshot', async () => {
    let now = Date.parse('2026-10-17T00:00:00.000Z')
    const store = new MemoryMetadataStore()
    const created = await createToken(store, { name: 'alice', repos: { 'team/*': 'read' }, lifetimeMs: 60_000, now: new Date(now) })
    const authenticator = new TokenAuthenticator(store, { cacheTtlMs: 30_000, now: () => now })
    const readsBefore = store.reads
    expect((await authenticator.authenticate(created.secret)).token?.id).toBe(created.token.id)
    now += 59_999
    // Reload the snapshot so the cache is fresh, then cross the expiry inside it.
    expect((await authenticator.authenticate(created.secret)).token?.id).toBe(created.token.id)
    now += 1
    expect((await authenticator.authenticate(created.secret)).token).toBeUndefined()
    expect(store.reads - readsBefore).toBe(2)
  })

  it('throttles lastUsedAt writes per token and retries failed writes', async () => {
    let now = Date.parse('2026-10-17T00:00:00.000Z')
    const store = new MemoryMetadataStore()
    const alice = await createToken(store, { name: 'alice', repos: { 'team/*': 'read' } })
    const bob = await createToken(store, { name: 'bob', repos: { 'team/*': 'read' } })
    const options = { cacheTtlMs: 30_000, lastUsedWriteIntervalMs: 600_000, now: () => now }
    const authenticator = new TokenAuthenticator(store, options)
    const writes = (): number => store.memory.updates.get('tokens') ?? 0

    for (let index = 0; index < 50; index++)
      await authenticator.authenticate(alice.secret)
    await authenticator.flush()
    expect(writes()).toBe(1)
    expect((await store.tokens.get(alice.token.id))?.lastUsedAt).toBe('2026-10-17T00:00:00.000Z')

    await authenticator.authenticate(bob.secret)
    now += 599_999
    await authenticator.authenticate(alice.secret)
    await authenticator.flush()
    expect(writes()).toBe(2)
    now += 1
    await authenticator.authenticate(alice.secret)
    await authenticator.flush()
    expect(writes()).toBe(3)

    // A restarted server sees the stored time and does not write again early.
    const restarted = new TokenAuthenticator(store, options)
    now += 1000
    await restarted.authenticate(alice.secret)
    await restarted.flush()
    expect(writes()).toBe(3)

    // A failed write is retried on the next request rather than waiting a whole interval.
    const touch = store.tokens.touch
    store.tokens.touch = async () => {
      throw new Error('simulated write failure')
    }
    now += 600_000
    await restarted.authenticate(alice.secret)
    await restarted.flush()
    store.tokens.touch = touch
    await restarted.authenticate(alice.secret)
    await restarted.flush()
    expect(writes()).toBe(4)
  })

  it('reads the password from Basic credentials and ignores the user name', () => {
    const encode = (value: string): string => `Basic ${Buffer.from(value).toString('base64')}`
    expect(parseBasicPassword(encode('anyone:ybx_secret'))).toBe('ybx_secret')
    expect(parseBasicPassword(encode(':ybx_secret:with:colons'))).toBe('ybx_secret:with:colons')
    expect(parseBasicPassword(encode('no-colon'))).toBeUndefined()
    expect(parseBasicPassword('Bearer ybx_secret')).toBeUndefined()
    expect(parseBasicPassword(undefined)).toBeUndefined()
  })

  describe('command line', () => {
    let lines: string[]
    const run = async (...args: string[]): Promise<void> => {
      await main([...args, '--storage-dir', directory], { stdout: line => lines.push(line), env: {} })
    }
    const metadata = (): LocalMetadataStore => new LocalMetadataStore(join(directory, '_yunbox', 'metadata'))

    beforeEach(() => {
      lines = []
    })

    it('creates, lists and revokes tokens, and manages grants', async () => {
      await run('token', 'create', '--name', 'alice', '--write', 'team/assets', '--read', 'team/*', '--read', 'team/assets', '--expires-in', '30d')
      const secret = lines.find(line => line.trim().startsWith('ybx_'))?.trim()
      expect(secret).toMatch(/^ybx_/)
      expect(lines.filter(line => line.includes(secret!))).toHaveLength(1)
      expect(lines[0]).toMatch(/^Created tok_[a-f\d]{16} {2}alice {2}user alice {2}created \S+ {2}expires \S+ {2}last used never$/)
      expect(lines[1]).toBe('User alice can access team/*:read, team/assets:write')
      const [token] = await metadata().tokens.list()
      expect(Date.parse(token!.expiresAt) - Date.parse(token!.createdAt)).toBe(30 * DAY)
      expect(token!.tokenHash).toBe(hashTokenSecret(secret!))

      lines.length = 0
      await run('token', 'create', '--name', 'alice-ci', '--user', 'alice')
      expect(lines[1]).toBe('User alice can access team/*:read, team/assets:write')

      lines.length = 0
      await run('token', 'list')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain('alice')
      expect(lines.join('\n')).not.toMatch(/ybx_|sha256/)
      const id = /tok_[a-f\d]{16}/.exec(lines[0]!)![0]

      lines.length = 0
      await run('grant', 'set', 'alice', '--read', 'team/assets')
      await run('grant', 'list')
      expect(lines.at(-1)).toMatch(/^alice {2}team\/assets:read {2}updated /)

      await expect(run('token', 'create', '--name', 'bob')).rejects.toThrow(/no repository grants/)
      await expect(run('token', 'create', '--write', 'team/assets')).rejects.toThrow(/--name/)
      await expect(run('token', 'create', '--name', 'bob', '--read', 'team/x', '--expires-in', '1y')).rejects.toThrow(/duration/)
      await expect(run('token', 'revoke', 'nobody')).rejects.toThrow(/no token matches/)
      await expect(run('grant', 'set')).rejects.toThrow(/needs a user/)
      lines.length = 0
      await run('token', 'revoke', id)
      expect(lines[0]).toMatch(/^Revoked tok_/)
      await run('token', 'revoke', 'alice-ci')
      lines.length = 0
      await run('token', 'list')
      expect(lines).toEqual(['No tokens.'])
      await run('grant', 'set', 'alice')
      expect(lines.at(-2)).toMatch(/Removed every grant of alice/)
    })

    it('never loses tokens when administrators create and revoke concurrently', async () => {
      for (const name of ['old-1', 'old-2', 'old-3', 'old-4'])
        await run('token', 'create', '--name', name, '--read', 'team/*')
      // Every command opens its own store, like separate processes.
      await Promise.all([
        ...Array.from({ length: 8 }, (_, index) => run('token', 'create', '--name', `new-${index}`, '--write', `team/repo-${index}`)),
        ...['old-1', 'old-2', 'old-3', 'old-4'].map(name => run('token', 'revoke', name)),
      ])
      const names = (await listTokens(metadata())).map(token => token.name).sort()
      expect(names).toEqual(Array.from({ length: 8 }, (_, index) => `new-${index}`))
      expect((await metadata().grants.list()).filter(grant => grant.user.startsWith('new-'))).toHaveLength(8)
    })

    it('migrates G1 tokens once, keeping their secrets working', async () => {
      const store = new MemoryMetadataStore()
      const legacy = [
        { name: 'alice', repos: { 'team/*': 'write', 'team/locked': 'read' } as const },
        { name: 'bob', repos: { 'art/library': 'read' } as const },
      ].map((entry, index) => ({
        secret: generateTokenSecret(),
        record: { id: `tok_${String(index).repeat(16)}`, name: entry.name, repos: entry.repos, createdAt: '2026-10-01T00:00:00.000Z' },
      }))
      const document = JSON.stringify({ version: 1, tokens: legacy.map(({ secret, record }) => ({ ...record, tokenHash: hashTokenSecret(secret) })) })
      expect(parseLegacyTokenDocument(document)).toHaveLength(2)
      const source = { description: 'test document', read: async () => document }
      const now = new Date('2026-10-17T00:00:00.000Z')

      const first = await migrateLegacyTokens(source, store, { now })
      expect(first.migrated.map(record => record.name)).toEqual(['alice', 'bob'])
      const authenticator = new TokenAuthenticator(store, { cacheTtlMs: 0 })
      const alice = await authenticator.authenticate(legacy[0]!.secret)
      expect(alice.token).toMatchObject({ id: legacy[0]!.record.id, name: 'alice', user: 'alice', createdAt: '2026-10-01T00:00:00.000Z' })
      expect(alice.token?.expiresAt).toBe(new Date(now.getTime() + DEFAULT_TOKEN_LIFETIME_MS).toISOString())
      expect(alice.grant?.repos).toEqual(legacy[0]!.record.repos)
      expect((await authenticator.authenticate(legacy[1]!.secret)).grant?.repos).toEqual({ 'art/library': 'read' })

      // Running again changes nothing, and a token revoked since is not brought back.
      await revokeToken(store, 'bob')
      await setGrant(store, 'alice', { 'team/*': 'read' })
      const second = await migrateLegacyTokens(source, store, { now })
      expect(second).toEqual({ migrated: [], skipped: first.migrated, conflicts: [] })
      expect((await listTokens(store)).map(token => token.name)).toEqual(['alice'])
      expect((await store.grants.get('alice'))?.repos).toEqual({ 'team/*': 'read' })

      // A token whose id is taken by a different hash is reported and left alone.
      const clash = { ...legacy[0]!.record, id: 'tok_ffffffffffffffff', tokenHash: hashTokenSecret('other') }
      await store.tokens.create({ id: clash.id, name: 'carol', user: 'carol', tokenHash: hashTokenSecret('mine'), createdAt: clash.createdAt, expiresAt: clash.createdAt })
      const clashing = await migrateLegacyTokens({ description: 'clash', read: async () => JSON.stringify({ version: 1, tokens: [clash] }) }, store)
      expect(clashing.conflicts).toEqual([clash])
    })

    it('points at a forgotten migration when the server starts', async () => {
      await mkdir(join(directory, '_yunbox'), { recursive: true })
      const record = { id: 'tok_0123456789abcdef', name: 'alice', tokenHash: hashTokenSecret(generateTokenSecret()), repos: { 'team/*': 'write' }, createdAt: '2026-10-01T00:00:00.000Z' }
      await writeFile(join(directory, '_yunbox', 'tokens.json'), JSON.stringify({ version: 1, tokens: [record] }))
      const serve = async (): Promise<string[]> => {
        const output: string[] = []
        const running = await main(['serve', '--port', '0', '--storage-dir', directory], { stdout: line => output.push(line), env: {} })
        await running?.close()
        return output
      }
      expect((await serve()).at(-1)).toMatch(/^Tokens from an earlier version exist in .*tokens\.json but are no longer read\. Run "yunbox-server token migrate"\.$/)
      await run('token', 'migrate')
      expect((await serve()).join('\n')).not.toMatch(/earlier version|No tokens exist/)
    })

    it('completes an interrupted migration and is idempotent from the command line', async () => {
      const secret = generateTokenSecret()
      const record = { id: 'tok_0123456789abcdef', name: 'alice', tokenHash: hashTokenSecret(secret), repos: { 'team/*': 'write' }, createdAt: '2026-10-01T00:00:00.000Z' }
      await mkdir(join(directory, '_yunbox'), { recursive: true })
      await writeFile(join(directory, '_yunbox', 'tokens.json'), JSON.stringify({ version: 1, tokens: [record] }))
      // Simulate a run that stopped after writing the grant and the token but before its marker.
      const store = metadata()
      await store.grants.update('alice', () => ({ 'team/*': 'write' }))
      await store.tokens.create({ ...record, user: 'alice', expiresAt: '2027-01-01T00:00:00.000Z' })

      await run('token', 'migrate', '--expires-in', '7d')
      expect(lines.at(-1)).toMatch(/^1 migrated, 0 already migrated, 0 conflicts, from .*tokens\.json\.$/)
      lines.length = 0
      await run('token', 'migrate')
      expect(lines).toEqual([`Already migrated ${record.id}  alice`, expect.stringMatching(/^0 migrated, 1 already migrated, 0 conflicts/)])
      expect((await listTokens(store)).map(token => token.id)).toEqual([record.id])
      expect((await store.audit.list()).map(event => event.action)).toEqual(['token.migrate'])
      // The G1 document is left in place for the administrator to retire.
      expect(await readdir(join(directory, '_yunbox'))).toContain('tokens.json')

      lines.length = 0
      await main(['token', 'migrate', '--storage-dir', join(directory, 'empty')], { stdout: line => lines.push(line), env: {} })
      expect(lines).toEqual([expect.stringMatching(/^No earlier tokens found in .*tokens\.json\.$/)])
    })
  })
})
