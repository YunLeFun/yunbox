// @env node

import type { AddressInfo } from 'node:net'
import type { RunningYunBoxServer, YunBoxServerOptions } from './types.ts'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, STATUS_CODES } from 'node:http'
import { isIP } from 'node:net'
import { DEFAULT_ACTION_TTL_SECONDS, LFS_JSON_MEDIA_TYPE } from '@yunbox/core'
import { createRequestHandler } from './request-handler.ts'
import { SignedActionFactory } from './signed-actions.ts'
import { TokenAuthenticator } from './tokens.ts'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8080
const DEFAULT_MAX_CONCURRENT_REQUESTS = 32
const DEFAULT_MAX_CONCURRENT_TRANSFERS = 4
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_IDLE_TIMEOUT_MS = 30_000
const DEFAULT_TOKEN_CACHE_TTL_SECONDS = 30
const MAX_HEADERS_TIMEOUT_MS = 10_000
/** How often Node checks the headers timeout; its 30 s default would let slow headers linger that long. */
const CONNECTIONS_CHECKING_INTERVAL_MS = 1000

/**
 * Start the YunBox Git LFS server.
 *
 * Every endpoint requires HTTP Basic authentication with a personal token
 * from `options.tokens`. The server listens on `127.0.0.1` unless `host` says
 * otherwise; any non-loopback host also requires an `https` `publicUrl`,
 * which is then the base of every action and verify URL.
 */
export async function startYunBoxServer(options: YunBoxServerOptions): Promise<RunningYunBoxServer> {
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? DEFAULT_PORT
  const actionTtlSeconds = options.actionTtlSeconds ?? DEFAULT_ACTION_TTL_SECONDS
  const tokenCacheTtlSeconds = options.tokenCacheTtlSeconds ?? DEFAULT_TOKEN_CACHE_TTL_SECONDS
  const maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS
  const maxConcurrentTransfers = options.maxConcurrentTransfers ?? DEFAULT_MAX_CONCURRENT_TRANSFERS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  assertIntegerInRange(port, 0, 65_535, 'port')
  assertIntegerInRange(actionTtlSeconds, 1, 3600, 'actionTtlSeconds')
  assertIntegerInRange(tokenCacheTtlSeconds, 0, actionTtlSeconds - 1, 'tokenCacheTtlSeconds')
  assertIntegerInRange(maxConcurrentRequests, 1, 10_000, 'maxConcurrentRequests')
  assertIntegerInRange(maxConcurrentTransfers, 1, 1000, 'maxConcurrentTransfers')
  assertIntegerInRange(requestTimeoutMs, 100, 10 * 60_000, 'requestTimeoutMs')
  assertIntegerInRange(idleTimeoutMs, 100, 60 * 60_000, 'idleTimeoutMs')
  const publicUrl = resolvePublicUrl(host, options.publicUrl)
  const { storage } = options
  if (storage.putObject === undefined && storage.createUploadAction === undefined)
    throw new TypeError('storage must implement putObject or createUploadAction')
  if (storage.readObject === undefined && storage.createDownloadAction === undefined)
    throw new TypeError('storage must implement readObject or createDownloadAction')

  let listenUrl = ''
  const handler = createRequestHandler({
    storage,
    actions: new SignedActionFactory(randomBytes(32)),
    authenticator: new TokenAuthenticator(options.tokens, { cacheTtlMs: tokenCacheTtlSeconds * 1000 }),
    actionTtlSeconds,
    getBaseUrl: () => publicUrl ?? listenUrl,
    maxConcurrentRequests,
    maxConcurrentTransfers,
    requestTimeoutMs,
    log: options.log,
  })
  const server = createServer({ connectionsCheckingInterval: CONNECTIONS_CHECKING_INTERVAL_MS }, handler)
  // Batch and verify have a per-request deadline in the handler; transfers
  // may legitimately take longer than that, so they are bounded by socket
  // inactivity instead of a total deadline.
  server.requestTimeout = 0
  server.headersTimeout = Math.min(requestTimeoutMs, MAX_HEADERS_TIMEOUT_MS)
  server.timeout = idleTimeoutMs
  server.keepAliveTimeout = 5000
  server.maxRequestsPerSocket = 100
  server.on('clientError', (error: NodeJS.ErrnoException, socket) => {
    if (!socket.writable || error.code === 'ECONNRESET') {
      socket.destroy()
      return
    }
    const status = error.code === 'ERR_HTTP_REQUEST_TIMEOUT'
      ? 408
      : error.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400
    const requestId = randomUUID()
    const body = JSON.stringify({ message: STATUS_CODES[status], request_id: requestId })
    socket.end([
      `HTTP/1.1 ${status} ${STATUS_CODES[status]}`,
      `Content-Type: ${LFS_JSON_MEDIA_TYPE}`,
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ].join('\r\n'))
    options.log?.({ time: new Date().toISOString(), requestId, method: '', path: '', status, durationMs: 0 })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error)
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      const address = server.address() as AddressInfo
      listenUrl = `http://${formatHost(address.address)}:${address.port}`
      resolve()
    })
  })

  let closePromise: Promise<void> | undefined
  return {
    url: listenUrl,
    publicUrl: publicUrl ?? listenUrl,
    server,
    close: () => {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.closeIdleConnections()
        server.close((error) => {
          if (error)
            reject(error)
          else
            resolve()
        })
      })
      return closePromise
    },
  }
}

/** Whether a listen host only accepts connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1')
    return true
  return isIP(host) === 4 && host.startsWith('127.')
}

function resolvePublicUrl(host: string, value: string | undefined): string | undefined {
  const loopback = isLoopbackHost(host)
  if (value === undefined) {
    if (!loopback)
      throw new TypeError(`publicUrl (https) is required when listening on ${host}, which is not a loopback address`)
    return undefined
  }
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw new TypeError('publicUrl must be an absolute URL')
  }
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    throw new TypeError(loopback ? 'publicUrl must use http or https' : 'publicUrl must use https when listening on a non-loopback address')
  if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '')
    throw new TypeError('publicUrl must be an origin without credentials, path, query or fragment')
  return url.origin
}

function formatHost(address: string): string {
  return isIP(address) === 6 ? `[${address}]` : address
}

function assertIntegerInRange(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`)
}
