// @env node

import type { Buffer } from 'node:buffer'
import type { DocumentBackend, ListDocumentsOptions, MetadataCollection, StoredDocument } from './metadata.ts'
import { createHash, createHmac } from 'node:crypto'
import { assertDocumentId, assertFieldNames, DocumentMetadataStore, newEtag } from './metadata.ts'

/**
 * Credentials for the CloudBase HTTP API: a Tencent Cloud key pair
 * (temporary keys include `sessionToken`), exchanged for an access token, or
 * a CloudBase server API key sent as a Bearer token.
 */
export type CloudBaseCredentials
  = | { secretId: string, secretKey: string, sessionToken?: string }
    | { apiKey: string }

/** Options for {@link CloudBaseDocumentBackend}. */
export interface CloudBaseDocumentBackendOptions {
  /** CloudBase environment id. */
  envId: string
  /** API origin. Defaults to `https://<envId>.api.tcloudbasegateway.com` (mainland regions). */
  endpoint?: string
  /** Database instance, default `(default)`. */
  instance?: string
  /** Database name, default `(default)`. */
  database?: string
  /** Prefix of the collection names, default `yunbox_` (so tokens live in `yunbox_tokens`). */
  collectionPrefix?: string
  /** Called before every request, so rotated temporary keys take effect without a restart. */
  credentials: () => CloudBaseCredentials
  /** Per-request timeout in milliseconds (default 10000). */
  timeoutMs?: number
  /** Clock for signatures and access token expiry, in milliseconds. */
  now?: () => number
}

/** Path of the endpoint that exchanges a signed request for an access token. */
export const CLIENT_CREDENTIAL_PATH = '/auth/v1/token/clientCredential'

/** Error from the CloudBase HTTP API. The message names the operation, status and error code, never URLs or credentials. */
export class CloudBaseRequestError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(operation: string, status: number, code: string | undefined, requestId: string | undefined) {
    const details = [code, requestId === undefined ? undefined : `request ${requestId}`].filter(Boolean).join(', ')
    super(`CloudBase ${operation} failed with HTTP ${status}${details === '' ? '' : ` (${details})`}${code === 'DATABASE_COLLECTION_NOT_EXIST' ? '; create the collection first' : ''}`)
    this.name = 'CloudBaseRequestError'
    this.status = status
    this.code = code
  }
}

const ENV_ID_PATTERN = /^[a-z\d][a-z\d-]{0,63}$/i
const PATH_SEGMENT_PATTERN = /^(?:\(default\)|[\w-]{1,64})$/
const COLLECTION_PREFIX_PATTERN = /^\w{0,32}$/
const PAGE_SIZE = 100
const MAX_DOCUMENTS = 100_000
const DEFAULT_TIMEOUT_MS = 10_000
/** Refresh an access token this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

interface AccessToken {
  value: string
  expiresAt: number
  /** The key pair it was obtained with; rotated keys get a new token. */
  owner: string
}

/**
 * {@link DocumentBackend} on the CloudBase document database (NoSQL), through
 * its HTTP API, without the CloudBase SDK.
 *
 * Authentication follows `@cloudbase/node-sdk`: with a key pair, one request
 * to {@link CLIENT_CREDENTIAL_PATH} is signed with TC3-HMAC-SHA256 and
 * returns an access token, which every database request then sends as a
 * Bearer token. The token is reused until shortly before it expires, fetched
 * again when the keys rotate, and refreshed once if a request answers 401.
 * A server API key is sent as the Bearer token directly.
 *
 * Documents are stored as `{ _id, etag, ...fields }`. Creation inserts with
 * the given `_id` and checks that the database kept it; an id that already
 * exists is detected by reading it back after a 409, whatever the error code.
 * Conditional updates and deletes filter on `{ _id, etag }` and check how
 * many documents matched. The four collections must exist before the server
 * starts.
 */
export class CloudBaseDocumentBackend implements DocumentBackend {
  readonly #origin: string
  readonly #basePath: string
  readonly #prefix: string
  readonly #credentials: () => CloudBaseCredentials
  readonly #timeoutMs: number
  readonly #now: () => number
  readonly #envId: string
  #token: AccessToken | undefined
  #tokenLoading: Promise<AccessToken> | undefined

  constructor(options: CloudBaseDocumentBackendOptions) {
    if (!ENV_ID_PATTERN.test(options.envId))
      throw new TypeError('CloudBase environment id is malformed')
    const instance = options.instance ?? '(default)'
    const database = options.database ?? '(default)'
    if (!PATH_SEGMENT_PATTERN.test(instance) || !PATH_SEGMENT_PATTERN.test(database))
      throw new TypeError('CloudBase database instance and name may only contain letters, digits, "_" and "-", or be (default)')
    const prefix = options.collectionPrefix ?? 'yunbox_'
    if (!COLLECTION_PREFIX_PATTERN.test(prefix))
      throw new TypeError('CloudBase collection prefix may only contain letters, digits and "_" (at most 32)')
    const endpoint = new URL(options.endpoint ?? `https://${options.envId}.api.tcloudbasegateway.com`)
    if (endpoint.protocol !== 'https:' && endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost')
      throw new TypeError('CloudBase endpoint must use https')
    if (endpoint.pathname !== '/' || endpoint.search !== '' || endpoint.username !== '' || endpoint.password !== '')
      throw new TypeError('CloudBase endpoint must be an origin')
    this.#origin = endpoint.origin
    this.#basePath = `/v1/database/instances/${instance}/databases/${database}`
    this.#prefix = prefix
    this.#credentials = options.credentials
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#now = options.now ?? Date.now
    this.#envId = options.envId
  }

  get description(): string {
    return `CloudBase document database of environment ${this.#envId}, collections ${this.#prefix}{tokens,grants,locks,audit}`
  }

  /** Full name of a collection, including the prefix. */
  collectionName(collection: MetadataCollection): string {
    return `${this.#prefix}${collection}`
  }

  async get(collection: MetadataCollection, id: string): Promise<StoredDocument | undefined> {
    assertDocumentId(id)
    const { status, body } = await this.#request('read', 'GET', `${this.#documents(collection)}/${id}`, { notFound: 'DOCUMENT_NOT_FOUND' })
    return status === 404 ? undefined : toStoredDocument(body)
  }

  async list(collection: MetadataCollection, options: ListDocumentsOptions = {}): Promise<StoredDocument[]> {
    const found = new Map<string, StoredDocument>()
    const wanted = Math.min(options.limit ?? MAX_DOCUMENTS, MAX_DOCUMENTS)
    let offset = 0
    while (found.size < wanted) {
      const query = {
        query: JSON.stringify(options.where ?? {}),
        offset: String(offset),
        limit: String(Math.min(PAGE_SIZE, wanted - found.size)),
        order: JSON.stringify([{ field: '_id', direction: options.descending ? 'desc' : 'asc' }]),
      }
      const { body } = await this.#request('list', 'GET', this.#documents(collection), { query })
      const page = (body as { list?: unknown }).list
      if (!Array.isArray(page))
        throw new TypeError('CloudBase list response is malformed')
      if (page.length === 0)
        break
      for (const item of page) {
        const document = toStoredDocument(item)
        found.set(document.id, document)
      }
      offset += page.length
    }
    const documents = [...found.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    if (options.descending)
      documents.reverse()
    return documents.slice(0, wanted)
  }

  async create(collection: MetadataCollection, id: string, data: Record<string, unknown>): Promise<string | undefined> {
    assertDocumentId(id)
    assertFieldNames(data)
    const etag = newEtag()
    const { status, body } = await this.#request('insert', 'POST', this.#documents(collection), {
      body: { data: [{ ...data, _id: id, etag }] },
      conflict: true,
    })
    if (status === 409) {
      // The documented code for a duplicate key is DATABASE_DUPLICATE_WRITE;
      // rather than rely on it, check that the id is taken by someone else.
      const existing = await this.get(collection, id)
      if (existing === undefined)
        throw new CloudBaseRequestError('insert', 409, undefined, undefined)
      return existing.etag === etag ? etag : undefined
    }
    const inserted = (body as { insertedIds?: unknown }).insertedIds
    if (!Array.isArray(inserted) || inserted.length !== 1 || inserted[0] !== id)
      throw new TypeError('CloudBase did not keep the document id given on insert')
    return etag
  }

  async update(collection: MetadataCollection, id: string, expectedEtag: string, fields: Record<string, unknown>): Promise<string | undefined> {
    assertDocumentId(id)
    assertFieldNames(fields)
    const etag = newEtag()
    const { body } = await this.#request('update', 'PATCH', this.#documents(collection), {
      body: {
        query: { _id: id, etag: expectedEtag },
        data: { $set: { ...fields, etag } },
        multi: false,
        upsert: false,
      },
    })
    return count(body, 'matched') === 1 ? etag : undefined
  }

  async delete(collection: MetadataCollection, id: string, expectedEtag?: string): Promise<boolean> {
    assertDocumentId(id)
    const query: Record<string, string> = { _id: id }
    if (expectedEtag !== undefined)
      query.etag = expectedEtag
    const { body } = await this.#request('delete', 'POST', `${this.#documents(collection)}/remove`, { body: { query, multi: false } })
    return count(body, 'deleted') === 1
  }

  #documents(collection: MetadataCollection): string {
    return `${this.#basePath}/collections/${this.collectionName(collection)}/documents`
  }

  async #request(
    operation: string,
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    options: { query?: Record<string, string>, body?: unknown, notFound?: string, conflict?: boolean },
  ): Promise<{ status: number, body: unknown }> {
    const search = Object.entries(options.query ?? {})
      .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
      .join('&')
    const url = `${this.#origin}${path}${search === '' ? '' : `?${search}`}`
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    for (let attempt = 0; ; attempt++) {
      const credentials = this.#credentials()
      const authorization = 'apiKey' in credentials
        ? `Bearer ${credentials.apiKey}`
        : `Bearer ${(await this.#accessToken(credentials)).value}`
      const response = await this.#fetch(operation, url, method, authorization, payload)
      // An access token can be revoked or expire early; get a new one once.
      if (response.status === 401 && !('apiKey' in credentials) && attempt === 0) {
        this.#token = undefined
        continue
      }
      const { status, body, code, requestId } = response
      if (status >= 200 && status < 300 && body !== undefined)
        return { status, body }
      if (status === 404 && options.notFound !== undefined && code === options.notFound)
        return { status, body }
      if (status === 409 && options.conflict)
        return { status, body }
      throw new CloudBaseRequestError(operation, status, code, requestId)
    }
  }

  async #accessToken(credentials: { secretId: string, secretKey: string, sessionToken?: string }): Promise<AccessToken> {
    const owner = createHash('sha256').update(`${credentials.secretId}\n${credentials.sessionToken ?? ''}`).digest('hex')
    const current = this.#token
    if (current !== undefined && current.owner === owner && this.#now() < current.expiresAt - TOKEN_REFRESH_MARGIN_MS)
      return current
    this.#tokenLoading ??= this.#fetchAccessToken(credentials, owner).finally(() => {
      this.#tokenLoading = undefined
    })
    return await this.#tokenLoading
  }

  async #fetchAccessToken(credentials: { secretId: string, secretKey: string, sessionToken?: string }, owner: string): Promise<AccessToken> {
    const url = `${this.#origin}${CLIENT_CREDENTIAL_PATH}`
    const payload = JSON.stringify({ grant_type: 'client_credentials' })
    const requestedAt = this.#now()
    const authorization = signCloudBaseRequest(credentials, {
      method: 'POST',
      url: new URL(url),
      contentType: 'application/json',
      payload,
      timestamp: Math.floor(requestedAt / 1000),
    })
    const { status, body, code, requestId } = await this.#fetch('access token', url, 'POST', authorization, payload)
    if (status < 200 || status >= 300)
      throw new CloudBaseRequestError('access token', status, code, requestId)
    const { access_token: value, expires_in: expiresIn } = (body ?? {}) as { access_token?: unknown, expires_in?: unknown }
    if (typeof value !== 'string' || value === '' || typeof expiresIn !== 'number' || !(expiresIn > 0))
      throw new TypeError('CloudBase access token response is malformed')
    this.#token = { value, expiresAt: requestedAt + expiresIn * 1000, owner }
    return this.#token
  }

  async #fetch(
    operation: string,
    url: string,
    method: string,
    authorization: string,
    payload: string | undefined,
  ): Promise<{ status: number, body: unknown, code?: string, requestId?: string }> {
    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', 'authorization': authorization },
        body: payload,
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: 'error',
      })
    }
    catch (error) {
      // Network errors may quote the URL; keep only the error name.
      throw new Error(`CloudBase ${operation} request failed: ${error instanceof Error ? error.name : 'network error'}`)
    }
    const text = await response.text()
    let body: unknown
    try {
      body = text === '' ? {} : fromEjson(JSON.parse(text))
    }
    catch {
      body = undefined
    }
    // Database errors carry { code, request_id }; authentication errors { error }.
    const error = (body ?? {}) as { code?: unknown, error?: unknown, request_id?: unknown }
    const code = typeof error.code === 'string' ? error.code : typeof error.error === 'string' ? error.error : undefined
    return {
      status: response.status,
      body,
      ...(code === undefined ? {} : { code }),
      ...(typeof error.request_id === 'string' ? { requestId: error.request_id } : {}),
    }
  }
}

/** {@link MetadataStore} in the CloudBase document database; see {@link CloudBaseDocumentBackend}. */
export class CloudBaseMetadataStore extends DocumentMetadataStore {
  constructor(options: CloudBaseDocumentBackendOptions) {
    super(new CloudBaseDocumentBackend(options))
  }
}

/** What {@link signCloudBaseRequest} signs. */
export interface CloudBaseSignatureInput {
  method: string
  url: URL
  contentType: string
  payload: string
  /** Unix time in seconds. */
  timestamp: number
}

/**
 * Sign a CloudBase HTTP API request with TC3-HMAC-SHA256 and return the
 * `Authorization` header value.
 *
 * This is Tencent Cloud signature v3 with service `tcb`, except that the
 * canonical URI is the request path instead of `/` and the timestamp (and the
 * session token of temporary keys) are appended to the header, as the
 * CloudBase HTTP API documentation describes and `@cloudbase/node-sdk` does
 * (through `@cloudbase/signature-nodejs` with `isCloudApi`). The signed
 * headers are `content-type` and `host`; the canonical query string is the
 * query as sent and the payload hash covers the body as sent.
 */
export function signCloudBaseRequest(
  credentials: { secretId: string, secretKey: string, sessionToken?: string },
  input: CloudBaseSignatureInput,
): string {
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10)
  const signedHeaders = 'content-type;host'
  const canonicalRequest = [
    input.method,
    input.url.pathname,
    input.url.search.slice(1),
    `content-type:${input.contentType}\nhost:${input.url.host.toLowerCase()}\n`,
    signedHeaders,
    sha256Hex(input.payload),
  ].join('\n')
  const scope = `${date}/tcb/tc3_request`
  const stringToSign = ['TC3-HMAC-SHA256', String(input.timestamp), scope, sha256Hex(canonicalRequest)].join('\n')
  const signingKey = ['tcb', 'tc3_request'].reduce(
    (key, part) => hmac(key, part),
    hmac(`TC3${credentials.secretKey}`, date),
  )
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
  const parts = [
    `TC3-HMAC-SHA256 Credential=${credentials.secretId}/${scope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
    `Timestamp=${input.timestamp}`,
  ]
  if (credentials.sessionToken !== undefined)
    parts.push(`Token=${credentials.sessionToken}`)
  return parts.join(', ')
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest()
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function count(body: unknown, field: string): number {
  const value = (body as Record<string, unknown> | null)?.[field]
  if (typeof value !== 'number')
    throw new TypeError(`CloudBase response has no ${field} count`)
  return value
}

function toStoredDocument(value: unknown): StoredDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('CloudBase document is malformed')
  const { _id: id, etag, ...rest } = value as Record<string, unknown>
  if (typeof id !== 'string' || typeof etag !== 'string')
    throw new TypeError('CloudBase document has no string _id and etag')
  // Drop system fields such as _openid.
  const data = Object.fromEntries(Object.entries(rest).filter(([name]) => !name.startsWith('_')))
  return { id, etag, data }
}

/**
 * Convert Strict EJSON, which every CloudBase response uses, into plain
 * values: numbers become numbers, ObjectIds strings and dates ISO strings.
 */
export function fromEjson(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(fromEjson)
  if (typeof value !== 'object' || value === null)
    return value
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 1) {
    const [key] = keys as [string]
    const inner = record[key]
    if ((key === '$numberInt' || key === '$numberLong' || key === '$numberDouble' || key === '$numberDecimal') && typeof inner === 'string')
      return Number(inner)
    if (key === '$oid' && typeof inner === 'string')
      return inner
    if (key === '$date') {
      const time = fromEjson(inner)
      return typeof time === 'number' || typeof time === 'string' ? new Date(time).toISOString() : time
    }
  }
  return Object.fromEntries(keys.map(key => [key, fromEjson(record[key])]))
}
