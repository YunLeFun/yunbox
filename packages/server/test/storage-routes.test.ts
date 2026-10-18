import type { RunningYunBoxServer } from '../src/types.ts'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCosServer } from '../../core/test/fake-cos-server.ts'
import { resolveServeConfig } from '../src/config.ts'
import { startYunBoxServer } from '../src/server.ts'
import { configureStorage } from '../src/storage-config.ts'
import { matchRoute, parseStorageRoutes, RoutedObjectStorage, writeStorageRoutes } from '../src/storage-routes.ts'
import { createToken } from '../src/tokens.ts'
import { basicAuth, batch, batchRequest, expectLfsError, getAction } from './http-helpers.ts'
import { runGitLfsWorkflow, WORKFLOW_REPOSITORY } from './lfs-workflow.ts'
import { MemoryMetadataStore } from './memory-metadata.ts'

const credentials = {
  secretId: 'AKIDTESTTESTTESTTESTTESTTESTTEST',
  secretKey: 'test-secret-key-test-secret-key',
  sessionToken: 'temporary-session-token',
}

describe('parsing storage routes', () => {
  const route = { bucket: 'assets-1250000000', region: 'ap-guangzhou' }

  it('accepts valid routes and rejects malformed ones with the route number', () => {
    expect(parseStorageRoutes(JSON.stringify({ version: 1, routes: [{ repos: 'team/*', prefix: 'yunbox/team', ...route }, { repos: '*', ...route }] })).routes).toHaveLength(2)
    const invalid: Array<[unknown, RegExp]> = [
      ['not json', /not valid JSON/],
      [{ version: 2, routes: [] }, /"version": 1/],
      [{ version: 1, routes: [] }, /at least one route/],
      [{ version: 1, routes: [{ repos: 'team/a/b', ...route }] }, /route 1 "repos" must be/],
      [{ version: 1, routes: [{ repos: '../x', ...route }] }, /route 1 "repos" contains an invalid/],
      [{ version: 1, routes: [{ repos: '*', ...route }, { repos: '*', ...route }] }, /route 2 repeats/],
      [{ version: 1, routes: [{ repos: '*', bucket: 'no-appid', region: 'ap-guangzhou' }] }, /route 1: bucket must look like/],
      [{ version: 1, routes: [{ repos: '*', ...route, prefix: 'a/../b' }] }, /route 1: prefix may only contain/],
    ]
    for (const [value, message] of invalid)
      expect(() => parseStorageRoutes(typeof value === 'string' ? value : JSON.stringify(value))).toThrow(message)
  })

  it('prefers an exact repository over an owner wildcard over the catch-all', () => {
    const routes = [{ repos: '*' }, { repos: 'team/*' }, { repos: 'team/game-a' }]
    expect(matchRoute(routes, { owner: 'team', repo: 'game-a' })?.repos).toBe('team/game-a')
    expect(matchRoute(routes, { owner: 'team', repo: 'game-b' })?.repos).toBe('team/*')
    expect(matchRoute(routes, { owner: 'other', repo: 'x' })?.repos).toBe('*')
    expect(matchRoute([{ repos: 'team/*' }], { owner: 'other', repo: 'x' })).toBeUndefined()
  })
})

describe('routing repositories to COS buckets', () => {
  let bucketA: FakeCosServer
  let bucketB: FakeCosServer
  let running: RunningYunBoxServer | undefined
  let directory: string

  beforeEach(async () => {
    bucketA = await new FakeCosServer(credentials).start()
    bucketB = await new FakeCosServer(credentials).start()
    directory = await mkdtemp(join(tmpdir(), 'yunbox-routes-test-'))
  })

  afterEach(async () => {
    await running?.close()
    running = undefined
    await Promise.all([bucketA.close(), bucketB.close(), rm(directory, { recursive: true, force: true })])
  })

  it('sends each repository to its bucket and prefix and refuses unrouted ones', async () => {
    const storage = new RoutedObjectStorage(parseStorageRoutes(JSON.stringify({
      version: 1,
      routes: [
        { repos: 'team/game-a', bucket: 'game-a-1250000000', region: 'ap-shanghai', prefix: 'yunbox', endpoint: bucketA.origin },
        { repos: 'team/*', bucket: 'shared-1250000000', region: 'ap-guangzhou', prefix: 'yunbox/team', endpoint: bucketB.origin },
      ],
    })), credentials)
    const metadata = new MemoryMetadataStore()
    const writer = basicAuth((await createToken(metadata, { name: 'writer', repos: { 'team/*': 'write', 'other/*': 'write' } })).secret)
    running = await startYunBoxServer({ storage, metadata, port: 0 })
    const oid = 'a'.repeat(64)

    const gameA = getAction(await batch(running.url, 'team/game-a', 'upload', oid, 4, writer), 'upload')
    expect(new URL(gameA.href).origin).toBe(bucketA.origin)
    expect(new URL(gameA.href).pathname).toBe(`/yunbox/team/game-a/aa/aa/${oid}`)
    const gameB = getAction(await batch(running.url, 'team/game-b', 'upload', oid, 4, writer), 'upload')
    expect(new URL(gameB.href).origin).toBe(bucketB.origin)
    expect(new URL(gameB.href).pathname).toBe(`/yunbox/team/team/game-b/aa/aa/${oid}`)

    await expectLfsError(await batchRequest(running.url, 'other/x', 'upload', oid, 4, writer), 404, /not configured/)
  })

  it('runs the git-lfs workflow through a routed bucket', async () => {
    const storage = new RoutedObjectStorage(parseStorageRoutes(JSON.stringify({
      version: 1,
      routes: [{ repos: `${WORKFLOW_REPOSITORY.owner}/*`, bucket: 'shared-1250000000', region: 'ap-guangzhou', prefix: 'yunbox/projects', endpoint: bucketA.origin }],
    })), credentials)
    const routed = storage.storageFor(WORKFLOW_REPOSITORY)
    const { oids } = await runGitLfsWorkflow({
      storage,
      metadata: new MemoryMetadataStore(),
      writeStamp: async oid => bucketA.putCount(routed.objectKey(WORKFLOW_REPOSITORY, oid)),
    })
    for (const oid of oids)
      expect(bucketA.putCount(`yunbox/projects/${WORKFLOW_REPOSITORY.owner}/${WORKFLOW_REPOSITORY.repo}/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`)).toBe(1)
    expect(bucketB.requests).toHaveLength(0)
  }, 120_000)

  it('loads routes from a file or inline JSON instead of YUNBOX_COS_* variables', async () => {
    const path = join(directory, 'yunbox.storage.json')
    const document = { version: 1 as const, routes: [{ repos: '*', bucket: 'shared-1250000000', region: 'ap-guangzhou', prefix: 'yunbox' }] }
    await writeStorageRoutes(path, document)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(document)
    const env = { TENCENTCLOUD_SECRETID: credentials.secretId, TENCENTCLOUD_SECRETKEY: credentials.secretKey }

    for (const source of [path, JSON.stringify(document)]) {
      const config = resolveServeConfig({ 'storage': 'cos', 'storage-config': source, 'metadata': 'local', 'metadata-dir': directory }, env)
      const configured = configureStorage({ ...config.storage, env })
      expect(configured.storage).toBeInstanceOf(RoutedObjectStorage)
      expect(configured.description).toContain('* -> shared-1250000000/yunbox')
    }

    expect(() => resolveServeConfig({ 'storage': 'cos', 'storage-config': join(directory, 'missing.json') }, env)).toThrow(/storage configuration file cannot be read/)
    expect(() => resolveServeConfig({ storage: 'cos' }, { ...env, YUNBOX_STORAGE_CONFIG: '{"version":1,"routes":[]}' })).toThrow(/at least one route \(from YUNBOX_STORAGE_CONFIG\)/)
    expect(() => resolveServeConfig({ 'storage': 'cos', 'storage-config': path }, {})).toThrow(/TENCENTCLOUD_SECRETID must be set/)
  })
})
