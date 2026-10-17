// @env node

import type { CosCredentials, ObjectStorage } from '@yunbox/core'
import type { TokenStore } from './tokens.ts'
import { join, resolve } from 'node:path'
import { CosObjectStorage, LocalFileObjectStorage } from '@yunbox/core'
import { ConfigError } from './config-error.ts'
import { CosTokenStore, FileTokenStore, TOKEN_DOCUMENT_NAME } from './tokens.ts'

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
  env: NodeJS.ProcessEnv
}

/** Configured object storage, the matching token store and a description for humans. */
export interface ConfiguredStorage {
  storage: ObjectStorage
  tokens: TokenStore
  description: string
}

/**
 * Create object storage and its token store.
 *
 * Local storage keeps tokens in `<storageDirectory>/_yunbox/tokens.json`; COS
 * keeps them in the private document `<prefix>/_yunbox/tokens.json`. Repository
 * owners must start with a letter or digit, so `_yunbox` never collides with
 * object paths.
 */
export function configureStorage(selection: StorageSelection): ConfiguredStorage {
  const problems = selection.kind === 'local' || selection.kind === 'cos'
    ? checkStorageEnvironment(selection.kind, selection.env)
    : ['storage must be local or cos']
  if (problems.length > 0)
    throw new ConfigError(problems)
  if (selection.kind === 'local') {
    const storageDirectory = resolve(selection.storageDirectory)
    const tokensPath = join(storageDirectory, '_yunbox', TOKEN_DOCUMENT_NAME)
    return {
      storage: new LocalFileObjectStorage(storageDirectory),
      tokens: new FileTokenStore(tokensPath),
      description: `Objects are stored in ${storageDirectory}; tokens in ${tokensPath}`,
    }
  }
  if (selection.kind === 'cos') {
    const storage = createCosStorageFromEnvironment(selection.env)
    const credentials = selection.env.TENCENTCLOUD_SESSIONTOKEN
      ? 'temporary credentials (TENCENTCLOUD_SESSIONTOKEN is set)'
      : 'long-term credentials (TENCENTCLOUD_SESSIONTOKEN is not set; prefer a runtime role with temporary keys)'
    return {
      storage,
      tokens: new CosTokenStore(storage),
      description: `Objects are stored in COS and transferred directly by Git LFS clients; tokens in ${storage.metadataKey(TOKEN_DOCUMENT_NAME)}; using ${credentials}`,
    }
  }
  throw new TypeError('storage must be local or cos')
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
  const missing = REQUIRED_COS_ENVIRONMENT.filter(name => env[name] === undefined || env[name] === '')
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
  const bucket = requireVariable(env, 'YUNBOX_COS_BUCKET')
  const region = requireVariable(env, 'YUNBOX_COS_REGION')
  readCredentials(env)
  return new CosObjectStorage({
    bucket,
    region,
    prefix: env.YUNBOX_COS_PREFIX,
    endpoint: env.YUNBOX_COS_ENDPOINT || undefined,
    credentials: () => readCredentials(env),
  })
}

function readCredentials(env: NodeJS.ProcessEnv): CosCredentials {
  return {
    secretId: requireVariable(env, 'TENCENTCLOUD_SECRETID'),
    secretKey: requireVariable(env, 'TENCENTCLOUD_SECRETKEY'),
    sessionToken: env.TENCENTCLOUD_SESSIONTOKEN || undefined,
  }
}

function requireVariable(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value === '')
    throw new Error(`${name} must be set to use COS storage`)
  return value
}
