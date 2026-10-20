import { describe, expect, it } from 'vitest'
import { SmithySha256 } from '../test/smithy-sha256.ts'
import { EMPTY_PAYLOAD_SHA256, signSigV4, UNSIGNED_PAYLOAD } from './s3-signature.ts'

/**
 * Cases from the AWS Signature Version 4 test suite, as published by AWS in
 * `aws-sig-v4-test-suite` and kept in awslabs/aws-c-auth
 * (`tests/aws-signing-test-suite/v4/<name>`): fixed keys, date, region and
 * the `service` service; header-based signing without `x-amz-content-sha256`
 * unless the case signs the body.
 */
const suite = {
  credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
  region: 'us-east-1',
  service: 'service',
  date: new Date('2015-08-30T12:36:00Z'),
}

describe('signSigV4 with the AWS test suite', () => {
  it('get-vanilla', () => {
    const result = signSigV4({ ...suite, method: 'GET', path: '/', headers: { Host: 'example.amazonaws.com' }, payloadHash: EMPTY_PAYLOAD_SHA256, contentSha256Header: false })
    expect(result.canonicalRequest).toBe('GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(result.stringToSign).toBe('AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63')
    expect(result.signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
    expect(result.headers.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
  })

  it('get-vanilla-query-order-key-case', () => {
    const result = signSigV4({ ...suite, method: 'GET', path: '/', query: { Param2: 'value2', Param1: 'value1' }, headers: { host: 'example.amazonaws.com' }, payloadHash: EMPTY_PAYLOAD_SHA256, contentSha256Header: false })
    expect(result.canonicalRequest.split('\n')[2]).toBe('Param1=value1&Param2=value2')
    expect(result.signature).toBe('b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500')
  })

  it('get-unreserved and get-utf8: only unreserved characters stay as they are', () => {
    const unreserved = signSigV4({ ...suite, method: 'GET', path: '/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', headers: { host: 'example.amazonaws.com' }, payloadHash: EMPTY_PAYLOAD_SHA256, contentSha256Header: false })
    expect(unreserved.signature).toBe('07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f')
    const utf8 = signSigV4({ ...suite, method: 'GET', path: '/ሴ', headers: { host: 'example.amazonaws.com' }, payloadHash: EMPTY_PAYLOAD_SHA256, contentSha256Header: false })
    expect(utf8.canonicalRequest.split('\n')[1]).toBe('/%E1%88%B4')
    expect(utf8.signature).toBe('8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85')
  })

  it('get-space-normalized: spaces are percent-encoded, the trailing slash kept', () => {
    const result = signSigV4({ ...suite, method: 'GET', path: '/example space/', headers: { host: 'example.amazonaws.com' }, payloadHash: EMPTY_PAYLOAD_SHA256, contentSha256Header: false })
    expect(result.signature).toBe('652487583200325589f1fba4c7e578f72c47cb61beeca81406b39ddec1366741')
  })

  it('get-vanilla-with-session-token', () => {
    const result = signSigV4({
      ...suite,
      credentials: { ...suite.credentials, sessionToken: '6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267' },
      method: 'GET',
      path: '/',
      headers: { host: 'example.amazonaws.com' },
      payloadHash: EMPTY_PAYLOAD_SHA256,
      contentSha256Header: false,
    })
    expect(result.headers['x-amz-security-token']).toBe('6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267')
    expect(result.signature).toBe('07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8')
  })

  it('post-x-www-form-urlencoded: a signed body hash', () => {
    const result = signSigV4({
      ...suite,
      method: 'POST',
      path: '/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Host': 'example.amazonaws.com', 'Content-Length': '13' },
      payloadHash: '9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e',
    })
    expect(result.canonicalRequest.split('\n').at(-2)).toBe('content-length;content-type;host;x-amz-content-sha256;x-amz-date')
    expect(result.stringToSign.split('\n').at(-1)).toBe('b1edd1d03544c25390e32085d55b57acc9a3961bb59415ff86c45c3d89d16cfb')
    expect(result.signature).toBe('d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b')
  })
})

describe('signSigV4 for S3 requests', () => {
  const s3 = {
    credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    region: 'us-east-1',
    service: 's3',
    date: new Date('2013-05-24T00:00:00Z'),
  }

  /** Sign the same request with the AWS SDK's signer (Smithy) and return its Authorization header. */
  async function smithy(request: { method: string, host: string, encodedPath: string, headers: Record<string, string>, sessionToken?: string, region?: string, date?: Date }): Promise<string> {
    const { SignatureV4 } = await import('@smithy/signature-v4')
    const signer = new SignatureV4({
      credentials: { ...s3.credentials, ...(request.sessionToken === undefined ? {} : { sessionToken: request.sessionToken }) },
      region: request.region ?? s3.region,
      service: 's3',
      sha256: SmithySha256,
      uriEscapePath: false,
      applyChecksum: false,
    })
    const signed = await signer.sign({ method: request.method, protocol: 'https:', hostname: request.host, path: request.encodedPath, query: {}, headers: { host: request.host, ...request.headers } }, { signingDate: request.date ?? s3.date })
    return signed.headers.authorization!
  }

  it('matches the AWS S3 documentation example of GET Object with a Range header', async () => {
    const result = signSigV4({ ...s3, method: 'GET', path: '/test.txt', headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9' }, payloadHash: EMPTY_PAYLOAD_SHA256 })
    expect(result.signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41')
    expect(result.headers.authorization).toBe(await smithy({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', encodedPath: '/test.txt', headers: { 'range': 'bytes=0-9', 'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256, 'x-amz-date': '20130524T000000Z' } }))
  })

  it('matches the AWS S3 documentation example of PUT Object, encoding $ in the key', async () => {
    const result = signSigV4({
      ...s3,
      method: 'PUT',
      path: '/test$file.text',
      headers: { 'host': 'examplebucket.s3.amazonaws.com', 'date': 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    })
    expect(result.canonicalRequest.split('\n')[1]).toBe('/test%24file.text')
    expect(result.signature).toBe('98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd')
  })

  it('agrees with the AWS SDK signer on the requests YunBox sends', async () => {
    const host = 'abc123.r2.cloudflarestorage.com'
    const date = new Date('2026-10-20T08:09:10Z')
    const oid = 'a'.repeat(64)
    const path = `/team-assets/yunbox/team/game/aa/aa/${oid}`
    const put = signSigV4({
      ...s3,
      region: 'auto',
      date,
      credentials: { ...s3.credentials, sessionToken: 'session/token+value' },
      method: 'PUT',
      path,
      headers: { 'host': host, 'content-length': '1048576', 'content-type': 'application/octet-stream', 'if-none-match': '*' },
      payloadHash: oid,
    })
    expect(put.headers.authorization).toBe(await smithy({
      method: 'PUT',
      host,
      encodedPath: path,
      region: 'auto',
      date,
      sessionToken: 'session/token+value',
      headers: { 'content-length': '1048576', 'content-type': 'application/octet-stream', 'if-none-match': '*', 'x-amz-content-sha256': oid, 'x-amz-date': '20261020T080910Z', 'x-amz-security-token': 'session/token+value' },
    }))

    const unsigned = signSigV4({ ...s3, date, method: 'PUT', path: '/bucket/key with space', headers: { host }, payloadHash: UNSIGNED_PAYLOAD })
    expect(unsigned.canonicalRequest.split('\n').at(-1)).toBe('UNSIGNED-PAYLOAD')
    expect(unsigned.headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD')
    expect(unsigned.headers.authorization).toBe(await smithy({ method: 'PUT', host, encodedPath: '/bucket/key%20with%20space', date, headers: { 'x-amz-content-sha256': UNSIGNED_PAYLOAD, 'x-amz-date': '20261020T080910Z' } }))
  })

  it('never puts the secret into the output', () => {
    const result = signSigV4({ ...s3, method: 'GET', path: '/k', headers: { host: 'h' }, payloadHash: EMPTY_PAYLOAD_SHA256 })
    expect(JSON.stringify(result)).not.toContain(s3.credentials.secretAccessKey)
  })
})
