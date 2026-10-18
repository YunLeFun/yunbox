import { describe, expect, it } from 'vitest'
import { signTc3 } from './tencent-api.ts'

describe('signing Tencent Cloud API 3.0 requests', () => {
  it('matches the official Python SDK (tencentcloud.common.sign.Sign.sign_tc3)', () => {
    // Reference signature computed with the SDK bundled in tccli 3.1.146.1 for the same canonical request.
    const authorization = signTc3({
      credentials: { secretId: 'AKID-example-not-a-real-key', secretKey: 'example-secret-key-example-secret1' },
      service: 'cam',
      host: 'cam.tencentcloudapi.com',
      action: 'GetUserAppId',
      payload: '{"Name":"yunbox-test"}',
      timestamp: 1_792_300_000,
    })
    expect(authorization).toBe('TC3-HMAC-SHA256 Credential=AKID-example-not-a-real-key/2026-10-18/cam/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=8d8ad76251e9cb52dbd827d9faaedd6b74ef97daeef71917b69f5393bc49870f')
  })
})
