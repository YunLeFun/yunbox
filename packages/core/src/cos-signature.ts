// @env node

import { createHash, createHmac } from 'node:crypto'

/** Tencent Cloud API credentials used to sign COS requests. */
export interface CosCredentials {
  secretId: string
  secretKey: string
  /** Session token for temporary credentials, such as a bound runtime role. */
  sessionToken?: string
}

/** Input for a COS XML API v5 request signature. */
export interface CosSignatureOptions {
  credentials: CosCredentials
  method: string
  /** Raw object path starting with `/`, without URL encoding. */
  pathname: string
  /** Query parameters covered by the signature. */
  query?: Record<string, string>
  /** Request headers covered by the signature; the client must send them unchanged. */
  headers?: Record<string, string>
  /** Signature start time in Unix seconds. */
  startTime: number
  expiresInSeconds: number
}

/**
 * Create a COS XML API v5 `Authorization` value.
 *
 * The same string is used as an `Authorization` header or appended as the
 * query string of a presigned URL.
 *
 * @see https://cloud.tencent.com/document/product/436/7778
 */
export function createCosAuthorization(options: CosSignatureOptions): string {
  const keyTime = `${options.startTime};${options.startTime + options.expiresInSeconds}`
  const query = canonicalPairs(options.query ?? {})
  const headers = canonicalPairs(options.headers ?? {})
  const httpString = [
    options.method.toLowerCase(),
    options.pathname,
    query.map(([key, value]) => `${key}=${value}`).join('&'),
    headers.map(([key, value]) => `${key}=${value}`).join('&'),
    '',
  ].join('\n')
  const signKey = createHmac('sha1', options.credentials.secretKey).update(keyTime).digest('hex')
  const stringToSign = ['sha1', keyTime, createHash('sha1').update(httpString).digest('hex'), ''].join('\n')
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex')
  return [
    'q-sign-algorithm=sha1',
    `q-ak=${options.credentials.secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headers.map(([key]) => key).join(';')}`,
    `q-url-param-list=${query.map(([key]) => key).join(';')}`,
    `q-signature=${signature}`,
  ].join('&')
}

/** URL-encode a value the way COS canonicalizes signed keys and values. */
export function cosEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function canonicalPairs(values: Record<string, string>): Array<[string, string]> {
  return Object.entries(values)
    .map(([key, value]): [string, string] => [cosEncode(key).toLowerCase(), cosEncode(value)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
}
