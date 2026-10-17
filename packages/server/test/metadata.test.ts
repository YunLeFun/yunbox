import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CloudBaseMetadataStore, fromEjson, signCloudBaseRequest } from '../src/metadata-cloudbase.ts'
import { LocalMetadataStore } from '../src/metadata-local.ts'
import { METADATA_COLLECTIONS } from '../src/metadata.ts'
import { createCloudBaseMetadataFromEnvironment } from '../src/storage-config.ts'
import { FakeCloudBaseServer } from './fake-cloudbase-server.ts'
import { describeMetadataStoreContract, sampleToken } from './metadata-contract.ts'

const credentials = {
  secretId: 'AKIDTESTTESTTESTTESTTESTTESTTEST',
  secretKey: 'test-secret-key-test-secret-key',
  sessionToken: 'temporary-session-token',
}
const collections = METADATA_COLLECTIONS.map(name => `yunbox_${name}`)

describeMetadataStoreContract('local files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yunbox-metadata-test-'))
  return {
    store: new LocalMetadataStore(directory),
    other: new LocalMetadataStore(directory),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  }
})

describeMetadataStoreContract('CloudBase (test double, TC3 with temporary keys)', async () => {
  const server = await new FakeCloudBaseServer(credentials, collections).start()
  const options = { envId: 'yunbox-test-1a2b3c', endpoint: server.origin, credentials: () => credentials }
  return {
    store: new CloudBaseMetadataStore(options),
    other: new CloudBaseMetadataStore(options),
    cleanup: () => server.close(),
  }
})

describe('local metadata files', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'yunbox-metadata-local-test-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps files owner-only, leaves no temporary or lock files, and separates ids by case', async () => {
    const store = new LocalMetadataStore(directory)
    const token = sampleToken()
    await store.tokens.create(token)
    await store.grants.update('Alice', () => ({ 'team/*': 'read' }))
    await store.grants.update('alice', () => ({ 'team/*': 'write' }))
    await store.tokens.touch(token.id, '2026-10-18T00:00:00.000Z')

    expect((await stat(join(directory, 'tokens', `${token.id}.json`))).mode & 0o777).toBe(0o600)
    expect((await stat(join(directory, 'tokens'))).mode & 0o777).toBe(0o700)
    expect((await store.grants.get('Alice'))?.repos).toEqual({ 'team/*': 'read' })
    expect((await store.grants.get('alice'))?.repos).toEqual({ 'team/*': 'write' })
    for (const collection of ['tokens', 'grants'])
      expect((await readdir(join(directory, collection))).every(name => name.endsWith('.json') && !name.startsWith('.'))).toBe(true)
  })

  it('fails closed on malformed documents', async () => {
    const store = new LocalMetadataStore(directory)
    await mkdir(join(directory, 'tokens'), { recursive: true })
    await writeFile(join(directory, 'tokens', 'tok_0123456789abcdef.json'), '{"id":"tok_0123456789abcdef","etag":"x","data":{"name":"a"}}')
    await expect(store.tokens.list()).rejects.toThrow(/token/)
    await writeFile(join(directory, 'tokens', 'tok_0123456789abcdef.json'), 'not json')
    await expect(store.tokens.list()).rejects.toThrow()
  })

  it('breaks a lock left behind by a crashed process', async () => {
    const store = new LocalMetadataStore(directory)
    const token = sampleToken()
    await store.tokens.create(token)
    const lockPath = join(directory, 'tokens', `${token.id}.json.lock`)
    await writeFile(lockPath, '')
    const { utimes } = await import('node:fs/promises')
    const old = new Date(Date.now() - 60_000)
    await utimes(lockPath, old, old)
    expect(await store.tokens.delete(token.id)).toBe(true)
  })
})

describe('cloudBase metadata over HTTP', () => {
  let server: FakeCloudBaseServer

  afterEach(async () => {
    await server.close()
  })

  it('sends an API key as a Bearer token when configured', async () => {
    server = await new FakeCloudBaseServer({ apiKey: 'server-api-key' }, collections).start()
    const store = createCloudBaseMetadataFromEnvironment({
      YUNBOX_CLOUDBASE_ENV: 'yunbox-test-1a2b3c',
      YUNBOX_CLOUDBASE_ENDPOINT: server.origin,
      YUNBOX_CLOUDBASE_API_KEY: 'server-api-key',
      TENCENTCLOUD_SECRETID: 'unused',
      TENCENTCLOUD_SECRETKEY: 'unused',
    })
    const token = sampleToken()
    expect(await store.tokens.create(token)).toBe(true)
    expect(await store.tokens.get(token.id)).toEqual(token)
    expect(server.requests.every(request => request.status < 400)).toBe(true)
  })

  it('reports failures by operation, status and code without URLs or credentials', async () => {
    server = await new FakeCloudBaseServer(credentials, collections.filter(name => name !== 'yunbox_grants')).start()
    const store = new CloudBaseMetadataStore({ envId: 'yunbox-test-1a2b3c', endpoint: server.origin, credentials: () => credentials })

    const missing = await store.grants.list().then(() => undefined, (error: unknown) => error as Error)
    expect(missing?.message).toBe('CloudBase list failed with HTTP 404 (DATABASE_COLLECTION_NOT_EXIST); create the collection first')

    server.failures.push({ status: 500, code: 'SYS_ERR' })
    const failed = await store.tokens.get('tok_0123456789abcdef').then(() => undefined, (error: unknown) => error as Error)
    expect(failed?.message).toBe('CloudBase read failed with HTTP 500 (SYS_ERR, request req-fake)')

    const wrongKey = new CloudBaseMetadataStore({ envId: 'yunbox-test-1a2b3c', endpoint: server.origin, credentials: () => ({ ...credentials, secretKey: 'wrong' }) })
    const rejected = await wrongKey.tokens.list().then(() => undefined, (error: unknown) => error as Error)
    expect(rejected?.message).toBe('CloudBase access token failed with HTTP 401 (invalid_client)')
    for (const error of [missing, failed, rejected]) {
      for (const secret of [credentials.secretId, credentials.secretKey, credentials.sessionToken, server.origin, '127.0.0.1'])
        expect(error!.message).not.toContain(secret)
    }

    const unreachable = new CloudBaseMetadataStore({ envId: 'yunbox-test-1a2b3c', endpoint: 'http://127.0.0.1:1', credentials: () => credentials })
    await expect(unreachable.tokens.list()).rejects.toThrow(/^CloudBase access token request failed: TypeError$/)
  })

  it('exchanges the key pair for an access token once, and renews it when needed', async () => {
    server = await new FakeCloudBaseServer(credentials, collections).start()
    let now = Date.now()
    let current = credentials
    const store = new CloudBaseMetadataStore({ envId: 'yunbox-test-1a2b3c', endpoint: server.origin, credentials: () => current, now: () => now })
    const tokenRequests = (): number => server.requests.filter(request => request.path === '/auth/v1/token/clientCredential').length

    await Promise.all(Array.from({ length: 5 }, () => store.tokens.list()))
    await store.grants.list()
    expect(tokenRequests()).toBe(1)
    // Only the token exchange is signed; database requests carry the token.
    expect(server.requests.filter(request => request.status === 401)).toEqual([])

    // Rotated temporary keys get their own token.
    current = { ...credentials, sessionToken: 'rotated-session-token' }
    server.credentials = current
    await store.tokens.list()
    expect(tokenRequests()).toBe(2)

    // A token rejected early is replaced once, transparently.
    server.accessTokens.clear()
    await store.tokens.list()
    expect(tokenRequests()).toBe(3)
    expect(server.requests.filter(request => request.status === 401)).toHaveLength(1)

    // Renewed 5 minutes before it expires.
    server.tokenLifetimeSeconds = 360
    const renewing = new CloudBaseMetadataStore({ envId: 'yunbox-test-1a2b3c', endpoint: server.origin, credentials: () => current, now: () => now })
    await renewing.tokens.list()
    expect(tokenRequests()).toBe(4)
    now += 60_000 - 1
    await renewing.tokens.list()
    expect(tokenRequests()).toBe(4)
    now += 1
    await renewing.tokens.list()
    expect(tokenRequests()).toBe(5)
  })

  it('does not depend on the exact duplicate error code, and fails closed if ids are not kept', async () => {
    server = await new FakeCloudBaseServer(credentials, collections).start()
    server.duplicateCode = 'SOME_OTHER_DUPLICATE_CODE'
    const store = new CloudBaseMetadataStore({ envId: 'yunbox-test-1a2b3c', endpoint: server.origin, credentials: () => credentials })
    const repository = { owner: 'team', repo: 'assets' }
    const attempts = await Promise.all(Array.from({ length: 6 }, () => store.locks.create({ repository, path: 'a.psd', owner: 'alice' })))
    expect(attempts.filter(result => result.created)).toHaveLength(1)
    const token = sampleToken()
    expect(await store.tokens.create(token)).toBe(true)
    expect(await store.tokens.create(token)).toBe(false)

    server.keepsInsertedIds = false
    await expect(store.tokens.create(sampleToken())).rejects.toThrow('CloudBase did not keep the document id given on insert')
  })

  it('pages through query results larger than the server page size', async () => {
    server = await new FakeCloudBaseServer(credentials, collections).start()
    server.pageLimit = 3
    const store = new CloudBaseMetadataStore({ envId: 'yunbox-test-1a2b3c', endpoint: server.origin, credentials: () => credentials })
    const tokens = Array.from({ length: 10 }, () => sampleToken())
    await Promise.all(tokens.map(token => store.tokens.create(token)))
    expect((await store.tokens.list()).map(token => token.id)).toEqual(tokens.map(token => token.id).sort())
    for (let index = 0; index < 5; index++)
      await store.audit.append({ action: 'token.create', at: `2026-10-17T00:00:0${index}.000Z` })
    expect((await store.audit.list({ limit: 4 })).map(event => event.at)).toEqual([4, 3, 2, 1].map(second => `2026-10-17T00:00:0${second}.000Z`))
  })

  it('validates settings without echoing them', () => {
    const create = (overrides: Record<string, string>): CloudBaseMetadataStore => new CloudBaseMetadataStore({
      envId: 'yunbox-test-1a2b3c',
      credentials: () => credentials,
      ...overrides,
    })
    expect(() => create({ envId: 'bad env!' })).toThrow('CloudBase environment id is malformed')
    expect(() => create({ endpoint: 'http://example.com' })).toThrow('CloudBase endpoint must use https')
    expect(() => create({ endpoint: 'https://example.com/path' })).toThrow('CloudBase endpoint must be an origin')
    expect(() => create({ collectionPrefix: 'a-b' })).toThrow(/collection prefix/)
    expect(create({}).description).toBe('CloudBase document database of environment yunbox-test-1a2b3c, collections yunbox_{tokens,grants,locks,audit}')
  })
})

describe('cloudBase wire formats', () => {
  it('signs with TC3-HMAC-SHA256 over the request path and appends timestamp and token', () => {
    const url = new URL('https://env-1.api.tcloudbasegateway.com/v1/database/instances/(default)/databases/(default)/collections/yunbox_tokens/documents?limit=1')
    const input = { method: 'GET', url, contentType: 'application/json', payload: '', timestamp: 1_760_000_000 }
    const header = signCloudBaseRequest(credentials, input)
    expect(header).toMatch(/^TC3-HMAC-SHA256 Credential=AKIDTESTTESTTESTTESTTESTTESTTEST\/2025-10-09\/tcb\/tc3_request, SignedHeaders=content-type;host, Signature=[a-f\d]{64}, Timestamp=1760000000, Token=temporary-session-token$/)
    // The signature depends on the path, query, payload and key.
    const signature = (value: string): string => /Signature=([a-f\d]+)/.exec(value)![1]!
    const variants = [
      signCloudBaseRequest(credentials, { ...input, url: new URL(url.href.replace('limit=1', 'limit=2')) }),
      signCloudBaseRequest(credentials, { ...input, url: new URL(url.href.replace('yunbox_tokens', 'yunbox_grants')) }),
      signCloudBaseRequest(credentials, { ...input, payload: '{}' }),
      signCloudBaseRequest({ ...credentials, secretKey: 'other' }, input),
    ]
    expect(new Set([signature(header), ...variants.map(signature)]).size).toBe(5)
    expect(signCloudBaseRequest({ secretId: 'id', secretKey: 'key' }, input)).not.toContain('Token=')
  })

  it('decodes Strict EJSON responses', () => {
    expect(fromEjson({
      count: { $numberInt: '3' },
      big: { $numberLong: '9007199254740991' },
      ratio: { $numberDouble: '0.5' },
      id: { $oid: '507f1f77bcf86cd799439011' },
      at: { $date: { $numberLong: '1736929200000' } },
      list: [{ $numberInt: '1' }, 'two'],
      nested: { keep: 'value' },
    })).toEqual({
      count: 3,
      big: 9_007_199_254_740_991,
      ratio: 0.5,
      id: '507f1f77bcf86cd799439011',
      at: '2025-01-15T08:20:00.000Z',
      list: [1, 'two'],
      nested: { keep: 'value' },
    })
  })
})
