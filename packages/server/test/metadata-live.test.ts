import type { CloudBaseDocumentBackend } from '../src/metadata-cloudbase.ts'
import process from 'node:process'
import { describe } from 'vitest'
import { METADATA_COLLECTIONS } from '../src/metadata.ts'
import { createCloudBaseMetadataFromEnvironment } from '../src/storage-config.ts'
import { describeMetadataStoreContract } from './metadata-contract.ts'

/**
 * Runs the metadata store contract against a real CloudBase environment.
 *
 * Skipped unless `YUNBOX_CLOUDBASE_E2E=1`. It reads the variables documented
 * in `createCloudBaseMetadataFromEnvironment`; `YUNBOX_CLOUDBASE_COLLECTION_PREFIX`
 * defaults to `yunbox_e2e_`. The four collections `<prefix>tokens`,
 * `<prefix>grants`, `<prefix>locks` and `<prefix>audit` must exist and be
 * used for nothing else: every test deletes all of their documents.
 */
describe.skipIf(process.env.YUNBOX_CLOUDBASE_E2E !== '1')('cloudBase metadata on a real environment', () => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    YUNBOX_CLOUDBASE_COLLECTION_PREFIX: process.env.YUNBOX_CLOUDBASE_COLLECTION_PREFIX || 'yunbox_e2e_',
  }

  async function clear(backend: CloudBaseDocumentBackend): Promise<void> {
    for (const collection of METADATA_COLLECTIONS) {
      for (const document of await backend.list(collection))
        await backend.delete(collection, document.id)
    }
  }

  describeMetadataStoreContract('CloudBase (live)', async () => {
    const store = createCloudBaseMetadataFromEnvironment(env)
    const backend = store.backend as CloudBaseDocumentBackend
    await clear(backend)
    return { store, other: createCloudBaseMetadataFromEnvironment(env), cleanup: () => clear(backend) }
  })
})
