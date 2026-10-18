import type { AddressInfo } from 'node:net'
import type { CosCredentials } from '../src/cos-signature.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import COS from 'cos-nodejs-sdk-v5'

/** One object held by {@link FakeCosServer}. */
export interface FakeCosObject {
  body: Buffer
  etag: string
}

/** The subset of a CAM policy document that {@link FakeCosServer} enforces. */
export interface FakeCamPolicy {
  statement: Array<{ effect: string, action: string[], resource: string[] }>
}

const OBJECT_ACTIONS: Record<string, string> = {
  PUT: 'PutObject',
  GET: 'GetObject',
  HEAD: 'HeadObject',
  DELETE: 'DeleteObject',
}

/** A request the fake server answered, without its signature. */
export interface FakeCosRequest {
  method: string
  key: string
  status: number
  presigned: boolean
}

const AUTHORIZATION_FIELDS = [
  'q-sign-algorithm',
  'q-ak',
  'q-sign-time',
  'q-key-time',
  'q-header-list',
  'q-url-param-list',
  'q-signature',
] as const

/**
 * Minimal COS XML API double for tests.
 *
 * Every request must carry a valid v5 signature, which is re-computed with the
 * official SDK rather than the code under test. Signed headers must be present
 * and unchanged, so tests catch clients that send different headers than were
 * presigned.
 */
export class FakeCosServer {
  readonly objects = new Map<string, FakeCosObject>()
  readonly requests: FakeCosRequest[] = []
  readonly #credentials: CosCredentials
  readonly #server = createServer((request, response) => {
    void this.#handle(request, response).catch(() => {
      if (!response.headersSent)
        response.writeHead(500)
      response.end()
    })
  })

  #interruptedKeys = new Set<string>()
  interruptedAttempts = 0
  origin = ''
  /** Buckets returned by GET Service (`GET /`), as the account's bucket list. */
  readonly buckets: Array<{ name: string, region: string }> = []
  /** `x-cos-acl` of every PUT Bucket (`PUT /`) request, in order. */
  readonly createdBucketAcls: string[] = []
  /**
   * When set, requests with valid signatures are also checked against this CAM
   * policy, as a sub-account would be: object PUT / GET / HEAD / DELETE need
   * `name/cos:PutObject` / `GetObject` / `HeadObject` / `DeleteObject`, GET
   * Service needs `name/cos:GetService`, and the resource's part after
   * `<bucket>/` must match the key (a trailing `*` matches any rest). The
   * region, APPID and bucket of resources are not checked.
   */
  policy: FakeCamPolicy | undefined

  constructor(credentials: CosCredentials) {
    this.#credentials = credentials
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

  /** Drop the connection part-way through every PUT to `key` until {@link resumePuts}. */
  interruptPuts(key: string): void {
    this.#interruptedKeys.add(key)
  }

  resumePuts(): void {
    this.#interruptedKeys.clear()
  }

  /** Count successful PUT requests for one key. */
  putCount(key: string): number {
    return this.requests.filter(request => request.method === 'PUT' && request.key === key && request.status === 200).length
  }

  async #handle(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.origin)
    const key = decodeURIComponent(url.pathname.slice(1))
    const method = request.method ?? 'GET'
    const presigned = url.searchParams.has('q-signature')
    const finish = (status: number, headers: Record<string, string> = {}, body?: Buffer): void => {
      this.requests.push({ method, key, status, presigned })
      response.writeHead(status, headers)
      response.end(method === 'HEAD' ? undefined : body)
    }

    if (!this.#isAuthorized(request, url, key, method) || !this.#isAllowed(key, method)) {
      await drain(request)
      finish(403, { 'Content-Type': 'application/xml' }, Buffer.from('<Error><Code>AccessDenied</Code></Error>'))
      return
    }

    if (key === '' && method === 'GET') {
      const entries = this.buckets.map(bucket => `<Bucket><Name>${bucket.name}</Name><Location>${bucket.region}</Location><CreationDate>2026-01-01T00:00:00Z</CreationDate></Bucket>`)
      finish(200, { 'Content-Type': 'application/xml' }, Buffer.from(`<ListAllMyBucketsResult><Buckets>${entries.join('')}</Buckets></ListAllMyBucketsResult>`))
      return
    }
    if (key === '' && method === 'PUT') {
      await drain(request)
      this.createdBucketAcls.push(String(request.headers['x-cos-acl']))
      finish(200)
      return
    }

    if (method === 'PUT') {
      if (this.#interruptedKeys.has(key)) {
        this.interruptedAttempts += 1
        request.once('data', () => request.socket.destroy())
        return
      }
      if (request.headers['x-cos-forbid-overwrite'] === 'true' && this.objects.has(key)) {
        await drain(request)
        finish(409, { 'Content-Type': 'application/xml' }, Buffer.from('<Error><Code>FileAlreadyExists</Code></Error>'))
        return
      }
      const body = await readBody(request)
      const object = { body, etag: `"${createHash('md5').update(body).digest('hex')}"` }
      this.objects.set(key, object)
      finish(200, { ETag: object.etag })
      return
    }

    await drain(request)
    const object = this.objects.get(key)
    if (method === 'DELETE') {
      this.objects.delete(key)
      finish(204)
      return
    }
    if (method !== 'GET' && method !== 'HEAD') {
      finish(405)
      return
    }
    if (object === undefined) {
      finish(404, { 'Content-Type': 'application/xml' }, Buffer.from('<Error><Code>NoSuchKey</Code></Error>'))
      return
    }
    const ifMatch = request.headers['if-match']
    if (ifMatch !== undefined && ifMatch !== object.etag) {
      finish(412)
      return
    }
    finish(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(object.body.byteLength),
      'ETag': object.etag,
    }, object.body)
  }

  #isAllowed(key: string, method: string): boolean {
    if (this.policy === undefined)
      return true
    const action = key === '' ? (method === 'GET' ? 'GetService' : 'PutBucket') : OBJECT_ACTIONS[method]
    if (action === undefined)
      return false
    return this.policy.statement.some(statement => statement.effect === 'allow'
      && statement.action.includes(`name/cos:${action}`)
      && statement.resource.some((resource) => {
        const pattern = /^qcs::cos:[^:]+:uid\/\d+:[^/]+\/(.*)$/.exec(resource)?.[1]
        if (pattern === undefined)
          return false
        return pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern
      }))
  }

  #isAuthorized(request: import('node:http').IncomingMessage, url: URL, key: string, method: string): boolean {
    const fields = new Map<string, string>()
    const header = request.headers.authorization
    if (header === undefined) {
      for (const name of AUTHORIZATION_FIELDS) {
        const value = url.searchParams.get(name)
        if (value !== null)
          fields.set(name, value)
      }
    }
    else {
      for (const pair of header.split('&')) {
        const index = pair.indexOf('=')
        fields.set(pair.slice(0, index), pair.slice(index + 1))
      }
    }
    if (AUTHORIZATION_FIELDS.some(name => !fields.has(name)))
      return false
    if (fields.get('q-ak') !== this.#credentials.secretId || fields.get('q-sign-time') !== fields.get('q-key-time'))
      return false

    const token = request.headers['x-cos-security-token'] ?? url.searchParams.get('x-cos-security-token') ?? undefined
    if (token !== this.#credentials.sessionToken)
      return false

    const keyTime = fields.get('q-key-time')!
    const [start, end] = keyTime.split(';').map(Number)
    const now = Math.floor(Date.now() / 1000)
    if (start === undefined || end === undefined || now < start || now > end)
      return false

    const signedHeaders: Record<string, string> = {}
    for (const name of splitList(fields.get('q-header-list')!)) {
      const value = request.headers[name]
      if (typeof value !== 'string')
        return false
      signedHeaders[name] = value
    }
    const signedQuery: Record<string, string> = {}
    for (const name of splitList(fields.get('q-url-param-list')!)) {
      const value = url.searchParams.get(name)
      if (value === null)
        return false
      signedQuery[name] = value
    }
    const expected = COS.getAuthorization({
      SecretId: this.#credentials.secretId,
      SecretKey: this.#credentials.secretKey,
      Method: method.toLowerCase(),
      Pathname: `/${key}`,
      Query: signedQuery,
      Headers: signedHeaders,
      KeyTime: keyTime,
    } as COS.StaticGetAuthorizationOptions)
    return new URLSearchParams(expected).get('q-signature') === fields.get('q-signature')
  }
}

function splitList(value: string): string[] {
  return value === '' ? [] : value.split(';')
}

async function readBody(request: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request)
    chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function drain(request: AsyncIterable<Uint8Array>): Promise<void> {
  // eslint-disable-next-line no-empty
  for await (const _chunk of request) {}
}
