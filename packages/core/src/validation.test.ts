import { describe, expect, it } from 'vitest'
import { MAX_OBJECT_SIZE } from './constants.ts'
import { assertObjectSize, assertOid, assertRepository, parseBatchRequest } from './validation.ts'

describe('protocol validation', () => {
  it('accepts canonical LFS object and repository values', () => {
    const oid = 'a'.repeat(64)
    expect(() => assertOid(oid)).not.toThrow()
    expect(() => assertObjectSize(MAX_OBJECT_SIZE)).not.toThrow()
    expect(() => assertRepository({ owner: 'YunLeFun', repo: 'game-assets.git' })).not.toThrow()
    expect(parseBatchRequest({
      operation: 'upload',
      transfers: ['basic'],
      objects: [{ oid, size: 42 }],
    })).toEqual({
      operation: 'upload',
      transfers: ['basic'],
      objects: [{ oid, size: 42 }],
    })
  })

  it('rejects non-canonical or out-of-range object values', () => {
    expect(() => assertOid('A'.repeat(64))).toThrow(/lowercase/)
    expect(() => assertOid('../object')).toThrow(/64-character/)
    expect(() => assertObjectSize(MAX_OBJECT_SIZE + 1)).toThrow(/must not exceed/)
    expect(() => assertObjectSize(1.5)).toThrow(/integer/)
  })

  it('rejects repository traversal and unsupported operations', () => {
    expect(() => assertRepository({ owner: '..', repo: 'assets' })).toThrow(/owner/)
    expect(() => assertRepository({ owner: 'team/other', repo: 'assets' })).toThrow(/owner/)
    expect(() => parseBatchRequest({ operation: 'delete', objects: [] })).toThrow(/operation/)
  })
})
