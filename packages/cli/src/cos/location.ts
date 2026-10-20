import type { CliContext } from '../context.ts'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readGitConfig, runGitChecked } from '../git.ts'

const BUCKET_PATTERN = /^[a-z\d][a-z\d-]{0,48}-\d{5,20}$/
const REGION_PATTERN = /^[a-z\d][a-z\d-]{1,40}$/
const PREFIX_SEGMENT_PATTERN = /^[\w.-]+$/

/**
 * Where a repository keeps its LFS objects in COS. Stored in the `[cos]`
 * section of `.yunbox/config` (git config format), which is committed and
 * shared; it never holds credentials. It is not in `.lfsconfig` because
 * git-lfs warns about every key it does not know there. Objects live at
 * `<prefix>/<oid[0:2]>/<oid[2:4]>/<oid>`.
 */
export interface CosLocation {
  /** Bucket name including the APPID suffix. */
  bucket: string
  region: string
  /** Key prefix, no leading or trailing slash; empty for the bucket root. */
  prefix: string
  /** Override the bucket origin, for tests only. */
  endpoint?: string
}

/** Validate and normalize a location. @throws {TypeError} naming the bad setting. */
export function normalizeLocation(location: CosLocation): CosLocation {
  if (!BUCKET_PATTERN.test(location.bucket))
    throw new TypeError(`bucket「${location.bucket}」格式不对，应该是 <名称>-<APPID>，例如 assets-1250000000`)
  if (!REGION_PATTERN.test(location.region))
    throw new TypeError(`region「${location.region}」不是有效的 COS 地域，例如 ap-guangzhou`)
  const prefix = location.prefix.replace(/^\/+|\/+$/g, '')
  if (prefix !== '' && prefix.split('/').some(segment => !PREFIX_SEGMENT_PATTERN.test(segment) || segment === '.' || segment === '..'))
    throw new TypeError(`前缀「${location.prefix}」只能包含字母、数字、「.」「_」「-」和「/」`)
  const normalized: CosLocation = { bucket: location.bucket, region: location.region, prefix }
  if (location.endpoint !== undefined) {
    const url = new URL(location.endpoint)
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '')
      throw new TypeError('endpoint 只能是 origin，不能带路径')
    normalized.endpoint = url.origin
  }
  return normalized
}

/**
 * The shared settings file, relative to the repository root. `.yunbox/` holds
 * only files that are committed and shared with the team; credentials and the
 * agent registration stay in the user's home and in `.git/config`.
 */
export const LOCATION_FILE = '.yunbox/config'

/** Where versions up to 0.1.x kept the same settings; still read, never written. */
export const LEGACY_LOCATION_FILE = '.yunboxconfig'

/** Which settings files exist in `root`, relative paths, current one first. */
export function locationFiles(root: string): string[] {
  return [LOCATION_FILE, LEGACY_LOCATION_FILE].filter(file => existsSync(join(root, file)))
}

/** Read the `[cos]` section of one settings file; `undefined` when it has no bucket. @throws {TypeError} for an invalid setting. */
export async function readCosSection(context: CliContext, file: string): Promise<CosLocation | undefined> {
  const bucket = await readGitConfig(context, 'cos.bucket', file)
  if (bucket === undefined)
    return undefined
  const region = await readGitConfig(context, 'cos.region', file)
  if (region === undefined)
    throw new TypeError('有 cos.bucket 但没有 cos.region')
  const endpoint = await readGitConfig(context, 'cos.endpoint', file)
  return normalizeLocation({
    bucket,
    region,
    prefix: await readGitConfig(context, 'cos.prefix', file) ?? '',
    ...(endpoint === undefined ? {} : { endpoint }),
  })
}

/**
 * Read the `[cos]` section of `<root>/.yunbox/config`, falling back to the
 * legacy `<root>/.yunboxconfig`; `undefined` when neither has a bucket. Both
 * files may exist while a team upgrades, but only with the same location.
 *
 * @throws {TypeError} naming the file when a setting is invalid or the two files disagree.
 */
export async function readLocation(context: CliContext, root: string): Promise<CosLocation | undefined> {
  const found: { file: string, location: CosLocation }[] = []
  for (const file of locationFiles(root)) {
    try {
      const location = await readCosSection(context, join(root, file))
      if (location !== undefined)
        found.push({ file, location })
    }
    catch (error) {
      throw new TypeError(`${file}：${(error as Error).message}`)
    }
  }
  const [current, legacy] = found
  if (current !== undefined && legacy !== undefined && !sameLocation(current.location, legacy.location))
    throw new TypeError(`${current.file} 和 ${legacy.file} 的 COS 位置不一致（${describeLocation(current.location)} / ${describeLocation(legacy.location)}），确认 ${current.file} 正确后删除 ${legacy.file}`)
  return current?.location
}

/**
 * Write the location into `<root>/.yunbox/config`, keeping every other
 * setting there, and delete the legacy `.yunboxconfig` so the two cannot
 * drift apart. Returns whether the legacy file was removed.
 */
export async function writeLocation(context: CliContext, root: string, location: CosLocation): Promise<{ removedLegacy: boolean }> {
  const file = join(root, LOCATION_FILE)
  await mkdir(dirname(file), { recursive: true })
  await writeCosSection(context, file, location)
  return removeLegacyLocationFile(root)
}

/** Write the `[cos]` section of a settings file, keeping every other setting. */
export async function writeCosSection(context: CliContext, file: string, location: CosLocation): Promise<void> {
  await runGitChecked(context, ['config', '--file', file, 'cos.bucket', location.bucket])
  await runGitChecked(context, ['config', '--file', file, 'cos.region', location.region])
  await runGitChecked(context, ['config', '--file', file, 'cos.prefix', location.prefix])
  if (location.endpoint === undefined)
    await runGitChecked(context, ['config', '--file', file, '--unset-all', 'cos.endpoint']).catch(() => {})
  else
    await runGitChecked(context, ['config', '--file', file, 'cos.endpoint', location.endpoint])
}

/** Delete the legacy `.yunboxconfig` so it cannot drift from `.yunbox/config`; returns whether it existed. */
export async function removeLegacyLocationFile(root: string): Promise<{ removedLegacy: boolean }> {
  const legacy = join(root, LEGACY_LOCATION_FILE)
  if (!existsSync(legacy))
    return { removedLegacy: false }
  await rm(legacy)
  return { removedLegacy: true }
}

/** Whether two locations point at the same objects. */
export function sameLocation(a: CosLocation, b: CosLocation): boolean {
  return a.bucket === b.bucket && a.region === b.region && a.prefix === b.prefix && a.endpoint === b.endpoint
}

/** Describe a location for messages. */
export function describeLocation(location: CosLocation): string {
  return `${location.bucket}（${location.region}）/${location.prefix === '' ? '' : `${location.prefix}/`}`
}
