import type { ServiceUrl } from './service-url.ts'
import { Buffer } from 'node:buffer'
import { LFS_JSON_MEDIA_TYPE } from '@yunbox/core'
import { CREDENTIAL_USERNAME } from './credentials.ts'

/**
 * Object the probes ask about: the SHA-256 of `yunbox doctor probe`. Asking
 * for it never writes anything; an upload batch only signs an upload URL.
 */
export const PROBE_OBJECT = {
  oid: '0a064abe845a8825acff88706339959763521d00c4f2c13111fdd74b7bf80781',
  size: 19,
} as const

const PROBE_TIMEOUT_MS = 15_000

/** Outcome of one batch request. */
export type ProbeResult
  = | { kind: 'response', status: number, lfs: boolean, message?: string, requestId?: string, location?: string, basicChallenge: boolean }
    | { kind: 'network-error', message: string }

/**
 * Send one Git LFS batch request for {@link PROBE_OBJECT}, the way git-lfs
 * would, optionally with the token as the HTTP Basic password.
 *
 * Redirects are not followed so the token is never sent to another origin.
 */
export async function probeBatch(service: ServiceUrl, operation: 'download' | 'upload', token?: string): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    'Accept': LFS_JSON_MEDIA_TYPE,
    'Content-Type': LFS_JSON_MEDIA_TYPE,
  }
  if (token !== undefined)
    headers.Authorization = `Basic ${Buffer.from(`${CREDENTIAL_USERNAME}:${token}`).toString('base64')}`
  let response: Response
  try {
    response = await fetch(`${service.url}/objects/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operation, transfers: ['basic'], objects: [PROBE_OBJECT] }),
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  }
  catch (error) {
    return { kind: 'network-error', message: describeNetworkError(error) }
  }
  const contentType = response.headers.get('content-type') ?? ''
  const lfs = contentType.includes('application/vnd.git-lfs+json') || contentType.includes('application/json')
  let message: string | undefined
  let requestId: string | undefined
  try {
    const text = await response.text()
    if (lfs && text !== '') {
      const body = JSON.parse(text) as { message?: unknown, request_id?: unknown }
      message = typeof body.message === 'string' ? body.message : undefined
      requestId = typeof body.request_id === 'string' ? body.request_id : undefined
    }
  }
  catch {}
  return {
    kind: 'response',
    status: response.status,
    lfs,
    basicChallenge: /basic/i.test(`${response.headers.get('lfs-authenticate') ?? ''} ${response.headers.get('www-authenticate') ?? ''}`),
    ...(message === undefined ? {} : { message }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(response.headers.has('location') ? { location: redactLocation(response.headers.get('location')!, service) } : {}),
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError')
    return `${PROBE_TIMEOUT_MS / 1000} 秒内没有响应`
  const cause = error instanceof Error ? (error.cause as { code?: unknown, message?: unknown } | undefined) : undefined
  const code = typeof cause?.code === 'string' ? cause.code : undefined
  switch (code) {
    case 'ECONNREFUSED':
      return '连接被拒绝（服务没有启动，或端口不对）'
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return '域名解析失败'
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return '连接超时'
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `HTTPS 证书无效（${code}）`
    default: {
      const detail = code ?? (typeof cause?.message === 'string' ? cause.message : error instanceof Error ? error.message : '')
      return detail === '' ? '网络请求失败' : `网络请求失败（${detail}）`
    }
  }
}

/** Show where a redirect points without its query string, which may carry signatures. */
function redactLocation(location: string, service: ServiceUrl): string {
  try {
    const url = new URL(location, service.url)
    return `${url.origin}${url.pathname}`
  }
  catch {
    return '（无法解析的地址）'
  }
}
