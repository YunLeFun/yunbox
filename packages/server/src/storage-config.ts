// @env node

import type { CosCredentials, ObjectStorage } from '@yunbox/core'
import type { LegacyTokenSource } from './legacy-tokens.ts'
import type { CloudBaseCredentials } from './metadata-cloudbase.ts'
import type { MetadataStore } from './metadata.ts'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { CosObjectStorage, LocalFileObjectStorage } from '@yunbox/core'
import { ConfigError } from './config-error.ts'
import { LEGACY_TOKEN_DOCUMENT_NAME } from './legacy-tokens.ts'
import { CloudBaseMetadataStore } from './metadata-cloudbase.ts'
import { LocalMetadataStore } from './metadata-local.ts'

/** Environment variables COS storage cannot start without. */
export const REQUIRED_COS_ENVIRONMENT = [
  'YUNBOX_COS_BUCKET',
  'YUNBOX_COS_REGION',
  'TENCENTCLOUD_SECRETID',
  'TENCENTCLOUD_SECRETKEY',
] as const

/** Storage settings shared by the server and the token commands. */
export interface StorageSelection {
  /** `local` (files under `storageDirectory`) or `cos`. */
  kind: string
  storageDirectory: string
  /** `local` (files under `metadataDirectory`) or `cloudbase`. Defaults to `cloudbase` with COS and `local` otherwise. */
  metadata?: string
  /** Local metadata directory (default `<storageDirectory>/_yunbox/metadata`). */
  metadataDirectory?: string
  env: NodeJS.ProcessEnv
}

/** Configured object storage, metadata store, the G1 token document and a description for humans. */
export interface ConfiguredStorage {
  storage: ObjectStorage
  metadata: MetadataStore
  /** Where a G1 `tokens.json` would be, for `token migrate`. */
  legacyTokens: LegacyTokenSource
  description: string
}

/** Default metadata store for a storage kind. */
export function defaultMetadataKind(storageKind: string): 'local' | 'cloudbase' {
  return storageKind === 'cos' ? 'cloudbase' : 'local'
}

/** Default local metadata directory for a storage directory. */
export function defaultMetadataDirectory(storageDirectory: string): string {
  return join(storageDirectory, '_yunbox', 'metadata')
}

/**
 * Create object storage and the metadata store.
 *
 * Local metadata lives in `<storageDirectory>/_yunbox/metadata/` unless
 * `metadataDirectory` says otherwise. Repository owners must start with a
 * letter or digit, so `_yunbox` never collides with object paths. The G1
 * token document is `<storageDirectory>/_yunbox/tokens.json` locally and
 * `<prefix>/_yunbox/tokens.json` in COS.
 */
export function configureStorage(selection: StorageSelection): ConfiguredStorage {
  const metadataKind = selection.metadata ?? defaultMetadataKind(selection.kind)
  const problems = [
    ...(selection.kind === 'local' || selection.kind === 'cos'
      ? checkStorageEnvironment(selection.kind, selection.env)
      : ['storage must be local or cos']),
    ...(metadataKind === 'local' || metadataKind === 'cloudbase'
      ? checkMetadataEnvironment(metadataKind, selection.env)
      : ['metadata must be local or cloudbase']),
  ]
  if (problems.length > 0)
    throw new ConfigError(problems)

  const storageDirectory = resolve(selection.storageDirectory)
  let storage: ObjectStorage
  let legacyTokens: LegacyTokenSource
  let storageDescription: string
  if (selection.kind === 'cos') {
    const cos = createCosStorageFromEnvironment(selection.env)
    storage = cos
    legacyTokens = {
      description: cos.metadataKey(LEGACY_TOKEN_DOCUMENT_NAME),
      read: () => cos.readMetadataDocument(LEGACY_TOKEN_DOCUMENT_NAME),
    }
    const credentials = selection.env.TENCENTCLOUD_SESSIONTOKEN
      ? 'temporary credentials (TENCENTCLOUD_SESSIONTOKEN is set)'
      : 'long-term credentials (TENCENTCLOUD_SESSIONTOKEN is not set; prefer a runtime role with temporary keys)'
    storageDescription = `Objects are stored in COS and transferred directly by Git LFS clients, using ${credentials}`
  }
  else {
    storage = new LocalFileObjectStorage(storageDirectory)
    const path = join(storageDirectory, '_yunbox', LEGACY_TOKEN_DOCUMENT_NAME)
    legacyTokens = { description: path, read: () => readOptionalFile(path) }
    storageDescription = `Objects are stored in ${storageDirectory}`
  }

  const metadata = metadataKind === 'cloudbase'
    ? createCloudBaseMetadataFromEnvironment(selection.env)
    : new LocalMetadataStore(resolve(selection.metadataDirectory ?? defaultMetadataDirectory(storageDirectory)))
  return {
    storage,
    metadata,
    legacyTokens,
    description: `${storageDescription}; tokens and grants are kept in ${metadata.description}`,
  }
}

/**
 * Check that the environment has what a storage kind needs, without touching
 * the network. For COS that is every variable in
 * {@link REQUIRED_COS_ENVIRONMENT} plus well-formed bucket, region, prefix and
 * endpoint values. Problems name variables but never contain their values.
 *
 * @returns One message per problem; empty when the storage can be created.
 */
export function checkStorageEnvironment(kind: 'local' | 'cos', env: NodeJS.ProcessEnv): string[] {
  if (kind === 'local')
    return []
  const missing = REQUIRED_COS_ENVIRONMENT.filter(name => !isSet(env, name))
  if (missing.length > 0)
    return missing.map(name => `${name} must be set to use COS storage`)
  try {
    createCosStorageFromEnvironment(env)
  }
  catch (error) {
    // CosObjectStorage reports which setting is malformed, never its value.
    return [`COS settings are invalid: ${(error as Error).message}`]
  }
  return []
}

/**
 * Check that the environment has what a metadata store needs, without
 * touching the network. CloudBase needs `YUNBOX_CLOUDBASE_ENV` and either
 * `YUNBOX_CLOUDBASE_API_KEY` or `TENCENTCLOUD_SECRETID` /
 * `TENCENTCLOUD_SECRETKEY`. Problems name variables but never contain their values.
 *
 * @returns One message per problem; empty when the store can be created.
 */
export function checkMetadataEnvironment(kind: 'local' | 'cloudbase', env: NodeJS.ProcessEnv): string[] {
  if (kind === 'local')
    return []
  const problems: string[] = []
  if (!isSet(env, 'YUNBOX_CLOUDBASE_ENV'))
    problems.push('YUNBOX_CLOUDBASE_ENV must be set to use CloudBase metadata')
  if (!isSet(env, 'YUNBOX_CLOUDBASE_API_KEY') && !(isSet(env, 'TENCENTCLOUD_SECRETID') && isSet(env, 'TENCENTCLOUD_SECRETKEY')))
    problems.push('TENCENTCLOUD_SECRETID and TENCENTCLOUD_SECRETKEY (or YUNBOX_CLOUDBASE_API_KEY) must be set to use CloudBase metadata')
  if (problems.length > 0)
    return problems
  try {
    createCloudBaseMetadataFromEnvironment(env)
  }
  catch (error) {
    // CloudBaseDocumentBackend reports which setting is malformed, never its value.
    return [`CloudBase settings are invalid: ${(error as Error).message}`]
  }
  return []
}

/**
 * Create COS storage from environment variables.
 *
 * Bucket settings come from `YUNBOX_COS_BUCKET`, `YUNBOX_COS_REGION` and the
 * optional `YUNBOX_COS_PREFIX` / `YUNBOX_COS_ENDPOINT`. Credentials use the
 * standard Tencent Cloud variables (`TENCENTCLOUD_SECRETID`,
 * `TENCENTCLOUD_SECRETKEY`, `TENCENTCLOUD_SESSIONTOKEN`), which a bound runtime
 * role injects. They are re-read before every signature so rotated temporary
 * keys take effect without a restart.
 */
export function createCosStorageFromEnvironment(env: NodeJS.ProcessEnv): CosObjectStorage {
  const bucket = requireVariable(env, 'YUNBOX_COS_BUCKET', 'COS storage')
  const region = requireVariable(env, 'YUNBOX_COS_REGION', 'COS storage')
  readCosCredentials(env)
  return new CosObjectStorage({
    bucket,
    region,
    prefix: env.YUNBOX_COS_PREFIX,
    endpoint: env.YUNBOX_COS_ENDPOINT || undefined,
    credentials: () => readCosCredentials(env),
  })
}

/**
 * Create the CloudBase metadata store from environment variables.
 *
 * `YUNBOX_CLOUDBASE_ENV` is the environment id; optional
 * `YUNBOX_CLOUDBASE_ENDPOINT` overrides the API origin (for example
 * `https://<env>.api.intl.tcloudbasegateway.com` outside the mainland) and
 * `YUNBOX_CLOUDBASE_COLLECTION_PREFIX` the collection prefix (default
 * `yunbox_`). Requests are signed with the Tencent Cloud key pair, re-read
 * before every request like COS, unless `YUNBOX_CLOUDBASE_API_KEY` is set, in
 * which case that server API key is sent instead.
 */
export function createCloudBaseMetadataFromEnvironment(env: NodeJS.ProcessEnv): CloudBaseMetadataStore {
  const envId = requireVariable(env, 'YUNBOX_CLOUDBASE_ENV', 'CloudBase metadata')
  const credentials = (): CloudBaseCredentials => isSet(env, 'YUNBOX_CLOUDBASE_API_KEY')
    ? { apiKey: env.YUNBOX_CLOUDBASE_API_KEY! }
    : readCosCredentials(env)
  credentials()
  return new CloudBaseMetadataStore({
    envId,
    endpoint: env.YUNBOX_CLOUDBASE_ENDPOINT || undefined,
    collectionPrefix: env.YUNBOX_CLOUDBASE_COLLECTION_PREFIX || undefined,
    credentials,
  })
}

function readCosCredentials(env: NodeJS.ProcessEnv): CosCredentials {
  return {
    secretId: requireVariable(env, 'TENCENTCLOUD_SECRETID', 'Tencent Cloud requests'),
    secretKey: requireVariable(env, 'TENCENTCLOUD_SECRETKEY', 'Tencent Cloud requests'),
    sessionToken: env.TENCENTCLOUD_SESSIONTOKEN || undefined,
  }
}

function isSet(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] !== undefined && env[name] !== ''
}

function requireVariable(env: NodeJS.ProcessEnv, name: string, purpose: string): string {
  if (!isSet(env, name))
    throw new Error(`${name} must be set to use ${purpose}`)
  return env[name]!
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw error
  }
}
