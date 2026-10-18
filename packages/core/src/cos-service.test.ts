import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCosServer } from '../test/fake-cos-server.ts'
import { CosObjectStorage, CosRequestError } from './cos-object-storage.ts'
import { cosAppIdOf, createCosBucket, listCosBuckets } from './cos-service.ts'

const credentials = {
  secretId: 'AKIDTESTTESTTESTTESTTESTTESTTEST',
  secretKey: 'test-secret-key-test-secret-key',
  sessionToken: 'session-token',
}

describe('managing COS buckets', () => {
  let cos: FakeCosServer

  beforeEach(async () => {
    cos = await new FakeCosServer(credentials).start()
  })

  afterEach(async () => {
    await cos.close()
  })

  it('lists the account buckets sorted by region and name', async () => {
    cos.buckets.push(
      { name: 'zeta-1250000000', region: 'ap-shanghai' },
      { name: 'assets-1250000000', region: 'ap-guangzhou' },
      { name: 'alpha-1250000000', region: 'ap-shanghai' },
    )
    const buckets = await listCosBuckets({ credentials, endpoint: cos.origin })
    expect(buckets.map(bucket => `${bucket.region}/${bucket.name}`)).toEqual([
      'ap-guangzhou/assets-1250000000',
      'ap-shanghai/alpha-1250000000',
      'ap-shanghai/zeta-1250000000',
    ])
    expect(buckets[0]?.createdAt).toBe('2026-01-01T00:00:00Z')
  })

  it('rejects bad credentials without leaking them', async () => {
    const error = await listCosBuckets({ credentials: { ...credentials, secretKey: 'wrong' }, endpoint: cos.origin }).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(CosRequestError)
    expect((error as CosRequestError).status).toBe(403)
    expect((error as Error).message).not.toMatch(/wrong|session-token/)
  })

  it('creates private buckets and validates names', async () => {
    await createCosBucket('yunbox-e2e-1250000000', 'ap-guangzhou', { credentials, endpoint: cos.origin })
    expect(cos.createdBucketAcls).toEqual(['private'])
    await expect(createCosBucket('no-appid', 'ap-guangzhou', { credentials, endpoint: cos.origin })).rejects.toThrow(TypeError)
    expect(cosAppIdOf('yunbox-e2e-1250000000')).toBe('1250000000')
    expect(cosAppIdOf('no-appid')).toBeUndefined()
  })

  it('probes write, read, inspect and delete access and leaves nothing behind', async () => {
    const storage = new CosObjectStorage({ bucket: 'assets-1250000000', region: 'ap-guangzhou', prefix: 'yunbox/game-a', endpoint: cos.origin, credentials })
    expect(await storage.probeAccess()).toEqual([
      { operation: 'PUT', ok: true, status: 200 },
      { operation: 'HEAD', ok: true, status: 200 },
      { operation: 'GET', ok: true, status: 200 },
      { operation: 'DELETE', ok: true, status: 204 },
    ])
    expect(cos.objects.size).toBe(0)
    expect(cos.requests.every(request => request.key.startsWith('yunbox/game-a/_yunbox/probe-'))).toBe(true)

    const denied = new CosObjectStorage({ bucket: 'assets-1250000000', region: 'ap-guangzhou', endpoint: cos.origin, credentials: { ...credentials, secretKey: 'wrong' } })
    expect(await denied.probeAccess()).toEqual([{ operation: 'PUT', ok: false, status: 403 }])
  })
})
