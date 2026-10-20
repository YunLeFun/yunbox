// @env node

import { createHash, createHmac } from 'node:crypto'

/** Access keys for an S3-compatible service (AWS S3, Cloudflare R2, MinIO, …). */
export interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
  /** Session token of temporary credentials, sent as `x-amz-security-token`. */
  sessionToken?: string
}

/**
 * Payload hash that tells the service not to check the body. Valid for S3
 * over HTTPS; YunBox signs the real hash instead whenever it knows it.
 */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

/** Hex SHA-256 of the empty body, the payload hash of GET and HEAD. */
export const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** Input for an AWS Signature Version 4 `Authorization` header. */
export interface SigV4Options {
  credentials: S3Credentials
  method: string
  /** Raw path starting with `/`, without URL encoding; each segment is encoded once, as S3 expects. */
  path: string
  /** Query parameters, unencoded. */
  query?: Record<string, string>
  /** Headers to sign and send, including `host`. Names are matched case-insensitively. */
  headers: Record<string, string>
  /** Hex SHA-256 of the body, or {@link UNSIGNED_PAYLOAD}. */
  payloadHash: string
  region: string
  /** `s3` for object storage. */
  service: string
  date: Date
  /**
   * Also send and sign `x-amz-content-sha256` with the payload hash. S3
   * requires it; the generic test suite of other services does not use it.
   * Defaults to true.
   */
  contentSha256Header?: boolean
}

/** A signed request and the intermediate strings, for tests. */
export interface SigV4Result {
  /** Every header to send: the input headers plus `x-amz-date`, the optional ones and `authorization`. */
  headers: Record<string, string>
  canonicalRequest: string
  stringToSign: string
  signature: string
}

/**
 * Sign a request with AWS Signature Version 4 (`AWS4-HMAC-SHA256`) in the
 * `Authorization` header. Signing never logs or returns the secret.
 *
 * @see https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 */
export function signSigV4(options: SigV4Options): SigV4Result {
  const amzDate = options.date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(options.headers))
    headers[name.toLowerCase()] = value
  headers['x-amz-date'] = amzDate
  if (options.contentSha256Header ?? true)
    headers['x-amz-content-sha256'] = options.payloadHash
  if (options.credentials.sessionToken !== undefined)
    headers['x-amz-security-token'] = options.credentials.sessionToken

  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(';')
  const canonicalRequest = [
    options.method.toUpperCase(),
    options.path.split('/').map(awsUriEncode).join('/'),
    Object.entries(options.query ?? {})
      .map(([key, value]): [string, string] => [awsUriEncode(key), awsUriEncode(value)])
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => compare(leftKey, rightKey) || compare(leftValue, rightValue))
      .map(([key, value]) => `${key}=${value}`)
      .join('&'),
    ...names.map(name => `${name}:${headers[name]!.trim().replace(/ +/g, ' ')}`),
    '',
    signedHeaders,
    options.payloadHash,
  ].join('\n')
  const scope = `${day}/${options.region}/${options.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n')
  let key: Uint8Array | string = `AWS4${options.credentials.secretAccessKey}`
  for (const part of [day, options.region, options.service, 'aws4_request'])
    key = createHmac('sha256', key).update(part).digest()
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex')
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return { headers, canonicalRequest, stringToSign, signature }
}

/** URI-encode one path segment or query component the SigV4 way: everything but `A-Z a-z 0-9 - _ . ~`. */
export function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
