// @env node

import type {
  LfsAction,
  LfsBatchResponse,
  LfsObject,
  LfsObjectResponse,
  ObjectStorage,
  RepositoryId,
} from '@yunbox/core'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SignedActionFactory } from './signed-actions.ts'
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  assertOid,
  assertRepository,
  LFS_JSON_MEDIA_TYPE,
  MAX_OBJECT_SIZE,
  ObjectTooLargeError,
  parseBatchRequest,
  parseLfsObject,
  ValidationError,
} from '@yunbox/core'
import { ActionAuthorizationError } from './signed-actions.ts'

const MAX_JSON_BODY_BYTES = 1024 * 1024

interface RequestHandlerOptions {
  storage: ObjectStorage
  actions: SignedActionFactory
  actionTtlSeconds: number
  getBaseUrl: () => string
  maxConcurrentTransfers: number
}

type Route
  = | { type: 'batch', repository: RepositoryId, searchParams: URLSearchParams }
    | { type: 'verify', repository: RepositoryId, searchParams: URLSearchParams }
    | { type: 'transfer', repository: RepositoryId, oid: string, searchParams: URLSearchParams }

class HttpError extends Error {
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
  const slots = new TransferSlots(options.maxConcurrentTransfers)
  return (request, response) => {
    void handleRequest(request, response, options, slots).catch(error => sendError(response, error))
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: RequestHandlerOptions,
  slots: TransferSlots,
): Promise<void> {
  const route = parseRoute(request.url)
  if (route === undefined)
    throw new HttpError(404, 'Route not found')

  if (route.type === 'batch') {
    requireMethod(request, 'POST')
    await handleBatch(request, response, route.repository, options)
    return
  }
  if (route.type === 'verify') {
    requireMethod(request, 'POST')
    await handleVerify(request, response, route.repository, options.storage)
    return
  }

  assertOid(route.oid)
  if (request.method !== 'PUT' && request.method !== 'GET')
    throw new HttpError(405, 'Transfer method not allowed', { Allow: 'GET, PUT' })
  const release = slots.acquire()
  if (release === undefined)
    throw new HttpError(503, 'Too many concurrent transfers', { 'Retry-After': '1' })
  try {
    if (request.method === 'PUT')
      await handleUpload(request, response, route, options)
    else
      await handleDownload(response, route, options)
  }
  finally {
    release()
  }
}

async function handleBatch(
  request: IncomingMessage,
  response: ServerResponse,
  repository: RepositoryId,
  options: RequestHandlerOptions,
): Promise<void> {
  const batch = parseBatchRequest(await readJson(request))
  if (batch.transfers !== undefined && !batch.transfers.includes('basic'))
    throw new HttpError(406, 'Only the basic transfer is supported')

  const objects = await Promise.all(batch.objects.map(async (object): Promise<LfsObjectResponse> => {
    const stored = await options.storage.inspectObject(repository, object.oid)
    if (batch.operation === 'upload') {
      if (stored?.verified && stored.size === object.size)
        return { ...object }
      return {
        ...object,
        actions: await createUploadActions(repository, object, options),
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
        })
      : await options.storage.createDownloadAction(repository, object, {
          expiresInSeconds: options.actionTtlSeconds,
        })
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
      })
    : await options.storage.createUploadAction(repository, object, {
        expiresInSeconds: options.actionTtlSeconds,
      })
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
    if (!Number.isSafeInteger(parsed) || parsed < 0)
      throw new HttpError(400, 'Content-Length is invalid')
    if (parsed > MAX_OBJECT_SIZE)
      throw new HttpError(413, 'Object body exceeds the service limit')
  }

  await options.storage.putObject(route.repository, route.oid, request, { maxBytes: MAX_OBJECT_SIZE })
  response.writeHead(200, {
    'Content-Length': '0',
    'X-Expected-Object-Size': String(expectedSize),
  })
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
  const object = await options.storage.readObject(route.repository, route.oid)
  if (object === undefined || object.size !== expectedSize)
    throw new HttpError(404, 'Object is not available for download')

  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(object.size),
  })
  await pipeline(Readable.from(object.body), response)
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

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'Content-Type': LFS_JSON_MEDIA_TYPE,
    'Content-Length': String(body.byteLength),
    ...headers,
  })
  response.end(body)
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  if (error instanceof HttpError) {
    sendJson(response, error.status, { message: error.message }, error.headers)
    return
  }
  if (error instanceof ActionAuthorizationError) {
    sendJson(response, 403, { message: error.message })
    return
  }
  if (error instanceof ValidationError) {
    sendJson(response, 422, { message: error.message })
    return
  }
  if (error instanceof ObjectTooLargeError) {
    sendJson(response, 413, { message: error.message })
    return
  }
  sendJson(response, 500, { message: 'Internal server error' })
}

class TransferSlots {
  readonly #limit: number
  #active = 0

  constructor(limit: number) {
    this.#limit = limit
  }

  acquire(): (() => void) | undefined {
    if (this.#active >= this.#limit)
      return undefined
    this.#active += 1
    return () => {
      this.#active -= 1
    }
  }
}
