import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createCosAuthorization } from '@yunbox/core'
import { describe, expect, it } from 'vitest'
import { LocalMetadataStore } from '../src/metadata-local.ts'
import { createCosStorageFromEnvironment } from '../src/storage-config.ts'
import { runGitLfsWorkflow, WORKFLOW_REPOSITORY } from './lfs-workflow.ts'

/**
 * Runs the shared Git LFS workflow against a real COS bucket.
 *
 * Skipped unless `YUNBOX_COS_E2E=1`. It needs the variables documented in
 * `createCosStorageFromEnvironment`, writes objects under a random sub-prefix
 * of `YUNBOX_COS_PREFIX` (default `yunbox-e2e`) and deletes what it wrote.
 * Tokens are kept in a temporary local metadata store; the CloudBase store
 * has its own live test (`metadata-live.test.ts`).
 */
describe.skipIf(process.env.YUNBOX_COS_E2E !== '1')('git LFS workflow on real COS', () => {
  it('pushes, clones, restores history and enforces tokens through presigned COS URLs', async () => {
    const prefix = `${process.env.YUNBOX_COS_PREFIX || 'yunbox-e2e'}/${randomUUID()}`
    const env: NodeJS.ProcessEnv = { ...process.env, YUNBOX_COS_PREFIX: prefix }
    const storage = createCosStorageFromEnvironment(env)
    const origin = process.env.YUNBOX_COS_ENDPOINT
      || `https://${env.YUNBOX_COS_BUCKET}.cos.${env.YUNBOX_COS_REGION}.myqcloud.com`

    const request = async (method: 'HEAD' | 'DELETE', key: string): Promise<Response> => {
      const host = new URL(origin).host
      const credentials = {
        secretId: env.TENCENTCLOUD_SECRETID!,
        secretKey: env.TENCENTCLOUD_SECRETKEY!,
        sessionToken: env.TENCENTCLOUD_SESSIONTOKEN || undefined,
      }
      const headers: Record<string, string> = {
        authorization: createCosAuthorization({
          credentials,
          method,
          pathname: `/${key}`,
          headers: { host },
          startTime: Math.floor(Date.now() / 1000) - 1,
          expiresInSeconds: 120,
        }),
      }
      if (credentials.sessionToken !== undefined)
        headers['x-cos-security-token'] = credentials.sessionToken
      return fetch(new URL(`/${key}`, origin), { method, headers })
    }

    const metadataDirectory = await mkdtemp(join(tmpdir(), 'yunbox-cos-live-metadata-'))
    let oids: string[] = []
    try {
      ;({ oids } = await runGitLfsWorkflow({
        storage,
        metadata: new LocalMetadataStore(metadataDirectory),
        writeStamp: async (oid) => {
          const response = await request('HEAD', storage.objectKey(WORKFLOW_REPOSITORY, oid))
          expect(response.status).toBe(200)
          return response.headers.get('last-modified')
        },
      }))
    }
    finally {
      for (const oid of oids) {
        const key = storage.objectKey(WORKFLOW_REPOSITORY, oid)
        await request('DELETE', key)
        await request('DELETE', `${key}.verified.json`)
      }
      await rm(metadataDirectory, { recursive: true, force: true })
    }
  }, 300_000)
})
