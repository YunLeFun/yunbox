// @env node

import type { CliContext } from './context.ts'
import type { ObjectStore, StorageLocation } from './storage/provider.ts'
import { AGENT_NAME } from './commands/lfs-agent.ts'
import { readGitConfig } from './git.ts'
import { providerOf, readStorageLocation } from './storage/config.ts'
import { objectKey, StorageRequestError } from './storage/provider.ts'

/** HEAD requests in flight at once. */
export const REMOTE_CHECK_CONCURRENCY = 8

/** Budget for all HEAD requests together, so many objects never hold up a push. */
export const REMOTE_CHECK_TIMEOUT_MS = 5000

/**
 * Outcome of {@link checkRemoteObjects}. Only `checked` is definite: `skipped`
 * means the repository is not in direct mode (any provider) or has no local keys, and
 * `failed` carries a reason that is safe to print (no keys, signatures or URLs).
 */
export type RemoteCheck
  = | { status: 'checked', present: Set<string>, storage: string }
    | { status: 'skipped' }
    | { status: 'failed', reason: string }

/**
 * Which LFS objects already exist in the repository's storage prefix, by one HEAD
 * request each with the user's own keys, as the transfer agent does before an
 * upload. All or nothing: any failed request, or running out of time, fails
 * the whole check, so an unanswered object is never taken as already uploaded.
 * An object of a different size counts as missing.
 *
 * `YUNBOX_INSPECT_REMOTE_TIMEOUT_MS` overrides the time budget; `0` turns the check off.
 *
 * @param context Repository context; `cwd` is the repository root.
 */
export async function checkRemoteObjects(context: CliContext, objects: Array<{ oid: string, bytes: number }>): Promise<RemoteCheck> {
  const timeoutMs = remoteCheckTimeout(context.env)
  if (objects.length === 0 || timeoutMs === 0)
    return { status: 'skipped' }
  if (await readGitConfig(context, 'lfs.standalonetransferagent') !== AGENT_NAME)
    return { status: 'skipped' }
  let client: ObjectStore
  let location: StorageLocation | undefined
  try {
    location = await readStorageLocation(context, context.cwd)
    if (location === undefined)
      return { status: 'skipped' }
    const provider = providerOf(location)
    const resolved = await provider.resolveCredentials(context.env)
    if (resolved === undefined)
      return { status: 'skipped' }
    client = provider.connect(location, () => resolved.credentials)
  }
  catch {
    return { status: 'failed', reason: `无法读取${location === undefined ? '存储' : ` ${providerOf(location).label} `}位置或本机密钥（yunbox doctor 可以检查）` }
  }
  const where = location

  const controller = new AbortController()
  const present = new Set<string>()
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < objects.length && !controller.signal.aborted) {
      const object = objects[next++]!
      const found = await client.head(objectKey(where, object.oid), { signal: controller.signal })
      if (found?.size === object.bytes)
        present.add(object.oid)
    }
  }
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(resolve, timeoutMs, 'timeout')
  })
  const work = Promise.all(Array.from({ length: Math.min(REMOTE_CHECK_CONCURRENCY, objects.length) }, worker))
  // After a timeout the aborted requests still reject; nobody awaits them any more.
  work.catch(() => {})
  try {
    if (await Promise.race([work, deadline]) === 'timeout')
      return { status: 'failed', reason: `${objects.length} 个对象未在 ${timeoutMs / 1000} 秒内查完` }
    return { status: 'checked', present, storage: providerOf(where).label }
  }
  catch (error) {
    return { status: 'failed', reason: error instanceof StorageRequestError ? error.message : `查询 ${providerOf(where).label} 失败` }
  }
  finally {
    clearTimeout(timer)
    controller.abort()
  }
}

function remoteCheckTimeout(env: NodeJS.ProcessEnv): number {
  const value = env.YUNBOX_INSPECT_REMOTE_TIMEOUT_MS
  return value !== undefined && /^\d{1,6}$/.test(value) ? Number(value) : REMOTE_CHECK_TIMEOUT_MS
}
