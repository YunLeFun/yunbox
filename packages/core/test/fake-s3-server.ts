import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { S3Credentials } from '../src/s3-signature.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { SignatureV4 } from '@smithy/signature-v4'
import { SmithySha256 } from './smithy-sha256.ts'

/** One object held by {@link FakeS3Server}. */
export interface FakeS3Object {
  body: Buffer
  etag: string
}

/** A request the fake server answered, without its signature. */
export interface FakeS3Request {
  method: string
  key: string
  status: number
  ifNoneMatch?: string
}

/**
 * How the fake treats `If-None-Match: *` on PUT: like AWS S3 and R2
 * (`supported`, 412 when the key exists), like a service that rejects the
 * header (`not-implemented`, 501), or like one that silently overwrites (`ignored`).
 */
export type ConditionalWrites = 'supported' | 'not-implemented' | 'ignored'

const MAX_CLOCK_SKEW_MS = 15 * 60 * 1000

/**
 * Minimal S3 object API double for tests: path-style
 * `/<bucket>/<key>` requests for one bucket.
 *
 * Every request must carry a valid Signature Version 4, which is re-computed
 * with the AWS SDK's signer (`@smithy/signature-v4`) rather than the code
 * under test. As S3 does, a signed `x-amz-content-sha256` must match the
 * body, and errors are XML with a `<Code>`.
 */
export class FakeS3Server {
  readonly objects = new Map<string, FakeS3Object>()
  readonly requests: FakeS3Request[] = []
  origin = ''
  conditionalWrites: ConditionalWrites = 'supported'
  /** Access key ids that may read but not write, like an R2 "Object Read only" token. */
  readonly readOnlyKeys = new Set<string>()
  readonly #keys: S3Credentials[]
  readonly #server = createServer((request, response) => {
    void this.#handle(request, response).catch(() => {
      if (!response.headersSent)
        response.writeHead(500)
      response.end()
    })
  })

  /**
   * @param bucket The only bucket; requests for others get `NoSuchBucket`.
   * @param region Signing region the requests must use, such as `auto` for R2.
   */
  constructor(readonly bucket: string, readonly region: string, ...keys: S3Credentials[]) {
    this.#keys = keys
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

  /** Count successful PUT requests for one key. */
  putCount(key: string): number {
    return this.requests.filter(request => request.method === 'PUT' && request.key === key && request.status === 200).length
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.origin)
    const method = request.method ?? 'GET'
    const [, bucket = '', ...rest] = url.pathname.split('/')
    const key = rest.map(decodeURIComponent).join('/')
    const body = await readBody(request)
    const ifNoneMatch = request.headers['if-none-match']
    const finish = (status: number, headers: Record<string, string> = {}, content?: Buffer): void => {
      this.requests.push({ method, key, status, ...(typeof ifNoneMatch === 'string' ? { ifNoneMatch } : {}) })
      response.writeHead(status, headers)
      response.end(method === 'HEAD' ? undefined : content)
    }
    const fail = (status: number, code: string): void => finish(status, { 'Content-Type': 'application/xml' }, Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`))

    const verdict = await this.#verify(request, url, method, body)
    if (verdict.error !== undefined) {
      fail(verdict.status, verdict.error)
      return
    }
    if (decodeURIComponent(bucket) !== this.bucket) {
      fail(404, 'NoSuchBucket')
      return
    }
    if (method === 'PUT') {
      if (this.readOnlyKeys.has(verdict.accessKeyId)) {
        fail(403, 'AccessDenied')
        return
      }
      if (ifNoneMatch !== undefined) {
        if (this.conditionalWrites === 'not-implemented') {
          fail(501, 'NotImplemented')
          return
        }
        if (this.conditionalWrites === 'supported' && (ifNoneMatch !== '*' || this.objects.has(key))) {
          fail(412, 'PreconditionFailed')
          return
        }
      }
      const object = { body, etag: `"${createHash('md5').update(body).digest('hex')}"` }
      this.objects.set(key, object)
      finish(200, { ETag: object.etag })
      return
    }
    if (method !== 'GET' && method !== 'HEAD') {
      fail(405, 'MethodNotAllowed')
      return
    }
    const object = this.objects.get(key)
    if (object === undefined) {
      fail(404, 'NoSuchKey')
      return
    }
    finish(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(object.body.byteLength), 'ETag': object.etag }, object.body)
  }

  async #verify(request: IncomingMessage, url: URL, method: string, body: Buffer): Promise<{ status: number, error?: string, accessKeyId: string }> {
    const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z\d;-]+), Signature=([\da-f]{64})$/.exec(request.headers.authorization ?? '')
    if (match === null)
      return { status: 403, error: 'AccessDenied', accessKeyId: '' }
    const [, accessKeyId, , region, signedHeaders, signature] = match as unknown as [string, string, string, string, string, string]
    const credentials = this.#keys.find(candidate => candidate.accessKeyId === accessKeyId)
    if (credentials === undefined)
      return { status: 403, error: 'InvalidAccessKeyId', accessKeyId }
    if (region !== this.region)
      return { status: 400, error: 'AuthorizationHeaderMalformed', accessKeyId }
    const amzDate = request.headers['x-amz-date']
    const date = typeof amzDate === 'string' ? new Date(amzDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')) : undefined
    if (date === undefined || Number.isNaN(date.getTime()) || Math.abs(Date.now() - date.getTime()) > MAX_CLOCK_SKEW_MS)
      return { status: 403, error: 'RequestTimeTooSkewed', accessKeyId }
    const token = request.headers['x-amz-security-token']
    if (token !== credentials.sessionToken)
      return { status: 403, error: 'InvalidToken', accessKeyId }
    const contentSha256 = request.headers['x-amz-content-sha256']
    if (typeof contentSha256 !== 'string')
      return { status: 400, error: 'InvalidRequest', accessKeyId }

    const headers: Record<string, string> = {}
    for (const name of signedHeaders.split(';')) {
      const value = request.headers[name]
      if (typeof value !== 'string')
        return { status: 403, error: 'SignatureDoesNotMatch', accessKeyId }
      headers[name] = value
    }
    if (!('host' in headers) || !('x-amz-date' in headers) || !('x-amz-content-sha256' in headers))
      return { status: 403, error: 'SignatureDoesNotMatch', accessKeyId }
    const signer = new SignatureV4({ credentials, region, service: 's3', sha256: SmithySha256, uriEscapePath: false, applyChecksum: false })
    const query: Record<string, string> = {}
    for (const [name, value] of url.searchParams)
      query[name] = value
    const expected = await signer.sign(
      { method, protocol: 'http:', hostname: url.hostname, port: Number(url.port), path: url.pathname, query, headers },
      { signingDate: date, signableHeaders: new Set(Object.keys(headers)) },
    )
    if (!expected.headers.authorization?.endsWith(`Signature=${signature}`))
      return { status: 403, error: 'SignatureDoesNotMatch', accessKeyId }
    if (contentSha256 !== 'UNSIGNED-PAYLOAD' && contentSha256 !== createHash('sha256').update(body).digest('hex'))
      return { status: 400, error: 'XAmzContentSHA256Mismatch', accessKeyId }
    return { status: 200, accessKeyId }
  }
}

async function readBody(request: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request)
    chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}
