import type { LfsBatchRequest, LfsObject, RepositoryId } from './types.ts'
import { MAX_OBJECT_SIZE } from './constants.ts'

const OID_PATTERN = /^[a-f\d]{64}$/
const REPOSITORY_COMPONENT_PATTERN = /^[a-z\d](?:[\w.-]{0,98}[a-z\d])?$/i
const MAX_BATCH_OBJECTS = 1000

/** Error raised when untrusted protocol input fails validation. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/** Assert that an oid is a canonical lowercase SHA-256 string. */
export function assertOid(oid: unknown): asserts oid is string {
  if (typeof oid !== 'string' || !OID_PATTERN.test(oid))
    throw new ValidationError('oid must be a 64-character lowercase hexadecimal SHA-256 value')
}

/** Assert that an object size is a non-negative integer within the service limit. */
export function assertObjectSize(size: unknown, maxSize = MAX_OBJECT_SIZE): asserts size is number {
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0)
    throw new ValidationError('size must be a non-negative safe integer')
  if (size > maxSize)
    throw new ValidationError(`size must not exceed ${maxSize} bytes`)
}

/** Assert that repository path components are portable and cannot traverse directories. */
export function assertRepository(repository: RepositoryId): void {
  for (const [label, value] of [['owner', repository.owner], ['repo', repository.repo]] as const) {
    if (!REPOSITORY_COMPONENT_PATTERN.test(value) || value === '.' || value === '..')
      throw new ValidationError(`${label} is not a valid repository path component`)
  }
}

/** Parse and validate one untrusted Git LFS object descriptor. */
export function parseLfsObject(value: unknown): LfsObject {
  if (!isRecord(value))
    throw new ValidationError('object must be a JSON object')
  assertOid(value.oid)
  assertObjectSize(value.size)
  return { oid: value.oid, size: value.size }
}

/** Parse and validate an untrusted Git LFS batch request body. */
export function parseBatchRequest(value: unknown): LfsBatchRequest {
  if (!isRecord(value))
    throw new ValidationError('batch request must be a JSON object')
  if (value.operation !== 'upload' && value.operation !== 'download')
    throw new ValidationError('operation must be upload or download')
  if (!Array.isArray(value.objects))
    throw new ValidationError('objects must be an array')
  if (value.objects.length > MAX_BATCH_OBJECTS)
    throw new ValidationError(`objects must contain at most ${MAX_BATCH_OBJECTS} entries`)

  let transfers: string[] | undefined
  if (value.transfers !== undefined) {
    if (!Array.isArray(value.transfers) || value.transfers.some(item => typeof item !== 'string'))
      throw new ValidationError('transfers must be an array of strings')
    transfers = value.transfers as string[]
  }

  let ref: { name: string } | undefined
  if (value.ref !== undefined) {
    if (!isRecord(value.ref) || typeof value.ref.name !== 'string')
      throw new ValidationError('ref must contain a string name')
    ref = { name: value.ref.name }
  }

  return {
    operation: value.operation,
    objects: value.objects.map(parseLfsObject),
    ...(transfers === undefined ? {} : { transfers }),
    ...(ref === undefined ? {} : { ref }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
