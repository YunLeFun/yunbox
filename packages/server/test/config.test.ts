import type { RunningYunBoxServer } from '../src/types.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFileObjectStorage } from '@yunbox/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main } from '../src/cli.ts'
import { ConfigError, resolveServeConfig, resolveStorageSettings } from '../src/config.ts'
import { startYunBoxServer } from '../src/server.ts'
import { configureStorage } from '../src/storage-config.ts'
import { listTokens } from '../src/tokens.ts'
import { expectLfsError } from './http-helpers.ts'
import { MemoryMetadataStore } from './memory-metadata.ts'

const SECRET_ID = 'AKIDsecretidvalue0000000000000000'
const SECRET_KEY = 'super-secret-key-value-do-not-print'
const SESSION_TOKEN = 'session-token-value-do-not-print'

const cosEnvironment = {
  YUNBOX_COS_BUCKET: 'examplebucket-1250000000',
  YUNBOX_COS_REGION: 'ap-guangzhou',
  TENCENTCLOUD_SECRETID: SECRET_ID,
  TENCENTCLOUD_SECRETKEY: SECRET_KEY,
  TENCENTCLOUD_SESSIONTOKEN: SESSION_TOKEN,
  YUNBOX_CLOUDBASE_ENV: 'yunbox-test-1a2b3c',
}

function configError(action: () => unknown): ConfigError {
  try {
    action()
  }
  catch (error) {
    expect(error).toBeInstanceOf(ConfigError)
    return error as ConfigError
  }
  throw new Error('expected a ConfigError')
}

function expectNoSecrets(text: string): void {
  for (const secret of [SECRET_ID, SECRET_KEY, SESSION_TOKEN])
    expect(text).not.toContain(secret)
}

describe('configuration', () => {
  it('uses defaults when nothing is configured', () => {
    expect(resolveServeConfig({}, {})).toEqual({
      host: '127.0.0.1',
      port: 8080,
      publicUrl: undefined,
      storage: { kind: 'local', storageDirectory: '.yunbox-data', metadata: 'local', metadataDirectory: join('.yunbox-data', '_yunbox', 'metadata') },
    })
  })

  it('reads every setting from the environment', () => {
    expect(resolveServeConfig({}, {
      YUNBOX_HOST: '0.0.0.0',
      YUNBOX_PORT: '9000',
      YUNBOX_PUBLIC_URL: 'https://lfs.example.com/',
      YUNBOX_STORAGE: 'cos',
      YUNBOX_STORAGE_DIR: '/data',
      ...cosEnvironment,
    })).toEqual({
      host: '0.0.0.0',
      port: 9000,
      publicUrl: 'https://lfs.example.com',
      storage: { kind: 'cos', storageDirectory: '/data', metadata: 'cloudbase', metadataDirectory: '/data/_yunbox/metadata' },
    })
  })

  it('lets command-line options override environment variables', () => {
    const env = {
      YUNBOX_HOST: '0.0.0.0',
      YUNBOX_PORT: '9000',
      PORT: '7000',
      YUNBOX_PUBLIC_URL: 'https://env.example.com',
      YUNBOX_STORAGE: 'cos',
      YUNBOX_STORAGE_DIR: '/env-data',
    }
    // COS variables are absent, so this also proves the env storage kind is ignored.
    expect(resolveServeConfig({
      'host': '127.0.0.1',
      'port': '8081',
      'public-url': 'http://127.0.0.1:8081',
      'storage': 'local',
      'storage-dir': '/cli-data',
    }, env)).toEqual({
      host: '127.0.0.1',
      port: 8081,
      publicUrl: 'http://127.0.0.1:8081',
      storage: { kind: 'local', storageDirectory: '/cli-data', metadata: 'local', metadataDirectory: '/cli-data/_yunbox/metadata' },
    })
  })

  it('prefers YUNBOX_PORT over the platform PORT and ignores empty variables', () => {
    expect(resolveServeConfig({}, { PORT: '7000' }).port).toBe(7000)
    expect(resolveServeConfig({}, { YUNBOX_PORT: '9000', PORT: '7000' }).port).toBe(9000)
    expect(resolveServeConfig({}, { YUNBOX_PORT: '', PORT: '7000' }).port).toBe(7000)
    expect(resolveServeConfig({ port: '0' }, { YUNBOX_PORT: '9000', PORT: '7000' }).port).toBe(0)
    expect(resolveServeConfig({}, { YUNBOX_HOST: '', YUNBOX_STORAGE: '' })).toMatchObject({
      host: '127.0.0.1',
      storage: { kind: 'local' },
    })
  })

  it('resolves token command storage with the same precedence', () => {
    expect(resolveStorageSettings({}, { YUNBOX_STORAGE_DIR: '/env-data' }))
      .toEqual({ kind: 'local', storageDirectory: '/env-data', metadata: 'local', metadataDirectory: '/env-data/_yunbox/metadata' })
    expect(resolveStorageSettings({ 'storage-dir': '/cli-data' }, { YUNBOX_STORAGE_DIR: '/env-data' }).storageDirectory).toBe('/cli-data')
    expect(resolveStorageSettings({}, { YUNBOX_STORAGE: 'cos', ...cosEnvironment }).kind).toBe('cos')
    expect(resolveStorageSettings({ storage: 'local' }, { YUNBOX_STORAGE: 'cos' }).kind).toBe('local')
  })

  it('selects the metadata store, defaulting to CloudBase with COS and local files otherwise', () => {
    expect(resolveStorageSettings({}, { YUNBOX_STORAGE: 'cos', ...cosEnvironment }).metadata).toBe('cloudbase')
    const { YUNBOX_CLOUDBASE_ENV: _, ...withoutCloudBase } = cosEnvironment
    expect(resolveStorageSettings({}, { YUNBOX_STORAGE: 'cos', YUNBOX_METADATA: 'local', ...withoutCloudBase }).metadata).toBe('local')
    expect(resolveStorageSettings({ 'metadata': 'local', 'metadata-dir': '/cli-meta' }, { YUNBOX_METADATA: 'cloudbase', YUNBOX_METADATA_DIR: '/env-meta' }))
      .toMatchObject({ metadata: 'local', metadataDirectory: '/cli-meta' })
    expect(resolveStorageSettings({}, { YUNBOX_METADATA_DIR: '/env-meta' }).metadataDirectory).toBe('/env-meta')
    // A server API key can replace the Tencent Cloud keys for CloudBase alone.
    expect(resolveStorageSettings({ metadata: 'cloudbase' }, { YUNBOX_CLOUDBASE_ENV: 'env-1', YUNBOX_CLOUDBASE_API_KEY: SECRET_KEY }).metadata).toBe('cloudbase')

    expect(configError(() => resolveStorageSettings({}, { YUNBOX_METADATA: 'redis' })).problems)
      .toEqual(['metadata (from YUNBOX_METADATA) must be local or cloudbase'])
    expect(configError(() => resolveStorageSettings({ metadata: 'cloudbase' }, {})).problems).toEqual([
      'YUNBOX_CLOUDBASE_ENV must be set to use CloudBase metadata',
      'TENCENTCLOUD_SECRETID and TENCENTCLOUD_SECRETKEY (or YUNBOX_CLOUDBASE_API_KEY) must be set to use CloudBase metadata',
    ])
    for (const [name, value] of [
      ['YUNBOX_CLOUDBASE_ENV', `env ${SECRET_KEY}`],
      ['YUNBOX_CLOUDBASE_ENDPOINT', `http://${SECRET_KEY}.example.com`],
      ['YUNBOX_CLOUDBASE_COLLECTION_PREFIX', `${SECRET_KEY}`],
    ] as const) {
      const error = configError(() => resolveStorageSettings({ storage: 'cos' }, { ...cosEnvironment, [name]: value }))
      expect(error.problems).toEqual([expect.stringMatching(/^CloudBase settings are invalid: /)])
      expectNoSecrets(error.message)
    }
  })

  it('reports every problem at once and names where each setting came from', () => {
    const error = configError(() => resolveServeConfig({ port: '70000' }, {
      YUNBOX_HOST: '0.0.0.0',
      YUNBOX_STORAGE: 'disk',
    }))
    expect(error.problems).toEqual([
      'port (from --port) must be an integer from 0 to 65535',
      expect.stringMatching(/^publicUrl \(https\) is required when listening on 0\.0\.0\.0.*\(set with --public-url or YUNBOX_PUBLIC_URL\)$/),
      'storage (from YUNBOX_STORAGE) must be local or cos',
    ])
    expect(error.message).toMatch(/^Invalid configuration:\n {2}- port/)

    expect(configError(() => resolveServeConfig({}, { PORT: 'http' })).problems)
      .toEqual(['port (from PORT) must be an integer from 0 to 65535'])
    expect(configError(() => resolveServeConfig({}, { YUNBOX_HOST: '0.0.0.0', YUNBOX_PUBLIC_URL: 'http://lfs.example.com' })).problems)
      .toEqual(['publicUrl must use https when listening on a non-loopback address (set with YUNBOX_PUBLIC_URL)'])
    expect(configError(() => resolveServeConfig({}, { YUNBOX_PUBLIC_URL: 'https://lfs.example.com/team' })).problems)
      .toEqual(['publicUrl must be an origin without credentials, path, query or fragment (set with YUNBOX_PUBLIC_URL)'])
  })

  it('lists every missing COS variable without printing credential values', () => {
    const error = configError(() => resolveServeConfig({ storage: 'cos' }, {
      TENCENTCLOUD_SECRETKEY: SECRET_KEY,
      TENCENTCLOUD_SESSIONTOKEN: SESSION_TOKEN,
    }))
    expect(error.problems).toEqual([
      'YUNBOX_COS_BUCKET must be set to use COS storage',
      'YUNBOX_COS_REGION must be set to use COS storage',
      'TENCENTCLOUD_SECRETID must be set to use COS storage',
      'YUNBOX_CLOUDBASE_ENV must be set to use CloudBase metadata',
    ])
    expectNoSecrets(error.message)

    const empty = configError(() => resolveStorageSettings({ storage: 'cos' }, { ...cosEnvironment, TENCENTCLOUD_SECRETKEY: '' }))
    expect(empty.problems).toEqual(['TENCENTCLOUD_SECRETKEY must be set to use COS storage'])
    expectNoSecrets(empty.message)
  })

  it('rejects malformed COS settings without echoing any value', () => {
    for (const [name, value] of [
      ['YUNBOX_COS_BUCKET', `bucket-${SECRET_KEY}`],
      ['YUNBOX_COS_REGION', `Region ${SECRET_KEY}`],
      ['YUNBOX_COS_PREFIX', `../${SECRET_KEY}`],
      ['YUNBOX_COS_ENDPOINT', `not a url ${SECRET_KEY}`],
    ] as const) {
      const error = configError(() => resolveServeConfig({ storage: 'cos' }, { ...cosEnvironment, [name]: value }))
      expect(error.problems).toHaveLength(1)
      expect(error.problems[0]).toMatch(/^COS settings are invalid: /)
      expectNoSecrets(error.message)
    }
  })

  it('describes the credential kind without printing credentials', () => {
    const temporary = configureStorage({ kind: 'cos', storageDirectory: '.', env: cosEnvironment }).description
    expect(temporary).toContain('temporary credentials')
    expectNoSecrets(temporary)
    const longTerm = configureStorage({ kind: 'cos', storageDirectory: '.', env: { ...cosEnvironment, TENCENTCLOUD_SESSIONTOKEN: '' } }).description
    expect(longTerm).toContain('long-term credentials')
    expectNoSecrets(longTerm)
  })

  describe('command line', () => {
    let directory: string
    let lines: string[]

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'yunbox-config-test-'))
      lines = []
    })

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true })
    })

    it('refuses to serve with an incomplete configuration and prints nothing secret', async () => {
      const io = { stdout: (line: string) => lines.push(line), env: { YUNBOX_STORAGE: 'cos', TENCENTCLOUD_SECRETKEY: SECRET_KEY } }
      const failure = await main(['serve'], io).then(() => undefined, (error: unknown) => error)
      expect(failure).toBeInstanceOf(ConfigError)
      expect((failure as ConfigError).problems).toEqual([
        'YUNBOX_COS_BUCKET must be set to use COS storage',
        'YUNBOX_COS_REGION must be set to use COS storage',
        'TENCENTCLOUD_SECRETID must be set to use COS storage',
        'YUNBOX_CLOUDBASE_ENV must be set to use CloudBase metadata',
      ])
      expectNoSecrets((failure as Error).message)
      expect(lines).toEqual([])
    })

    it('lets token commands find the storage through the environment', async () => {
      const io = { stdout: (line: string) => lines.push(line), env: { YUNBOX_STORAGE_DIR: directory } }
      await main(['token', 'create', '--name', 'alice', '--write', 'team/assets'], io)
      const { metadata: local } = configureStorage({ kind: 'local', storageDirectory: directory, env: {} })
      expect((await listTokens(local)).map(token => token.name)).toEqual(['alice'])

      const override = join(directory, 'other')
      await main(['token', 'create', '--name', 'bob', '--read', 'team/assets', '--storage-dir', override], io)
      const other = configureStorage({ kind: 'local', storageDirectory: override, env: {} }).metadata
      expect((await listTokens(other)).map(token => token.name)).toEqual(['bob'])

      await expect(main(['token', 'list'], { ...io, env: { YUNBOX_STORAGE: 's3' } })).rejects.toThrow(/storage \(from YUNBOX_STORAGE\) must be local or cos/)
    })
  })
})

describe('health check', () => {
  let directory: string
  let running: RunningYunBoxServer | undefined
  let metadata: MemoryMetadataStore
  let logged: number

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'yunbox-health-test-'))
    metadata = new MemoryMetadataStore()
    logged = 0
    running = await startYunBoxServer({
      storage: new LocalFileObjectStorage(directory),
      metadata,
      port: 0,
      log: () => {
        logged += 1
      },
    })
  })

  afterEach(async () => {
    await running?.close()
    running = undefined
    await rm(directory, { recursive: true, force: true })
  })

  it('answers without credentials, storage or token store access, and reveals nothing', async () => {
    metadata.failReads = true
    const response = await fetch(`${running!.url}/_health`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(metadata.reads).toBe(0)

    const head = await fetch(`${running!.url}/_health?probe=1`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    // Probes arrive every few seconds; successful ones stay out of the access log.
    expect(logged).toBe(0)
  })

  it('rejects other methods in the LFS error format', async () => {
    const response = await fetch(`${running!.url}/_health`, { method: 'POST' })
    await expectLfsError(response, 405, /GET or HEAD/)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
    await expect.poll(() => logged).toBe(1)
  })
})
