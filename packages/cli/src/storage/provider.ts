import type { CosCredentials } from '@yunbox/core'
import type { CliContext } from '../context.ts'
import type { ResolvedCredentials } from '../cos/credentials.ts'
import type { CosLocation } from '../cos/location.ts'
import type { SecretStore } from '../cos/secret-store.ts'

/** The built-in object stores. Providers are not plugins: none of them is loaded from outside the CLI. */
export type ProviderId = 'cos'

/**
 * Where a repository keeps its LFS objects, as read from `.yunbox/config`.
 * COS locations have no `provider` field, so they stay what 0.1.x wrote.
 */
export type StorageLocation = CosLocation

/**
 * A key pair for any provider: `secretId` / `secretKey` are the provider's
 * key id and secret (the Tencent Cloud SecretId / SecretKey for COS).
 */
export type AccessKeys = CosCredentials

/** Called with the bytes transferred since the previous call. */
export type ProgressListener = (bytes: number) => void

/** The steps of {@link ObjectStore.probe}, in order. */
export const PROBE_OPERATIONS = ['PUT', 'HEAD', 'GET'] as const

/** Probe object key, relative to the prefix. */
export const PROBE_KEY = '_yunbox/probe'

/** Key that {@link ObjectStore.head} asks about to tell read access from none; it is never written. */
export const READ_CHECK_KEY = '_yunbox/read-check'

/** One step of {@link ObjectStore.probe}; `status` is 0 when no response arrived. */
export interface ProbeStep {
  operation: typeof PROBE_OPERATIONS[number]
  ok: boolean
  status: number
}

/**
 * What the transfer agent, `init`, `doctor` and the push check need from a
 * bucket. Every provider gets these from one shared implementation; only how
 * requests are addressed and signed differs.
 */
export interface ObjectStore {
  /** Size and ETag of a key, or `undefined` when it does not exist. */
  head: (key: string, options?: { signal?: AbortSignal }) => Promise<{ size: number, etag: string } | undefined>
  /**
   * Upload a file to `key` unless the key already exists with the same size;
   * never replaces an existing object.
   *
   * @returns `skipped` when the object was already there.
   */
  uploadFile: (key: string, path: string, expected: { oid: string, size: number }, onProgress?: ProgressListener) => Promise<'uploaded' | 'skipped'>
  /**
   * Stream `key` to `destination`, checking the size and SHA-256 against the
   * LFS object id; a mismatching file is deleted and an error raised.
   */
  downloadFile: (key: string, destination: string, expected: { oid: string, size: number }, onProgress?: ProgressListener) => Promise<void>
  /** Write, inspect and read back the probe object; stops at the first failure. */
  probe: () => Promise<ProbeStep[]>
}

/** A bucket the keys can see. */
export interface BucketSummary {
  name: string
  region: string
}

/** Optional capability: list and create buckets with the user's keys. */
export interface BucketCapability<L extends StorageLocation> {
  /** @throws {StorageRequestError} with the HTTP status and service error code. */
  list: (credentials: AccessKeys, env: NodeJS.ProcessEnv) => Promise<BucketSummary[]>
  /** Create a private bucket. */
  create: (location: L, credentials: AccessKeys, env: NodeJS.ProcessEnv) => Promise<void>
}

/** Optional capability: print a least-privilege access policy for a location. */
export interface PolicyCapability<L extends StorageLocation> {
  build: (location: L, options: { readOnly: boolean }) => unknown
}

/**
 * One built-in object store. The transfer actions are required; bucket
 * management, policies and restricted keys are capabilities that commands
 * check for instead of asking which provider this is.
 */
export interface StorageProvider<L extends StorageLocation = StorageLocation> {
  readonly id: ProviderId
  /** Short name for step titles and messages, such as `COS`. */
  readonly label: string
  /** Section of `.yunbox/config` holding the location, such as `cos`. */
  readonly section: string
  /** Read this provider's section of a settings file; `undefined` when it has no bucket. @throws {TypeError} for an invalid setting. */
  readConfig: (context: CliContext, file: string) => Promise<L | undefined>
  /** Write the location into a settings file, keeping every other setting. */
  writeConfig: (context: CliContext, file: string, location: L) => Promise<void>
  /** Validate and normalize. @throws {TypeError} naming the bad setting. */
  normalize: (location: L) => L
  describe: (location: L) => string
  same: (a: L, b: L) => boolean
  /** Where `yunbox login` keeps this provider's keys on this computer, most preferred first. @throws {Error} for an invalid setting. */
  credentialStores: (env: NodeJS.ProcessEnv) => SecretStore[]
  /** The user's own keys for this provider; `undefined` when none are configured. */
  resolveCredentials: (env: NodeJS.ProcessEnv) => Promise<ResolvedCredentials | undefined>
  /** Lines explaining how to configure keys. */
  credentialHelp: string[]
  connect: (location: L, credentials: () => AccessKeys) => ObjectStore
  buckets?: BucketCapability<L>
  policy?: PolicyCapability<L>
  /** Whether `yunbox subaccount` can create restricted keys for this provider. */
  restrictedKeys?: boolean
}

/** Error from a request to an object store. Messages never contain signatures, keys or full URLs. */
export class StorageRequestError extends Error {
  readonly status: number
  readonly code: string | undefined

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'StorageRequestError'
    this.status = status
    this.code = code
  }
}

/** The key of an LFS object: `<prefix>/<oid[0:2]>/<oid[2:4]>/<oid>`. */
export function objectKey(location: StorageLocation, oid: string): string {
  return prefixed(location, `${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`)
}

/** A key relative to the location's prefix. */
export function prefixed(location: StorageLocation, key: string): string {
  return location.prefix === '' ? key : `${location.prefix}/${key}`
}
