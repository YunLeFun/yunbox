// @env node

import type { LfsAction, RepositoryId } from '@yunbox/core'
import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { assertObjectSize, ValidationError } from '@yunbox/core'

type TransferMethod = 'GET' | 'PUT'

interface CreateActionOptions {
  baseUrl: string
  method: TransferMethod
  repository: RepositoryId
  oid: string
  size: number
  headers: Record<string, string>
  expiresInSeconds: number
}

interface VerifyActionOptions {
  method: TransferMethod
  repository: RepositoryId
  oid: string
  searchParams: URLSearchParams
}

/**
 * Signs server-hosted PUT / GET action URLs with a per-process HMAC key.
 *
 * The signature proves the server issued this exact action (method,
 * repository, oid, size, expiry). It does not identify the caller: transfer
 * requests must also pass Basic authentication with a token that still has
 * the required permission.
 */
export class SignedActionFactory {
  readonly #secret: Uint8Array

  constructor(secret: Uint8Array) {
    this.#secret = secret
  }

  create(options: CreateActionOptions): LfsAction {
    const expires = Math.floor(Date.now() / 1000) + options.expiresInSeconds
    const path = transferPath(options.repository, options.oid)
    const signature = this.#sign(options.method, path, options.size, expires)
    const url = new URL(path, options.baseUrl)
    url.searchParams.set('size', String(options.size))
    url.searchParams.set('expires', String(expires))
    url.searchParams.set('signature', signature)
    return {
      href: url.href,
      header: options.headers,
      expires_in: options.expiresInSeconds,
    }
  }

  verify(options: VerifyActionOptions): number {
    const size = parseInteger(options.searchParams.get('size'), 'size')
    assertObjectSize(size)
    const expires = parseInteger(options.searchParams.get('expires'), 'expires')
    if (expires < Math.floor(Date.now() / 1000))
      throw new ActionAuthorizationError('transfer action has expired')

    const supplied = options.searchParams.get('signature')
    if (supplied === null || !/^[a-f\d]{64}$/.test(supplied))
      throw new ActionAuthorizationError('transfer action signature is invalid')
    const path = transferPath(options.repository, options.oid)
    const expected = this.#sign(options.method, path, size, expires)
    if (!timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex')))
      throw new ActionAuthorizationError('transfer action signature is invalid')
    return size
  }

  #sign(method: TransferMethod, path: string, size: number, expires: number): string {
    return createHmac('sha256', this.#secret)
      .update(`${method}\n${path}\n${size}\n${expires}`)
      .digest('hex')
  }
}

export class ActionAuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActionAuthorizationError'
  }
}

function transferPath(repository: RepositoryId, oid: string): string {
  return `/${repository.owner}/${repository.repo}/objects/${oid}`
}

function parseInteger(value: string | null, name: string): number {
  if (value === null || !/^\d+$/.test(value))
    throw new ValidationError(`${name} must be an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed))
    throw new ValidationError(`${name} must be a safe integer`)
  return parsed
}
