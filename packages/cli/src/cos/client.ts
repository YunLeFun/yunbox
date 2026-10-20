// @env node

import type { CosCredentials } from '@yunbox/core'
import type { ObjectTransport } from '../storage/object-store.ts'
import type { ObjectStore } from '../storage/provider.ts'
import type { CosLocation } from './location.ts'
import { cosEncode, createCosAuthorization } from '@yunbox/core'
import { HttpObjectStore } from '../storage/object-store.ts'

/** Signatures only need to outlive one request; uploads stream for longer but are checked at the start. */
const SIGNATURE_TTL_SECONDS = 600

/**
 * The COS side of {@link HttpObjectStore}: virtual-hosted bucket origins,
 * v5 signatures over `host` and the sent headers, and
 * `x-cos-forbid-overwrite` so an existing object is never replaced.
 */
export function cosTransport(location: CosLocation, credentials: () => CosCredentials): ObjectTransport {
  const origin = new URL(location.endpoint ?? `https://${location.bucket}.cos.${location.region}.myqcloud.com`)
  return {
    label: 'COS',
    prefix: location.prefix,
    url: key => new URL(`/${key.split('/').map(cosEncode).join('/')}`, origin),
    sign: ({ method, key, headers }) => {
      const keys = credentials()
      const authorization = createCosAuthorization({
        credentials: keys,
        method,
        pathname: `/${key}`,
        headers,
        startTime: Math.floor(Date.now() / 1000) - 1,
        expiresInSeconds: SIGNATURE_TTL_SECONDS,
      })
      return { ...headers, authorization, ...(keys.sessionToken === undefined ? {} : { 'x-cos-security-token': keys.sessionToken }) }
    },
    noOverwrite: { 'x-cos-forbid-overwrite': 'true' },
    conflictStatuses: [409],
    hint: (status, code) => status === 403
      ? '：密钥没有这个 bucket / 前缀的权限，或者已经失效（yunbox doctor 可以检查）'
      : status === 404 && code === 'NoSuchBucket'
        ? '：bucket 不存在，检查 .yunbox/config 里的 cos.bucket 和 cos.region'
        : '',
  }
}

/** A COS bucket through the shared {@link HttpObjectStore}. */
export function createCosObjectStore(location: CosLocation, credentials: () => CosCredentials): ObjectStore {
  return new HttpObjectStore(cosTransport(location, credentials))
}
