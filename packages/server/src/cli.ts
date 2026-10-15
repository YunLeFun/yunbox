// @env node

import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { LocalFileObjectStorage } from '@yunbox/core'
import { startYunBoxServer } from './server.ts'

const help = `Start the YunBox M1 Git LFS server (local testing only).

Usage:
  pnpm --filter @yunbox/server start [--port 8080] [--storage-dir .yunbox-data]

Options:
  --port          Loopback port, or 0 for an ephemeral port (default: 8080)
  --storage-dir   Local object storage directory (default: .yunbox-data)
  --help, -h      Show this help
`

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'port': { type: 'string', default: '8080' },
      'storage-dir': { type: 'string', default: '.yunbox-data' },
      'help': { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log(help)
    return
  }

  const port = parsePort(values.port)
  const storageDirectory = resolve(values['storage-dir'])
  const running = await startYunBoxServer({
    storage: new LocalFileObjectStorage(storageDirectory),
    port,
  })
  console.log(`YunBox is listening on ${running.url}`)
  console.log(`Objects are stored in ${storageDirectory}`)
  console.log('M1 has no authentication and is not suitable for production use.')

  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping)
      return
    stopping = true
    await running.close()
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value))
    throw new Error('port must be an integer from 0 to 65535')
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error('port must be an integer from 0 to 65535')
  return port
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Unable to start YunBox')
    process.exitCode = 1
  })
}
