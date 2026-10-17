// @env node

import type { CosCredentials } from './cos-signature.ts'
import type {
  CreateStorageActionOptions,
  LfsAction,
  LfsObject,
  ObjectStorage,
  RepositoryId,
  StorageVerificationResult,
  StoredObjectInfo,
} from './types.ts'
import { cosEncode, createCosAuthorization } from './cos-signature.ts'
import { assertOid, assertRepository } from './validation.ts'

const BUCKET_PATTERN = /^[a-z\d][a-z\d-]{0,48}-\d{5,20}$/
const REGION_PATTERN = /^[a-z\d][a-z\d-]{1,40}$/
const PREFIX_SEGMENT_PATTERN = /^[\w.-]+$/
const DEFAULT_MAX_CONCURRENT_REQUESTS = 16
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
/** Server-side COS requests are signed for a short window to tolerate clock skew. */
const REQUEST_SIGNATURE_TTL_SECONDS = 120

/** Credentials, or a provider called before each signature so temporary keys can rotate. */
export type CosCredentialSource = CosCredentials | (() => CosCredentials | Promise<CosCredentials>)

/** Configuration for {@link CosObjectStorage}. */
export interface CosObjectStorageOptions {
  /** Bucket name including the APPID suffix, for example `assets-1250000000`. */
  bucket: string
  /** Bucket region, for example `ap-guangzhou`. */
  region: string
  credentials: CosCredentialSource
  /** Optional key prefix such as `yunbox/` shared by every repository. */
  prefix?: string
  /** Override the bucket origin, for example a local test double. Defaults to the public COS origin. */
  endpoint?: string
  maxConcurrentRequests?: number
  requestTimeoutMs?: number
  /** Clock used for signatures, in milliseconds. */
  now?: () => number
  fetch?: typeof globalThis.fetch
}

/** Error raised when COS rejects a server-side request. The message never contains signed URLs. */
export class CosRequestError extends Error {
  readonly status: number

  constructor(operation: string, status: number) {
    super(`COS ${operation} request failed with HTTP ${status}`)
    this.name = 'CosRequestError'
    this.status = status
  }
}

interface VerificationMarker {
  oid: string
  size: number
  etag: string
  verifiedAt: string
}

interface ObjectHead {
  size: number
  etag: string
}

/**
 * Tencent Cloud COS object storage with presigned direct transfers.
 *
 * Git LFS clients upload and download object bytes directly from COS. The
 * server only signs short-lived URLs, checks object metadata and keeps a
 * verification marker next to each object. A marker records the ETag that was
 * verified, so any later overwrite invalidates it, and download URLs carry a
 * signed `If-Match` header so COS refuses to serve replaced bytes.
 */
export class CosObjectStorage implements ObjectStorage {
  readonly #origin: URL
  readonly #prefix: string
  readonly #credentials: CosCredentialSource
  readonly #requestTimeoutMs: number
  readonly #now: () => number
  readonly #fetch: typeof globalThis.fetch
  readonly #slots: RequestSlots

  constructor(options: CosObjectStorageOptions) {
    if (!BUCKET_PATTERN.test(options.bucket))
      throw new TypeError('bucket must look like <name>-<appid>')
    if (!REGION_PATTERN.test(options.region))
      throw new TypeError('region is not a valid COS region')
    this.#origin = new URL(options.endpoint ?? `https://${options.bucket}.cos.${options.region}.myqcloud.com`)
    if (this.#origin.pathname !== '/' || this.#origin.search !== '' || this.#origin.hash !== '')
      throw new TypeError('endpoint must be an origin without a path, query or fragment')
    this.#prefix = normalizePrefix(options.prefix ?? '')
    this.#credentials = options.credentials
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.#now = options.now ?? Date.now
    this.#fetch = options.fetch ?? globalThis.fetch
    this.#slots = new RequestSlots(options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS)
  }

  /** Resolve the repository-isolated COS key for an object. */
  objectKey(repository: RepositoryId, oid: string): string {
    assertRepository(repository)
    assertOid(oid)
    return `${this.#prefix}${repository.owner}/${repository.repo}/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`
  }

  /** Inspect object size and whether its current ETag has a verification marker. */
  async inspectObject(repository: RepositoryId, oid: string): Promise<StoredObjectInfo | undefined> {
    const key = this.objectKey(repository, oid)
    const [head, marker] = await Promise.all([this.#head(key), this.#readMarker(markerKey(key))])
    if (head === undefined)
      return undefined
    return {
      size: head.size,
      verified: marker?.oid === oid && marker.size === head.size && marker.etag === head.etag,
      version: head.etag,
    }
  }

  /** Compare the stored size, then persist a marker bound to the verified ETag. */
  async verifyObject(
    repository: RepositoryId,
    oid: string,
    expectedSize: number,
  ): Promise<StorageVerificationResult> {
    const key = this.objectKey(repository, oid)
    const first = await this.#head(key)
    if (first === undefined)
      return { status: 'missing' }
    if (first.size !== expectedSize)
      return { status: 'size-mismatch', actualSize: first.size }

    const marker: VerificationMarker = { oid, size: first.size, etag: first.etag, verifiedAt: new Date(this.#now()).toISOString() }
    await this.#writeMarker(markerKey(key), marker)

    const second = await this.#head(key)
    if (second === undefined) {
      await this.#deleteMarker(markerKey(key))
      return { status: 'missing' }
    }
    if (second.size !== first.size || second.etag !== first.etag) {
      await this.#deleteMarker(markerKey(key))
      return { status: 'changed', actualSize: second.size }
    }
    return { status: 'verified', actualSize: second.size }
  }

  /** Presign a direct PUT whose signature also pins the exact `Content-Length`. */
  async createUploadAction(
    repository: RepositoryId,
    object: LfsObject,
    options: CreateStorageActionOptions,
  ): Promise<LfsAction> {
    const key = this.objectKey(repository, object.oid)
    return {
      href: await this.#presign('PUT', key, { 'content-length': String(object.size) }, options.expiresInSeconds),
      expires_in: options.expiresInSeconds,
    }
  }

  /** Presign a direct GET that COS only serves while the object still has the verified ETag. */
  async createDownloadAction(
    repository: RepositoryId,
    object: LfsObject,
    options: CreateStorageActionOptions,
  ): Promise<LfsAction> {
    const key = this.objectKey(repository, object.oid)
    let etag = options.stored?.version
    if (etag === undefined) {
      const head = await this.#head(key)
      if (head === undefined)
        throw new CosRequestError('HEAD', 404)
      etag = head.etag
    }
    return {
      href: await this.#presign('GET', key, { 'if-match': etag }, options.expiresInSeconds),
      header: { 'If-Match': etag },
      expires_in: options.expiresInSeconds,
    }
  }

  async #head(key: string): Promise<ObjectHead | undefined> {
    const response = await this.#request('HEAD', key)
    if (response.status === 404)
      return undefined
    if (!response.ok)
      throw new CosRequestError('HEAD', response.status)
    const size = Number(response.headers.get('content-length'))
    const etag = response.headers.get('etag')
    if (!Number.isSafeInteger(size) || size < 0 || etag === null || etag === '')
      throw new CosRequestError('HEAD', 502)
    return { size, etag }
  }

  async #readMarker(key: string): Promise<VerificationMarker | undefined> {
    const response = await this.#request('GET', key)
    if (response.status === 404) {
      await response.body?.cancel()
      return undefined
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new CosRequestError('GET', response.status)
    }
    try {
      const value = JSON.parse(await response.text()) as Partial<VerificationMarker> | null
      if (typeof value?.oid !== 'string'
        || typeof value.size !== 'number'
        || typeof value.etag !== 'string'
        || typeof value.verifiedAt !== 'string') {
        return undefined
      }
      return value as VerificationMarker
    }
    catch (error) {
      if (error instanceof SyntaxError)
        return undefined
      throw error
    }
  }

  async #writeMarker(key: string, marker: VerificationMarker): Promise<void> {
    const response = await this.#request('PUT', key, `${JSON.stringify(marker)}\n`)
    await response.body?.cancel()
    if (!response.ok)
      throw new CosRequestError('PUT', response.status)
  }

  async #deleteMarker(key: string): Promise<void> {
    const response = await this.#request('DELETE', key)
    await response.body?.cancel()
    if (!response.ok && response.status !== 404)
      throw new CosRequestError('DELETE', response.status)
  }

  async #request(method: string, key: string, body?: string): Promise<Response> {
    const credentials = await this.#resolveCredentials()
    const headers: Record<string, string> = { host: this.#origin.host }
    if (body !== undefined)
      headers['content-type'] = 'application/json'
    const authorization = createCosAuthorization({
      credentials,
      method,
      pathname: `/${key}`,
      headers,
      startTime: this.#startTime(),
      expiresInSeconds: REQUEST_SIGNATURE_TTL_SECONDS,
    })
    const requestHeaders: Record<string, string> = { ...headers, authorization }
    delete requestHeaders.host
    if (credentials.sessionToken !== undefined)
      requestHeaders['x-cos-security-token'] = credentials.sessionToken

    const release = await this.#slots.acquire()
    try {
      return await this.#fetch(this.#url(key), {
        method,
        headers: requestHeaders,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      })
    }
    finally {
      release()
    }
  }

  async #presign(method: 'GET' | 'PUT', key: string, signedHeaders: Record<string, string>, expiresInSeconds: number): Promise<string> {
    const credentials = await this.#resolveCredentials()
    const authorization = createCosAuthorization({
      credentials,
      method,
      pathname: `/${key}`,
      headers: { host: this.#origin.host, ...signedHeaders },
      startTime: this.#startTime(),
      expiresInSeconds,
    })
    let href = `${this.#url(key)}?${authorization}`
    if (credentials.sessionToken !== undefined)
      href += `&x-cos-security-token=${cosEncode(credentials.sessionToken)}`
    return href
  }

  #url(key: string): string {
    return new URL(`/${key.split('/').map(cosEncode).join('/')}`, this.#origin).href
  }

  /** Start one second early, as the official SDK does, to absorb small clock differences. */
  #startTime(): number {
    return Math.floor(this.#now() / 1000) - 1
  }

  async #resolveCredentials(): Promise<CosCredentials> {
    const credentials = typeof this.#credentials === 'function' ? await this.#credentials() : this.#credentials
    if (credentials.secretId === '' || credentials.secretKey === '')
      throw new TypeError('COS credentials are incomplete')
    return credentials
  }
}

function markerKey(objectKey: string): string {
  return `${objectKey}.verified.json`
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+|\/+$/g, '')
  if (trimmed === '')
    return ''
  for (const segment of trimmed.split('/')) {
    if (!PREFIX_SEGMENT_PATTERN.test(segment) || segment === '.' || segment === '..')
      throw new TypeError('prefix may only contain path segments of letters, digits, ".", "_" and "-"')
  }
  return `${trimmed}/`
}

class RequestSlots {
  readonly #limit: number
  readonly #waiting: Array<() => void> = []
  #active = 0

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new RangeError('maxConcurrentRequests must be a positive integer')
    this.#limit = limit
  }

  async acquire(): Promise<() => void> {
    if (this.#active >= this.#limit)
      await new Promise<void>(resolve => this.#waiting.push(resolve))
    else
      this.#active += 1
    return () => {
      const next = this.#waiting.shift()
      if (next === undefined)
        this.#active -= 1
      else
        next()
    }
  }
}
