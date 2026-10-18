// @env node

import type {
  LfsAction,
  LfsBatchResponse,
  LfsObject,
  LfsObjectResponse,
  ObjectStorage,
  RepositoryId,
  StoredObjectInfo,
} from '@yunbox/core'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RequestLogger } from './logging.ts'
import type { SignedActionFactory } from './signed-actions.ts'
import type { Authentication, TokenAuthenticator, TokenPermission, TokenSummary } from './tokens.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  assertOid,
  assertRepository,
  LFS_JSON_MEDIA_TYPE,
  ObjectTooLargeError,
  parseBatchRequest,
  parseLfsObject,
  ValidationError,
} from '@yunbox/core'
import { describeErrorForLog, loggablePath } from './logging.ts'
import { ActionAuthorizationError } from './signed-actions.ts'
import { RepositoryNotConfiguredError } from './storage-routes.ts'
import { permits, resolvePermission, TokenStoreUnavailableError } from './tokens.ts'

/** Largest accepted batch or verify request body. */
export const MAX_JSON_BODY_BYTES = 1024 * 1024

/**
 * Most bytes of an unread request body discarded after an early error
 * response; a body that fits keeps the connection reusable.
 */
export const MAX_DISCARDED_BODY_BYTES = MAX_JSON_BODY_BYTES

/** How long a connection stays open after an early error response, for the client to read it. */
export const LINGER_TIMEOUT_MS = 5000

/**
 * Unauthenticated liveness endpoint for container platforms. It answers
 * `GET` / `HEAD` with `{"status":"ok"}` and never touches storage or reveals
 * configuration. Repository owners must start with a letter or digit, so the
 * path cannot collide with an LFS route.
 */
export const HEALTH_PATH = '/_health'

/** Value of the `LFS-Authenticate` header sent with every 401 response. */
export const LFS_AUTHENTICATE = 'Basic realm="YunBox", charset="UTF-8"'

export interface RequestHandlerOptions {
  storage: ObjectStorage
  actions: SignedActionFactory
  authenticator: TokenAuthenticator
  actionTtlSeconds: number
  getBaseUrl: () => string
  maxConcurrentRequests: number
  maxConcurrentTransfers: number
  requestTimeoutMs: number
  log?: RequestLogger
}

type Route
  = | { type: 'batch', repository: RepositoryId, searchParams: URLSearchParams }
    | { type: 'verify', repository: RepositoryId, searchParams: URLSearchParams }
    | { type: 'transfer', repository: RepositoryId, oid: string, searchParams: URLSearchParams }

interface RequestContext {
  id: string
  startedAt: number
  tokenId?: string
  error?: string
}

interface Authorized {
  token: TokenSummary
  /** Seconds until actions issued for this request must expire. */
  actionExpiresInSeconds: number
}

/** An error with an HTTP status, rendered as an LFS JSON error body. */
export class HttpError extends Error {
  readonly status: number
  readonly headers?: Record<string, string>

  constructor(status: number, message: string, headers?: Record<string, string>) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.headers = headers
  }
}

export function createRequestHandler(options: RequestHandlerOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const apiSlots = new Slots(options.maxConcurrentRequests)
  const transferSlots = new Slots(options.maxConcurrentTransfers)
  return (request, response) => {
    // Successful probes are not logged: platforms send them every few seconds.
    if (isHealthCheck(request)) {
      sendHealth(request, response)
      return
    }
    const context: RequestContext = { id: randomUUID(), startedAt: performance.now() }
    response.once('close', () => {
      options.log?.({
        time: new Date().toISOString(),
        requestId: context.id,
        method: request.method ?? '',
        path: loggablePath(request.url),
        status: response.statusCode,
        durationMs: Math.round(performance.now() - context.startedAt),
        ...(context.tokenId === undefined ? {} : { tokenId: context.tokenId }),
        ...(context.error === undefined ? {} : { error: context.error }),
        ...(response.writableFinished ? {} : { aborted: true }),
      })
    })
    void handleRequest(request, response, options, context, apiSlots, transferSlots)
      .catch(error => sendError(request, response, context, error))
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: RequestHandlerOptions,
  context: RequestContext,
  apiSlots: Slots,
  transferSlots: Slots,
): Promise<void> {
  if (requestPath(request.url) === HEALTH_PATH)
    throw new HttpError(405, 'Method must be GET or HEAD', { Allow: 'GET, HEAD' })
  const route = parseRoute(request.url)
  if (route === undefined)
    throw new HttpError(404, 'Route not found')

  if (route.type === 'transfer') {
    assertOid(route.oid)
    if (request.method !== 'PUT' && request.method !== 'GET')
      throw new HttpError(405, 'Transfer method not allowed', { Allow: 'GET, PUT' })
    const { putObject, readObject } = options.storage
    if ((request.method === 'PUT' ? putObject : readObject) === undefined)
      throw new HttpError(404, 'Route not found')
    const release = acquire(transferSlots, 'Too many concurrent transfers')
    try {
      await authorize(request, options, context, route.repository, request.method === 'PUT' ? 'write' : 'read')
      if (request.method === 'PUT')
        await handleUpload(request, response, route, options)
      else
        await handleDownload(response, route, options)
    }
    finally {
      release()
    }
    return
  }

  requireMethod(request, 'POST')
  const timer = setTimeout(() => {
    sendError(request, response, context, request.complete
      ? new HttpError(503, 'Request timed out', { 'Retry-After': '1' })
      : new HttpError(408, 'Request body was not received in time'))
  }, options.requestTimeoutMs)
  response.once('close', () => clearTimeout(timer))
  const release = acquire(apiSlots, 'Too many concurrent requests')
  try {
    if (route.type === 'batch') {
      const authentication = await authenticate(request, options, context)
      const batch = parseBatchRequest(await readJson(request))
      const authorized = requirePermission(authentication, options, route.repository, batch.operation === 'upload' ? 'write' : 'read')
      if (batch.transfers !== undefined && !batch.transfers.includes('basic'))
        throw new HttpError(406, 'Only the basic transfer is supported')
      await handleBatch(response, route.repository, batch, authorized, options)
    }
    else {
      await authorize(request, options, context, route.repository, 'write')
      await handleVerify(request, response, route.repository, options.storage)
    }
  }
  finally {
    release()
  }
}

async function authenticate(request: IncomingMessage, options: RequestHandlerOptions, context: RequestContext): Promise<Authentication> {
  const authentication = await options.authenticator.authenticate(parseBasicPassword(request.headers.authorization))
  if (authentication.token === undefined)
    throw new HttpError(401, 'Credentials are missing or invalid', { 'LFS-Authenticate': LFS_AUTHENTICATE })
  context.tokenId = authentication.token.id
  return authentication
}

async function authorize(
  request: IncomingMessage,
  options: RequestHandlerOptions,
  context: RequestContext,
  repository: RepositoryId,
  required: TokenPermission,
): Promise<Authorized> {
  return requirePermission(await authenticate(request, options, context), options, repository, required)
}

function requirePermission(
  authentication: Authentication,
  options: RequestHandlerOptions,
  repository: RepositoryId,
  required: TokenPermission,
): Authorized {
  const token = authentication.token!
  const granted = resolvePermission(authentication.grant, repository)
  if (!permits(granted, required)) {
    throw new HttpError(403, granted === 'read'
      ? 'This token has read-only access to the repository'
      : 'This token has no access to the repository')
  }
  // Actions expire relative to the token snapshot that authorized them, so a
  // revocation is fully effective at most actionTtlSeconds after it is saved,
  // and never outlive the token itself.
  const expiresAt = Math.min(
    Math.floor(authentication.snapshotAt / 1000) + options.actionTtlSeconds,
    Math.floor(Date.parse(token.expiresAt) / 1000),
  )
  return {
    token,
    actionExpiresInSeconds: Math.max(1, expiresAt - Math.floor(Date.now() / 1000)),
  }
}

/** Extract the password from an HTTP Basic `Authorization` header. The user name is ignored. */
export function parseBasicPassword(header: string | undefined): string | undefined {
  const match = header === undefined ? null : /^Basic +([A-Z\d+/]+=*) *$/i.exec(header)
  if (match === null)
    return undefined
  const decoded = Buffer.from(match[1]!, 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  return separator === -1 ? undefined : decoded.slice(separator + 1)
}

async function handleBatch(
  response: ServerResponse,
  repository: RepositoryId,
  batch: ReturnType<typeof parseBatchRequest>,
  authorized: Authorized,
  options: RequestHandlerOptions,
): Promise<void> {
  const expiresInSeconds = authorized.actionExpiresInSeconds
  const objects = await Promise.all(batch.objects.map(async (object): Promise<LfsObjectResponse> => {
    const stored = await options.storage.inspectObject(repository, object.oid)
    if (batch.operation === 'upload') {
      if (stored?.verified && stored.size === object.size)
        return { ...object }
      return {
        ...object,
        actions: await createUploadActions(repository, object, stored, expiresInSeconds, options),
      }
    }

    if (!stored?.verified || stored.size !== object.size) {
      return {
        ...object,
        error: { code: 404, message: 'Object is not available for download' },
      }
    }
    const download = options.storage.createDownloadAction === undefined
      ? options.actions.create({
          baseUrl: options.getBaseUrl(),
          method: 'GET',
          repository,
          oid: object.oid,
          size: object.size,
          headers: { Accept: 'application/octet-stream' },
          expiresInSeconds,
        })
      : await options.storage.createDownloadAction(repository, object, { expiresInSeconds, stored })
    return {
      ...object,
      actions: {
        download,
      },
    }
  }))

  const result: LfsBatchResponse = { transfer: 'basic', objects }
  sendJson(response, 200, result)
}

async function createUploadActions(
  repository: RepositoryId,
  object: LfsObject,
  stored: StoredObjectInfo | undefined,
  expiresInSeconds: number,
  options: RequestHandlerOptions,
): Promise<{ upload: LfsAction, verify: LfsAction }> {
  const baseUrl = options.getBaseUrl()
  const upload = options.storage.createUploadAction === undefined
    ? options.actions.create({
        baseUrl,
        method: 'PUT',
        repository,
        oid: object.oid,
        size: object.size,
        headers: { 'Content-Type': 'application/octet-stream' },
        expiresInSeconds,
      })
    : await options.storage.createUploadAction(repository, object, { expiresInSeconds, stored })
  return {
    upload,
    verify: {
      href: new URL(`/${repository.owner}/${repository.repo}/objects/verify`, baseUrl).href,
      header: {
        'Accept': LFS_JSON_MEDIA_TYPE,
        'Content-Type': LFS_JSON_MEDIA_TYPE,
      },
    },
  }
}

async function handleVerify(
  request: IncomingMessage,
  response: ServerResponse,
  repository: RepositoryId,
  storage: ObjectStorage,
): Promise<void> {
  const object = parseLfsObject(await readJson(request))
  const result = await storage.verifyObject(repository, object.oid, object.size)
  switch (result.status) {
    case 'verified':
      sendJson(response, 200, {})
      return
    case 'missing':
      throw new HttpError(404, 'Object not found')
    case 'size-mismatch':
      throw new HttpError(422, `Object size mismatch: expected ${object.size}, received ${result.actualSize}`)
    case 'changed':
      throw new HttpError(409, 'Object changed while it was being verified')
  }
}

async function handleUpload(
  request: IncomingMessage,
  response: ServerResponse,
  route: Extract<Route, { type: 'transfer' }>,
  options: RequestHandlerOptions,
): Promise<void> {
  const expectedSize = options.actions.verify({
    method: 'PUT',
    repository: route.repository,
    oid: route.oid,
    searchParams: route.searchParams,
  })
  const contentLength = request.headers['content-length']
  if (contentLength !== undefined) {
    const parsed = Number(contentLength)
    if (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(parsed))
      throw new HttpError(400, 'Content-Length is invalid')
    if (parsed > expectedSize)
      throw new HttpError(413, 'Object body is larger than the size in the upload action')
  }

  await options.storage.putObject!(route.repository, route.oid, request, { maxBytes: expectedSize })
  response.writeHead(200, { 'Content-Length': '0' })
  response.end()
}

async function handleDownload(
  response: ServerResponse,
  route: Extract<Route, { type: 'transfer' }>,
  options: RequestHandlerOptions,
): Promise<void> {
  const expectedSize = options.actions.verify({
    method: 'GET',
    repository: route.repository,
    oid: route.oid,
    searchParams: route.searchParams,
  })
  const info = await options.storage.inspectObject(route.repository, route.oid)
  if (!info?.verified || info.size !== expectedSize)
    throw new HttpError(404, 'Object is not available for download')
  const object = await options.storage.readObject!(route.repository, route.oid)
  if (object === undefined || object.size !== expectedSize)
    throw new HttpError(404, 'Object is not available for download')

  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(object.size),
  })
  await pipeline(Readable.from(object.body), response)
}

function requestPath(rawUrl: string | undefined): string | undefined {
  if (rawUrl === undefined)
    return undefined
  const queryIndex = rawUrl.indexOf('?')
  return queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex)
}

function isHealthCheck(request: IncomingMessage): boolean {
  return (request.method === 'GET' || request.method === 'HEAD') && requestPath(request.url) === HEALTH_PATH
}

function sendHealth(request: IncomingMessage, response: ServerResponse): void {
  const body = Buffer.from('{"status":"ok"}')
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
  })
  response.end(request.method === 'HEAD' ? undefined : body)
}

function parseRoute(rawUrl: string | undefined): Route | undefined {
  if (rawUrl === undefined)
    return undefined
  const queryIndex = rawUrl.indexOf('?')
  const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex)
  const rawQuery = queryIndex === -1 ? '' : rawUrl.slice(queryIndex + 1)
  const segments = rawPath.split('/')
  if (segments.length !== 5 || segments[0] !== '' || segments[3] !== 'objects')
    return undefined

  let owner: string
  let repo: string
  let endpoint: string
  try {
    owner = decodeURIComponent(segments[1] ?? '')
    repo = decodeURIComponent(segments[2] ?? '')
    endpoint = decodeURIComponent(segments[4] ?? '')
  }
  catch {
    throw new ValidationError('repository path contains malformed encoding')
  }
  const repository = { owner, repo }
  assertRepository(repository)
  const searchParams = new URLSearchParams(rawQuery)
  if (endpoint === 'batch')
    return { type: 'batch', repository, searchParams }
  if (endpoint === 'verify')
    return { type: 'verify', repository, searchParams }
  return { type: 'transfer', repository, oid: endpoint, searchParams }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentLength = Number(request.headers['content-length'])
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES)
    throw new HttpError(413, 'JSON request body is too large')
  const chunks: Buffer[] = []
  let receivedBytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    receivedBytes += buffer.byteLength
    if (receivedBytes > MAX_JSON_BODY_BYTES)
      throw new HttpError(413, 'JSON request body is too large')
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  }
  catch {
    throw new HttpError(400, 'Request body must be valid JSON')
  }
}

function requireMethod(request: IncomingMessage, method: string): void {
  if (request.method !== method)
    throw new HttpError(405, `Method must be ${method}`, { Allow: method })
}

function acquire(slots: Slots, message: string): () => void {
  const release = slots.acquire()
  if (release === undefined)
    throw new HttpError(503, message, { 'Retry-After': '1' })
  return release
}

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'Content-Type': LFS_JSON_MEDIA_TYPE,
    'Content-Length': String(body.byteLength),
    ...headers,
  })
  response.end(body)
}

function sendError(request: IncomingMessage, response: ServerResponse, context: RequestContext, error: unknown): void {
  if (response.headersSent) {
    context.error ??= describeErrorForLog(error)
    response.destroy()
    return
  }
  const { status, message, headers } = toHttpError(error)
  if (status >= 500)
    context.error ??= describeErrorForLog(error)
  const body = { message, request_id: context.id }
  if (request.complete || request.destroyed) {
    sendJson(response, status, body, headers)
    return
  }
  if (request.readableFlowing === null) {
    // Nothing of the body has been read yet, typically the 401 for git-lfs's
    // first upload, which it sends without credentials.
    lingerAfterEarlyResponse(request)
    sendJson(response, status, body, headers)
    return
  }
  // A partly read body is not drained into the void.
  sendJson(response, status, body, { ...headers, Connection: 'close' })
}

/**
 * Keep a connection open after an error response that was sent before its
 * request body was read: discard up to {@link MAX_DISCARDED_BODY_BYTES} of the
 * body, then stop reading. A body that ends within the limit leaves the
 * connection usable; otherwise it is closed after {@link LINGER_TIMEOUT_MS}
 * unless the client hangs up first.
 *
 * Closing a socket that still has unread data makes the kernel answer with a
 * reset. A client that is still writing the body (git-lfs sends the first
 * upload of a fresh repository without credentials) can then fail with EPIPE
 * or ECONNRESET before it reads the 401, and never retries with credentials.
 * Once reading stops, TCP flow control holds the client back, so nothing is
 * buffered beyond the socket's own buffers.
 */
function lingerAfterEarlyResponse(request: IncomingMessage): void {
  const { socket } = request
  let discardedBytes = 0
  const timer = setTimeout(() => socket.destroy(), LINGER_TIMEOUT_MS)
  const stop = (): void => {
    clearTimeout(timer)
    socket.off('close', stop)
  }
  socket.once('close', stop)
  // A fully discarded body leaves the connection usable for the next request.
  request.once('end', stop)
  request.on('data', (chunk: Buffer) => {
    discardedBytes += chunk.byteLength
    if (discardedBytes > MAX_DISCARDED_BODY_BYTES)
      request.pause()
  })
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError)
    return error
  if (error instanceof ActionAuthorizationError)
    return new HttpError(403, error.message)
  if (error instanceof ValidationError)
    return new HttpError(422, error.message)
  if (error instanceof ObjectTooLargeError)
    return new HttpError(413, 'Object body is larger than the size in the upload action')
  if (error instanceof TokenStoreUnavailableError)
    return new HttpError(503, 'Authentication is temporarily unavailable', { 'Retry-After': '5' })
  if (error instanceof RepositoryNotConfiguredError)
    return new HttpError(404, error.message)
  return new HttpError(500, 'Internal server error')
}

class Slots {
  readonly #limit: number
  #active = 0

  constructor(limit: number) {
    this.#limit = limit
  }

  acquire(): (() => void) | undefined {
    if (this.#active >= this.#limit)
      return undefined
    this.#active += 1
    let released = false
    return () => {
      if (released)
        return
      released = true
      this.#active -= 1
    }
  }
}
