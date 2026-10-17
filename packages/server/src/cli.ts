#!/usr/bin/env node
// @env node

import type { CommandIo } from './token-command.ts'
import type { RunningYunBoxServer } from './types.ts'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { resolveServeConfig } from './config.ts'
import { startYunBoxServer } from './server.ts'
import { configureStorage } from './storage-config.ts'
import { runGrantCommand, runTokenCommand, tokenHelp } from './token-command.ts'

const help = `YunBox Git LFS server.

Usage:
  yunbox-server [serve] [options]
  yunbox-server token create | list | revoke | migrate ...   (see yunbox-server token --help)
  yunbox-server grant list | set ...

Serve options (each falls back to an environment variable, then a default):
  --host          Listen address; YUNBOX_HOST (default: 127.0.0.1)
  --port          Port, or 0 for an ephemeral port; YUNBOX_PORT, then PORT (default: 8080)
  --public-url    External https origin, required when the host is not a loopback
                  address; YUNBOX_PUBLIC_URL
  --storage       local: files under the storage directory; cos: Tencent Cloud COS;
                  YUNBOX_STORAGE (default: local)
  --storage-dir   Local object storage directory; YUNBOX_STORAGE_DIR (default: .yunbox-data)
  --metadata      Where tokens, grants, locks and the audit log live: local or
                  cloudbase; YUNBOX_METADATA (default: cloudbase with COS storage,
                  local otherwise)
  --metadata-dir  Local metadata directory; YUNBOX_METADATA_DIR
                  (default: <storage-dir>/_yunbox/metadata)
  --help, -h      Show this help

Command-line options override environment variables. The configuration is
checked before the server starts; every problem is reported and the process
exits with status 1. Problems name settings, never their values.

Every request except GET /_health needs HTTP Basic authentication whose
password is a token from "yunbox-server token create". COS storage reads
YUNBOX_COS_BUCKET, YUNBOX_COS_REGION, optional YUNBOX_COS_PREFIX, and
credentials from TENCENTCLOUD_SECRETID, TENCENTCLOUD_SECRETKEY and
TENCENTCLOUD_SESSIONTOKEN. CloudBase metadata reads YUNBOX_CLOUDBASE_ENV,
optional YUNBOX_CLOUDBASE_ENDPOINT and YUNBOX_CLOUDBASE_COLLECTION_PREFIX, and
signs requests with the same TENCENTCLOUD_* keys unless YUNBOX_CLOUDBASE_API_KEY
is set. Access logs are JSON lines on stdout and never contain tokens or URLs.
`

/**
 * Run the `yunbox-server` command line.
 *
 * @returns The running server for `serve`, which stops on SIGINT or SIGTERM.
 */
export async function main(argv: string[], io: CommandIo): Promise<RunningYunBoxServer | undefined> {
  if (argv[0] === 'token') {
    await runTokenCommand(argv.slice(1), io)
    return undefined
  }
  if (argv[0] === 'grant') {
    await runGrantCommand(argv.slice(1), io)
    return undefined
  }
  return await serve(argv[0] === 'serve' ? argv.slice(1) : argv, io)
}

async function serve(args: string[], io: CommandIo): Promise<RunningYunBoxServer | undefined> {
  const { values } = parseArgs({
    args,
    options: {
      'host': { type: 'string' },
      'port': { type: 'string' },
      'public-url': { type: 'string' },
      'storage': { type: 'string' },
      'storage-dir': { type: 'string' },
      'metadata': { type: 'string' },
      'metadata-dir': { type: 'string' },
      'help': { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    io.stdout(help)
    io.stdout(tokenHelp)
    return undefined
  }

  const config = resolveServeConfig(values, io.env)
  const { storage, metadata, legacyTokens, description } = configureStorage({ ...config.storage, env: io.env })
  const existing = await metadata.tokens.list()
  // Only consulted while the store is empty, to point at a forgotten migration.
  const legacy = existing.length === 0 ? await legacyTokens.read() : undefined
  const running = await startYunBoxServer({
    storage,
    metadata,
    host: config.host,
    port: config.port,
    publicUrl: config.publicUrl,
    log: entry => io.stdout(JSON.stringify(entry)),
  })
  io.stdout(`YunBox is listening on ${running.url}; clients use ${running.publicUrl}`)
  io.stdout(description)
  if (legacy !== undefined)
    io.stdout(`Tokens from an earlier version exist in ${legacyTokens.description} but are no longer read. Run "yunbox-server token migrate".`)
  else if (existing.length === 0)
    io.stdout('No tokens exist yet, so every request is rejected. Create one with "yunbox-server token create".')

  // close() is idempotent, so a second signal is harmless.
  const onSignal = (): void => void running.close()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return {
    ...running,
    close: async () => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      await running.close()
    },
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(resolve(process.argv[1]))) {
  main(process.argv.slice(2), { stdout: line => console.log(line), env: process.env }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'yunbox-server failed')
    process.exitCode = 1
  })
}
