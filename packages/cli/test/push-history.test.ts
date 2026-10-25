import type { PushHistoryEntry } from '../src/push-history.ts'
import type { Sandbox } from './helpers.ts'
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { blockedPushesPath, readBlockedPushes } from '../src/blocked-pushes.ts'
import { clearPushHistory, PUSH_HISTORY_POLICY, pushHistoryPath, readPushHistory, recordPushHistory, retainedPushHistory } from '../src/push-history.ts'
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
function decision(root: string, outcome: PushHistoryEntry['outcome'] = 'blocked'): Omit<PushHistoryEntry, 'id'> {
  return { root, at: new Date().toISOString(), reason: 'exceeded', outcome, summary: '超过单文件预算' }
}

describe('local project push history', () => {
  it('appends separate decisions and keeps confirmed continuations out of the blocked shortcut', async () => {
    const { sandbox, repo } = await fixture()
    await recordPushHistory(sandbox.env, decision(repo))
    await recordPushHistory(sandbox.env, { ...decision(repo, 'cancelled'), note: '先压缩图片' })
    await recordPushHistory(sandbox.env, { ...decision(repo, 'continued'), note: '已确认素材用途' })
    const entries = await readPushHistory(sandbox.env)
    expect(entries).toHaveLength(3)
    expect(new Set(entries.map(entry => entry.id)).size).toBe(3)
    expect(entries.map(entry => entry.outcome)).toEqual(['continued', 'cancelled', 'blocked'])
    expect((await readBlockedPushes(sandbox.env))[0]).toMatchObject({ reason: 'cancelled', summary: '原因：先压缩图片；超过单文件预算' })
    if (process.platform !== 'win32')
      expect((await stat(pushHistoryPath(sandbox.env))).mode & 0o777).toBe(0o600)
  })

  it('imports legacy snapshots, preserves other projects on clear, and never resurrects cleared entries', async () => {
    const { sandbox, repo } = await fixture()
    const path = blockedPushesPath(sandbox.env)
    await mkdir(join(path, '..'), { recursive: true })
    const at = new Date().toISOString()
    await writeFile(path, JSON.stringify({ version: 1, entries: [
      { root: repo, at, reason: 'cancelled', summary: '旧版取消说明' },
      { root: join(repo, 'other'), at, reason: 'freeze', summary: '禁推时段' },
    ] }))
    expect((await readPushHistory(sandbox.env)).map(entry => entry.outcome)).toEqual(['cancelled', 'blocked'])
    await clearPushHistory(sandbox.env, repo)
    expect((await readPushHistory(sandbox.env)).map(entry => entry.root)).toEqual([join(repo, 'other')])
    expect((JSON.parse(await readFile(path, 'utf8'))).entries).toHaveLength(1)
    await clearPushHistory(sandbox.env)
    expect(await readPushHistory(sandbox.env)).toEqual([])
    expect(await readBlockedPushes(sandbox.env)).toEqual([])
  })

  it('does not lose simultaneous appends or another project while clearing', async () => {
    const { sandbox, repo } = await fixture()
    await Promise.all(Array.from({ length: 20 }, (_, index) => recordPushHistory(sandbox.env, { ...decision(repo), note: String(index) })))
    expect(await readPushHistory(sandbox.env)).toHaveLength(20)
    const other = join(repo, 'other')
    await recordPushHistory(sandbox.env, decision(other))
    await Promise.all([clearPushHistory(sandbox.env, repo), recordPushHistory(sandbox.env, decision(other, 'continued'))])
    expect((await readPushHistory(sandbox.env)).map(entry => entry.root)).toEqual([other, other])
  })

  it('bounds age, project size, and total size without merging one project into a single snapshot', () => {
    const now = Date.now()
    const entries: PushHistoryEntry[] = Array.from({ length: PUSH_HISTORY_POLICY.perRepository + 5 }, (_, index) => ({
      ...decision('/work/game'),
      id: String(index),
      at: new Date(now - index * 1000).toISOString(),
    }))
    entries.push({ ...decision('/work/old'), id: 'old', at: new Date(now - 91 * 86400000).toISOString() })
    expect(retainedPushHistory(entries, now)).toHaveLength(200)
    const many = Array.from({ length: 5100 }, (_, index) => ({ ...decision(`/work/${index}`), id: String(index) }))
    expect(retainedPushHistory(many, now)).toHaveLength(5000)
  })

  it('requires explicit clearing confirmation, supports deleted projects, and keeps settings and credentials intact', async () => {
    const { sandbox, repo } = await fixture()
    const removedProject = join(repo, 'deleted-project')
    await recordPushHistory(sandbox.env, decision(removedProject, 'continued'))
    await recordPushHistory(sandbox.env, decision(repo))
    const before = await readFile(join(repo, '.git/config'), 'utf8')
    const secret = join(pushHistoryPath(sandbox.env), '..', 'credentials.json')
    await writeFile(secret, 'test-only sentinel')
    expect((await runYunBox(sandbox, repo, ['history', 'clear', '--all'])).code).toBe(2)
    expect((await runYunBox(sandbox, repo, ['history', 'clear', '--project', '', '--yes'])).code).toBe(2)
    expect(await readPushHistory(sandbox.env)).toHaveLength(2)
    const listing = await runYunBox(sandbox, repo, ['history', '--all', '--json'])
    expect(JSON.parse(listing.stdout)).toMatchObject({ version: 1, retention: PUSH_HISTORY_POLICY, entries: expect.any(Array) })
    expect((await runYunBox(sandbox, repo, ['history', 'clear', '--project', removedProject, '--yes'])).code).toBe(0)
    expect((await readPushHistory(sandbox.env)).map(entry => entry.root)).toEqual([repo])
    expect(await readFile(secret, 'utf8')).toBe('test-only sentinel')
    expect(await readFile(join(repo, '.git/config'), 'utf8')).toBe(before)
  })

  it('records confirmation to continue only from a real hook, and preserves the supplied reason', async () => {
    if (process.platform === 'win32')
      return
    const { sandbox, repo } = await fixture()
    await writeFile(join(repo, 'large.txt'), 'payload'.repeat(2000))
    await git(sandbox, repo, 'add', '.')
    await git(sandbox, repo, 'commit', '-qm', 'test(history): create over-budget payload')
    const tip = await git(sandbox, repo, 'rev-parse', 'HEAD')
    const bin = join(sandbox.root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'osascript'), '#!/bin/sh\ncat >/dev/null\nprintf "continue\\nQA approval\\n"\n', { mode: 0o755 })
    Object.assign(sandbox.env, { YUNBOX_CONFIRM_UI: 'dialog', PATH: `${bin}:${sandbox.env.PATH}` })
    const args = ['inspect', '--push', '--file-limit', '4k', '--confirm']
    expect((await runYunBox(sandbox, repo, args)).code).toBe(0)
    expect(await readPushHistory(sandbox.env)).toEqual([])
    expect((await runYunBox(sandbox, repo, [...args, '--stdin'], `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`)).code).toBe(0)
    expect(await readPushHistory(sandbox.env)).toEqual([expect.objectContaining({ root: await git(sandbox, repo, 'rev-parse', '--show-toplevel'), reason: 'exceeded', outcome: 'continued', note: 'QA approval' })])
  })

  it('recovers a writer crash without stealing an active writer lock', async () => {
    const { sandbox, repo } = await fixture()
    await recordPushHistory(sandbox.env, decision(repo))
    const lock = `${pushHistoryPath(sandbox.env)}.lock`
    await mkdir(lock)
    const old = new Date(Date.now() - 60000)
    await utimes(lock, old, old)
    await recordPushHistory(sandbox.env, decision(repo, 'continued'))
    expect(await readPushHistory(sandbox.env)).toHaveLength(2)
    await mkdir(lock)
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'active-test-owner' }))
    await utimes(lock, old, old)
    await recordPushHistory(sandbox.env, decision(repo))
    expect(await readPushHistory(sandbox.env)).toHaveLength(2)
    expect(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')).token).toBe('active-test-owner')
  })

  it.skipIf(process.platform !== 'darwin')('matches standardized macOS project paths for listing and clearing', async () => {
    const { sandbox } = await fixture()
    await recordPushHistory(sandbox.env, decision('/private/tmp/removed-history-project'))
    const listed = await runYunBox(sandbox, sandbox.root, ['history', '--project', '/tmp/removed-history-project', '--json'])
    expect(JSON.parse(listed.stdout).entries).toHaveLength(1)
    expect((await runYunBox(sandbox, sandbox.root, ['history', 'clear', '--project', '/tmp/removed-history-project', '--yes'])).code).toBe(0)
    expect(await readPushHistory(sandbox.env)).toEqual([])
  })

  it('preserves corrupt new history until an explicit clear and never changes a verdict on write errors', async () => {
    const { sandbox, repo } = await fixture()
    await clearPushHistory(sandbox.env)
    await writeFile(pushHistoryPath(sandbox.env), 'broken history')
    await recordPushHistory(sandbox.env, decision(repo))
    expect(await readFile(pushHistoryPath(sandbox.env), 'utf8')).toBe('broken history')
    await expect(readPushHistory(sandbox.env)).rejects.toThrow('格式不正确')
    await clearPushHistory(sandbox.env)
    expect(await readPushHistory(sandbox.env)).toEqual([])
  })
})
