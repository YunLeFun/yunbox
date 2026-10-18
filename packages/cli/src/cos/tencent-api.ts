// @env node

import type { CosCredentials } from '@yunbox/core'
import type { Buffer } from 'node:buffer'
import { createHash, createHmac } from 'node:crypto'

const CONTENT_TYPE = 'application/json; charset=utf-8'
const REQUEST_TIMEOUT_MS = 20_000

/** Error returned by a Tencent Cloud API 3.0 call. Messages never contain keys. */
export class TencentApiError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = 'TencentApiError'
    this.code = code
  }
}

/** Input for {@link signTc3}. */
export interface Tc3Request {
  credentials: Pick<CosCredentials, 'secretId' | 'secretKey'>
  service: string
  host: string
  action: string
  payload: string
  /** Unix seconds. */
  timestamp: number
}

/**
 * The `Authorization` header of a Tencent Cloud API 3.0 request
 * (TC3-HMAC-SHA256), signing `content-type`, `host` and `x-tc-action`.
 *
 * @see https://cloud.tencent.com/document/api/213/30654
 */
export function signTc3(request: Tc3Request): string {
  const date = new Date(request.timestamp * 1000).toISOString().slice(0, 10)
  const signedHeaders = 'content-type;host;x-tc-action'
  const canonicalRequest = [
    'POST',
    '/',
    '',
    `content-type:${CONTENT_TYPE}\nhost:${request.host}\nx-tc-action:${request.action.toLowerCase()}\n`,
    signedHeaders,
    sha256(request.payload),
  ].join('\n')
  const scope = `${date}/${request.service}/tc3_request`
  const stringToSign = ['TC3-HMAC-SHA256', String(request.timestamp), scope, sha256(canonicalRequest)].join('\n')
  const secretDate = hmac(`TC3${request.credentials.secretKey}`, date)
  const secretService = hmac(secretDate, request.service)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = createHmac('sha256', secretSigning).update(stringToSign).digest('hex')
  return `TC3-HMAC-SHA256 Credential=${request.credentials.secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

/** Options for {@link callTencentApi}. */
export interface TencentApiCall {
  credentials: CosCredentials
  service: string
  version: string
  action: string
  params: Record<string, unknown>
  /** Override the origin, for tests. Defaults to `https://<service>.tencentcloudapi.com`. */
  endpoint?: string
  region?: string
}

/**
 * Call a Tencent Cloud API 3.0 action and return its `Response` object.
 *
 * @throws {TencentApiError} with the API's error code (for example `AuthFailure.UnauthorizedOperation`).
 */
export async function callTencentApi<T>(call: TencentApiCall): Promise<T> {
  const origin = new URL(call.endpoint ?? `https://${call.service}.tencentcloudapi.com`)
  const payload = JSON.stringify(call.params)
  const timestamp = Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = {
    'Content-Type': CONTENT_TYPE,
    'X-TC-Action': call.action,
    'X-TC-Version': call.version,
    'X-TC-Timestamp': String(timestamp),
    'Authorization': signTc3({ credentials: call.credentials, service: call.service, host: origin.host, action: call.action, payload, timestamp }),
  }
  if (call.region !== undefined)
    headers['X-TC-Region'] = call.region
  if (call.credentials.sessionToken !== undefined)
    headers['X-TC-Token'] = call.credentials.sessionToken
  let response: Response
  try {
    response = await fetch(new URL('/', origin), { method: 'POST', headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  }
  catch (error) {
    throw new TencentApiError('NetworkError', `无法连接 ${origin.host}：${(error as Error).message}`)
  }
  let body: { Response?: T & { Error?: { Code: string, Message: string } } }
  try {
    body = await response.json() as typeof body
  }
  catch {
    throw new TencentApiError('InvalidResponse', `${origin.host} 返回了 HTTP ${response.status}，内容不是 JSON`)
  }
  const result = body.Response
  if (result === undefined)
    throw new TencentApiError('InvalidResponse', `${origin.host} 的响应里没有 Response`)
  if (result.Error !== undefined)
    throw new TencentApiError(result.Error.Code, result.Error.Message)
  return result
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function hmac(key: string | Buffer, text: string): Buffer {
  return createHmac('sha256', key).update(text).digest()
}
