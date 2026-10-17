import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'

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
 * conditional update and conditional remove.
 *
 * It follows the official OpenAPI description: responses are Strict EJSON
 * (numbers become `{ "$numberInt": "1" }`), a duplicate `_id` is `409
 * DATABASE_DUPLICATE_WRITE`, a missing collection `404
 * DATABASE_COLLECTION_NOT_EXIST`. It returns at most `pageLimit` documents per
 * query whatever the client asks, to exercise paging. Every request must be
 * signed with TC3-HMAC-SHA256 (recomputed here independently of the client)
 * or carry the configured API key.
 */
export class FakeCloudBaseServer {
  readonly collections = new Map<string, Map<string, Document>>()
  readonly requests: FakeCloudBaseRequest[] = []
  readonly #credentials: FakeCloudBaseCredentials
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
  /** Make the next requests fail with this status and code. */
  failures: Array<{ status: number, code: string }> = []
  origin = ''

  constructor(credentials: FakeCloudBaseCredentials, collections: string[]) {
    this.#credentials = credentials
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

    if (!this.#authorized(request, path, query, body)) {
      this.#send(request, response, 401, { code: 'INVALID_ACCESS_TOKEN', message: 'signature mismatch' })
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
        if (collection.has(String(document._id))) {
          this.#send(request, response, 409, { code: 'DATABASE_DUPLICATE_WRITE', message: 'duplicate key', request_id: 'req-dup' })
          return
        }
      }
      for (const document of inserted)
        collection.set(String(document._id), structuredClone(document))
      this.#send(request, response, 201, { insertedIds: inserted.map(document => document._id) })
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

  #authorized(request: IncomingMessage, path: string, query: string, body: string): boolean {
    const header = request.headers.authorization ?? ''
    const credentials = this.#credentials
    if (credentials.apiKey !== undefined)
      return header === `Bearer ${credentials.apiKey}`
    const fields = new Map<string, string>()
    const [algorithm, ...rest] = header.split(' ')
    if (algorithm !== 'TC3-HMAC-SHA256')
      return false
    for (const part of rest.join(' ').split(', ')) {
      const separator = part.indexOf('=')
      fields.set(part.slice(0, separator), part.slice(separator + 1))
    }
    const timestamp = Number(fields.get('Timestamp'))
    if (!Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300)
      return false
    if (fields.get('Token') !== credentials.sessionToken)
      return false
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
    if (fields.get('Credential') !== `${credentials.secretId}/${date}/tcb/tc3_request` || fields.get('SignedHeaders') !== 'content-type;host')
      return false
    const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
    const canonical = `${request.method}\n${path}\n${query}\ncontent-type:${request.headers['content-type']}\nhost:${request.headers.host}\n\ncontent-type;host\n${sha256(body)}`
    const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${date}/tcb/tc3_request\n${sha256(canonical)}`
    let key: Buffer = createHmac('sha256', `TC3${credentials.secretKey}`).update(date).digest()
    key = createHmac('sha256', key).update('tcb').digest()
    key = createHmac('sha256', key).update('tc3_request').digest()
    return fields.get('Signature') === createHmac('sha256', key).update(stringToSign).digest('hex')
  }

  #send(request: IncomingMessage, response: ServerResponse, status: number, body: unknown): void {
    const code = typeof body === 'object' && body !== null && 'code' in body ? String(body.code) : undefined
    this.requests.push({ method: request.method ?? '', path: (request.url ?? '').split('?')[0]!, status, ...(code === undefined ? {} : { code }) })
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(toStrictEjson(body)))
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
