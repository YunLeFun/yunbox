// @env node

import type { AddressInfo } from 'node:net'
import type { RunningYunBoxServer, YunBoxServerOptions } from './types.ts'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { DEFAULT_ACTION_TTL_SECONDS } from '@yunbox/core'
import { createRequestHandler } from './request-handler.ts'
import { SignedActionFactory } from './signed-actions.ts'

const DEFAULT_PORT = 8080
const DEFAULT_MAX_CONCURRENT_TRANSFERS = 4
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Start a Git LFS server bound exclusively to the IPv4 loopback interface. */
export async function startYunBoxServer(options: YunBoxServerOptions): Promise<RunningYunBoxServer> {
  const port = options.port ?? DEFAULT_PORT
  const actionTtlSeconds = options.actionTtlSeconds ?? DEFAULT_ACTION_TTL_SECONDS
  const maxConcurrentTransfers = options.maxConcurrentTransfers ?? DEFAULT_MAX_CONCURRENT_TRANSFERS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  assertIntegerInRange(port, 0, 65_535, 'port')
  assertIntegerInRange(actionTtlSeconds, 1, 3600, 'actionTtlSeconds')
  assertIntegerInRange(maxConcurrentTransfers, 1, 1000, 'maxConcurrentTransfers')
  assertIntegerInRange(requestTimeoutMs, 1000, 10 * 60_000, 'requestTimeoutMs')
  const { storage } = options
  if (storage.putObject === undefined && storage.createUploadAction === undefined)
    throw new TypeError('storage must implement putObject or createUploadAction')
  if (storage.readObject === undefined && storage.createDownloadAction === undefined)
    throw new TypeError('storage must implement readObject or createDownloadAction')

  let baseUrl = ''
  const actions = new SignedActionFactory(randomBytes(32), actionTtlSeconds)
  const handler = createRequestHandler({
    storage: options.storage,
    actions,
    actionTtlSeconds,
    getBaseUrl: () => baseUrl,
    maxConcurrentTransfers,
  })
  const server = createServer(handler)
  server.requestTimeout = requestTimeoutMs
  server.headersTimeout = Math.min(requestTimeoutMs, 10_000)
  server.keepAliveTimeout = 5000
  server.maxRequestsPerSocket = 100

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error)
    }
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      const address = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })

  let closePromise: Promise<void> | undefined
  return {
    url: baseUrl,
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

function assertIntegerInRange(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`)
}
