import type { CliContext } from '../context.ts'
import { join } from 'node:path'
import { readGitConfig, runGitChecked } from '../git.ts'

const BUCKET_PATTERN = /^[a-z\d][a-z\d-]{0,48}-\d{5,20}$/
const REGION_PATTERN = /^[a-z\d][a-z\d-]{1,40}$/
const PREFIX_SEGMENT_PATTERN = /^[\w.-]+$/

/**
 * Where a repository keeps its LFS objects in COS. Stored in the `[cos]`
 * section of `.yunboxconfig` (git config format), which is committed and
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

/** The COS key of an LFS object. */
export function objectKey(location: CosLocation, oid: string): string {
  const path = `${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`
  return location.prefix === '' ? path : `${location.prefix}/${path}`
}

/** The shared COS settings file at the repository root. */
export const LOCATION_FILE = '.yunboxconfig'

/** Read the `[cos]` section of `<root>/.yunboxconfig`; `undefined` when there is no bucket. */
export async function readLocation(context: CliContext, root: string): Promise<CosLocation | undefined> {
  const file = join(root, LOCATION_FILE)
  const bucket = await readGitConfig(context, 'cos.bucket', file)
  if (bucket === undefined)
    return undefined
  const region = await readGitConfig(context, 'cos.region', file)
  if (region === undefined)
    throw new TypeError(`${LOCATION_FILE} 里有 cos.bucket 但没有 cos.region`)
  const endpoint = await readGitConfig(context, 'cos.endpoint', file)
  return normalizeLocation({
    bucket,
    region,
    prefix: await readGitConfig(context, 'cos.prefix', file) ?? '',
    ...(endpoint === undefined ? {} : { endpoint }),
  })
}

/** Write the location into `<root>/.yunboxconfig`, keeping every other setting. */
export async function writeLocation(context: CliContext, root: string, location: CosLocation): Promise<void> {
  const file = join(root, LOCATION_FILE)
  await runGitChecked(context, ['config', '--file', file, 'cos.bucket', location.bucket])
  await runGitChecked(context, ['config', '--file', file, 'cos.region', location.region])
  await runGitChecked(context, ['config', '--file', file, 'cos.prefix', location.prefix])
  if (location.endpoint === undefined)
    await runGitChecked(context, ['config', '--file', file, '--unset-all', 'cos.endpoint']).catch(() => {})
  else
    await runGitChecked(context, ['config', '--file', file, 'cos.endpoint', location.endpoint])
}

/** Describe a location for messages. */
export function describeLocation(location: CosLocation): string {
  return `${location.bucket}（${location.region}）/${location.prefix === '' ? '' : `${location.prefix}/`}`
}
