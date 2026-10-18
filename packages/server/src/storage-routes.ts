// @env node

import type {
  CosCredentialSource,
  CreateStorageActionOptions,
  LfsAction,
  LfsObject,
  ObjectStorage,
  RepositoryId,
  StorageVerificationResult,
  StoredObjectInfo,
} from '@yunbox/core'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assertRepository, CosObjectStorage } from '@yunbox/core'

/** Where one set of repositories keeps its objects in COS. */
export interface CosRoute {
  /** `*`, `<owner>/*` or `<owner>/<repo>`. */
  repos: string
  /** Bucket name including the APPID suffix. */
  bucket: string
  region: string
  /** Key prefix inside the bucket; repositories are further separated by `<owner>/<repo>/`. */
  prefix?: string
  /** Override the bucket origin, for tests. */
  endpoint?: string
}

/** The storage configuration file, `yunbox.storage.json` by convention. */
export interface StorageRoutesDocument {
  version: 1
  routes: CosRoute[]
}

/** Raised when no route matches a repository; the server answers 404. */
export class RepositoryNotConfiguredError extends Error {
  constructor() {
    super('Repository is not configured for storage on this server')
    this.name = 'RepositoryNotConfiguredError'
  }
}

/**
 * Parse and validate a storage configuration document.
 *
 * @throws {TypeError} naming the first problem; messages never contain credentials.
 */
export function parseStorageRoutes(text: string): StorageRoutesDocument {
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch {
    throw new TypeError('storage configuration is not valid JSON')
  }
  if (typeof value !== 'object' || value === null || (value as { version?: unknown }).version !== 1)
    throw new TypeError('storage configuration must be an object with "version": 1')
  const routes = (value as { routes?: unknown }).routes
  if (!Array.isArray(routes) || routes.length === 0)
    throw new TypeError('storage configuration needs at least one route')
  const seen = new Set<string>()
  const parsed = routes.map((route, index): CosRoute => {
    const label = `route ${index + 1}`
    if (typeof route !== 'object' || route === null)
      throw new TypeError(`${label} must be an object`)
    const { repos, bucket, region, prefix, endpoint } = route as Record<string, unknown>
    if (typeof repos !== 'string' || typeof bucket !== 'string' || typeof region !== 'string')
      throw new TypeError(`${label} needs string "repos", "bucket" and "region"`)
    if (prefix !== undefined && typeof prefix !== 'string')
      throw new TypeError(`${label} "prefix" must be a string`)
    if (endpoint !== undefined && typeof endpoint !== 'string')
      throw new TypeError(`${label} "endpoint" must be a string`)
    assertRoutePattern(repos, label)
    if (seen.has(repos))
      throw new TypeError(`${label} repeats the repository pattern ${repos}`)
    seen.add(repos)
    const result: CosRoute = { repos, bucket, region }
    if (prefix !== undefined)
      result.prefix = prefix
    if (endpoint !== undefined)
      result.endpoint = endpoint
    try {
      // Validates bucket, region, prefix and endpoint exactly as the server will use them.
      createRouteStorage(result, { secretId: 'check', secretKey: 'check' })
    }
    catch (error) {
      throw new TypeError(`${label}: ${(error as Error).message}`)
    }
    return result
  })
  return { version: 1, routes: parsed }
}

/** Read a storage configuration from a file path, or inline JSON when `source` starts with `{`. */
export function readStorageRoutes(source: string): StorageRoutesDocument {
  const text = source.trimStart().startsWith('{') ? source : readFileSync(source, 'utf8')
  return parseStorageRoutes(text)
}

/** Read a configuration file, or return an empty document when it does not exist yet. */
export function readStorageRoutesFileOrEmpty(path: string): { version: 1, routes: CosRoute[] } {
  return existsSync(path) ? readStorageRoutes(path) : { version: 1, routes: [] }
}

/** Write a configuration file atomically. It contains no credentials. */
export async function writeStorageRoutes(path: string, document: StorageRoutesDocument): Promise<void> {
  parseStorageRoutes(JSON.stringify(document))
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' })
  await rename(temporary, path)
}

/** Add a route, replacing an existing one with the same pattern. Returns the replaced route, if any. */
export function upsertRoute(document: { version: 1, routes: CosRoute[] }, route: CosRoute): CosRoute | undefined {
  const index = document.routes.findIndex(existing => existing.repos === route.repos)
  if (index === -1) {
    document.routes.push(route)
    return undefined
  }
  const replaced = document.routes[index]
  document.routes[index] = route
  return replaced
}

/** The route for a repository: an exact `<owner>/<repo>` wins over `<owner>/*`, which wins over `*`. */
export function matchRoute<T extends { repos: string }>(routes: readonly T[], repository: RepositoryId): T | undefined {
  const name = `${repository.owner}/${repository.repo}`
  return routes.find(route => route.repos === name)
    ?? routes.find(route => route.repos === `${repository.owner}/*`)
    ?? routes.find(route => route.repos === '*')
}

/** Create the COS storage a route points at. */
export function createRouteStorage(route: CosRoute, credentials: CosCredentialSource): CosObjectStorage {
  return new CosObjectStorage({
    bucket: route.bucket,
    region: route.region,
    prefix: route.prefix,
    endpoint: route.endpoint,
    credentials,
  })
}

/**
 * Object storage that sends each repository to the COS bucket and prefix of
 * its route, so different projects can use different buckets or share one
 * bucket under different prefixes. Repositories without a route are refused.
 */
export class RoutedObjectStorage implements ObjectStorage {
  readonly routes: ReadonlyArray<{ route: CosRoute, storage: CosObjectStorage }>

  constructor(document: StorageRoutesDocument, credentials: CosCredentialSource) {
    this.routes = document.routes.map(route => ({ route, storage: createRouteStorage(route, credentials) }))
  }

  /** The storage of the `*` route, or of the first route when there is none. */
  get defaultStorage(): CosObjectStorage {
    return (this.routes.find(entry => entry.route.repos === '*') ?? this.routes[0]!).storage
  }

  /** The storage for a repository. @throws {RepositoryNotConfiguredError} */
  storageFor(repository: RepositoryId): CosObjectStorage {
    assertRepository(repository)
    const entry = matchRoute(this.routes.map(entry => ({ ...entry, repos: entry.route.repos })), repository)
    if (entry === undefined)
      throw new RepositoryNotConfiguredError()
    return entry.storage
  }

  inspectObject(repository: RepositoryId, oid: string): Promise<StoredObjectInfo | undefined> {
    return this.storageFor(repository).inspectObject(repository, oid)
  }

  verifyObject(repository: RepositoryId, oid: string, expectedSize: number): Promise<StorageVerificationResult> {
    return this.storageFor(repository).verifyObject(repository, oid, expectedSize)
  }

  createUploadAction(repository: RepositoryId, object: LfsObject, options: CreateStorageActionOptions): Promise<LfsAction> {
    return this.storageFor(repository).createUploadAction(repository, object, options)
  }

  createDownloadAction(repository: RepositoryId, object: LfsObject, options: CreateStorageActionOptions): Promise<LfsAction> {
    return this.storageFor(repository).createDownloadAction(repository, object, options)
  }
}

function assertRoutePattern(pattern: string, label: string): void {
  if (pattern === '*')
    return
  const [owner, repo, ...rest] = pattern.split('/')
  if (owner === undefined || repo === undefined || rest.length > 0)
    throw new TypeError(`${label} "repos" must be "*", "<owner>/*" or "<owner>/<repo>"`)
  try {
    assertRepository({ owner, repo: repo === '*' ? 'x' : repo })
  }
  catch {
    throw new TypeError(`${label} "repos" contains an invalid owner or repository name`)
  }
}
