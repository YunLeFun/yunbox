import type { LfsAction, LfsBatchResponse } from '@yunbox/core'
import { Buffer } from 'node:buffer'
import { LFS_JSON_MEDIA_TYPE } from '@yunbox/core'
import { expect } from 'vitest'

/** `Authorization` header for a token, with an arbitrary user name as Git would send it. */
export function basicAuth(secret: string, user = 'anyone'): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}` }
}

export async function postJson(url: string, value: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': LFS_JSON_MEDIA_TYPE,
      'Content-Type': LFS_JSON_MEDIA_TYPE,
      ...headers,
    },
    body: JSON.stringify(value),
  })
}

export function batchRequest(
  baseUrl: string,
  repository: string,
  operation: 'upload' | 'download',
  oid: string,
  size: number,
  headers: Record<string, string> = {},
): Promise<Response> {
  return postJson(`${baseUrl}/${repository}/objects/batch`, {
    operation,
    transfers: ['basic'],
    objects: [{ oid, size }],
  }, headers)
}

export async function batch(
  baseUrl: string,
  repository: string,
  operation: 'upload' | 'download',
  oid: string,
  size: number,
  headers: Record<string, string> = {},
): Promise<LfsBatchResponse> {
  const response = await batchRequest(baseUrl, repository, operation, oid, size, headers)
  expect(response.status).toBe(200)
  return await response.json() as LfsBatchResponse
}

export function getAction(response: LfsBatchResponse, action: 'upload' | 'download' | 'verify'): LfsAction {
  const result = response.objects[0]?.actions?.[action]
  expect(result).toBeDefined()
  return result as LfsAction
}

/** Assert the unified error format: LFS JSON with a message and a request id. */
export async function expectLfsError(response: Response, status: number, message?: RegExp): Promise<void> {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toBe(LFS_JSON_MEDIA_TYPE)
  const body = await response.json() as { message?: unknown, request_id?: unknown }
  expect(body.message).toEqual(expect.any(String))
  expect(body.request_id).toEqual(expect.stringMatching(/^[\da-f-]{36}$/))
  if (message !== undefined)
    expect(body.message).toMatch(message)
}
