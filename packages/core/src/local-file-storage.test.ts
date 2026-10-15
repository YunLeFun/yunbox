import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalFileObjectStorage } from './local-file-storage.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('localFileObjectStorage', () => {
  it('isolates repositories and persists verification in a sidecar marker', async () => {
    const directory = await createTemporaryDirectory()
    const storage = new LocalFileObjectStorage(directory)
    const oid = 'b'.repeat(64)
    const primary = { owner: 'team', repo: 'primary' }
    const secondary = { owner: 'team', repo: 'secondary' }

    await storage.putObject(primary, oid, chunks('asset'))
    expect(await storage.inspectObject(primary, oid)).toEqual({ size: 5, verified: false })
    expect(await storage.inspectObject(secondary, oid)).toBeUndefined()
    expect(await storage.verifyObject(primary, oid, 4)).toEqual({ status: 'size-mismatch', actualSize: 5 })
    expect(await storage.verifyObject(primary, oid, 5)).toEqual({ status: 'verified', actualSize: 5 })
    expect(await storage.inspectObject(primary, oid)).toEqual({ size: 5, verified: true })

    const marker = JSON.parse(await readFile(`${storage.objectPath(primary, oid)}.verified.json`, 'utf8')) as unknown
    expect(marker).toMatchObject({ oid, size: 5 })
  })

  it('invalidates a verified object before an interrupted replacement', async () => {
    const directory = await createTemporaryDirectory()
    const storage = new LocalFileObjectStorage(directory)
    const repository = { owner: 'team', repo: 'retry' }
    const oid = 'c'.repeat(64)
    await storage.putObject(repository, oid, chunks('old'))
    await storage.verifyObject(repository, oid, 3)

    await expect(storage.putObject(repository, oid, interruptedChunks())).rejects.toThrow('interrupted')
    expect(await storage.inspectObject(repository, oid)).toEqual({ size: 3, verified: false })
    expect(await readFile(storage.objectPath(repository, oid), 'utf8')).toBe('old')

    await storage.putObject(repository, oid, chunks('replacement'))
    expect(await storage.verifyObject(repository, oid, 11)).toEqual({ status: 'verified', actualSize: 11 })
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'yunbox-core-test-'))
  temporaryDirectories.push(directory)
  return directory
}

async function* chunks(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value)
}

async function* interruptedChunks(): AsyncIterable<Uint8Array> {
  yield Buffer.from('partial')
  throw new Error('interrupted')
}
