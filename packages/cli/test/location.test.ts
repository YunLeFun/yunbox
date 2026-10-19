import type { CliContext } from '../src/context.ts'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_LOCATION_FILE, LOCATION_FILE, readLocation, writeLocation } from '../src/cos/location.ts'
import { createRepository, createSandbox } from './helpers.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

const location = { bucket: 'team-assets-1250000000', region: 'ap-shanghai', prefix: 'yunbox/team/game' }

function settings(prefix = location.prefix): string {
  return `[cos]\n\tbucket = ${location.bucket}\n\tregion = ${location.region}\n\tprefix = ${prefix}\n`
}

async function setup(): Promise<{ context: CliContext, repo: string }> {
  const sandbox = await createSandbox()
  cleanups.push(sandbox.cleanup)
  const repo = await createRepository(sandbox)
  return { context: { cwd: repo, env: sandbox.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, repo }
}

async function writeCurrent(repo: string, content: string): Promise<void> {
  await mkdir(join(repo, '.yunbox'), { recursive: true })
  await writeFile(join(repo, LOCATION_FILE), content)
}

describe('cos location file', () => {
  it('reads .yunbox/config, and the legacy .yunboxconfig when it is the only one', async () => {
    const { context, repo } = await setup()
    expect(await readLocation(context, repo)).toBeUndefined()

    await writeFile(join(repo, LEGACY_LOCATION_FILE), settings())
    expect(await readLocation(context, repo)).toEqual(location)

    await writeCurrent(repo, settings())
    expect(await readLocation(context, repo)).toEqual(location)
  })

  it('refuses two files that point at different places, naming both', async () => {
    const { context, repo } = await setup()
    await writeCurrent(repo, settings())
    await writeFile(join(repo, LEGACY_LOCATION_FILE), settings('yunbox/team/old'))
    await expect(readLocation(context, repo)).rejects.toThrow(/\.yunbox\/config 和 \.yunboxconfig 的 COS 位置不一致/)
  })

  it('names the file with the bad setting', async () => {
    const { context, repo } = await setup()
    await writeFile(join(repo, LEGACY_LOCATION_FILE), `[cos]\n\tbucket = ${location.bucket}\n`)
    await expect(readLocation(context, repo)).rejects.toThrow(/^\.yunboxconfig：有 cos\.bucket 但没有 cos\.region/)
  })

  it('writes .yunbox/config, keeps other settings there and removes the legacy file', async () => {
    const { context, repo } = await setup()
    expect(await writeLocation(context, repo, location)).toEqual({ removedLegacy: false })
    expect(await readLocation(context, repo)).toEqual(location)

    await writeFile(join(repo, LOCATION_FILE), `${await readFile(join(repo, LOCATION_FILE), 'utf8')}[future]\n\tkey = kept\n`)
    await writeFile(join(repo, LEGACY_LOCATION_FILE), settings('yunbox/team/old'))
    const moved = { ...location, prefix: 'yunbox/team/new' }
    expect(await writeLocation(context, repo, moved)).toEqual({ removedLegacy: true })
    expect(existsSync(join(repo, LEGACY_LOCATION_FILE))).toBe(false)
    expect(await readLocation(context, repo)).toEqual(moved)
    expect(await readFile(join(repo, LOCATION_FILE), 'utf8')).toContain('key = kept')
  })
})
