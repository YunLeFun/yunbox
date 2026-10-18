// @env node

import type { CosCredentials } from '@yunbox/core'
import type { SecretStore, SecretStoreKind, StoredKeys } from './secret-store.ts'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CliError } from '../context.ts'
import { defaultSecretStores } from './secret-store.ts'

export { credentialsFilePath } from './secret-store.ts'

/** Where a set of COS credentials came from, for messages; never the values. */
export type CredentialSource = 'env' | SecretStoreKind | 'tccli'

/** Credentials plus where they came from. */
export interface ResolvedCredentials {
  credentials: CosCredentials
  source: CredentialSource
  /** Human description of the source, safe to print. */
  description: string
}

function storesFor(env: NodeJS.ProcessEnv, stores: SecretStore[] | undefined): SecretStore[] {
  if (stores !== undefined)
    return stores
  try {
    return defaultSecretStores(env)
  }
  catch (error) {
    throw new CliError((error as Error).message)
  }
}

/**
 * Resolve the user's own COS credentials, in order: `TENCENTCLOUD_SECRETID` /
 * `TENCENTCLOUD_SECRETKEY` (+ `TENCENTCLOUD_SESSIONTOKEN`), what `yunbox login`
 * saved (the macOS keychain, then the file), then the temporary keys of
 * `tccli auth login`. A store that cannot be read is skipped so that a later
 * one still works; its error is raised only when nothing else is configured.
 *
 * @param env Environment with the `TENCENTCLOUD_*` and `YUNBOX_*` settings.
 * @param stores Defaults to {@link defaultSecretStores}; injected by tests.
 * @returns `undefined` when none is configured.
 * @throws {CliError} when a source exists but is unusable (for example an expired tccli login).
 */
export async function resolveCredentials(env: NodeJS.ProcessEnv, stores?: SecretStore[]): Promise<ResolvedCredentials | undefined> {
  if (env.TENCENTCLOUD_SECRETID && env.TENCENTCLOUD_SECRETKEY) {
    return {
      credentials: { secretId: env.TENCENTCLOUD_SECRETID, secretKey: env.TENCENTCLOUD_SECRETKEY, sessionToken: env.TENCENTCLOUD_SESSIONTOKEN || undefined },
      source: 'env',
      description: 'TENCENTCLOUD_* 环境变量',
    }
  }
  let failure: Error | undefined
  for (const store of storesFor(env, stores)) {
    let keys: StoredKeys | undefined
    try {
      keys = await store.read()
    }
    catch (error) {
      failure ??= error as Error
      continue
    }
    if (keys !== undefined)
      return { credentials: { secretId: keys.secretId, secretKey: keys.secretKey }, source: store.kind, description: store.description }
  }
  const tccli = env.YUNBOX_TCCLI_CREDENTIAL || join(env.HOME || homedir(), '.tccli', 'default.credential')
  if (existsSync(tccli)) {
    let value: { secretId?: unknown, secretKey?: unknown, token?: unknown, expiresAt?: unknown }
    try {
      value = JSON.parse(readFileSync(tccli, 'utf8')) as typeof value
    }
    catch {
      throw new CliError(`读不了 tccli 的凭据文件 ${tccli}，请重新运行 tccli auth login，或用 yunbox login 保存自己的密钥`)
    }
    if (typeof value.secretId === 'string' && typeof value.secretKey === 'string') {
      if (typeof value.expiresAt === 'number' && value.expiresAt * 1000 <= Date.now())
        throw new CliError('tccli 登录已过期。重新运行 tccli auth login，或用 yunbox login 保存自己的子账号密钥')
      return {
        credentials: { secretId: value.secretId, secretKey: value.secretKey, sessionToken: typeof value.token === 'string' ? value.token : undefined },
        source: 'tccli',
        description: typeof value.expiresAt === 'number' ? `tccli 登录（${new Date(value.expiresAt * 1000).toLocaleString()} 过期）` : 'tccli 登录',
      }
    }
  }
  if (failure !== undefined)
    throw new CliError(failure.message)
  return undefined
}

/** Like {@link resolveCredentials}, but explains how to configure credentials when there are none. */
export async function requireCredentials(env: NodeJS.ProcessEnv, stores?: SecretStore[]): Promise<ResolvedCredentials> {
  const resolved = await resolveCredentials(env, stores)
  if (resolved === undefined) {
    throw new CliError([
      '本机还没有配置腾讯云 COS 密钥。任选一种：',
      '  yunbox login            # 保存自己的子账号 SecretId / SecretKey（推荐，只对这台电脑生效）',
      '  tccli auth login        # 用浏览器登录腾讯云，临时密钥约 2 小时有效',
      '  export TENCENTCLOUD_SECRETID=... TENCENTCLOUD_SECRETKEY=...',
    ].join('\n'))
  }
  return resolved
}

/** Outcome of {@link saveCredentials}. */
export interface SaveResult {
  /** Where the keys now are. */
  store: SecretStore
  /** Preferred stores that failed, with the reason; the keys went to a later one. */
  skipped: Array<{ store: SecretStore, reason: string }>
  /** Other stores that held an older copy, now deleted. */
  cleaned: SecretStore[]
}

/**
 * Save a key pair to the first store that accepts it (the macOS keychain
 * before the 0600 file), then delete any copy in the other stores so that an
 * older key cannot shadow the new one and no plain-text copy is left behind.
 *
 * @throws {CliError} when no store accepts the keys.
 */
export async function saveCredentials(env: NodeJS.ProcessEnv, keys: StoredKeys, stores?: SecretStore[]): Promise<SaveResult> {
  const all = storesFor(env, stores)
  const skipped: SaveResult['skipped'] = []
  for (const store of all) {
    try {
      await store.write(keys)
    }
    catch (error) {
      skipped.push({ store, reason: (error as Error).message })
      continue
    }
    const cleaned: SecretStore[] = []
    for (const other of all) {
      if (other !== store && await other.delete().catch(() => false))
        cleaned.push(other)
    }
    return { store, skipped, cleaned }
  }
  throw new CliError(`没有保存：${skipped.map(entry => entry.reason).join('；')}`)
}

/**
 * Delete what `yunbox login` saved from every store.
 *
 * @returns the stores that held keys, and the ones that could not be cleaned.
 */
export async function deleteCredentials(env: NodeJS.ProcessEnv, stores?: SecretStore[]): Promise<{ removed: SecretStore[], failed: Array<{ store: SecretStore, reason: string }> }> {
  const removed: SecretStore[] = []
  const failed: Array<{ store: SecretStore, reason: string }> = []
  for (const store of storesFor(env, stores)) {
    try {
      if (await store.delete())
        removed.push(store)
    }
    catch (error) {
      failed.push({ store, reason: (error as Error).message })
    }
  }
  return { removed, failed }
}
