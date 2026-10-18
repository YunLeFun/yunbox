// @env node

import type { CosCredentials } from './cos-signature.ts'
import { CosRequestError } from './cos-object-storage.ts'
import { createCosAuthorization } from './cos-signature.ts'

const SERVICE_ORIGIN = 'https://service.cos.myqcloud.com'
const BUCKET_PATTERN = /^[a-z\d][a-z\d-]{0,48}-\d{5,20}$/
const REGION_PATTERN = /^[a-z\d][a-z\d-]{1,40}$/
const REQUEST_TIMEOUT_MS = 15_000

/** A bucket owned by the account, from the COS GET Service API. */
export interface CosBucketSummary {
  /** Bucket name including the APPID suffix. */
  name: string
  region: string
  /** ISO 8601 creation time, when COS reports it. */
  createdAt?: string
}

/** Options shared by the account-level COS calls. */
export interface CosServiceOptions {
  credentials: CosCredentials
  /** Override the origin, for example a local test double. */
  endpoint?: string
  fetch?: typeof globalThis.fetch
  /** Clock used for signatures, in milliseconds. */
  now?: () => number
}

/**
 * List every bucket the credentials can see (COS GET Service).
 *
 * @see https://cloud.tencent.com/document/product/436/8291
 */
export async function listCosBuckets(options: CosServiceOptions): Promise<CosBucketSummary[]> {
  const response = await signedRequest('GET', options.endpoint ?? SERVICE_ORIGIN, options)
  const xml = await response.text()
  if (!response.ok)
    throw new CosRequestError('GET Service', response.status)
  const buckets: CosBucketSummary[] = []
  for (const match of xml.matchAll(/<Bucket>([\s\S]*?)<\/Bucket>/g)) {
    const name = xmlField(match[1]!, 'Name')
    const region = xmlField(match[1]!, 'Location')
    if (name !== undefined && region !== undefined)
      buckets.push({ name, region, createdAt: xmlField(match[1]!, 'CreationDate') })
  }
  return buckets.sort((left, right) => left.region.localeCompare(right.region) || left.name.localeCompare(right.name))
}

/**
 * Create a private bucket (COS PUT Bucket with `x-cos-acl: private`).
 *
 * @param bucket Full name including the APPID suffix.
 * @see https://cloud.tencent.com/document/product/436/7738
 */
export async function createCosBucket(bucket: string, region: string, options: CosServiceOptions): Promise<void> {
  if (!BUCKET_PATTERN.test(bucket))
    throw new TypeError('bucket must look like <name>-<appid>')
  if (!REGION_PATTERN.test(region))
    throw new TypeError('region is not a valid COS region')
  const response = await signedRequest('PUT', options.endpoint ?? `https://${bucket}.cos.${region}.myqcloud.com`, options, { 'x-cos-acl': 'private' })
  await response.body?.cancel()
  if (!response.ok)
    throw new CosRequestError('PUT Bucket', response.status)
}

/** The APPID suffix of a bucket name, for example `1250000000`. */
export function cosAppIdOf(bucket: string): string | undefined {
  return /-(\d{5,20})$/.exec(bucket)?.[1]
}

async function signedRequest(method: string, origin: string, options: CosServiceOptions, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const url = new URL('/', origin)
  const headers = { host: url.host, ...extraHeaders }
  const authorization = createCosAuthorization({
    credentials: options.credentials,
    method,
    pathname: '/',
    headers,
    startTime: Math.floor((options.now ?? Date.now)() / 1000) - 1,
    expiresInSeconds: 120,
  })
  const requestHeaders: Record<string, string> = { ...extraHeaders, authorization }
  if (options.credentials.sessionToken !== undefined)
    requestHeaders['x-cos-security-token'] = options.credentials.sessionToken
  return (options.fetch ?? globalThis.fetch)(url, {
    method,
    headers: requestHeaders,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}

function xmlField(xml: string, name: string): string | undefined {
  const value = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1]
  return value === undefined ? undefined : decodeXml(value)
}

function decodeXml(value: string): string {
  return value.replace(/&(lt|gt|quot|apos|amp);/g, (_, entity: string) => ({ lt: '<', gt: '>', quot: '"', apos: '\'', amp: '&' })[entity]!)
}
