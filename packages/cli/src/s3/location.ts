import type { CliContext } from '../context.ts'
import { readGitConfig, runGitChecked } from '../git.ts'

const BUCKET_PATTERN = /^[a-z\d][a-z\d.-]{1,61}[a-z\d]$/
const REGION_PATTERN = /^[a-z\d][a-z\d-]{0,40}$/
const PREFIX_SEGMENT_PATTERN = /^[\w.-]+$/
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** How the bucket appears in request URLs. */
export type AddressingStyle = 'path' | 'virtual'

/**
 * A bucket of an S3-compatible service, stored in the `[s3]` section of
 * `.yunbox/config` next to `storage.provider = s3`. Objects live at
 * `<prefix>/<oid[0:2]>/<oid[2:4]>/<oid>`, as with COS.
 */
export interface S3Location {
  provider: 's3'
  /** Service origin without the bucket, for example `https://<account id>.r2.cloudflarestorage.com`. */
  endpoint: string
  bucket: string
  /** Signing region; `auto` for R2. */
  region: string
  /** Key prefix, no leading or trailing slash; empty for the bucket root. */
  prefix: string
  /** `path`: `<endpoint>/<bucket>/<key>`; `virtual`: `<bucket>.<endpoint host>/<key>`. */
  addressingStyle: AddressingStyle
}

/** A starting point for `git yunbox init --preset`. */
export interface S3Preset {
  id: 'r2' | 'aws' | 'minio'
  label: string
  /** Endpoint for a region or account; `undefined` when the user must give one. */
  endpoint?: (values: { region: string, accountId?: string }) => string
  region: string
  addressingStyle: AddressingStyle
}

/**
 * Presets of the services YunBox documents. Anything else S3-compatible
 * works with an explicit `--endpoint`.
 *
 * - R2: https://developers.cloudflare.com/r2/api/s3/api/ (endpoint `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, region `auto`)
 * - AWS: https://docs.aws.amazon.com/general/latest/gr/s3.html (regional endpoints, virtual-hosted style)
 * - MinIO: path-style on the server's own address, region `us-east-1` unless the server sets another
 */
export const S3_PRESETS: readonly S3Preset[] = [
  { id: 'r2', label: 'Cloudflare R2', endpoint: ({ accountId }) => `https://${accountId}.r2.cloudflarestorage.com`, region: 'auto', addressingStyle: 'path' },
  { id: 'aws', label: 'AWS S3', endpoint: ({ region }) => `https://s3.${region}.amazonaws.com`, region: 'us-east-1', addressingStyle: 'virtual' },
  { id: 'minio', label: 'MinIO', region: 'us-east-1', addressingStyle: 'path' },
]

/** Validate and normalize. @throws {TypeError} naming the bad setting. */
export function normalizeS3Location(location: Omit<S3Location, 'provider'>): S3Location {
  let url: URL
  try {
    url = new URL(location.endpoint)
  }
  catch {
    throw new TypeError(`endpoint「${location.endpoint}」不是有效的地址，例如 https://<account id>.r2.cloudflarestorage.com`)
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '')
    throw new TypeError('endpoint 只能是 origin（协议、域名和端口），不能带路径、参数或用户名')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)))
    throw new TypeError('endpoint 必须用 https；只有本机地址（localhost、127.0.0.1）可以用 http')
  if (!BUCKET_PATTERN.test(location.bucket) || location.bucket.includes('..'))
    throw new TypeError(`bucket「${location.bucket}」格式不对：3–63 个小写字母、数字、「-」或「.」`)
  if (!REGION_PATTERN.test(location.region))
    throw new TypeError(`region「${location.region}」格式不对，例如 auto（R2）或 us-east-1`)
  if (location.addressingStyle !== 'path' && location.addressingStyle !== 'virtual')
    throw new TypeError(`addressingStyle 只能是 path 或 virtual，不是「${String(location.addressingStyle)}」`)
  if (location.addressingStyle === 'virtual' && location.bucket.includes('.'))
    throw new TypeError(`bucket「${location.bucket}」含有「.」，虚拟主机风格的 HTTPS 证书对不上，请改用 addressingStyle = path`)
  const prefix = location.prefix.replace(/^\/+|\/+$/g, '')
  if (prefix !== '' && prefix.split('/').some(segment => !PREFIX_SEGMENT_PATTERN.test(segment) || segment === '.' || segment === '..'))
    throw new TypeError(`前缀「${location.prefix}」只能包含字母、数字、「.」「_」「-」和「/」`)
  return { provider: 's3', endpoint: url.origin, bucket: location.bucket, region: location.region, prefix, addressingStyle: location.addressingStyle }
}

/** Read the `[s3]` section of one settings file; `undefined` when it has no bucket. @throws {TypeError} for an invalid or missing setting. */
export async function readS3Section(context: CliContext, file: string): Promise<S3Location | undefined> {
  const bucket = await readGitConfig(context, 's3.bucket', file)
  if (bucket === undefined)
    return undefined
  const endpoint = await readGitConfig(context, 's3.endpoint', file)
  if (endpoint === undefined)
    throw new TypeError('有 s3.bucket 但没有 s3.endpoint')
  const region = await readGitConfig(context, 's3.region', file)
  if (region === undefined)
    throw new TypeError('有 s3.bucket 但没有 s3.region')
  return normalizeS3Location({
    endpoint,
    bucket,
    region,
    prefix: await readGitConfig(context, 's3.prefix', file) ?? '',
    addressingStyle: (await readGitConfig(context, 's3.addressingStyle', file) ?? 'path') as AddressingStyle,
  })
}

/** Write the `[s3]` section of a settings file, keeping every other setting. */
export async function writeS3Section(context: CliContext, file: string, location: S3Location): Promise<void> {
  for (const [key, value] of [['endpoint', location.endpoint], ['bucket', location.bucket], ['region', location.region], ['prefix', location.prefix], ['addressingStyle', location.addressingStyle]] as const)
    await runGitChecked(context, ['config', '--file', file, `s3.${key}`, value])
}

/** Whether two locations point at the same objects. */
export function sameS3Location(a: S3Location, b: S3Location): boolean {
  return a.endpoint === b.endpoint && a.bucket === b.bucket && a.region === b.region && a.prefix === b.prefix && a.addressingStyle === b.addressingStyle
}

/** Describe a location for messages: `bucket（host）/prefix/`. The endpoint host is not a secret. */
export function describeS3Location(location: S3Location): string {
  return `${location.bucket}（${new URL(location.endpoint).host}）/${location.prefix === '' ? '' : `${location.prefix}/`}`
}

/** Whether the endpoint is Cloudflare R2, whose tokens are scoped to buckets, never to prefixes. */
export function isR2(location: S3Location): boolean {
  return /\.r2\.cloudflarestorage\.com$/.test(new URL(location.endpoint).hostname)
}
