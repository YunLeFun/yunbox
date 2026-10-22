import type { Sandbox } from './helpers.ts'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { readUsedRepositories, recordUsedRepository, USED_REPOSITORY_LIMIT, usedRepositoriesPath } from '../src/used-repositories.ts'
import { createRepository, createSandbox, git, runYunBox } from './helpers.ts'

const sandboxes: Sandbox[] = []

async function fixture() {
  const sandbox = await createSandbox()
  sandboxes.push(sandbox)
  const repo = await createRepository(sandbox)
  return { sandbox, repo }
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(sandbox => sandbox.cleanup()))
})

describe('used repository record', () => {
  it('lives beside the blocked push record and keeps one entry per repository, newest first', async () => {
    const { sandbox } = await fixture()
    expect(usedRepositoriesPath(sandbox.env)).toBe(process.platform === 'win32'
      ? join(sandbox.env.APPDATA!, 'yunbox', 'repositories.json')
      : join(sandbox.env.XDG_CONFIG_HOME!, 'yunbox', 'repositories.json'))
    await recordUsedRepository(sandbox.env, { root: '/work/a', at: '2026-10-20T01:00:00.000Z' })
    await recordUsedRepository(sandbox.env, { root: '/work/b', at: '2026-10-20T02:00:00.000Z' })
    await recordUsedRepository(sandbox.env, { root: '/work/a', at: '2026-10-20T03:00:00.000Z' })
    expect(await readUsedRepositories(sandbox.env)).toEqual([{ root: '/work/a', at: '2026-10-20T03:00:00.000Z' }, { root: '/work/b', at: '2026-10-20T02:00:00.000Z' }])
    if (process.platform !== 'win32')
      expect((await stat(usedRepositoriesPath(sandbox.env))).mode & 0o777).toBe(0o600)
    for (let index = 0; index < USED_REPOSITORY_LIMIT + 5; index++)
      await recordUsedRepository(sandbox.env, { root: `/work/${index}`, at: '2026-10-21T00:00:00.000Z' })
    const entries = await readUsedRepositories(sandbox.env)
    expect(entries).toHaveLength(USED_REPOSITORY_LIMIT)
    expect(entries[0]!.root).toBe(`/work/${USED_REPOSITORY_LIMIT + 4}`)
  })

  it('records the repository a command runs in, but not help or other directories', async () => {
    const { sandbox, repo } = await fixture()
    await mkdir(join(repo, 'art'))
    await runYunBox(sandbox, join(repo, 'art'), ['status', '--help'])
    expect(await readUsedRepositories(sandbox.env)).toEqual([])
    await runYunBox(sandbox, join(repo, 'art'), ['status'])
    const root = await git(sandbox, repo, 'rev-parse', '--show-toplevel')
    expect(await readUsedRepositories(sandbox.env)).toEqual([{ root, at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) }])
    await runYunBox(sandbox, sandbox.root, ['status'])
    await runYunBox(sandbox, repo, ['policy', '--help'])
    expect((await readUsedRepositories(sandbox.env)).map(item => item.root)).toEqual([root])
  })

  it('never changes a command result when the record cannot be written', async () => {
    const { sandbox, repo } = await fixture()
    const blocked = join(sandbox.root, 'not-a-directory')
    await writeFile(blocked, '')
    const env = { ...sandbox.env, YUNBOX_CONFIG_DIR: blocked }
    const result = await runYunBox({ ...sandbox, env }, repo, ['status'])
    expect(result.code).toBe((await runYunBox(sandbox, repo, ['status'])).code)
    expect(await readUsedRepositories(env)).toEqual([])
  })
})
