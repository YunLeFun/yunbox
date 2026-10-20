import type { CliContext } from '../src/context.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_LOCATION_FILE, LOCATION_FILE } from '../src/cos/location.ts'
import { s3Address } from '../src/s3/client.ts'
import { normalizeS3Location } from '../src/s3/location.ts'
import { readStorageLocation, writeStorageLocation } from '../src/storage/config.ts'
import { createRepository, createSandbox } from './helpers.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function setup(): Promise<{ context: CliContext, repo: string }> {
  const sandbox = await createSandbox()
  cleanups.push(sandbox.cleanup)
  const repo = await createRepository(sandbox)
  return { context: { cwd: repo, env: sandbox.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, repo }
}

const r2 = normalizeS3Location({ endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/', bucket: 'game-assets', region: 'auto', prefix: '/yunbox/team/game/', addressingStyle: 'path' })
const cos = { bucket: 'team-assets-1250000000', region: 'ap-shanghai', prefix: 'yunbox/team/game' }

describe('s3 locations', () => {
  it('normalizes the endpoint to an origin and the prefix without slashes', () => {
    expect(r2).toEqual({ provider: 's3', endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com', bucket: 'game-assets', region: 'auto', prefix: 'yunbox/team/game', addressingStyle: 'path' })
    expect(normalizeS3Location({ ...r2, endpoint: 'http://localhost:9000' }).endpoint).toBe('http://localhost:9000')
    expect(() => normalizeS3Location({ ...r2, endpoint: 'http://minio.lan:9000' })).toThrow('必须用 https')
    expect(() => normalizeS3Location({ ...r2, endpoint: 'https://key:secret@example.com' })).toThrow('不能带路径、参数或用户名')
    expect(() => normalizeS3Location({ ...r2, bucket: 'Game' })).toThrow('bucket')
    expect(() => normalizeS3Location({ ...r2, prefix: 'a/../b' })).toThrow('前缀')
  })

  it('addresses keys path-style or virtual-hosted, encoding each segment once', () => {
    const key = 'yunbox/team/game/ab/cd/file name+1'
    expect(s3Address(r2, key)).toEqual({
      path: `/game-assets/${key}`,
      url: new URL('https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/game-assets/yunbox/team/game/ab/cd/file%20name%2B1'),
    })
    const aws = normalizeS3Location({ endpoint: 'https://s3.eu-west-1.amazonaws.com', bucket: 'game-assets', region: 'eu-west-1', prefix: '', addressingStyle: 'virtual' })
    expect(s3Address(aws, 'ab/cd/x')).toEqual({ path: '/ab/cd/x', url: new URL('https://game-assets.s3.eu-west-1.amazonaws.com/ab/cd/x') })
  })
})

describe('.yunbox/config with storage providers', () => {
  it('writes S3 settings with storage.provider, reads them back and switches back to COS', async () => {
    const { context, repo } = await setup()
    await writeStorageLocation(context, repo, cos)
    expect(await readStorageLocation(context, repo)).toEqual(cos)

    await writeStorageLocation(context, repo, r2)
    expect(await readStorageLocation(context, repo)).toEqual(r2)
    const s3Text = await readFile(join(repo, LOCATION_FILE), 'utf8')
    expect(s3Text).toContain('[storage]\n\tprovider = s3')
    expect(s3Text).not.toContain('[cos]')

    // COS is written as before providers existed, so 0.1.x clients still read it.
    await writeStorageLocation(context, repo, cos)
    expect(await readStorageLocation(context, repo)).toEqual(cos)
    const cosText = await readFile(join(repo, LOCATION_FILE), 'utf8')
    expect(cosText).not.toContain('provider')
    expect(cosText).not.toContain('[s3]')
  })

  it('names the problem with broken or conflicting settings', async () => {
    const { context, repo } = await setup()
    await mkdir(join(repo, '.yunbox'))
    await writeFile(join(repo, LOCATION_FILE), '[storage]\n\tprovider = gcs\n')
    await expect(readStorageLocation(context, repo)).rejects.toThrow(/storage\.provider 只能是 cos 或 s3，不是「gcs」/)
    await writeFile(join(repo, LOCATION_FILE), '[storage]\n\tprovider = s3\n[s3]\n\tbucket = game-assets\n\tregion = auto\n')
    await expect(readStorageLocation(context, repo)).rejects.toThrow(/有 s3\.bucket 但没有 s3\.endpoint/)
    await writeFile(join(repo, LOCATION_FILE), '[storage]\n\tprovider = s3\n')
    await expect(readStorageLocation(context, repo)).rejects.toThrow(/没有 s3\.bucket/)

    await writeStorageLocation(context, repo, r2)
    await writeFile(join(repo, LEGACY_LOCATION_FILE), `[cos]\n\tbucket = ${cos.bucket}\n\tregion = ${cos.region}\n`)
    await expect(readStorageLocation(context, repo)).rejects.toThrow(/\.yunboxconfig 还指向 COS/)
  })
})
