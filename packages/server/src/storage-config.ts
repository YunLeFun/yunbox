// @env node

import type { CosCredentials } from '@yunbox/core'
import { CosObjectStorage } from '@yunbox/core'

/**
 * Create COS storage from environment variables.
 *
 * Bucket settings come from `YUNBOX_COS_BUCKET`, `YUNBOX_COS_REGION` and the
 * optional `YUNBOX_COS_PREFIX` / `YUNBOX_COS_ENDPOINT`. Credentials use the
 * standard Tencent Cloud variables (`TENCENTCLOUD_SECRETID`,
 * `TENCENTCLOUD_SECRETKEY`, `TENCENTCLOUD_SESSIONTOKEN`), which a bound runtime
 * role injects. They are re-read before every signature so rotated temporary
 * keys take effect without a restart.
 */
export function createCosStorageFromEnvironment(env: NodeJS.ProcessEnv): CosObjectStorage {
  const bucket = requireVariable(env, 'YUNBOX_COS_BUCKET')
  const region = requireVariable(env, 'YUNBOX_COS_REGION')
  readCredentials(env)
  return new CosObjectStorage({
    bucket,
    region,
    prefix: env.YUNBOX_COS_PREFIX,
    endpoint: env.YUNBOX_COS_ENDPOINT || undefined,
    credentials: () => readCredentials(env),
  })
}

function readCredentials(env: NodeJS.ProcessEnv): CosCredentials {
  return {
    secretId: requireVariable(env, 'TENCENTCLOUD_SECRETID'),
    secretKey: requireVariable(env, 'TENCENTCLOUD_SECRETKEY'),
    sessionToken: env.TENCENTCLOUD_SESSIONTOKEN || undefined,
  }
}

function requireVariable(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value === '')
    throw new Error(`${name} must be set to use COS storage`)
  return value
}
