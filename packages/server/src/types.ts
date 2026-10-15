import type { ObjectStorage } from '@yunbox/core'
import type { Server } from 'node:http'

/** Options for starting a local-only YunBox Git LFS server. */
export interface YunBoxServerOptions {
  storage: ObjectStorage
  port?: number
  actionTtlSeconds?: number
  maxConcurrentTransfers?: number
  requestTimeoutMs?: number
}

/** A listening YunBox server and its loopback base URL. */
export interface RunningYunBoxServer {
  url: string
  server: Server
  close: () => Promise<void>
}
