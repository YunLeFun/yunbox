// @env node

import type { ResolvedCredentials } from '../cos/credentials.ts'
import type { S3Location } from '../s3/location.ts'
import type { StorageProvider } from './provider.ts'
import { CliError } from '../context.ts'
import { readStores } from '../cos/credentials.ts'
import { defaultSecretStores } from '../cos/secret-store.ts'
import { createS3ObjectStore } from '../s3/client.ts'
import { describeS3Location, normalizeS3Location, readS3Section, sameS3Location, writeS3Section } from '../s3/location.ts'

/**
 * Resolve the user's keys for S3-compatible storage, in order:
 * `YUNBOX_S3_ACCESS_KEY_ID` / `YUNBOX_S3_SECRET_ACCESS_KEY`
 * (+ `YUNBOX_S3_SESSION_TOKEN`), then what `yunbox login --provider s3`
 * saved (the macOS keychain, then the file). The generic `AWS_*` variables
 * are deliberately not read, so that a developer's AWS identity is never
 * sent to another service such as R2.
 *
 * @throws {CliError} when a store exists but cannot be read and nothing else is configured.
 */
export async function resolveS3Credentials(env: NodeJS.ProcessEnv): Promise<ResolvedCredentials | undefined> {
  if (env.YUNBOX_S3_ACCESS_KEY_ID && env.YUNBOX_S3_SECRET_ACCESS_KEY) {
    return {
      credentials: { secretId: env.YUNBOX_S3_ACCESS_KEY_ID, secretKey: env.YUNBOX_S3_SECRET_ACCESS_KEY, sessionToken: env.YUNBOX_S3_SESSION_TOKEN || undefined },
      source: 'env',
      description: 'YUNBOX_S3_* 环境变量',
    }
  }
  let stores
  try {
    stores = defaultSecretStores(env, undefined, 's3')
  }
  catch (error) {
    throw new CliError((error as Error).message)
  }
  const { resolved, failure } = await readStores(stores)
  if (resolved === undefined && failure !== undefined)
    throw new CliError(failure.message)
  return resolved
}

/**
 * S3-compatible storage: Cloudflare R2, AWS S3, MinIO or any service with
 * the S3 object API and Signature Version 4. Only the transfer actions are
 * implemented: buckets, tokens and policies are managed in the service's
 * own console.
 */
export const s3Provider = {
  id: 's3' as const,
  label: 'S3',
  section: 's3',
  readConfig: readS3Section,
  writeConfig: writeS3Section,
  normalize: normalizeS3Location,
  describe: describeS3Location,
  same: sameS3Location,
  credentialStores: env => defaultSecretStores(env, undefined, 's3'),
  resolveCredentials: resolveS3Credentials,
  credentialHelp: [
    '本机还没有配置 S3 兼容存储（R2、AWS S3、MinIO 等）的密钥。任选一种：',
    '  yunbox login --provider s3   # 保存自己的 Access Key ID / Secret Access Key（推荐，只对这台电脑生效）',
    '  export YUNBOX_S3_ACCESS_KEY_ID=... YUNBOX_S3_SECRET_ACCESS_KEY=...',
  ],
  connect: createS3ObjectStore,
} satisfies StorageProvider<S3Location>
