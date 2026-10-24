import type { BlockedPush } from '../src/blocked-pushes.ts'
import type { Sandbox } from './helpers.ts'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { BLOCKED_PUSH_LIMIT, readBlockedPushes, recordBlockedPush } from '../src/blocked-pushes.ts'
import { pushHistoryPath as blockedPushesPath, clearPushHistory } from '../src/push-history.ts'
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

function entry(root: string, at: string, reason: BlockedPush['reason'] = 'exceeded'): BlockedPush {
  return { root, at, reason, summary: '1 个文件版本超过单文件限额 4 KiB' }
}

describe('blocked push record', () => {
  it('lives in the YunBox config directory, never in the repository', async () => {
    const { sandbox } = await fixture()
    expect(blockedPushesPath(sandbox.env)).toBe(process.platform === 'win32'
      ? join(sandbox.env.APPDATA!, 'yunbox', 'push-history.json')
      : join(sandbox.env.XDG_CONFIG_HOME!, 'yunbox', 'push-history.json'))
    const env = { ...sandbox.env, YUNBOX_CONFIG_DIR: join(sandbox.root, 'custom') }
    expect(blockedPushesPath(env)).toBe(join(sandbox.root, 'custom', 'push-history.json'))
    await recordBlockedPush(env, entry('/work/a', '2026-10-20T01:00:00.000Z'))
    expect(await readBlockedPushes(env)).toEqual([entry('/work/a', '2026-10-20T01:00:00.000Z')])
    if (process.platform !== 'win32')
      expect((await stat(blockedPushesPath(env))).mode & 0o777).toBe(0o600)
  })

  it('keeps one entry per repository, newest first, up to the limit', async () => {
    const { sandbox } = await fixture()
    await recordBlockedPush(sandbox.env, entry('/work/a', '2026-10-20T01:00:00.000Z'))
    await recordBlockedPush(sandbox.env, entry('/work/b', '2026-10-20T02:00:00.000Z', 'freeze'))
    await recordBlockedPush(sandbox.env, entry('/work/a', '2026-10-20T03:00:00.000Z', 'cancelled'))
    expect((await readBlockedPushes(sandbox.env)).map(item => [item.root, item.reason])).toEqual([['/work/a', 'cancelled'], ['/work/b', 'freeze']])
    for (let index = 0; index < BLOCKED_PUSH_LIMIT + 5; index++)
      await recordBlockedPush(sandbox.env, entry(`/work/${index}`, `2026-10-21T00:00:${String(index).padStart(2, '0')}.000Z`))
    const entries = await readBlockedPushes(sandbox.env)
    expect(entries).toHaveLength(BLOCKED_PUSH_LIMIT)
    expect(entries[0]!.root).toBe(`/work/${BLOCKED_PUSH_LIMIT + 4}`)
  })

  it('shortens summaries and survives a broken or unwritable file', async () => {
    const { sandbox } = await fixture()
    await recordBlockedPush(sandbox.env, { ...entry('/work/a', '2026-10-20T01:00:00.000Z'), summary: `第一行\n${'超'.repeat(500)}` })
    const [long] = await readBlockedPushes(sandbox.env)
    expect(long!.summary).toHaveLength(200)
    expect(long!.summary.startsWith('第一行 超')).toBe(true)
    await writeFile(blockedPushesPath(sandbox.env), '{ not json')
    expect(await readBlockedPushes(sandbox.env)).toEqual([])
    await clearPushHistory(sandbox.env)
    await recordBlockedPush(sandbox.env, entry('/work/b', '2026-10-20T02:00:00.000Z'))
    expect((await readBlockedPushes(sandbox.env)).map(item => item.root)).toEqual(['/work/b'])
    // A file where the directory should be: the write fails quietly.
    const blocked = join(sandbox.root, 'not-a-directory')
    await writeFile(blocked, '')
    await expect(recordBlockedPush({ ...sandbox.env, YUNBOX_CONFIG_DIR: blocked }, entry('/work/c', '2026-10-20T03:00:00.000Z'))).resolves.toBeUndefined()
  })

  it('is written when the pre-push hook blocks, not by manual checks', async () => {
    const { sandbox, repo } = await fixture()
    await writeFile(join(repo, 'big.bin'), randomBytes(8192))
    await git(sandbox, repo, 'add', '-A')
    await git(sandbox, repo, 'commit', '-qm', 'test(inspect): add a large file')
    const tip = await git(sandbox, repo, 'rev-parse', 'HEAD')
    const updates = `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`
    const remote = 'https://user:secret-token@example.invalid/team/game.git'
    expect((await runYunBox(sandbox, repo, ['inspect', '--push', '--file-limit', '4k'])).code).toBe(1)
    expect(await readBlockedPushes(sandbox.env)).toEqual([])
    const blocked = await runYunBox(sandbox, repo, ['inspect', '--push', '--stdin', '--remote', remote, '--file-limit', '4k', '--confirm'], updates)
    expect(blocked.code).toBe(1)
    const root = await git(sandbox, repo, 'rev-parse', '--show-toplevel')
    expect(await readBlockedPushes(sandbox.env)).toEqual([{ root, at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), reason: 'exceeded', summary: '1 个文件版本超过单文件限额 4.00 KiB' }])
    const text = await readFile(blockedPushesPath(sandbox.env), 'utf8')
    expect(text).not.toContain('secret-token')
    expect(text).not.toContain('example.invalid')

    await runYunBox(sandbox, repo, ['freeze', 'set', '24/7', '--shared'])
    expect((await runYunBox(sandbox, repo, ['inspect', '--push', '--stdin'], updates)).code).toBe(1)
    expect(await readBlockedPushes(sandbox.env)).toEqual([{ root, at: expect.any(String), reason: 'freeze', summary: '禁推时段 24/7（团队 .yunbox/config）' }])
  })

  it.skipIf(process.platform === 'win32')('passes the reason typed in the dialog to the pusher and the record', async () => {
    const { sandbox, repo } = await fixture()
    await writeFile(join(repo, 'big.bin'), randomBytes(8192))
    await git(sandbox, repo, 'add', '-A')
    await git(sandbox, repo, 'commit', '-qm', 'test(inspect): add a large file')
    const tip = await git(sandbox, repo, 'rev-parse', 'HEAD')
    const updates = `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`
    // A stand-in for osascript that answers like the dialog: the button, then the note.
    const bin = join(sandbox.root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'osascript'), '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n%s\\n\' "$ANSWER" "$NOTE"\n', { mode: 0o755 })
    Object.assign(sandbox.env, { YUNBOX_CONFIRM_UI: 'dialog', PATH: `${bin}:${sandbox.env.PATH}`, ANSWER: 'cancel', NOTE: '先压缩  图片' })
    const hook = ['inspect', '--push', '--stdin', '--file-limit', '4k', '--confirm']
    const cancelled = await runYunBox(sandbox, repo, hook, updates)
    expect(cancelled.code).toBe(1)
    expect(cancelled.stderr).toContain('已取消推送，原因：先压缩 图片\n')
    expect(cancelled.stderr).toContain('不要提高限额或用 --no-verify 绕过检查')
    expect((await readBlockedPushes(sandbox.env))[0]).toMatchObject({ reason: 'cancelled', summary: '原因：先压缩 图片；1 个文件版本超过单文件限额 4.00 KiB' })

    Object.assign(sandbox.env, { ANSWER: 'continue', NOTE: '美术已确认' })
    const continued = await runYunBox(sandbox, repo, hook, updates)
    expect(continued.code).toBe(0)
    expect(continued.stderr).toContain('已确认，继续推送。原因：美术已确认\n')

    // No note: the cancel still says not to work around it.
    Object.assign(sandbox.env, { ANSWER: 'cancel', NOTE: '' })
    const plain = await runYunBox(sandbox, repo, hook, updates)
    expect(plain.stderr).toContain('已取消推送。\n这是人工确认的结果：不要提高限额')
  })

  it('never changes the push result when the record cannot be written', async () => {
    const { sandbox, repo } = await fixture()
    await writeFile(join(repo, 'small.txt'), 'hello\n')
    await git(sandbox, repo, 'add', '-A')
    await git(sandbox, repo, 'commit', '-qm', 'test(freeze): record fixture')
    const tip = await git(sandbox, repo, 'rev-parse', 'HEAD')
    const updates = `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`
    const blocked = join(sandbox.root, 'not-a-directory')
    await writeFile(blocked, '')
    await runYunBox(sandbox, repo, ['freeze', 'set', '24/7', '--shared'])
    const result = await runYunBox({ ...sandbox, env: { ...sandbox.env, YUNBOX_CONFIG_DIR: blocked } }, repo, ['inspect', '--push', '--stdin'], updates)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('禁止推送')
  })
})
