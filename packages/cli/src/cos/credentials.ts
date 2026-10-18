// @env node

import type { CosCredentials } from '@yunbox/core'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { CliError } from '../context.ts'

/** Where a set of COS credentials came from, for messages; never the values. */
export type CredentialSource = 'env' | 'file' | 'tccli'

/** Credentials plus where they came from. */
export interface ResolvedCredentials {
  credentials: CosCredentials
  source: CredentialSource
  /** Human description of the source, safe to print. */
  description: string
}

interface StoredCredentials {
  version: 1
  secretId: string
  secretKey: string
}

/**
 * The per-user credentials file: `$YUNBOX_CONFIG_DIR/credentials.json`, else
 * `%APPDATA%\yunbox\` on Windows, else `$XDG_CONFIG_HOME/yunbox/` or
 * `~/.config/yunbox/`. It lives outside every repository.
 */
export function credentialsFilePath(env: NodeJS.ProcessEnv): string {
  if (env.YUNBOX_CONFIG_DIR)
    return join(env.YUNBOX_CONFIG_DIR, 'credentials.json')
  if (process.platform === 'win32' && env.APPDATA)
    return join(env.APPDATA, 'yunbox', 'credentials.json')
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config')
  return join(base, 'yunbox', 'credentials.json')
}

/**
 * Resolve the user's own COS credentials, in order: `TENCENTCLOUD_SECRETID` /
 * `TENCENTCLOUD_SECRETKEY` (+ `TENCENTCLOUD_SESSIONTOKEN`), the file written by
 * `yunbox login`, then the temporary keys of `tccli auth login`.
 *
 * @returns `undefined` when none is configured.
 * @throws {CliError} when a source exists but is unusable (for example an expired tccli login).
 */
export function resolveCredentials(env: NodeJS.ProcessEnv): ResolvedCredentials | undefined {
  if (env.TENCENTCLOUD_SECRETID && env.TENCENTCLOUD_SECRETKEY) {
    return {
      credentials: { secretId: env.TENCENTCLOUD_SECRETID, secretKey: env.TENCENTCLOUD_SECRETKEY, sessionToken: env.TENCENTCLOUD_SESSIONTOKEN || undefined },
      source: 'env',
      description: 'TENCENTCLOUD_* 环境变量',
    }
  }
  const file = credentialsFilePath(env)
  if (existsSync(file)) {
    const stored = parseStored(readFileSync(file, 'utf8'), file)
    return { credentials: { secretId: stored.secretId, secretKey: stored.secretKey }, source: 'file', description: file }
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
  return undefined
}

/** Like {@link resolveCredentials}, but explains how to configure credentials when there are none. */
export function requireCredentials(env: NodeJS.ProcessEnv): ResolvedCredentials {
  const resolved = resolveCredentials(env)
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

/** Save a key pair to the per-user credentials file with owner-only permissions. */
export async function saveCredentials(env: NodeJS.ProcessEnv, credentials: { secretId: string, secretKey: string }): Promise<string> {
  const file = credentialsFilePath(env)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  const document: StoredCredentials = { version: 1, secretId: credentials.secretId, secretKey: credentials.secretKey }
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  // writeFile's mode only applies to new files; make sure a reused name is private too.
  await chmod(temporary, 0o600)
  await rename(temporary, file)
  return file
}

/** Delete the per-user credentials file. Returns whether one existed. */
export async function deleteCredentials(env: NodeJS.ProcessEnv): Promise<boolean> {
  const file = credentialsFilePath(env)
  if (!existsSync(file))
    return false
  await rm(file)
  return true
}

function parseStored(text: string, file: string): StoredCredentials {
  try {
    const value = JSON.parse(text) as Partial<StoredCredentials>
    if (value.version === 1 && typeof value.secretId === 'string' && typeof value.secretKey === 'string')
      return value as StoredCredentials
  }
  catch {}
  throw new CliError(`凭据文件 ${file} 格式不对。运行 yunbox login 重新保存，或删除它`)
}
