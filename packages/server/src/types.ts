import type { ObjectStorage } from '@yunbox/core'
import type { Server } from 'node:http'
import type { RequestLogger } from './logging.ts'
import type { TokenStore } from './tokens.ts'

/** Options for starting a YunBox Git LFS server. */
export interface YunBoxServerOptions {
  storage: ObjectStorage
  /** Personal tokens accepted as the HTTP Basic password. */
  tokens: TokenStore
  /** Listen address (default `127.0.0.1`). Non-loopback hosts require an https `publicUrl`. */
  host?: string
  port?: number
  /**
   * External origin clients use, such as `https://lfs.example.com`. Action and
   * verify URLs are built from it. Defaults to the listen URL on loopback.
   */
  publicUrl?: string
  /** Lifetime of upload / download URLs, in seconds (default 300). */
  actionTtlSeconds?: number
  /** How long a token store snapshot is reused, in seconds (default 30, must be below `actionTtlSeconds`). */
  tokenCacheTtlSeconds?: number
  /** Concurrent batch and verify requests before answering 503 (default 32). */
  maxConcurrentRequests?: number
  /** Concurrent server-hosted PUT / GET transfers before answering 503 (default 4). */
  maxConcurrentTransfers?: number
  /** Deadline for a whole batch or verify request, in milliseconds (default 30000). */
  requestTimeoutMs?: number
  /** Socket inactivity timeout, which also bounds stalled transfers, in milliseconds (default 30000). */
  idleTimeoutMs?: number
  /** Access log sink. Entries are already redacted. */
  log?: RequestLogger
}

/** A listening YunBox server. */
export interface RunningYunBoxServer {
  /** The address the server is listening on. */
  url: string
  /** The origin used in action and verify URLs. */
  publicUrl: string
  server: Server
  close: () => Promise<void>
}
