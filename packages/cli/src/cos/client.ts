// @env node

import type { CosCredentials } from '@yunbox/core'
import type { IncomingMessage } from 'node:http'
import type { CosLocation } from './location.ts'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { cosEncode, createCosAuthorization } from '@yunbox/core'

const REQUEST_TIMEOUT_MS = 60_000
/** Signatures only need to outlive one request; uploads stream for longer but are checked at the start. */
const SIGNATURE_TTL_SECONDS = 600

/** Error from a COS request. Messages never contain signatures, keys or full URLs. */
export class CosClientError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'CosClientError'
    this.status = status
  }
}

/** Called with the bytes transferred since the previous call. */
export type ProgressListener = (bytes: number) => void

/** One step of {@link CosDirectClient.probe}; `status` is 0 when no response arrived. */
export interface ProbeStep {
  operation: 'PUT' | 'HEAD' | 'GET' | 'DELETE'
  ok: boolean
  status: number
}

/**
 * Talks to one bucket directly with the user's own credentials: no YunBox
 * server in between. Uploads never overwrite an existing key, and downloads
 * are hashed so a corrupted or replaced object is never handed to git-lfs.
 */
export class CosDirectClient {
  readonly location: CosLocation
  readonly #credentials: () => CosCredentials
  readonly #origin: URL

  constructor(location: CosLocation, credentials: () => CosCredentials) {
    this.location = location
    this.#credentials = credentials
    this.#origin = new URL(location.endpoint ?? `https://${location.bucket}.cos.${location.region}.myqcloud.com`)
  }

  /** Size and ETag of a key, or `undefined` when it does not exist. */
  async head(key: string): Promise<{ size: number, etag: string } | undefined> {
    const response = await this.#send('HEAD', key)
    response.resume()
    if (response.statusCode === 404)
      return undefined
    if (response.statusCode !== 200)
      throw this.#error('HEAD', response.statusCode)
    const size = Number(response.headers['content-length'])
    return { size, etag: String(response.headers.etag ?? '') }
  }

  /**
   * Upload a file to `key` unless the key already exists with the same size.
   * Sends `x-cos-forbid-overwrite`, so an existing object is never replaced.
   *
   * @returns `skipped` when the object was already there.
   */
  async uploadFile(key: string, path: string, size: number, onProgress?: ProgressListener): Promise<'uploaded' | 'skipped'> {
    const existing = await this.head(key)
    if (existing !== undefined) {
      if (existing.size !== size)
        throw new CosClientError(`COS 里已有这个对象，但大小是 ${existing.size} 字节，不是 ${size} 字节。请联系管理员检查 ${key}`, 409)
      return 'skipped'
    }
    const counter = progressCounter(onProgress)
    const response = await this.#send('PUT', key, {
      'content-length': String(size),
      'content-type': 'application/octet-stream',
      'x-cos-forbid-overwrite': 'true',
    }, async (outgoing) => {
      await pipeline(createReadStream(path), counter, outgoing)
    })
    const body = await readText(response)
    if (response.statusCode === 409) {
      // Someone else uploaded the same object meanwhile; content-addressed keys make that fine.
      const now = await this.head(key)
      if (now?.size === size)
        return 'skipped'
    }
    if (response.statusCode !== 200)
      throw this.#error('PUT', response.statusCode, body)
    return 'uploaded'
  }

  /**
   * Download `key` to `destination`, checking the size and SHA-256 against the
   * LFS object id. A mismatching file is deleted and an error raised.
   */
  async downloadFile(key: string, destination: string, expected: { oid: string, size: number }, onProgress?: ProgressListener): Promise<void> {
    const response = await this.#send('GET', key)
    if (response.statusCode === 404) {
      response.resume()
      throw new CosClientError('COS 里没有这个对象：可能还没有人推送它，或者 .yunboxconfig 里的 bucket / 前缀不对', 404)
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
        throw new CosClientError(`下载的大小是 ${received} 字节，不是 ${expected.size} 字节`, 422)
      if (hash.digest('hex') !== expected.oid)
        throw new CosClientError('下载的内容和对象 ID（SHA-256）不一致，已丢弃。COS 里的对象可能已损坏', 422)
    }
    catch (error) {
      await rm(destination, { force: true })
      throw error
    }
  }

  /** Write, inspect, read and delete a small probe object under the prefix; stops at the first failure. */
  async probe(): Promise<ProbeStep[]> {
    const key = `${this.location.prefix === '' ? '' : `${this.location.prefix}/`}_yunbox/probe-${randomUUID()}`
    const body = Buffer.from('yunbox access probe\n')
    const steps: ProbeStep[] = []
    const record = (operation: ProbeStep['operation'], status: number, ok: boolean): boolean => {
      steps.push({ operation, ok, status })
      return ok
    }
    try {
      const put = await this.#send('PUT', key, { 'content-length': String(body.byteLength), 'content-type': 'text/plain' }, async (outgoing) => {
        outgoing.end(body)
      })
      await readText(put)
      if (!record('PUT', put.statusCode ?? 0, put.statusCode === 200))
        return steps
      const head = await this.#send('HEAD', key)
      head.resume()
      if (!record('HEAD', head.statusCode ?? 0, head.statusCode === 200))
        return steps
      const get = await this.#send('GET', key)
      const text = await readText(get)
      if (!record('GET', get.statusCode ?? 0, get.statusCode === 200 && text === body.toString()))
        return steps
      const del = await this.#send('DELETE', key)
      del.resume()
      record('DELETE', del.statusCode ?? 0, del.statusCode === 204 || del.statusCode === 200)
    }
    catch {
      steps.push({ operation: (['PUT', 'HEAD', 'GET', 'DELETE'] as const)[steps.length]!, ok: false, status: 0 })
    }
    return steps
  }

  #send(method: string, key: string, signedHeaders: Record<string, string> = {}, writeBody?: (outgoing: NodeJS.WritableStream) => Promise<void>): Promise<IncomingMessage> {
    const credentials = this.#credentials()
    const headers: Record<string, string> = { host: this.#origin.host, ...signedHeaders }
    const authorization = createCosAuthorization({
      credentials,
      method,
      pathname: `/${key}`,
      headers,
      startTime: Math.floor(Date.now() / 1000) - 1,
      expiresInSeconds: SIGNATURE_TTL_SECONDS,
    })
    const requestHeaders: Record<string, string> = { ...headers, authorization }
    if (credentials.sessionToken !== undefined)
      requestHeaders['x-cos-security-token'] = credentials.sessionToken
    const url = new URL(`/${key.split('/').map(cosEncode).join('/')}`, this.#origin)
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest
    return new Promise((resolve, reject) => {
      const outgoing = send(url, { method, headers: requestHeaders, timeout: REQUEST_TIMEOUT_MS }, resolve)
      outgoing.on('timeout', () => outgoing.destroy(new CosClientError(`连接 COS 超时（${method}）`, 0)))
      outgoing.on('error', error => reject(error instanceof CosClientError ? error : new CosClientError(`无法连接 COS（${method}）：${error.message}`, 0)))
      if (writeBody === undefined)
        outgoing.end()
      else
        writeBody(outgoing).catch(error => outgoing.destroy(error as Error))
    })
  }

  #error(operation: string, status: number | undefined, body = ''): CosClientError {
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1]
    const hint = status === 403
      ? '：密钥没有这个 bucket / 前缀的权限，或者已经失效（yunbox doctor 可以检查）'
      : status === 404 && code === 'NoSuchBucket'
        ? '：bucket 不存在，检查 .yunboxconfig 里的 cos.bucket 和 cos.region'
        : ''
    return new CosClientError(`COS ${operation} 失败，HTTP ${status ?? 0}${code === undefined ? '' : ` ${code}`}${hint}`, status ?? 0)
  }
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
