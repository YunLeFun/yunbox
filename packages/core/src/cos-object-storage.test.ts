import type { CosObjectStorageOptions } from './cos-object-storage.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCosServer } from '../test/fake-cos-server.ts'
import { CosObjectStorage, CosRequestError } from './cos-object-storage.ts'

const credentials = {
  secretId: 'AKIDTESTTESTTESTTESTTESTTESTTEST',
  secretKey: 'test-secret-key-test-secret-key',
  sessionToken: 'session/token+with=symbols',
}
const repository = { owner: 'team', repo: 'assets' }

describe('storing objects in COS', () => {
  let cos: FakeCosServer

  beforeEach(async () => {
    cos = await new FakeCosServer(credentials).start()
  })

  afterEach(async () => {
    await cos.close()
  })

  function createStorage(overrides: Partial<CosObjectStorageOptions> = {}): CosObjectStorage {
    return new CosObjectStorage({
      bucket: 'assets-1250000000',
      region: 'ap-guangzhou',
      prefix: 'yunbox',
      endpoint: cos.origin,
      credentials,
      ...overrides,
    })
  }

  it('isolates repositories under the configured prefix', () => {
    const storage = createStorage()
    const oid = 'ab'.repeat(32)
    expect(storage.objectKey(repository, oid)).toBe(`yunbox/team/assets/ab/ab/${oid}`)
    expect(storage.objectKey({ owner: 'team', repo: 'other' }, oid)).toBe(`yunbox/team/other/ab/ab/${oid}`)
    expect(() => storage.objectKey({ owner: '..', repo: 'assets' }, oid)).toThrow()
    expect(() => createStorage({ prefix: 'a/../b' })).toThrow(TypeError)
    expect(() => createStorage({ bucket: 'no-appid' })).toThrow(TypeError)
    expect(() => createStorage({ endpoint: 'https://example.com/path' })).toThrow(TypeError)
  })

  it('uploads directly, verifies the size and binds the marker to the ETag', async () => {
    const storage = createStorage()
    const body = Buffer.from('first version')
    const object = { oid: sha256(body), size: body.byteLength }
    expect(await storage.inspectObject(repository, object.oid)).toBeUndefined()
    expect(await storage.verifyObject(repository, object.oid, object.size)).toEqual({ status: 'missing' })

    const upload = await storage.createUploadAction(repository, object, { expiresInSeconds: 300 })
    expect(upload.expires_in).toBe(300)
    expect(upload.href).toContain('x-cos-security-token=session%2Ftoken%2Bwith%3Dsymbols')
    expect((await fetch(upload.href, { method: 'PUT', body })).status).toBe(200)

    const unverified = await storage.inspectObject(repository, object.oid)
    expect(unverified).toMatchObject({ size: object.size, verified: false })
    expect(await storage.verifyObject(repository, object.oid, object.size + 1)).toEqual({ status: 'size-mismatch', actualSize: object.size })
    expect(await storage.verifyObject(repository, object.oid, object.size)).toEqual({ status: 'verified', actualSize: object.size })

    const verified = await storage.inspectObject(repository, object.oid)
    expect(verified).toEqual({ size: object.size, verified: true, version: unverified?.version })
    const download = await storage.createDownloadAction(repository, object, { expiresInSeconds: 300, stored: verified })
    const response = await fetch(download.href, { headers: download.header })
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body)
  })

  it('rejects an upload whose length differs from the presigned size', async () => {
    const storage = createStorage()
    const object = { oid: 'c'.repeat(64), size: 4 }
    const upload = await storage.createUploadAction(repository, object, { expiresInSeconds: 300 })
    expect((await fetch(upload.href, { method: 'PUT', body: 'too long' })).status).toBe(403)
    expect(await storage.inspectObject(repository, object.oid)).toBeUndefined()
  })

  it('invalidates verification and blocks stale downloads after an overwrite', async () => {
    const storage = createStorage()
    const object = { oid: 'd'.repeat(64), size: 4 }
    const upload = await storage.createUploadAction(repository, object, { expiresInSeconds: 300 })
    await fetch(upload.href, { method: 'PUT', body: 'good' })
    await storage.verifyObject(repository, object.oid, object.size)
    const download = await storage.createDownloadAction(repository, object, { expiresInSeconds: 300 })

    expect((await fetch(upload.href, { method: 'PUT', body: 'evil' })).status).toBe(200)
    expect(await storage.inspectObject(repository, object.oid)).toMatchObject({ verified: false })
    expect((await fetch(download.href, { headers: download.header })).status).toBe(412)
    expect((await fetch(download.href)).status).toBe(403)
  })

  it('refuses expired presigned URLs', async () => {
    const storage = createStorage({ now: () => Date.now() - 10 * 60_000 })
    const upload = await storage.createUploadAction(repository, { oid: 'e'.repeat(64), size: 1 }, { expiresInSeconds: 300 })
    expect((await fetch(upload.href, { method: 'PUT', body: 'x' })).status).toBe(403)
  })

  it('resolves rotating credentials for each signature', async () => {
    let calls = 0
    const storage = createStorage({
      credentials: () => {
        calls += 1
        return credentials
      },
    })
    await storage.inspectObject(repository, 'f'.repeat(64))
    await storage.createUploadAction(repository, { oid: 'f'.repeat(64), size: 1 }, { expiresInSeconds: 60 })
    expect(calls).toBe(3)
  })

  it('keeps private metadata documents in a namespace no repository can use', async () => {
    const storage = createStorage()
    expect(storage.metadataKey('tokens.json')).toBe('yunbox/_yunbox/tokens.json')
    expect(() => storage.metadataKey('../tokens.json')).toThrow(TypeError)
    expect(() => storage.objectKey({ owner: '_yunbox', repo: 'tokens.json' }, 'a'.repeat(64))).toThrow()

    expect(await storage.readMetadataDocument('tokens.json')).toBeUndefined()
    await storage.writeMetadataDocument('tokens.json', '{"version":1}\n')
    expect(await storage.readMetadataDocument('tokens.json')).toBe('{"version":1}\n')
    expect(cos.objects.get('yunbox/_yunbox/tokens.json')?.body.toString()).toBe('{"version":1}\n')
  })

  it('reports COS failures without leaking request URLs or keys', async () => {
    const storage = createStorage({ credentials: { ...credentials, secretKey: 'wrong-secret' } })
    const error = await storage.inspectObject(repository, 'a'.repeat(64)).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(CosRequestError)
    expect((error as CosRequestError).status).toBe(403)
    expect((error as Error).message).not.toMatch(/https?:\/\/|q-signature|secret|team\/assets/i)
  })
})

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
