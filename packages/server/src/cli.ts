// @env node

import type { ObjectStorage } from '@yunbox/core'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { LocalFileObjectStorage } from '@yunbox/core'
import { startYunBoxServer } from './server.ts'
import { createCosStorageFromEnvironment } from './storage-config.ts'

const help = `Start the YunBox Git LFS server (local testing only, no authentication yet).

Usage:
  pnpm --filter @yunbox/server start [--port 8080] [--storage local|cos] [--storage-dir .yunbox-data]

Options:
  --port          Loopback port, or 0 for an ephemeral port (default: 8080)
  --storage       local: files under --storage-dir; cos: Tencent Cloud COS (default: local)
  --storage-dir   Local object storage directory (default: .yunbox-data)
  --help, -h      Show this help

COS storage reads YUNBOX_COS_BUCKET, YUNBOX_COS_REGION, optional YUNBOX_COS_PREFIX,
and credentials from TENCENTCLOUD_SECRETID, TENCENTCLOUD_SECRETKEY and
TENCENTCLOUD_SESSIONTOKEN.
`

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'port': { type: 'string', default: '8080' },
      'storage': { type: 'string', default: 'local' },
      'storage-dir': { type: 'string', default: '.yunbox-data' },
      'help': { type: 'boolean', short: 'h' },
    },
  })
  if (values.help) {
    console.log(help)
    return
  }

  const port = parsePort(values.port)
  let storage: ObjectStorage
  let storageDescription: string
  if (values.storage === 'local') {
    const storageDirectory = resolve(values['storage-dir'])
    storage = new LocalFileObjectStorage(storageDirectory)
    storageDescription = `Objects are stored in ${storageDirectory}`
  }
  else if (values.storage === 'cos') {
    storage = createCosStorageFromEnvironment(process.env)
    storageDescription = 'Objects are stored in COS and transferred directly by Git LFS clients'
  }
  else {
    throw new Error('storage must be local or cos')
  }

  const running = await startYunBoxServer({ storage, port })
  console.log(`YunBox is listening on ${running.url}`)
  console.log(storageDescription)
  console.log('This server has no authentication yet and is not suitable for production use.')

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
