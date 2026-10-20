// @env node

import type { CliContext } from '../context.ts'
import type { ResolvedCredentials } from '../cos/credentials.ts'
import type { CosLocation } from '../cos/location.ts'
import type { ProviderId, StorageLocation, StorageProvider } from './provider.ts'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CliError } from '../context.ts'
import { LEGACY_LOCATION_FILE, LOCATION_FILE, readCosSection, readLocation, removeLegacyLocationFile, writeLocation } from '../cos/location.ts'
import { readGitConfig, runGit, runGitChecked } from '../git.ts'
import { cosProvider } from './cos.ts'
import { PROVIDER_IDS } from './provider.ts'
import { s3Provider } from './s3.ts'

/** The built-in provider with this id. */
export function providerById(id: ProviderId): StorageProvider {
  return (id === 's3' ? s3Provider : cosProvider) as unknown as StorageProvider
}

/** The provider that serves a location. */
export function providerOf(location: StorageLocation): StorageProvider {
  return providerById(location.provider ?? 'cos')
}

/** Parse a `--provider` value. @throws {CliError} for an unknown one. */
export function parseProviderId(value: string): ProviderId {
  if (!(PROVIDER_IDS as readonly string[]).includes(value))
    throw new CliError(`--provider 只能是 ${PROVIDER_IDS.join(' 或 ')}，不是「${value}」`, 2)
  return value as ProviderId
}

/**
 * Check that the repository's provider has a capability before a command
 * that needs it, such as `yunbox policy`.
 *
 * @throws {CliError} naming the provider and the command.
 */
export function requireCapability(location: StorageLocation, capability: 'buckets' | 'policy' | 'restrictedKeys', command: string): void {
  const provider = providerOf(location)
  if (provider[capability] === undefined || provider[capability] === false)
    throw new CliError(`这个仓库的素材存在 ${provider.label}（${describeStorage(location)}），${command} 只支持腾讯云 COS。${provider.label} 的密钥和权限请在它自己的控制台里管理`)
}

/** Describe a location for messages, such as `bucket（region）/prefix/`. */
export function describeStorage(location: StorageLocation): string {
  return providerOf(location).describe(location)
}

/** Whether two locations point at the same objects with the same provider. */
export function sameStorage(a: StorageLocation, b: StorageLocation): boolean {
  return providerOf(a) === providerOf(b) && providerOf(a).same(a, b)
}

/**
 * Read where the repository keeps its objects from `<root>/.yunbox/config`;
 * `undefined` when it is not set up. `storage.provider` picks the section
 * (`cos` when absent, as 0.1.x wrote it). COS settings may still come from
 * the legacy `.yunboxconfig`, which never held anything else.
 *
 * @throws {TypeError} naming the file when a setting is invalid or two files disagree.
 */
export async function readStorageLocation(context: CliContext, root: string): Promise<StorageLocation | undefined> {
  const file = join(root, LOCATION_FILE)
  const configured = existsSync(file) ? await readGitConfig(context, 'storage.provider', file) : undefined
  if (configured === undefined || configured === 'cos')
    return await readLocation(context, root)
  if (configured !== 's3')
    throw new TypeError(`${LOCATION_FILE}：storage.provider 只能是 ${PROVIDER_IDS.join(' 或 ')}，不是「${configured}」。可能需要升级 YunBox 命令行`)
  let location: StorageLocation | undefined
  try {
    location = await s3Provider.readConfig(context, file)
  }
  catch (error) {
    throw new TypeError(`${LOCATION_FILE}：${(error as Error).message}`)
  }
  if (location === undefined)
    throw new TypeError(`${LOCATION_FILE}：storage.provider = s3，但没有 s3.bucket`)
  const legacy = join(root, LEGACY_LOCATION_FILE)
  let legacyLocation: CosLocation | undefined
  if (existsSync(legacy))
    legacyLocation = await readCosSection(context, legacy).catch(() => undefined)
  if (legacyLocation !== undefined)
    throw new TypeError(`${LOCATION_FILE} 用的是 S3（${describeStorage(location)}），但 ${LEGACY_LOCATION_FILE} 还指向 COS，确认 ${LOCATION_FILE} 正确后删除 ${LEGACY_LOCATION_FILE}`)
  return location
}

/**
 * Write the location into `<root>/.yunbox/config`, keeping every other
 * setting there, drop the section of another provider, and delete the
 * legacy `.yunboxconfig`. COS locations are written exactly as before
 * providers existed (no `storage.provider`), so older clients still read them.
 */
export async function writeStorageLocation(context: CliContext, root: string, location: StorageLocation): Promise<{ removedLegacy: boolean }> {
  const file = join(root, LOCATION_FILE)
  if (location.provider !== 's3') {
    if (existsSync(file)) {
      await runGit(context, ['config', '--file', file, '--unset-all', 'storage.provider'])
      await runGit(context, ['config', '--file', file, '--remove-section', 's3'])
    }
    return await writeLocation(context, root, location)
  }
  await mkdir(dirname(file), { recursive: true })
  if (existsSync(file))
    await runGit(context, ['config', '--file', file, '--remove-section', 'cos'])
  await runGitChecked(context, ['config', '--file', file, 'storage.provider', 's3'])
  await s3Provider.writeConfig(context, file, location)
  return await removeLegacyLocationFile(root)
}

/**
 * The user's own keys for a provider.
 *
 * @throws {CliError} explaining how to configure keys when there are none, or when a source is unusable.
 */
export async function requireStorageCredentials(env: NodeJS.ProcessEnv, provider: Pick<StorageProvider, 'resolveCredentials' | 'credentialHelp'>): Promise<ResolvedCredentials> {
  const resolved = await provider.resolveCredentials(env)
  if (resolved === undefined)
    throw new CliError(provider.credentialHelp.join('\n'))
  return resolved
}
