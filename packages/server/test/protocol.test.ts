import type { RunningYunBoxServer, YunBoxServerOptions } from '../src/types.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { LocalFileObjectStorage, MAX_OBJECT_SIZE } from '@yunbox/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LFS_AUTHENTICATE } from '../src/request-handler.ts'
import { startYunBoxServer } from '../src/server.ts'
import { createToken, revokeToken } from '../src/tokens.ts'
import { basicAuth, batch, batchRequest, expectLfsError, getAction, postJson } from './http-helpers.ts'
import { MemoryMetadataStore } from './memory-metadata.ts'

describe('git LFS HTTP protocol', () => {
  let directory: string
  let metadata: MemoryMetadataStore
  let running: RunningYunBoxServer | undefined
  let writer: Record<string, string>

  async function start(overrides: Partial<YunBoxServerOptions> = {}): Promise<RunningYunBoxServer> {
    await running?.close()
    running = await startYunBoxServer({
      storage: new LocalFileObjectStorage(directory),
      metadata,
      port: 0,
      ...overrides,
    })
    return running
  }

  async function uploadVerified(server: RunningYunBoxServer, repository: string, oid: string, body: string): Promise<void> {
    const response = await batch(server.url, repository, 'upload', oid, body.length, writer)
    expect((await fetch(getAction(response, 'upload').href, { method: 'PUT', body, headers: writer })).status).toBe(200)
    expect((await postJson(getAction(response, 'verify').href, { oid, size: body.length }, writer)).status).toBe(200)
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'yunbox-protocol-test-'))
    metadata = new MemoryMetadataStore()
    writer = basicAuth((await createToken(metadata, { name: 'writer', repos: { 'team/*': 'write' } })).secret)
  })

  afterEach(async () => {
    await running?.close()
    running = undefined
    await rm(directory, { recursive: true, force: true })
  })

  it('requires verify before download and rejects a size mismatch', async () => {
    const server = await start()
    const oid = 'a'.repeat(64)
    const uploadBatch = await batch(server.url, 'team/assets', 'upload', oid, 4, writer)
    const upload = getAction(uploadBatch, 'upload')
    const verify = getAction(uploadBatch, 'verify')

    expect(upload.expires_in).toBe(300)
    expect((await fetch(upload.href, { method: 'PUT', body: 'abc', headers: writer })).status).toBe(200)
    const mismatch = await postJson(verify.href, { oid, size: 4 }, writer)
    await expectLfsError(mismatch, 422, /size mismatch/)

    const unavailable = await batch(server.url, 'team/assets', 'download', oid, 4, writer)
    expect(unavailable.objects[0]?.error).toEqual({
      code: 404,
      message: 'Object is not available for download',
    })

    expect((await fetch(upload.href, { method: 'PUT', body: 'data', headers: writer })).status).toBe(200)
    expect((await postJson(verify.href, { oid, size: 4 }, writer)).status).toBe(200)
    const downloadBatch = await batch(server.url, 'team/assets', 'download', oid, 4, writer)
    const download = getAction(downloadBatch, 'download')
    const downloaded = await fetch(download.href, { headers: writer })
    expect(downloaded.status).toBe(200)
    await expect(downloaded.text()).resolves.toBe('data')
  })

  it('keeps objects isolated by repository and makes upload idempotent', async () => {
    const server = await start()
    const oid = 'b'.repeat(64)
    await uploadVerified(server, 'team/one', oid, 'hello')

    const repeated = await batch(server.url, 'team/one', 'upload', oid, 5, writer)
    expect(repeated.objects[0]?.actions).toBeUndefined()
    const otherRepository = await batch(server.url, 'team/two', 'download', oid, 5, writer)
    expect(otherRepository.objects[0]?.error?.code).toBe(404)

    const download = getAction(await batch(server.url, 'team/one', 'download', oid, 5, writer), 'download')
    const tampered = new URL(download.href)
    tampered.searchParams.set('size', '4')
    await expectLfsError(await fetch(tampered, { headers: writer }), 403, /signature/)
  })

  it('rejects invalid object and repository input with LFS JSON errors', async () => {
    const server = await start()
    const invalidOid = await postJson(`${server.url}/team/assets/objects/batch`, {
      operation: 'upload',
      transfers: ['basic'],
      objects: [{ oid: '../object', size: 1 }],
    }, writer)
    await expectLfsError(invalidOid, 422)

    const oversized = await postJson(`${server.url}/team/assets/objects/batch`, {
      operation: 'upload',
      objects: [{ oid: 'c'.repeat(64), size: MAX_OBJECT_SIZE + 1 }],
    }, writer)
    await expectLfsError(oversized, 422)

    const traversal = await postJson(`${server.url}/bad%2Fowner/assets/objects/batch`, {
      operation: 'download',
      objects: [],
    }, writer)
    await expectLfsError(traversal, 422)
  })

  it('asks for credentials with 401 and LFS-Authenticate on every endpoint', async () => {
    const server = await start()
    const oid = 'd'.repeat(64)
    const uploadBatch = await batch(server.url, 'team/assets', 'upload', oid, 4, writer)
    const upload = getAction(uploadBatch, 'upload')

    const attempts = [
      batchRequest(server.url, 'team/assets', 'upload', oid, 4),
      batchRequest(server.url, 'team/assets', 'upload', oid, 4, basicAuth('ybx_not-a-real-token')),
      batchRequest(server.url, 'team/assets', 'upload', oid, 4, { Authorization: 'Bearer something' }),
      postJson(getAction(uploadBatch, 'verify').href, { oid, size: 4 }),
      fetch(upload.href, { method: 'PUT', body: 'data' }),
      fetch(upload.href),
    ]
    for (const response of await Promise.all(attempts)) {
      expect(response.headers.get('lfs-authenticate')).toBe(LFS_AUTHENTICATE)
      await expectLfsError(response, 401, /Credentials are missing or invalid/)
    }
    expect(await new LocalFileObjectStorage(directory).inspectObject({ owner: 'team', repo: 'assets' }, oid)).toBeUndefined()
  })

  it('enforces read and write permissions with owner wildcards', async () => {
    const server = await start()
    const reader = basicAuth((await createToken(metadata, { name: 'reader', repos: { 'team/*': 'read' } })).secret)
    const mixed = basicAuth((await createToken(metadata, {
      name: 'mixed',
      repos: { 'team/*': 'write', 'team/locked': 'read' },
    })).secret)
    const oid = 'e'.repeat(64)
    await uploadVerified(server, 'team/assets', oid, 'data')

    await expectLfsError(await batchRequest(server.url, 'team/assets', 'upload', oid, 4, reader), 403, /read-only/)
    const downloaded = await batch(server.url, 'team/assets', 'download', oid, 4, reader)
    const download = getAction(downloaded, 'download')
    expect((await fetch(download.href, { headers: reader })).status).toBe(200)
    await expectLfsError(await batchRequest(server.url, 'other/assets', 'download', oid, 4, reader), 403, /no access/)
    await expectLfsError(await postJson(`${server.url}/team/assets/objects/verify`, { oid, size: 4 }, reader), 403)

    // A writer's upload URL is useless to a reader: the transfer itself needs write access.
    const upload = getAction(await batch(server.url, 'team/fresh', 'upload', oid, 4, writer), 'upload')
    await expectLfsError(await fetch(upload.href, { method: 'PUT', body: 'data', headers: reader }), 403)

    // An exact repository entry overrides the owner wildcard.
    await expectLfsError(await batchRequest(server.url, 'team/locked', 'upload', oid, 4, mixed), 403, /read-only/)
    expect((await batchRequest(server.url, 'team/other', 'upload', oid, 4, mixed)).status).toBe(200)
  })

  it('stops accepting a revoked token after the cache TTL, including on signed URLs', async () => {
    const server = await start({ tokenCacheTtlSeconds: 1 })
    const created = await createToken(metadata, { name: 'temporary', repos: { 'team/assets': 'write' } })
    const temporary = basicAuth(created.secret)
    const oid = 'f'.repeat(64)
    const upload = getAction(await batch(server.url, 'team/assets', 'upload', oid, 4, temporary), 'upload')

    await revokeToken(metadata, created.token.id)
    await delay(1100)
    await expectLfsError(await batchRequest(server.url, 'team/assets', 'upload', oid, 4, temporary), 401)
    await expectLfsError(await fetch(upload.href, { method: 'PUT', body: 'data', headers: temporary }), 401)
    expect((await batchRequest(server.url, 'team/assets', 'upload', oid, 4, writer)).status).toBe(200)
  })

  it('expires actions relative to the token snapshot that authorized them', async () => {
    const server = await start({ actionTtlSeconds: 5, tokenCacheTtlSeconds: 3 })
    const oid = '1'.repeat(64)
    const fresh = getAction(await batch(server.url, 'team/assets', 'upload', oid, 4, writer), 'upload')
    expect(fresh.expires_in).toBe(5)
    await delay(1200)
    const cached = getAction(await batch(server.url, 'team/assets', 'upload', oid, 4, writer), 'upload')
    expect(cached.expires_in).toBeLessThanOrEqual(4)
    expect(Number(new URL(cached.href).searchParams.get('expires'))).toBe(Number(new URL(fresh.href).searchParams.get('expires')))
  })

  it('refuses expired tokens and never issues actions that outlive a token', async () => {
    const server = await start()
    const shortLived = await createToken(metadata, { name: 'short', repos: { 'team/assets': 'write' }, lifetimeMs: 3000 })
    const auth = basicAuth(shortLived.secret)
    const oid = '4'.repeat(64)
    const upload = getAction(await batch(server.url, 'team/assets', 'upload', oid, 4, auth), 'upload')
    expect(upload.expires_in).toBeGreaterThan(0)
    expect(upload.expires_in).toBeLessThanOrEqual(3)
    await delay(3100)
    await expectLfsError(await batchRequest(server.url, 'team/assets', 'upload', oid, 4, auth), 401)
    await expectLfsError(await fetch(upload.href, { method: 'PUT', body: 'data', headers: auth }), 401)
  })

  it('fails closed with 503 when the token store cannot be read', async () => {
    const server = await start({ tokenCacheTtlSeconds: 0 })
    metadata.failReads = true
    const response = await batchRequest(server.url, 'team/assets', 'download', '2'.repeat(64), 1, writer)
    expect(response.headers.get('retry-after')).toBe('5')
    await expectLfsError(response, 503, /temporarily unavailable/)
  })

  it('builds action and verify URLs from publicUrl and refuses unsafe listen settings', async () => {
    const server = await start({ publicUrl: 'https://lfs.example.com' })
    expect(server.publicUrl).toBe('https://lfs.example.com')
    const response = await batch(server.url, 'team/assets', 'upload', '3'.repeat(64), 4, writer)
    expect(getAction(response, 'upload').href).toMatch(/^https:\/\/lfs\.example\.com\/team\/assets\/objects\/3{64}\?/)
    expect(getAction(response, 'verify').href).toBe('https://lfs.example.com/team/assets/objects/verify')

    const storage = new LocalFileObjectStorage(directory)
    await expect(startYunBoxServer({ storage, metadata, host: '0.0.0.0', port: 0 })).rejects.toThrow(/publicUrl \(https\) is required/)
    await expect(startYunBoxServer({ storage, metadata, host: '0.0.0.0', port: 0, publicUrl: 'http://lfs.example.com' }))
      .rejects
      .toThrow(/must use https/)
    await expect(startYunBoxServer({ storage, metadata, host: '::', port: 0, publicUrl: 'https://lfs.example.com/base' }))
      .rejects
      .toThrow(/origin without/)
    await expect(startYunBoxServer({ storage, metadata, port: 0, actionTtlSeconds: 30, tokenCacheTtlSeconds: 30 }))
      .rejects
      .toThrow(RangeError)
  })
})
