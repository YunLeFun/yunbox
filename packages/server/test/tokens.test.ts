import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main } from '../src/cli.ts'
import { parseBasicPassword } from '../src/request-handler.ts'
import {
  createToken,
  FileTokenStore,
  generateTokenSecret,
  hashTokenSecret,
  listTokens,
  parseTokenDocument,
  permits,
  resolvePermission,
  revokeToken,
  TokenAuthenticator,
  TokenStoreUnavailableError,
} from '../src/tokens.ts'
import { MemoryTokenStore } from './memory-token-store.ts'

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

    const store = new FileTokenStore(join(directory, '_yunbox', 'tokens.json'))
    expect(await store.read()).toEqual([])
    const created = await createToken(store, { name: 'alice', repos: { 'team/assets': 'write' } })
    const text = await readFile(store.path, 'utf8')
    expect(text).not.toContain(created.secret)
    expect(text).toContain(hashTokenSecret(created.secret))
    expect((await stat(store.path)).mode & 0o777).toBe(0o600)
    expect(await listTokens(store)).toEqual([created.token])
    expect(JSON.stringify(await listTokens(store))).not.toContain('sha256:')
  })

  it('validates names, repositories and the stored document', async () => {
    const store = new MemoryTokenStore()
    await createToken(store, { name: 'alice', repos: { 'team/*': 'read' } })
    await expect(createToken(store, { name: 'alice', repos: { 'team/*': 'read' } })).rejects.toThrow(/already exists/)
    await expect(createToken(store, { name: 'bad name', repos: { 'team/*': 'read' } })).rejects.toThrow(/name/)
    await expect(createToken(store, { name: 'bob', repos: {} })).rejects.toThrow(/at least one/)
    await expect(createToken(store, { name: 'bob', repos: { '*/*': 'read' } })).rejects.toThrow(/owner/)
    await expect(createToken(store, { name: 'bob', repos: { 'team/../x': 'read' } })).rejects.toThrow()
    await expect(createToken(store, { name: 'bob', repos: { 'team/x': 'admin' as 'read' } })).rejects.toThrow(/read or write/)

    expect(() => parseTokenDocument('not json')).toThrow(/JSON/)
    expect(() => parseTokenDocument('{"version":2,"tokens":[]}')).toThrow(/version/)
    expect(() => parseTokenDocument(JSON.stringify({ version: 1, tokens: [{ ...store.records[0], tokenHash: 'plain' }] }))).toThrow(/hash/)
    const path = join(directory, 'tokens.json')
    await writeFile(path, '{"version":1,"tokens":[{}]}')
    await expect(new FileTokenStore(path).read()).rejects.toThrow()
  })

  it('resolves permissions with exact entries overriding owner wildcards', () => {
    const record = { repos: { 'team/*': 'write', 'team/locked': 'read', 'art/library': 'read' } as const }
    expect(resolvePermission(record, { owner: 'team', repo: 'anything' })).toBe('write')
    expect(resolvePermission(record, { owner: 'team', repo: 'locked' })).toBe('read')
    expect(resolvePermission(record, { owner: 'art', repo: 'library' })).toBe('read')
    expect(resolvePermission(record, { owner: 'art', repo: 'other' })).toBeUndefined()
    expect(permits('write', 'read')).toBe(true)
    expect(permits('read', 'write')).toBe(false)
    expect(permits(undefined, 'read')).toBe(false)
  })

  it('caches the store for the TTL, then sees revocations and fails closed', async () => {
    let now = 1_000_000
    const store = new MemoryTokenStore()
    const { secret, token } = await createToken(store, { name: 'alice', repos: { 'team/*': 'read' } })
    const authenticator = new TokenAuthenticator(store, { cacheTtlMs: 30_000, now: () => now })

    expect(await authenticator.authenticate(secret)).toEqual({ token, snapshotAt: 1_000_000 })
    expect((await authenticator.authenticate('ybx_wrong')).token).toBeUndefined()
    expect((await authenticator.authenticate(undefined)).token).toBeUndefined()
    expect(store.reads).toBe(2)

    await revokeToken(store, 'alice')
    now += 29_999
    expect((await authenticator.authenticate(secret)).token).toEqual(token)
    now += 1
    expect(await authenticator.authenticate(secret)).toEqual({ snapshotAt: 1_030_000 })

    store.failReads = true
    now += 30_000
    await expect(authenticator.authenticate(secret)).rejects.toBeInstanceOf(TokenStoreUnavailableError)
  })

  it('reads the password from Basic credentials and ignores the user name', () => {
    const encode = (value: string): string => `Basic ${Buffer.from(value).toString('base64')}`
    expect(parseBasicPassword(encode('anyone:ybx_secret'))).toBe('ybx_secret')
    expect(parseBasicPassword(encode(':ybx_secret:with:colons'))).toBe('ybx_secret:with:colons')
    expect(parseBasicPassword(encode('no-colon'))).toBeUndefined()
    expect(parseBasicPassword('Bearer ybx_secret')).toBeUndefined()
    expect(parseBasicPassword(undefined)).toBeUndefined()
  })

  it('creates, lists and revokes tokens from the command line', async () => {
    const lines: string[] = []
    const run = (...args: string[]): Promise<void> => main(['token', ...args, '--storage-dir', directory], {
      stdout: line => lines.push(line),
      env: {},
    })

    await run('create', '--name', 'alice', '--write', 'team/assets', '--read', 'team/*', '--read', 'team/assets')
    const secret = lines.find(line => line.trim().startsWith('ybx_'))?.trim()
    expect(secret).toMatch(/^ybx_/)
    expect(lines.filter(line => line.includes(secret!))).toHaveLength(1)
    expect(lines[0]).toMatch(/^Created tok_[a-f\d]{16} {2}alice .*team\/\*:read, team\/assets:write$/)

    lines.length = 0
    await run('list')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('alice')
    expect(lines.join('\n')).not.toMatch(/ybx_|sha256/)
    const id = /tok_[a-f\d]{16}/.exec(lines[0]!)![0]

    const stored = await new FileTokenStore(join(directory, '_yunbox', 'tokens.json')).read()
    expect(stored[0]?.tokenHash).toBe(hashTokenSecret(secret!))

    await expect(run('create', '--name', 'bob')).rejects.toThrow(/--read or --write/)
    await expect(run('create', '--write', 'team/assets')).rejects.toThrow(/--name/)
    await expect(run('revoke', 'nobody')).rejects.toThrow(/no token matches/)
    lines.length = 0
    await run('revoke', id)
    expect(lines[0]).toMatch(/^Revoked tok_/)
    lines.length = 0
    await run('list')
    expect(lines).toEqual(['No tokens.'])
  })
})
