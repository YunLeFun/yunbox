import COS from 'cos-nodejs-sdk-v5'
import { describe, expect, it } from 'vitest'
import { cosEncode, createCosAuthorization } from './cos-signature.ts'

const credentials = {
  secretId: 'AKIDEXAMPLEEXAMPLEEXAMPLEEXAMPLE',
  secretKey: 'example-secret-key-example-secret',
}

function sdkAuthorization(options: {
  method: string
  pathname: string
  query?: Record<string, string>
  headers?: Record<string, string>
  keyTime: string
}): string {
  return COS.getAuthorization({
    SecretId: credentials.secretId,
    SecretKey: credentials.secretKey,
    Method: options.method,
    Pathname: options.pathname,
    Query: options.query ?? {},
    Headers: options.headers ?? {},
    KeyTime: options.keyTime,
  } as COS.StaticGetAuthorizationOptions)
}

describe('signing COS requests', () => {
  it('matches the official SDK for a presigned upload', () => {
    const headers = { 'host': 'bucket-1250000000.cos.ap-guangzhou.myqcloud.com', 'content-length': '131072' }
    const pathname = `/yunbox/team/assets/ab/cd/${'a'.repeat(64)}`
    expect(createCosAuthorization({
      credentials,
      method: 'PUT',
      pathname,
      headers,
      startTime: 1_792_000_000,
      expiresInSeconds: 300,
    })).toBe(sdkAuthorization({ method: 'put', pathname, headers, keyTime: '1792000000;1792000300' }))
  })

  it('matches the official SDK with mixed-case headers, query and non-ASCII paths', () => {
    const headers = { 'Host': '127.0.0.1:9000', 'If-Match': '"0123456789abcdef"', 'x-cos-meta-Note': 'a b(c)*' }
    const query = { 'versionId': 'v 1', 'response-content-type': 'application/octet-stream' }
    const pathname = '/素材/模型 (1).fbx'
    expect(createCosAuthorization({
      credentials,
      method: 'GET',
      pathname,
      headers,
      query,
      startTime: 1_792_000_000,
      expiresInSeconds: 60,
    })).toBe(sdkAuthorization({ method: 'get', pathname, headers, query, keyTime: '1792000000;1792000060' }))
  })

  it('encodes the characters encodeURIComponent leaves alone', () => {
    expect(cosEncode('!\'()*~ /')).toBe('%21%27%28%29%2A~%20%2F')
  })
})
