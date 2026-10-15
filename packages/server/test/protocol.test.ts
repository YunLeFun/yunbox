import type { LfsAction, LfsBatchResponse } from '@yunbox/core'
import type { RunningYunBoxServer } from '../src/types.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LFS_JSON_MEDIA_TYPE, LocalFileObjectStorage, MAX_OBJECT_SIZE } from '@yunbox/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startYunBoxServer } from '../src/server.ts'

describe('git LFS HTTP protocol', () => {
  let directory: string
  let running: RunningYunBoxServer

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'yunbox-protocol-test-'))
    running = await startYunBoxServer({
      storage: new LocalFileObjectStorage(directory),
      port: 0,
    })
  })

  afterEach(async () => {
    await running.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('requires verify before download and rejects a size mismatch', async () => {
    const oid = 'a'.repeat(64)
    const uploadBatch = await batch(running.url, 'team', 'assets', 'upload', oid, 4)
    const upload = getAction(uploadBatch, 'upload')
    const verify = getAction(uploadBatch, 'verify')

    expect(upload.expires_in).toBe(300)
    expect((await fetch(upload.href, { method: 'PUT', body: 'abc' })).status).toBe(200)
    const mismatch = await postJson(verify.href, { oid, size: 4 })
    expect(mismatch.status).toBe(422)
    await expect(mismatch.json()).resolves.toMatchObject({ message: expect.stringContaining('size mismatch') })

    const unavailable = await batch(running.url, 'team', 'assets', 'download', oid, 4)
    expect(unavailable.objects[0]?.error).toEqual({
      code: 404,
      message: 'Object is not available for download',
    })

    expect((await fetch(upload.href, { method: 'PUT', body: 'data' })).status).toBe(200)
    expect((await postJson(verify.href, { oid, size: 4 })).status).toBe(200)
    const downloadBatch = await batch(running.url, 'team', 'assets', 'download', oid, 4)
    const download = getAction(downloadBatch, 'download')
    const downloaded = await fetch(download.href)
    expect(downloaded.status).toBe(200)
    await expect(downloaded.text()).resolves.toBe('data')
  })

  it('keeps objects isolated by repository and makes upload idempotent', async () => {
    const oid = 'b'.repeat(64)
    const firstBatch = await batch(running.url, 'team', 'one', 'upload', oid, 5)
    const upload = getAction(firstBatch, 'upload')
    const verify = getAction(firstBatch, 'verify')
    await fetch(upload.href, { method: 'PUT', body: 'hello' })
    await postJson(verify.href, { oid, size: 5 })

    const repeated = await batch(running.url, 'team', 'one', 'upload', oid, 5)
    expect(repeated.objects[0]?.actions).toBeUndefined()
    const otherRepository = await batch(running.url, 'team', 'two', 'download', oid, 5)
    expect(otherRepository.objects[0]?.error?.code).toBe(404)

    const download = getAction(await batch(running.url, 'team', 'one', 'download', oid, 5), 'download')
    const tampered = new URL(download.href)
    tampered.searchParams.set('size', '4')
    expect((await fetch(tampered)).status).toBe(403)
  })

  it('rejects invalid object and repository input with LFS JSON errors', async () => {
    const invalidOid = await postJson(`${running.url}/team/assets/objects/batch`, {
      operation: 'upload',
      transfers: ['basic'],
      objects: [{ oid: '../object', size: 1 }],
    })
    expect(invalidOid.status).toBe(422)
    expect(invalidOid.headers.get('content-type')).toBe(LFS_JSON_MEDIA_TYPE)
    await expect(invalidOid.json()).resolves.toMatchObject({ message: expect.any(String) })

    const oversized = await postJson(`${running.url}/team/assets/objects/batch`, {
      operation: 'upload',
      objects: [{ oid: 'c'.repeat(64), size: MAX_OBJECT_SIZE + 1 }],
    })
    expect(oversized.status).toBe(422)

    const traversal = await postJson(`${running.url}/bad%2Fowner/assets/objects/batch`, {
      operation: 'download',
      objects: [],
    })
    expect(traversal.status).toBe(422)
  })
})

async function batch(
  baseUrl: string,
  owner: string,
  repo: string,
  operation: 'upload' | 'download',
  oid: string,
  size: number,
): Promise<LfsBatchResponse> {
  const response = await postJson(`${baseUrl}/${owner}/${repo}/objects/batch`, {
    operation,
    transfers: ['basic'],
    objects: [{ oid, size }],
  })
  expect(response.status).toBe(200)
  return await response.json() as LfsBatchResponse
}

async function postJson(url: string, value: unknown): Promise<Response> {
  return await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': LFS_JSON_MEDIA_TYPE,
      'Content-Type': LFS_JSON_MEDIA_TYPE,
    },
    body: JSON.stringify(value),
  })
}

function getAction(response: LfsBatchResponse, action: 'upload' | 'download' | 'verify'): LfsAction {
  const result = response.objects[0]?.actions?.[action]
  expect(result).toBeDefined()
  return result as LfsAction
}
