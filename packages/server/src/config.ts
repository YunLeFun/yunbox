// @env node

import { ConfigError } from './config-error.ts'
import { DEFAULT_HOST, DEFAULT_PORT, resolvePublicUrl } from './server.ts'
import { checkMetadataEnvironment, checkStorageEnvironment, defaultMetadataDirectory, defaultMetadataKind } from './storage-config.ts'

export { ConfigError } from './config-error.ts'
export { DEFAULT_HOST, DEFAULT_PORT } from './server.ts'

/** Default storage kind. */
export const DEFAULT_STORAGE = 'local'
/** Default local storage directory. */
export const DEFAULT_STORAGE_DIRECTORY = '.yunbox-data'

/**
 * Environment variables that configure the server, in lookup order after the
 * matching command-line option. `PORT` is the port container platforms such as
 * CloudBase CloudRun tell the service to listen on.
 */
export const CONFIG_ENVIRONMENT = {
  host: ['YUNBOX_HOST'],
  port: ['YUNBOX_PORT', 'PORT'],
  publicUrl: ['YUNBOX_PUBLIC_URL'],
  storage: ['YUNBOX_STORAGE'],
  storageDirectory: ['YUNBOX_STORAGE_DIR'],
  metadata: ['YUNBOX_METADATA'],
  metadataDirectory: ['YUNBOX_METADATA_DIR'],
} as const

/** Command-line values for the settings shared by `serve` and `token`; `undefined` means not given. */
export interface StorageOptionValues {
  'storage'?: string
  'storage-dir'?: string
  'metadata'?: string
  'metadata-dir'?: string
}

/** Command-line values for `serve`; `undefined` means not given. */
export interface ServeOptionValues extends StorageOptionValues {
  'host'?: string
  'port'?: string
  'public-url'?: string
}

/** Where objects and metadata (tokens, grants, locks, audit log) live. */
export interface StorageSettings {
  kind: 'local' | 'cos'
  storageDirectory: string
  metadata: 'local' | 'cloudbase'
  /** Directory of local metadata. */
  metadataDirectory: string
}

/** Fully resolved and checked `serve` settings. */
export interface ServeConfig {
  host: string
  port: number
  /** Normalized origin, or `undefined` to use the listen URL (loopback only). */
  publicUrl?: string
  storage: StorageSettings
}

interface Picked {
  value: string
  /** `--option`, an environment variable name or `default`, for error messages. */
  source: string
}

/**
 * Pick a setting: the command-line option wins, then the first non-empty
 * environment variable in `names`, then the default.
 */
function pick(cliName: string, cliValue: string | undefined, env: NodeJS.ProcessEnv, names: readonly string[], fallback: string): Picked {
  if (cliValue !== undefined)
    return { value: cliValue, source: `--${cliName}` }
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && value !== '')
      return { value, source: name }
  }
  return { value: fallback, source: 'default' }
}

function resolveStorage(values: StorageOptionValues, env: NodeJS.ProcessEnv, problems: string[]): StorageSettings {
  const kind = pick('storage', values.storage, env, CONFIG_ENVIRONMENT.storage, DEFAULT_STORAGE)
  const storageDirectory = pick('storage-dir', values['storage-dir'], env, CONFIG_ENVIRONMENT.storageDirectory, DEFAULT_STORAGE_DIRECTORY).value
  const metadataDirectory = pick('metadata-dir', values['metadata-dir'], env, CONFIG_ENVIRONMENT.metadataDirectory, defaultMetadataDirectory(storageDirectory)).value
  const storageKind = kind.value === 'cos' ? 'cos' : 'local'
  if (kind.value !== 'local' && kind.value !== 'cos')
    problems.push(`storage (from ${kind.source}) must be local or cos`)
  else
    problems.push(...checkStorageEnvironment(kind.value, env))
  const metadata = pick('metadata', values.metadata, env, CONFIG_ENVIRONMENT.metadata, defaultMetadataKind(kind.value))
  const metadataKind = metadata.value === 'cloudbase' ? 'cloudbase' : 'local'
  if (metadata.value !== 'local' && metadata.value !== 'cloudbase') {
    problems.push(`metadata (from ${metadata.source}) must be local or cloudbase`)
  }
  else {
    // Missing Tencent Cloud keys are already reported once for COS storage.
    problems.push(...checkMetadataEnvironment(metadata.value, env).filter(problem =>
      !(problem.startsWith('TENCENTCLOUD_SECRETID and') && problems.some(other => other.startsWith('TENCENTCLOUD_SECRET')))))
  }
  return { kind: storageKind, storageDirectory, metadata: metadataKind, metadataDirectory }
}

/**
 * Resolve storage settings for `yunbox-server token` and `grant`, with the
 * same precedence as the server: command-line option, then the environment
 * variables in {@link CONFIG_ENVIRONMENT}, then the defaults. Metadata
 * defaults to `cloudbase` with COS storage and `local` otherwise.
 *
 * @throws {ConfigError} listing every problem, including missing COS variables.
 */
export function resolveStorageSettings(values: StorageOptionValues, env: NodeJS.ProcessEnv): StorageSettings {
  const problems: string[] = []
  const storage = resolveStorage(values, env, problems)
  if (problems.length > 0)
    throw new ConfigError(problems)
  return storage
}

/**
 * Resolve and self-check the `serve` configuration before anything starts.
 *
 * Each setting comes from its command-line option, else the environment
 * variables in {@link CONFIG_ENVIRONMENT}, else its default. The check covers
 * the port, the public URL (required and https when the host is not a
 * loopback address), the storage kind and, for COS, the bucket, region and
 * credential variables.
 *
 * @throws {ConfigError} listing every problem at once.
 */
export function resolveServeConfig(values: ServeOptionValues, env: NodeJS.ProcessEnv): ServeConfig {
  const problems: string[] = []
  const host = pick('host', values.host, env, CONFIG_ENVIRONMENT.host, DEFAULT_HOST)
  const port = pick('port', values.port, env, CONFIG_ENVIRONMENT.port, String(DEFAULT_PORT))
  const publicUrlSetting = pick('public-url', values['public-url'], env, CONFIG_ENVIRONMENT.publicUrl, '')

  if (host.value === '')
    problems.push(`host (from ${host.source}) must not be empty`)
  const parsedPort = parsePort(port.value)
  if (parsedPort === undefined)
    problems.push(`port (from ${port.source}) must be an integer from 0 to 65535`)

  let publicUrl: string | undefined
  try {
    publicUrl = resolvePublicUrl(host.value, publicUrlSetting.value === '' ? undefined : publicUrlSetting.value)
  }
  catch (error) {
    const source = publicUrlSetting.source === 'default' ? '--public-url or YUNBOX_PUBLIC_URL' : publicUrlSetting.source
    problems.push(`${(error as Error).message} (set with ${source})`)
  }

  const storage = resolveStorage(values, env, problems)
  if (problems.length > 0)
    throw new ConfigError(problems)
  return { host: host.value, port: parsedPort!, publicUrl, storage }
}

function parsePort(value: string): number | undefined {
  if (!/^\d{1,5}$/.test(value))
    return undefined
  const port = Number(value)
  return port <= 65_535 ? port : undefined
}
