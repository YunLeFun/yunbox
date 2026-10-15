/** A validated repository identifier used to isolate stored objects. */
export interface RepositoryId {
  owner: string
  repo: string
}

/** An object descriptor from the Git LFS protocol. */
export interface LfsObject {
  oid: string
  size: number
}

/** Operations supported by the Git LFS batch endpoint. */
export type LfsOperation = 'upload' | 'download'

/** Optional Git reference included by Git LFS clients. */
export interface LfsReference {
  name: string
}

/** A validated Git LFS batch request. */
export interface LfsBatchRequest {
  operation: LfsOperation
  transfers?: string[]
  ref?: LfsReference
  objects: LfsObject[]
}

/** A transfer or verify action returned to a Git LFS client. */
export interface LfsAction {
  href: string
  header?: Record<string, string>
  expires_in?: number
}

/** An object-specific Git LFS protocol error. */
export interface LfsObjectError {
  code: number
  message: string
}

/** Actions available for one object in a batch response. */
export interface LfsObjectActions {
  upload?: LfsAction
  download?: LfsAction
  verify?: LfsAction
}

/** One object entry in a Git LFS batch response. */
export interface LfsObjectResponse extends LfsObject {
  authenticated?: boolean
  actions?: LfsObjectActions
  error?: LfsObjectError
}

/** Git LFS basic-transfer batch response. */
export interface LfsBatchResponse {
  transfer: 'basic'
  objects: LfsObjectResponse[]
}

/** Metadata known about an object in storage. */
export interface StoredObjectInfo {
  size: number
  verified: boolean
}

/** Readable object body and its current byte size. */
export interface StoredObjectBody {
  size: number
  body: AsyncIterable<Uint8Array>
}

/** Options applied while receiving an object. */
export interface PutObjectOptions {
  maxBytes?: number
}

/** Options supplied when a backend creates a direct transfer action. */
export interface CreateStorageActionOptions {
  expiresInSeconds: number
}

/** Result of comparing a stored object with a verify request. */
export type StorageVerificationResult
  = | { status: 'verified', actualSize: number }
    | { status: 'missing' }
    | { status: 'size-mismatch', actualSize: number }
    | { status: 'changed', actualSize: number }

/**
 * Storage contract used by the LFS server.
 *
 * Remote backends can implement the optional action factories to return
 * provider-presigned URLs. Backends without them use server-hosted streaming.
 */
export interface ObjectStorage {
  inspectObject: (repository: RepositoryId, oid: string) => Promise<StoredObjectInfo | undefined>
  putObject: (
    repository: RepositoryId,
    oid: string,
    body: AsyncIterable<Uint8Array>,
    options?: PutObjectOptions,
  ) => Promise<StoredObjectInfo>
  readObject: (repository: RepositoryId, oid: string) => Promise<StoredObjectBody | undefined>
  verifyObject: (repository: RepositoryId, oid: string, expectedSize: number) => Promise<StorageVerificationResult>
  createUploadAction?: (
    repository: RepositoryId,
    object: LfsObject,
    options: CreateStorageActionOptions,
  ) => Promise<LfsAction>
  createDownloadAction?: (
    repository: RepositoryId,
    object: LfsObject,
    options: CreateStorageActionOptions,
  ) => Promise<LfsAction>
}
