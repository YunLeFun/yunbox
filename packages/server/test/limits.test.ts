import type { ObjectStorage } from '@yunbox/core'
import type { IncomingMessage } from 'node:http'
import type { RequestLogEntry } from '../src/logging.ts'
import type { RunningYunBoxServer, YunBoxServerOptions } from '../src/types.ts'
import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { LFS_JSON_MEDIA_TYPE, LocalFileObjectStorage } from '@yunbox/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeErrorForLog, redactLogText } from '../src/logging.ts'
import { LINGER_TIMEOUT_MS, MAX_DISCARDED_BODY_BYTES, MAX_JSON_BODY_BYTES } from '../src/request-handler.ts'
import { startYunBoxServer } from '../src/server.ts'
import { createToken } from '../src/tokens.ts'
import { basicAuth, batch, batchRequest, expectLfsError, getAction, postJson } from './http-helpers.ts'
import { MemoryMetadataStore } from './memory-metadata.ts'

const repository = { owner: 'team', repo: 'assets' }

describe('server limits, error format and logging', () => {
  let directory: string
  let metadata: MemoryMetadataStore
  let secret: string
  let auth: Record<string, string>
  let logs: RequestLogEntry[]
  let running: RunningYunBoxServer | undefined
  const pending: Array<{ destroy: () => void }> = []

  async function start(overrides: Partial<YunBoxServerOptions> = {}): Promise<RunningYunBoxServer> {
    running = await startYunBoxServer({
      storage: new LocalFileObjectStorage(directory),
      metadata,
      port: 0,
      log: entry => logs.push(entry),
      ...overrides,
    })
    return running
  }

  /** Send headers and part of a body, then keep the request open. */
  function openRequest(
    url: string,
    method: string,
    headers: Record<string, string>,
    partialBody: string,
  ): Promise<{ status: number, body: string } | 'closed'> {
    return new Promise((resolve) => {
      const request = httpRequest(url, { method, headers })
      pending.push(request)
      request.on('response', (response: IncomingMessage) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
        response.on('error', () => resolve('closed'))
      })
      request.on('error', () => resolve('closed'))
      request.flushHeaders()
      request.write(partialBody)
    })
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'yunbox-limits-test-'))
    metadata = new MemoryMetadataStore()
    secret = (await createToken(metadata, { name: 'writer', repos: { 'team/*': 'write' } })).secret
    auth = basicAuth(secret)
    logs = []
  })

  afterEach(async () => {
    for (const request of pending.splice(0))
      request.destroy()
    await running?.close()
    running = undefined
    await rm(directory, { recursive: true, force: true })
  })

  it('answers 408 when a batch body does not arrive before the request timeout', async () => {
    const server = await start({ requestTimeoutMs: 300 })
    const result = await openRequest(`${server.url}/team/assets/objects/batch`, 'POST', {
      ...auth,
      'Content-Type': LFS_JSON_MEDIA_TYPE,
      'Content-Length': '100',
    }, '{"operation":')
    expect(result).not.toBe('closed')
    const { status, body } = result as { status: number, body: string }
    expect(status).toBe(408)
    expect(JSON.parse(body)).toMatchObject({ message: expect.stringContaining('not received in time'), request_id: expect.any(String) })
  })

  it('answers 408 in LFS JSON when request headers trickle in too slowly', async () => {
    const server = await start({ requestTimeoutMs: 300, idleTimeoutMs: 60_000 })
    const started = Date.now()
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(new URL(server.url).port), '127.0.0.1', () => socket.write('POST /team/assets/objects/batch HTTP/1.1\r\n'))
      const timer = setInterval(() => socket.writable && socket.write('X-Slow: 1\r\n'), 100)
      const chunks: Buffer[] = []
      socket.on('data', chunk => chunks.push(chunk))
      socket.on('close', () => {
        clearInterval(timer)
        resolve(Buffer.concat(chunks).toString())
      })
      socket.on('error', reject)
    })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(raw).toMatch(/^HTTP\/1\.1 408 Request Timeout/)
    expect(raw).toContain(`Content-Type: ${LFS_JSON_MEDIA_TYPE}`)
  })

  it('closes a stalled transfer after the idle timeout without storing anything', async () => {
    const server = await start({ idleTimeoutMs: 300 })
    const oid = 'a'.repeat(64)
    const upload = getAction(await batch(server.url, 'team/assets', 'upload', oid, 1000, auth), 'upload')
    const started = Date.now()
    const result = await openRequest(upload.href, 'PUT', { ...auth, 'Content-Length': '1000' }, 'x'.repeat(10))
    expect(result).toBe('closed')
    expect(Date.now() - started).toBeLessThan(5000)
    expect(await new LocalFileObjectStorage(directory).inspectObject(repository, oid)).toBeUndefined()
  })

  it('limits concurrent API requests and transfers with 503 and Retry-After', async () => {
    const server = await start({ maxConcurrentRequests: 1, maxConcurrentTransfers: 1 })
    const oid = 'b'.repeat(64)
    const upload = getAction(await batch(server.url, 'team/assets', 'upload', oid, 1000, auth), 'upload')

    void openRequest(`${server.url}/team/assets/objects/batch`, 'POST', {
      ...auth,
      'Content-Type': LFS_JSON_MEDIA_TYPE,
      'Content-Length': '100',
    }, '{')
    void openRequest(upload.href, 'PUT', { ...auth, 'Content-Length': '1000' }, 'x')
    // Let both held requests reach the server and take their slots.
    await delay(200)

    const busyBatch = await batchRequest(server.url, 'team/assets', 'download', oid, 1000, auth)
    expect(busyBatch.headers.get('retry-after')).toBe('1')
    await expectLfsError(busyBatch, 503, /concurrent requests/)
    const busyTransfer = await fetch(upload.href, { method: 'PUT', body: 'y'.repeat(1000), headers: auth })
    expect(busyTransfer.headers.get('retry-after')).toBe('1')
    await expectLfsError(busyTransfer, 503, /concurrent transfers/)
  })

  it('rejects oversized JSON bodies and uploads larger than the signed size', async () => {
    const server = await start()
    // Rejected from Content-Length alone, before the body is read.
    const declared = await openRequest(`${server.url}/team/assets/objects/batch`, 'POST', {
      ...auth,
      'Content-Type': LFS_JSON_MEDIA_TYPE,
      'Content-Length': String(MAX_JSON_BODY_BYTES + 1),
    }, '')
    expect(declared).toMatchObject({ status: 413 })
    const streamed = await openRequest(`${server.url}/team/assets/objects/batch`, 'POST', {
      ...auth,
      'Content-Type': LFS_JSON_MEDIA_TYPE,
      'Transfer-Encoding': 'chunked',
    }, ' '.repeat(MAX_JSON_BODY_BYTES + 1))
    expect(streamed).toMatchObject({ status: 413 })

    const oid = 'c'.repeat(64)
    const upload = getAction(await batch(server.url, 'team/assets', 'upload', oid, 4, auth), 'upload')
    const longer = await openRequest(upload.href, 'PUT', { ...auth, 'Content-Length': '8' }, '')
    expect(longer).toMatchObject({ status: 413 })
    const chunked = await openRequest(upload.href, 'PUT', { ...auth, 'Transfer-Encoding': 'chunked' }, 'also too long')
    expect(chunked).toMatchObject({ status: 413 })
    expect(JSON.parse((chunked as { body: string }).body)).toMatchObject({ message: expect.stringContaining('larger than the size') })
    expect(await new LocalFileObjectStorage(directory).inspectObject(repository, oid)).toBeUndefined()
  })

  it('keeps the connection open after an early 401 until the client stops uploading', async () => {
    const server = await start()
    const socket = connect(Number(new URL(server.url).port), '127.0.0.1')
    pending.push(socket)
    const declaredBytes = 256 * 1024 * 1024
    let writtenBytes = 0
    let closedAt: number | undefined
    let failure: Error | undefined
    const chunk = Buffer.alloc(64 * 1024, 0x11)
    const pump = (): void => {
      while (writtenBytes < declaredBytes && socket.write(chunk))
        writtenBytes += chunk.byteLength
    }
    socket.on('drain', () => {
      writtenBytes += chunk.byteLength
      pump()
    })
    socket.on('error', (error) => {
      failure = error
    })
    socket.on('close', () => {
      closedAt = Date.now()
    })
    const received: Buffer[] = []
    const response = new Promise<string>((resolve) => {
      socket.on('data', (data: Buffer) => {
        received.push(data)
        const text = Buffer.concat(received).toString()
        const headerEnd = text.indexOf('\r\n\r\n')
        const length = /content-length: (\d+)/i.exec(text)
        if (headerEnd !== -1 && length !== null && text.length >= headerEnd + 4 + Number(length[1]))
          resolve(text)
      })
    })
    socket.write(`PUT /team/assets/objects/${'e'.repeat(64)}?size=${declaredBytes} HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${declaredBytes}\r\n\r\n`)
    pump()

    const raw = await response
    const respondedAt = Date.now()
    expect(raw).toMatch(/^HTTP\/1\.1 401 /)
    expect(raw).toContain(`Content-Type: ${LFS_JSON_MEDIA_TYPE}`)
    // Closing now would reset a client that is still writing before it reads the 401.
    await delay(300)
    expect(failure).toBeUndefined()
    expect(closedAt).toBeUndefined()

    // A client that never stops is cut off after the linger timeout, having
    // pushed little more than the discard limit and the socket buffers.
    await waitFor(() => closedAt !== undefined, LINGER_TIMEOUT_MS + 3000)
    expect(closedAt! - respondedAt).toBeGreaterThanOrEqual(LINGER_TIMEOUT_MS - 500)
    expect(writtenBytes).toBeLessThan(MAX_DISCARDED_BODY_BYTES + 32 * 1024 * 1024)
    expect(logs.find(entry => entry.status === 401)).toMatchObject({ method: 'PUT' })
  }, 20_000)

  it('discards a small unauthenticated body and keeps the connection reusable', async () => {
    const server = await start()
    const socket = connect(Number(new URL(server.url).port), '127.0.0.1')
    pending.push(socket)
    const received: Buffer[] = []
    socket.on('data', (data: Buffer) => received.push(data))
    const responses = async (count: number): Promise<string> => {
      await waitFor(() => (Buffer.concat(received).toString().match(/HTTP\/1\.1 \d{3} /g)?.length ?? 0) >= count, 5000)
      return Buffer.concat(received).toString()
    }
    const body = JSON.stringify({ operation: 'download', objects: [{ oid: 'f'.repeat(64), size: 1 }] })
    socket.write(`POST /team/assets/objects/batch HTTP/1.1\r\nHost: localhost\r\nContent-Type: ${LFS_JSON_MEDIA_TYPE}\r\nContent-Length: ${body.length}\r\n\r\n`)
    expect(await responses(1)).toMatch(/^HTTP\/1\.1 401 /)
    socket.write(body)
    socket.write('GET /_health HTTP/1.1\r\nHost: localhost\r\n\r\n')
    expect(await responses(2)).toMatch(/HTTP\/1\.1 200 OK[\s\S]*\{"status":"ok"\}$/)
  })

  it('uses the LFS JSON error format for routing, method, body and malformed HTTP errors', async () => {
    const server = await start()
    await expectLfsError(await fetch(`${server.url}/nowhere`), 404)
    await expectLfsError(await fetch(`${server.url}/team/assets/objects/batch`, { headers: auth }), 405)
    await expectLfsError(await fetch(`${server.url}/team/assets/objects/batch`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': LFS_JSON_MEDIA_TYPE },
      body: 'not json',
    }), 400)

    const raw = await new Promise<string>((resolve, reject) => {
      const { port } = new URL(server.url)
      const socket = connect(Number(port), '127.0.0.1', () => socket.write('NOT HTTP\r\n\r\n'))
      const chunks: Buffer[] = []
      socket.on('data', chunk => chunks.push(chunk))
      socket.on('end', () => resolve(Buffer.concat(chunks).toString()))
      socket.on('error', reject)
    })
    expect(raw).toMatch(/^HTTP\/1\.1 400 Bad Request/)
    expect(raw).toContain(`Content-Type: ${LFS_JSON_MEDIA_TYPE}`)
    expect(JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4))).toMatchObject({ request_id: expect.any(String) })
  })

  it('keeps tokens, Authorization headers and signed URLs out of logs', async () => {
    const failing: ObjectStorage = {
      inspectObject: async () => {
        throw new Error(`upstream https://bucket.example.com/key?q-signature=abc failed for ${secret}`)
      },
      putObject: async () => ({ size: 0, verified: false }),
      readObject: async () => undefined,
      verifyObject: async () => ({ status: 'missing' }),
    }
    const server = await start()
    const oid = 'd'.repeat(64)
    const uploadBatch = await batch(server.url, 'team/assets', 'upload', oid, 4, auth)
    expect((await fetch(getAction(uploadBatch, 'upload').href, { method: 'PUT', body: 'data', headers: auth })).status).toBe(200)
    expect((await postJson(getAction(uploadBatch, 'verify').href, { oid, size: 4 }, auth)).status).toBe(200)
    const download = getAction(await batch(server.url, 'team/assets', 'download', oid, 4, auth), 'download')
    expect((await fetch(download.href, { headers: auth })).status).toBe(200)
    await batchRequest(server.url, 'team/assets', 'upload', oid, 4)
    await running!.close()

    const broken = await start({ storage: failing })
    const failure = await batchRequest(broken.url, 'team/assets', 'download', oid, 4, auth)
    await expectLfsError(failure, 500, /^Internal server error$/)

    await waitFor(() => logs.length >= 7, 1000)
    // Entries are written when a response closes, so the download, which ends
    // only after the file stream does, may be logged after the next request.
    expect(logs.map(entry => entry.status).sort()).toEqual([200, 200, 200, 200, 200, 401, 500])
    expect(logs.every(entry => !entry.path.includes('?'))).toBe(true)
    expect(logs.filter(entry => entry.status === 200).every(entry => entry.tokenId?.startsWith('tok_'))).toBe(true)
    expect(logs.at(-1)?.error).toContain('[url]')
    const serialized = JSON.stringify(logs)
    for (const forbidden of [secret, auth.Authorization!, 'signature', 'expires=', 'https://', 'http://'])
      expect(serialized).not.toContain(forbidden)
  })

  it('redacts credentials and URLs from free-form log text', () => {
    expect(redactLogText('GET https://b.cos.example.com/k?q-signature=x ok')).toBe('GET [url] ok')
    expect(redactLogText('token ybx_abc-DEF_123 used')).toBe('token [token] used')
    expect(redactLogText('Authorization: Basic eW91OnNlY3JldA==')).toBe('Authorization: Basic [redacted]')
    expect(redactLogText('q-ak=AKID&signature=abc')).toBe('q-ak=[redacted]&signature=[redacted]')
    expect(describeErrorForLog(new Error('x', { cause: new Error('see http://h/p?a=1') }))).toBe('Error: x (cause: Error: see [url])')
  })
})

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline)
    await delay(10)
}
