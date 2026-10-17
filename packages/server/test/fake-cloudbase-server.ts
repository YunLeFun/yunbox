import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { sign } from '@cloudbase/signature-nodejs'

/** Credentials the fake accepts: a Tencent Cloud key pair, or a server API key. */
export interface FakeCloudBaseCredentials {
  secretId?: string
  secretKey?: string
  sessionToken?: string
  apiKey?: string
}

/** A request the fake answered, without its credentials. */
export interface FakeCloudBaseRequest {
  method: string
  path: string
  status: number
  code?: string
}

type Document = Record<string, unknown>

const BASE = '/v1/database/instances/(default)/databases/(default)/collections/'

/**
 * Minimal double of the CloudBase document database HTTP API, covering the
 * calls YunBox makes: insert, get by id, query with equality filters,
 * conditional update and conditional remove, plus the access token exchange
 * at `/auth/v1/token/clientCredential`.
 *
 * It follows the official OpenAPI description: responses are Strict EJSON
 * (numbers become `{ "$numberInt": "1" }`), a duplicate `_id` is `409
 * DATABASE_DUPLICATE_WRITE`, a missing collection `404
 * DATABASE_COLLECTION_NOT_EXIST`. It returns at most `pageLimit` documents per
 * query whatever the client asks, to exercise paging. The token exchange
 * must be signed with TC3-HMAC-SHA256 (recomputed here independently of the
 * client, the way `@cloudbase/signature-nodejs` builds it); database requests
 * must carry an unexpired access token it issued, or the configured API key.
 * Switches simulate the API behaviour the documentation leaves open.
 */
export class FakeCloudBaseServer {
  readonly collections = new Map<string, Map<string, Document>>()
  readonly requests: FakeCloudBaseRequest[] = []
  /** Credentials it accepts; replace to simulate rotated keys. */
  credentials: FakeCloudBaseCredentials
  readonly #server = createServer((request, response) => {
    void this.#handle(request, response).catch(() => {
      if (!response.headersSent)
        this.#send(request, response, 500, { code: 'SYS_ERR', message: 'fake failure' })
      else
        response.end()
    })
  })

  /** Most documents returned by one query. */
  pageLimit = 7
  /** Make the next database requests fail with this status and code. */
  failures: Array<{ status: number, code: string }> = []
  /** Lifetime of issued access tokens, in seconds. */
  tokenLifetimeSeconds = 7200
  /** Access tokens issued so far, with their expiry in milliseconds. */
  readonly accessTokens = new Map<string, number>()
  /** Error code returned for a duplicate `_id` (the documented one by default). */
  duplicateCode = 'DATABASE_DUPLICATE_WRITE'
  /** When false, inserts ignore the given `_id` and generate one, as some document databases do. */
  keepsInsertedIds = true
  origin = ''

  constructor(credentials: FakeCloudBaseCredentials, collections: string[]) {
    this.credentials = credentials
    for (const name of collections)
      this.collections.set(name, new Map())
  }

  async start(): Promise<this> {
    await new Promise<void>(resolve => this.#server.listen(0, '127.0.0.1', resolve))
    this.origin = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`
    return this
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections()
    await new Promise<void>(resolve => this.#server.close(() => resolve()))
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of request)
      chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    const rawUrl = request.url ?? '/'
    const [path = '/', query = ''] = rawUrl.split('?', 2)

    if (path === '/auth/v1/token/clientCredential') {
      if (request.method !== 'POST' || !this.#signed(request, path, query, body) || body !== '{"grant_type":"client_credentials"}') {
        this.#send(request, response, 401, { error: 'invalid_client', error_code: 2, error_description: 'signature mismatch' }, false)
        return
      }
      const token = randomBytes(24).toString('base64url')
      this.accessTokens.set(token, Date.now() + this.tokenLifetimeSeconds * 1000)
      this.#send(request, response, 200, { token_type: 'Bearer', access_token: token, expires_in: this.tokenLifetimeSeconds }, false)
      return
    }
    if (!this.#bearer(request)) {
      this.#send(request, response, 401, { code: 'INVALID_ACCESS_TOKEN', message: 'token is missing, invalid or expired' })
      return
    }
    const failure = this.failures.shift()
    if (failure !== undefined) {
      this.#send(request, response, failure.status, { code: failure.code, message: 'injected failure', request_id: 'req-fake' })
      return
    }
    if (!path.startsWith(BASE)) {
      this.#send(request, response, 404, { code: 'NOT_FOUND', message: 'route' })
      return
    }
    const [collectionName = '', documents, documentId, extra] = path.slice(BASE.length).split('/')
    const collection = this.collections.get(collectionName)
    if (documents !== 'documents' || extra !== undefined) {
      this.#send(request, response, 404, { code: 'NOT_FOUND', message: 'route' })
      return
    }
    if (collection === undefined) {
      this.#send(request, response, 404, { code: 'DATABASE_COLLECTION_NOT_EXIST', message: 'collection' })
      return
    }
    const json = body === '' ? {} : JSON.parse(body) as Record<string, unknown>

    if (request.method === 'GET' && documentId !== undefined) {
      const document = collection.get(decodeURIComponent(documentId))
      if (document === undefined)
        this.#send(request, response, 404, { code: 'DOCUMENT_NOT_FOUND', message: 'Document not found' })
      else
        this.#send(request, response, 200, document)
      return
    }
    if (request.method === 'GET') {
      const params = new URLSearchParams(query)
      const filter = JSON.parse(params.get('query') ?? '{}') as Document
      const order = JSON.parse(params.get('order') ?? '[]') as Array<{ field: string, direction: string }>
      const offset = Number(params.get('offset') ?? 0)
      const limit = Math.min(Number(params.get('limit') ?? 20), this.pageLimit)
      const list = [...collection.values()].filter(document => matches(document, filter))
      list.sort((a, b) => String(a._id) < String(b._id) ? -1 : 1)
      if (order[0]?.field === '_id' && order[0].direction === 'desc')
        list.reverse()
      this.#send(request, response, 200, { offset, limit, list: list.slice(offset, offset + limit) })
      return
    }
    if (request.method === 'POST' && documentId === 'remove') {
      const filter = json.query as Document
      const match = [...collection.values()].find(document => matches(document, filter))
      if (match !== undefined)
        collection.delete(String(match._id))
      this.#send(request, response, 200, { deleted: match === undefined ? 0 : 1 })
      return
    }
    if (request.method === 'POST' && documentId === undefined) {
      const inserted = json.data as Document[]
      for (const document of inserted) {
        if (!this.keepsInsertedIds)
          document._id = randomBytes(12).toString('hex')
        if (collection.has(String(document._id))) {
          this.#send(request, response, 409, { code: this.duplicateCode, message: 'duplicate key', request_id: 'req-dup' })
          return
        }
      }
      for (const document of inserted)
        collection.set(String(document._id), structuredClone(document))
      this.#send(request, response, 201, { insertedIds: inserted.map(document => this.keepsInsertedIds ? document._id : { $oid: document._id }) })
      return
    }
    if (request.method === 'PATCH' && documentId === undefined) {
      const filter = json.query as Document
      const update = json.data as { $set: Document }
      if (json.upsert !== false || json.multi !== false || typeof update.$set !== 'object')
        throw new Error('unexpected update shape')
      const match = [...collection.values()].find(document => matches(document, filter))
      if (match !== undefined)
        Object.assign(match, structuredClone(update.$set))
      this.#send(request, response, 200, { updated: match === undefined ? 0 : 1, matched: match === undefined ? 0 : 1, upsert_id: '' })
      return
    }
    this.#send(request, response, 404, { code: 'NOT_FOUND', message: 'route' })
  }

  #bearer(request: IncomingMessage): boolean {
    const header = request.headers.authorization ?? ''
    if (this.credentials.apiKey !== undefined)
      return header === `Bearer ${this.credentials.apiKey}`
    const expiresAt = this.accessTokens.get(header.slice('Bearer '.length))
    return header.startsWith('Bearer ') && expiresAt !== undefined && Date.now() < expiresAt
  }

  /** Check a TC3 signature by recomputing it with the official `@cloudbase/signature-nodejs`, as `@cloudbase/node-sdk` builds it. */
  #signed(request: IncomingMessage, path: string, query: string, body: string): boolean {
    const header = request.headers.authorization ?? ''
    const { secretId, secretKey, sessionToken } = this.credentials
    const timestamp = Number(/, Timestamp=(\d+)/.exec(header)?.[1])
    if (secretId === undefined || secretKey === undefined || !Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300)
      return false
    const host = request.headers.host ?? ''
    const { authorization } = sign({
      secretId,
      secretKey,
      method: request.method ?? '',
      url: `http://${host}${path}${query === '' ? '' : `?${query}`}`,
      headers: { 'content-type': request.headers['content-type'] ?? '', host },
      params: JSON.parse(body) as Record<string, unknown>,
      timestamp,
      isCloudApi: true,
    })
    return header === `${authorization}, Timestamp=${timestamp}${sessionToken === undefined ? '' : `, Token=${sessionToken}`}`
  }

  /** Database responses are Strict EJSON; the authentication API answers plain JSON. */
  #send(request: IncomingMessage, response: ServerResponse, status: number, body: unknown, ejson = true): void {
    const record = (typeof body === 'object' && body !== null ? body : {}) as { code?: unknown, error?: unknown }
    const code = record.code !== undefined ? String(record.code) : record.error !== undefined ? String(record.error) : undefined
    this.requests.push({ method: request.method ?? '', path: (request.url ?? '').split('?')[0]!, status, ...(code === undefined ? {} : { code }) })
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(ejson ? toStrictEjson(body) : body))
  }
}

function matches(document: Document, filter: Document): boolean {
  return Object.entries(filter).every(([field, value]) => document[field] === value)
}

function toStrictEjson(value: unknown): unknown {
  if (typeof value === 'number')
    return Number.isInteger(value) ? { $numberInt: String(value) } : { $numberDouble: String(value) }
  if (Array.isArray(value))
    return value.map(toStrictEjson)
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, toStrictEjson(inner)]))
  return value
}
