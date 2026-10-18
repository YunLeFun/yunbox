import type { CosLocation } from './location.ts'
import { cosAppIdOf } from '@yunbox/core'

/** COS actions the transfer agent needs to push: upload, then check and read back. */
export const WRITE_ACTIONS = ['name/cos:PutObject', 'name/cos:GetObject', 'name/cos:HeadObject'] as const
/** COS actions the transfer agent needs to pull. */
export const READ_ACTIONS = ['name/cos:GetObject', 'name/cos:HeadObject'] as const

/** One statement of a Tencent Cloud CAM policy (policy syntax 2.0). */
export interface CamStatement {
  effect: 'allow'
  action: string[]
  resource: string[]
}

/** A CAM policy document that can be pasted into the console's「按策略语法创建」editor. */
export interface CamPolicy {
  version: '2.0'
  statement: CamStatement[]
}

/**
 * The CAM resource covering every object under the location's prefix:
 * `qcs::cos:<region>:uid/<APPID>:<bucket>/<prefix>/*`, the six-part format of
 * the COS access-policy documentation. The APPID is the bucket name's numeric
 * suffix. An empty prefix covers the whole bucket.
 *
 * @throws {TypeError} when the bucket name has no APPID suffix.
 */
export function cosObjectResource(location: CosLocation): string {
  const appId = cosAppIdOf(location.bucket)
  if (appId === undefined)
    throw new TypeError(`bucket「${location.bucket}」没有 APPID 后缀，应该是 <名称>-<APPID>`)
  const prefix = location.prefix.replace(/^\/+|\/+$/g, '')
  return `qcs::cos:${location.region}:uid/${appId}:${location.bucket}/${prefix === '' ? '' : `${prefix}/`}*`
}

/**
 * The least-privilege policy for one collaborator of a direct-to-COS
 * repository: object read and write under the prefix only, no listing, no
 * deletion and nothing outside the prefix. With `readOnly`, read only.
 */
export function buildCosPolicy(location: CosLocation, options: { readOnly?: boolean } = {}): CamPolicy {
  return {
    version: '2.0',
    statement: [{
      effect: 'allow',
      action: [...(options.readOnly ? READ_ACTIONS : WRITE_ACTIONS)],
      resource: [cosObjectResource(location)],
    }],
  }
}
