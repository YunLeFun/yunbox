// @env node

import type { ObjectTransport } from '../storage/object-store.ts'
import type { AccessKeys, ObjectStore } from '../storage/provider.ts'
import type { S3Location } from './location.ts'
import { awsUriEncode, signSigV4 } from '@yunbox/core'
import { HttpObjectStore } from '../storage/object-store.ts'
import { isR2 } from './location.ts'

/** The raw (unencoded) path of `key` and its URL, for the location's addressing style. */
export function s3Address(location: S3Location, key: string): { path: string, url: URL } {
  const endpoint = new URL(location.endpoint)
  const path = location.addressingStyle === 'path' ? `/${location.bucket}/${key}` : `/${key}`
  const origin = location.addressingStyle === 'path' ? endpoint.origin : `${endpoint.protocol}//${location.bucket}.${endpoint.host}`
  return { path, url: new URL(path.split('/').map(awsUriEncode).join('/'), origin) }
}

/**
 * The S3 side of {@link HttpObjectStore}: path-style or virtual-hosted
 * addresses and AWS Signature Version 4 in the `Authorization` header.
 *
 * The payload hash is always signed. For LFS objects it is the object id
 * itself (git-lfs ids are the SHA-256 of the content), so uploads need no
 * extra read, no `UNSIGNED-PAYLOAD` and no chunked streaming signature, and
 * the service rejects a body that does not match (`XAmzContentSHA256Mismatch`).
 *
 * Uploads send `If-None-Match: *`. A service that answers 501 (or
 * `NotImplemented`) does not support it; the store then repeats the PUT
 * without it, see docs/plan.md section 12 for why that is acceptable.
 */
export function s3Transport(location: S3Location, credentials: () => AccessKeys): ObjectTransport {
  const r2 = isR2(location)
  return {
    label: 'S3',
    prefix: location.prefix,
    url: key => s3Address(location, key).url,
    sign: ({ method, key, headers, payloadSha256 }) => {
      const keys = credentials()
      return signSigV4({
        credentials: { accessKeyId: keys.secretId, secretAccessKey: keys.secretKey, ...(keys.sessionToken === undefined ? {} : { sessionToken: keys.sessionToken }) },
        method,
        path: s3Address(location, key).path,
        headers,
        payloadHash: payloadSha256,
        region: location.region,
        service: 's3',
        date: new Date(),
      }).headers
    },
    noOverwrite: { 'if-none-match': '*' },
    // 412: the key exists. 409: a concurrent write or delete won; a fresh HEAD decides.
    conflictStatuses: [412, 409],
    guardUnsupported: (status, code) => status === 501 || code === 'NotImplemented',
    hint: (status, code) => {
      if (code === 'SignatureDoesNotMatch')
        return '：签名不对，通常是 Secret Access Key 不对，或 .yunbox/config 里的 s3.region 不对'
      if (code === 'RequestTimeTooSkewed')
        return '：本机时间和服务器相差太多（超过 15 分钟），请校准系统时间'
      if (code === 'InvalidAccessKeyId')
        return '：Access Key ID 不存在或已被删除，请重新运行 yunbox login --provider s3'
      if (status === 403) {
        return r2
          ? '：R2 token 没有这个 bucket 的权限，或者已经失效。R2 token 需要这个 bucket 的「对象读和写」权限（yunbox doctor 可以检查）'
          : '：密钥没有这个 bucket 的权限，或者已经失效（yunbox doctor 可以检查）'
      }
      if (status === 404 && code === 'NoSuchBucket')
        return '：bucket 不存在，检查 .yunbox/config 里的 s3.bucket 和 s3.endpoint'
      return ''
    },
  }
}

/** An S3-compatible bucket through the shared {@link HttpObjectStore}. */
export function createS3ObjectStore(location: S3Location, credentials: () => AccessKeys): ObjectStore {
  return new HttpObjectStore(s3Transport(location, credentials))
}
