// @env node

import type { CliContext } from '../context.ts'
import type { CosLocation } from '../cos/location.ts'
import type { StorageProvider } from './provider.ts'
import { CosRequestError, createCosBucket, listCosBuckets } from '@yunbox/core'
import { createCosObjectStore } from '../cos/client.ts'
import { resolveCredentials } from '../cos/credentials.ts'
import { describeLocation, normalizeLocation, readCosSection, sameLocation, writeCosSection } from '../cos/location.ts'
import { buildCosPolicy } from '../cos/policy.ts'
import { defaultSecretStores } from '../cos/secret-store.ts'
import { StorageRequestError } from './provider.ts'

/** Turn a COS account-API failure into a {@link StorageRequestError} that keeps the status and code. */
async function wrap<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  }
  catch (error) {
    if (error instanceof CosRequestError)
      throw new StorageRequestError(error.message, error.status, error.code)
    throw error
  }
}

/**
 * Tencent Cloud COS, the default provider. `YUNBOX_COS_SERVICE_ENDPOINT`
 * points the account API (list / create buckets) at a test double.
 */
export const cosProvider = {
  id: 'cos' as const,
  label: 'COS',
  section: 'cos',
  readConfig: (context: CliContext, file: string) => readCosSection(context, file),
  writeConfig: (context: CliContext, file: string, location: CosLocation) => writeCosSection(context, file, location),
  normalize: normalizeLocation,
  describe: describeLocation,
  same: sameLocation,
  credentialStores: env => defaultSecretStores(env),
  resolveCredentials: env => resolveCredentials(env),
  credentialHelp: [
    '本机还没有配置腾讯云 COS 密钥。任选一种：',
    '  yunbox login            # 保存自己的子账号 SecretId / SecretKey（推荐，只对这台电脑生效）',
    '  tccli auth login        # 用浏览器登录腾讯云，临时密钥约 2 小时有效',
    '  export TENCENTCLOUD_SECRETID=... TENCENTCLOUD_SECRETKEY=...',
  ],
  connect: createCosObjectStore,
  buckets: {
    list: (credentials, env) => wrap(() => listCosBuckets({ credentials, endpoint: env.YUNBOX_COS_SERVICE_ENDPOINT || undefined })),
    create: (location, credentials, _env) => wrap(() => createCosBucket(location.bucket, location.region, { credentials, endpoint: location.endpoint })),
  },
  policy: { build: buildCosPolicy },
  restrictedKeys: true,
} satisfies StorageProvider<CosLocation>
