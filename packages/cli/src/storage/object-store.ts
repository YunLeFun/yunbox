// @env node

import type { IncomingMessage } from 'node:http'
import type { ObjectStore, ProbeStep, ProgressListener } from './provider.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PROBE_KEY, PROBE_OPERATIONS, StorageRequestError } from './provider.ts'

const REQUEST_TIMEOUT_MS = 60_000

/** One request before signing. */
export interface UnsignedRequest {
  method: 'GET' | 'HEAD' | 'PUT'
  url: URL
  /** Raw object key, without the prefix slash or URL encoding. */
  key: string
  /** Headers to send and sign, lower-case names; `host` is added by the transport. */
  headers: Record<string, string>
  /** Hex SHA-256 of the body; the empty-body hash for GET and HEAD. */
  payloadSha256: string
}

/**
 * How one provider addresses and signs requests, and how it refuses to
 * overwrite. Everything else (skip existing objects, hash downloads, probe)
 * is shared by {@link HttpObjectStore}.
 */
export interface ObjectTransport {
  /** Short provider name for messages, such as `COS`. */
  readonly label: string
  /** The key prefix of the location, for the probe. */
  readonly prefix: string
  /** Where `key` lives. */
  url: (key: string) => URL
  /** Every header to send, including the signature. */
  sign: (request: UnsignedRequest) => Record<string, string>
  /** Headers that make a PUT fail instead of replacing an existing object. */
  readonly noOverwrite: Record<string, string>
  /** Statuses meaning "already exists" for a PUT with {@link noOverwrite}. */
  readonly conflictStatuses: readonly number[]
  /**
   * Whether a response to a PUT with {@link noOverwrite} means the service
   * does not support the guard, so the PUT is repeated without it. The store
   * checked that the key was absent just before; see docs/plan.md section 12.
   */
  guardUnsupported?: (status: number, code: string | undefined) => boolean
  /** Extra hint for a failed request, starting with `：`, or `''`. */
  hint: (status: number, code: string | undefined) => string
}

/** SHA-256 of the empty body. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/**
 * Talks to one bucket directly with the user's own keys: no YunBox server in
 * between. Uploads never overwrite an existing key, and downloads are hashed
 * so a corrupted or replaced object is never handed to git-lfs.
 */
export class HttpObjectStore implements ObjectStore {
  readonly #transport: ObjectTransport
  #guardSupported = true

  constructor(transport: ObjectTransport) {
    this.#transport = transport
  }

  async head(key: string, options: { signal?: AbortSignal } = {}): Promise<{ size: number, etag: string } | undefined> {
    const response = await this.#send('HEAD', key, {}, EMPTY_SHA256, undefined, options.signal)
    response.resume()
    if (response.statusCode === 404)
      return undefined
    if (response.statusCode !== 200)
      throw this.#error('HEAD', response.statusCode)
    const size = Number(response.headers['content-length'])
    return { size, etag: String(response.headers.etag ?? '') }
  }

  async uploadFile(key: string, path: string, expected: { oid: string, size: number }, onProgress?: ProgressListener): Promise<'uploaded' | 'skipped'> {
    const { size } = expected
    const existing = await this.head(key)
    if (existing !== undefined)
      return this.#existing(key, existing.size, size)
    const put = async (guard: boolean): Promise<{ response: IncomingMessage, body: string }> => {
      const response = await this.#send('PUT', key, {
        'content-length': String(size),
        'content-type': 'application/octet-stream',
        ...(guard ? this.#transport.noOverwrite : {}),
      }, expected.oid, async (outgoing) => {
        await pipeline(createReadStream(path), progressCounter(onProgress), outgoing)
      })
      return { response, body: await readText(response) }
    }
    let { response, body } = await put(this.#guardSupported)
    if (this.#guardSupported && this.#transport.guardUnsupported?.(response.statusCode ?? 0, errorCode(body))) {
      // The key was absent a moment ago, and the payload hash is signed, so a racing writer can only store the same bytes.
      this.#guardSupported = false;
      ({ response, body } = await put(false))
    }
    if (this.#transport.conflictStatuses.includes(response.statusCode ?? 0)) {
      // Someone else uploaded the same object meanwhile; content-addressed keys make that fine.
      const now = await this.head(key)
      if (now !== undefined)
        return this.#existing(key, now.size, size)
    }
    if (response.statusCode !== 200)
      throw this.#error('PUT', response.statusCode, body)
    return 'uploaded'
  }

  async downloadFile(key: string, destination: string, expected: { oid: string, size: number }, onProgress?: ProgressListener): Promise<void> {
    const response = await this.#send('GET', key, {}, EMPTY_SHA256)
    if (response.statusCode === 404) {
      response.resume()
      throw new StorageRequestError(`${this.#transport.label} 里没有这个对象：可能还没有人推送它，或者 .yunbox/config 里的 bucket / 前缀不对`, 404)
    }
    if (response.statusCode !== 200)
      throw this.#error('GET', response.statusCode, await readText(response))
    const hash = createHash('sha256')
    let received = 0
    const checker = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk)
        received += chunk.byteLength
        onProgress?.(chunk.byteLength)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(response, checker, createWriteStream(destination, { flags: 'wx' }))
      if (received !== expected.size)
        throw new StorageRequestError(`下载的大小是 ${received} 字节，不是 ${expected.size} 字节`, 422)
      if (hash.digest('hex') !== expected.oid)
        throw new StorageRequestError(`下载的内容和对象 ID（SHA-256）不一致，已丢弃。${this.#transport.label} 里的对象可能已损坏`, 422)
    }
    catch (error) {
      await rm(destination, { force: true })
      throw error
    }
  }

  /**
   * Write, inspect and read back a small probe object under the prefix; stops
   * at the first failure. It checks exactly what the transfer agent needs, so
   * least-privilege keys (no delete) pass. The key is fixed and the body
   * constant, so repeated or concurrent probes overwrite one tiny object
   * instead of leaving one per run.
   */
  async probe(): Promise<ProbeStep[]> {
    const prefix = this.#transport.prefix
    const key = `${prefix === '' ? '' : `${prefix}/`}${PROBE_KEY}`
    const body = Buffer.from('yunbox access probe\n')
    const steps: ProbeStep[] = []
    const record = (operation: ProbeStep['operation'], status: number, ok: boolean): boolean => {
      steps.push({ operation, ok, status })
      return ok
    }
    try {
      const put = await this.#send('PUT', key, { 'content-length': String(body.byteLength), 'content-type': 'text/plain' }, createHash('sha256').update(body).digest('hex'), async (outgoing) => {
        outgoing.end(body)
      })
      await readText(put)
      if (!record('PUT', put.statusCode ?? 0, put.statusCode === 200))
        return steps
      const head = await this.#send('HEAD', key, {}, EMPTY_SHA256)
      head.resume()
      if (!record('HEAD', head.statusCode ?? 0, head.statusCode === 200))
        return steps
      const get = await this.#send('GET', key, {}, EMPTY_SHA256)
      const text = await readText(get)
      record('GET', get.statusCode ?? 0, get.statusCode === 200 && text === body.toString())
    }
    catch {
      steps.push({ operation: PROBE_OPERATIONS[steps.length]!, ok: false, status: 0 })
    }
    return steps
  }

  #existing(key: string, actual: number, size: number): 'skipped' {
    if (actual !== size)
      throw new StorageRequestError(`${this.#transport.label} 里已有这个对象，但大小是 ${actual} 字节，不是 ${size} 字节。请联系管理员检查 ${key}`, 409)
    return 'skipped'
  }

  #send(method: UnsignedRequest['method'], key: string, headers: Record<string, string>, payloadSha256: string, writeBody?: (outgoing: NodeJS.WritableStream) => Promise<void>, signal?: AbortSignal): Promise<IncomingMessage> {
    const { label } = this.#transport
    const url = this.#transport.url(key)
    const requestHeaders = this.#transport.sign({ method, url, key, headers: { host: url.host, ...headers }, payloadSha256 })
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest
    return new Promise((resolve, reject) => {
      const outgoing = send(url, { method, headers: requestHeaders, timeout: REQUEST_TIMEOUT_MS, signal }, resolve)
      outgoing.on('timeout', () => outgoing.destroy(new StorageRequestError(`连接 ${label} 超时（${method}）`, 0)))
      outgoing.on('error', error => reject(error instanceof StorageRequestError ? error : new StorageRequestError(`无法连接 ${label}（${method}）：${error.message}`, 0)))
      if (writeBody === undefined)
        outgoing.end()
      else
        writeBody(outgoing).catch(error => outgoing.destroy(error as Error))
    })
  }

  #error(operation: string, status: number | undefined, body = ''): StorageRequestError {
    const code = errorCode(body)
    const hint = this.#transport.hint(status ?? 0, code)
    return new StorageRequestError(`${this.#transport.label} ${operation} 失败，HTTP ${status ?? 0}${code === undefined ? '' : ` ${code}`}${hint}`, status ?? 0, code)
  }
}

/** The `<Code>` of an XML error body. */
function errorCode(body: string): string | undefined {
  return /<Code>([^<]+)<\/Code>/.exec(body)?.[1]
}

function progressCounter(onProgress: ProgressListener | undefined): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      onProgress?.(chunk.byteLength)
      callback(null, chunk)
    },
  })
}

async function readText(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of response)
    chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
