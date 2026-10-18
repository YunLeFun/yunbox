// @env node

import type { CosBucketSummary, CosCredentials } from '@yunbox/core'
import type { CosRoute } from './storage-routes.ts'
import type { CommandIo } from './token-command.ts'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { cosAppIdOf, createCosBucket, listCosBuckets } from '@yunbox/core'
import {
  createRouteStorage,
  readStorageRoutes,
  readStorageRoutesFileOrEmpty,
  upsertRoute,
  writeStorageRoutes,
} from './storage-routes.ts'

/** Default storage configuration file, relative to the working directory. */
export const DEFAULT_STORAGE_CONFIG_FILE = 'yunbox.storage.json'
const DEFAULT_REGION = 'ap-guangzhou'
const DEFAULT_PREFIX = 'yunbox'

export const cosHelp = `Choose where YunBox keeps objects in Tencent Cloud COS.

Usage:
  yunbox-server cos setup [--config <file>] [--bucket <name>] [--region <region>]
                          [--create] [--prefix <prefix>] [--repos <pattern>] [--yes]
  yunbox-server cos list
  yunbox-server cos routes [--config <file>]
  yunbox-server cos check  [--config <file>]

setup lists the buckets of the account, lets you pick one or create a new
private bucket, asks for a key prefix and which repositories use it, checks
that the credentials can write, read and delete under that prefix, and saves
the route to the configuration file (default ./${DEFAULT_STORAGE_CONFIG_FILE}, or
YUNBOX_STORAGE_CONFIG). Options skip the matching question; --yes also skips
the confirmations, so setup can run unattended.

Routes map repositories to buckets: "<owner>/<repo>" wins over "<owner>/*",
which wins over "*". Several routes may share a bucket with different prefixes;
objects are always stored under <prefix>/<owner>/<repo>/, so repositories never
share keys. The file holds no credentials. Start the server with
"--storage cos --storage-config <file>" and run "cos check" with the server's
own credentials before going live.

Credentials: TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY /
TENCENTCLOUD_SESSIONTOKEN when set, otherwise the temporary keys written by
"tccli auth login" (~/.tccli/default.credential).
`

const options = {
  config: { type: 'string' },
  bucket: { type: 'string' },
  region: { type: 'string' },
  create: { type: 'boolean' },
  prefix: { type: 'string' },
  repos: { type: 'string' },
  endpoint: { type: 'string' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
} as const

/** Run `yunbox-server cos <subcommand>`. */
export async function runCosCommand(args: string[], io: CommandIo): Promise<void> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options })
  const [subcommand] = positionals
  if (values.help || subcommand === undefined) {
    io.stdout(cosHelp)
    return
  }
  switch (subcommand) {
    case 'list': {
      const credentials = resolveAdminCredentials(io)
      printBuckets(io, await listCosBuckets({ credentials, endpoint: serviceEndpoint(io) }))
      return
    }
    case 'routes': {
      const path = configPath(values.config, io)
      const document = readStorageRoutes(path)
      io.stdout(`Routes in ${path}:`)
      for (const route of document.routes)
        io.stdout(`  ${route.repos.padEnd(24)} -> ${describeRoute(route)}`)
      return
    }
    case 'check': {
      const path = configPath(values.config, io)
      const credentials = resolveAdminCredentials(io)
      let failed = false
      for (const route of readStorageRoutes(path).routes) {
        const checks = await createRouteStorage(route, credentials).probeAccess()
        const ok = checks.length === 4 && checks.every(check => check.ok)
        failed ||= !ok
        io.stdout(`${ok ? 'ok  ' : 'FAIL'} ${route.repos.padEnd(24)} ${describeRoute(route)}  ${formatChecks(checks)}`)
      }
      if (failed)
        throw new Error('At least one route failed its access check')
      return
    }
    case 'setup':
      await setup(values, io)
      return
    default:
      throw new Error(`Unknown cos subcommand "${subcommand}". Run "yunbox-server cos --help".`)
  }
}

async function setup(values: ReturnType<typeof parseArgs<{ options: typeof options }>>['values'], io: CommandIo): Promise<void> {
  const path = configPath(values.config, io)
  const document = readStorageRoutesFileOrEmpty(path)
  const credentials = resolveAdminCredentials(io)
  const buckets = await listCosBuckets({ credentials, endpoint: serviceEndpoint(io) })

  let bucket = values.bucket
  let region = values.region
  let create = values.create === true
  if (bucket === undefined) {
    printBuckets(io, buckets)
    const answer = (await ask(io, buckets.length > 0 ? 'Bucket number, or "n" to create a new private bucket: ' : 'No buckets yet. Press Enter to create one: ')).trim()
    if (answer === '' || answer.toLowerCase() === 'n') {
      create = true
    }
    else {
      const chosen = buckets[Number(answer) - 1]
      if (!/^\d+$/.test(answer) || chosen === undefined)
        throw new Error(`"${answer}" is not a bucket number from the list`)
      bucket = chosen.name
      region ??= chosen.region
    }
  }
  if (create) {
    const appId = bucket === undefined ? cosAppIdOf(buckets[0]?.name ?? '') : undefined
    if (bucket === undefined) {
      const name = (await ask(io, `New bucket name${appId === undefined ? ' (including -<appid>)' : ` (-${appId} is added)`}: `)).trim()
      bucket = appId !== undefined && cosAppIdOf(name) === undefined ? `${name}-${appId}` : name
    }
    region ??= (await ask(io, `Region [${DEFAULT_REGION}]: `)).trim() || DEFAULT_REGION
    if (buckets.some(existing => existing.name === bucket))
      throw new Error(`Bucket ${bucket} already exists; choose it instead of creating it`)
    await confirm(io, values.yes, `Create the private bucket ${bucket} in ${region}? COS bills storage and traffic for it.`)
    await createCosBucket(bucket, region, { credentials, endpoint: values.endpoint })
    io.stdout(`Created private bucket ${bucket} in ${region}.`)
  }
  else if (region === undefined) {
    region = buckets.find(existing => existing.name === bucket)?.region
    if (region === undefined)
      throw new Error(`Bucket ${bucket} is not in the account's bucket list; pass --region`)
  }

  const prefix = values.prefix ?? ((await ask(io, `Key prefix inside the bucket [${DEFAULT_PREFIX}]: `)).trim() || DEFAULT_PREFIX)
  const repos = values.repos ?? ((await ask(io, 'Repositories that use it: "*", "<owner>/*" or "<owner>/<repo>" [*]: ')).trim() || '*')
  const route: CosRoute = { repos, bucket: bucket!, region: region!, prefix }
  if (values.endpoint !== undefined)
    route.endpoint = values.endpoint

  const candidate = { version: 1 as const, routes: document.routes.map(existing => ({ ...existing })) }
  const replaced = upsertRoute(candidate, route)
  // Validates the pattern, bucket, region and prefix before touching COS again.
  readStorageRoutes(JSON.stringify(candidate))
  io.stdout(`Route: ${repos} -> ${describeRoute(route)}${replaced === undefined ? '' : ` (replaces ${describeRoute(replaced)})`}`)
  const shared = document.routes.filter(existing => existing.repos !== repos && existing.bucket === route.bucket)
  if (shared.length > 0)
    io.stdout(`This bucket is also used by ${shared.map(existing => `${existing.repos} (prefix ${existing.prefix ?? '/'})`).join(', ')}; keys stay separate under <prefix>/<owner>/<repo>/.`)

  const checks = await createRouteStorage(route, credentials).probeAccess()
  io.stdout(`Access check: ${formatChecks(checks)}`)
  if (checks.length !== 4 || !checks.every(check => check.ok))
    throw new Error('The credentials cannot write, read and delete under this prefix; nothing was saved')

  await confirm(io, values.yes, `Save this route to ${path}?`)
  await writeStorageRoutes(path, candidate)
  io.stdout(`Saved ${candidate.routes.length} route(s) to ${path}. It contains no credentials.`)
  io.stdout(`Start the server with: yunbox-server --storage cos --storage-config ${path}`)
  io.stdout('Then run "yunbox-server cos check" with the server\'s own credentials (for example its runtime role).')
}

/** Resolve the configuration file: --config, then a YUNBOX_STORAGE_CONFIG path, then ./yunbox.storage.json. */
function configPath(option: string | undefined, io: CommandIo): string {
  const fromEnv = io.env.YUNBOX_STORAGE_CONFIG
  if (option !== undefined)
    return resolve(option)
  if (fromEnv !== undefined && fromEnv !== '' && !fromEnv.trimStart().startsWith('{'))
    return resolve(fromEnv)
  return resolve(DEFAULT_STORAGE_CONFIG_FILE)
}

/**
 * Administrator credentials: the TENCENTCLOUD_* variables, else the temporary
 * keys from `tccli auth login`. Never printed.
 */
export function resolveAdminCredentials(io: CommandIo): CosCredentials {
  const { env } = io
  if (env.TENCENTCLOUD_SECRETID && env.TENCENTCLOUD_SECRETKEY) {
    io.stdout('Using Tencent Cloud credentials from TENCENTCLOUD_* environment variables.')
    return { secretId: env.TENCENTCLOUD_SECRETID, secretKey: env.TENCENTCLOUD_SECRETKEY, sessionToken: env.TENCENTCLOUD_SESSIONTOKEN || undefined }
  }
  const path = env.YUNBOX_TCCLI_CREDENTIAL || join(env.HOME || homedir(), '.tccli', 'default.credential')
  if (!existsSync(path))
    throw new Error('No Tencent Cloud credentials: set TENCENTCLOUD_SECRETID and TENCENTCLOUD_SECRETKEY, or run "tccli auth login"')
  let stored: { secretId?: unknown, secretKey?: unknown, token?: unknown, expiresAt?: unknown }
  try {
    stored = JSON.parse(readFileSync(path, 'utf8')) as typeof stored
  }
  catch {
    throw new Error(`Cannot read the tccli credential file ${path}; run "tccli auth login" again`)
  }
  if (typeof stored.secretId !== 'string' || typeof stored.secretKey !== 'string')
    throw new Error(`The tccli credential file ${path} has no key pair; run "tccli auth login" again`)
  if (typeof stored.expiresAt === 'number' && stored.expiresAt * 1000 <= Date.now())
    throw new Error('The tccli login has expired; run "tccli auth login" again')
  const expires = typeof stored.expiresAt === 'number' ? `, valid until ${new Date(stored.expiresAt * 1000).toLocaleString()}` : ''
  io.stdout(`Using temporary Tencent Cloud credentials from tccli login${expires}.`)
  return { secretId: stored.secretId, secretKey: stored.secretKey, sessionToken: typeof stored.token === 'string' ? stored.token : undefined }
}

function serviceEndpoint(io: CommandIo): string | undefined {
  return io.env.YUNBOX_COS_SERVICE_ENDPOINT || undefined
}

function printBuckets(io: CommandIo, buckets: CosBucketSummary[]): void {
  if (buckets.length === 0) {
    io.stdout('The account has no COS buckets.')
    return
  }
  io.stdout('Buckets:')
  buckets.forEach((bucket, index) => io.stdout(`  ${String(index + 1).padStart(2)}) ${bucket.name}  (${bucket.region})`))
}

function describeRoute(route: CosRoute): string {
  return `${route.bucket} (${route.region}) prefix ${route.prefix ? `${route.prefix.replace(/\/+$/, '')}/` : '/'}`
}

function formatChecks(checks: Array<{ operation: string, ok: boolean, status: number }>): string {
  return checks.map(check => `${check.operation} ${check.ok ? 'ok' : `failed (${check.status || 'no response'})`}`).join(', ')
}

async function ask(io: CommandIo, question: string): Promise<string> {
  if (io.prompt === undefined)
    throw new Error(`Cannot ask "${question.trim()}" without an interactive terminal; pass the matching option`)
  return io.prompt(question)
}

async function confirm(io: CommandIo, yes: boolean | undefined, question: string): Promise<void> {
  if (yes)
    return
  const answer = (await ask(io, `${question} [y/N] `)).trim().toLowerCase()
  if (answer !== 'y' && answer !== 'yes')
    throw new Error('Cancelled; nothing was changed')
}
