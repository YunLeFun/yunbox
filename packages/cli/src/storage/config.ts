// @env node

import type { CliContext } from '../context.ts'
import type { ResolvedCredentials } from '../cos/credentials.ts'
import type { StorageLocation, StorageProvider } from './provider.ts'
import { CliError } from '../context.ts'
import { readLocation, writeLocation } from '../cos/location.ts'
import { cosProvider } from './cos.ts'

/** The provider that serves a location. */
export function providerOf(_location: StorageLocation): StorageProvider {
  return cosProvider
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
 * Read where the repository keeps its objects from `<root>/.yunbox/config`
 * (falling back to the legacy `.yunboxconfig`); `undefined` when it is not
 * set up.
 *
 * @throws {TypeError} naming the file when a setting is invalid or two files disagree.
 */
export async function readStorageLocation(context: CliContext, root: string): Promise<StorageLocation | undefined> {
  return await readLocation(context, root)
}

/**
 * Write the location into `<root>/.yunbox/config`, keeping every other
 * setting there, and delete the legacy `.yunboxconfig`.
 */
export async function writeStorageLocation(context: CliContext, root: string, location: StorageLocation): Promise<{ removedLegacy: boolean }> {
  return await writeLocation(context, root, location)
}

/**
 * The user's own keys for the provider of `location`.
 *
 * @throws {CliError} explaining how to configure keys when there are none, or when a source is unusable.
 */
export async function requireStorageCredentials(env: NodeJS.ProcessEnv, provider: StorageProvider): Promise<ResolvedCredentials> {
  const resolved = await provider.resolveCredentials(env)
  if (resolved === undefined)
    throw new CliError(provider.credentialHelp.join('\n'))
  return resolved
}
