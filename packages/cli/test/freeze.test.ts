import type { Sandbox } from './helpers.ts'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

describe('push freeze windows', () => {
  it('sets, lists and clears windows in each scope', async () => {
    const { sandbox, repo } = await fixture()
    const set = await runYunBox(sandbox, repo, ['freeze', 'set', '10:00-12:00', '14:00~18:00', '--message', '联调时段'])
    expect(set.code).toBe(0)
    expect(set.stdout).toContain('yunbox hook install')
    expect(await git(sandbox, repo, 'config', '--local', '--get-all', 'yunbox.pushFreeze')).toBe('10:00-12:00\n14:00-18:00')
    expect((await runYunBox(sandbox, repo, ['freeze', 'set', '22:00-02:00', '--shared'])).code).toBe(0)
    expect(await readFile(join(repo, '.yunbox', 'config'), 'utf8')).toContain('pushFreeze = 22:00-02:00')
    expect((await runYunBox(sandbox, repo, ['freeze', 'set', '07:00-08:00', '--global'])).code).toBe(0)
    const list = JSON.parse((await runYunBox(sandbox, repo, ['freeze', 'list', '--json'])).stdout)
    expect(list).toEqual({
      schemaVersion: 1,
      windows: [
        { window: '22:00-02:00', scope: 'shared' },
        { window: '07:00-08:00', scope: 'global' },
        { window: '10:00-12:00', scope: 'local' },
        { window: '14:00-18:00', scope: 'local' },
      ],
      messages: { local: '联调时段' },
    })
    // set replaces the scope's windows instead of appending.
    await runYunBox(sandbox, repo, ['freeze', 'set', '13:00-14:00'])
    expect(await git(sandbox, repo, 'config', '--local', '--get-all', 'yunbox.pushFreeze')).toBe('13:00-14:00')
    expect((await runYunBox(sandbox, repo, ['freeze', 'clear'])).code).toBe(0)
    expect((await runYunBox(sandbox, repo, ['freeze', 'clear', '--global'])).code).toBe(0)
    expect((await runYunBox(sandbox, repo, ['freeze', 'clear', '--shared'])).stdout).toContain('没有设置禁推时段')
  })

  it('checks a time and explains the block', async () => {
    const { sandbox, repo } = await fixture()
    await runYunBox(sandbox, repo, ['freeze', 'set', '10:00-12:00', '--message', '联调时段'])
    const frozen = await runYunBox(sandbox, repo, ['freeze', 'check', '--at', '11:30'])
    expect(frozen.code).toBe(1)
    expect(frozen.stdout).toContain('11:30，处于禁推时段 10:00-12:00')
    expect(frozen.stdout).toContain('12:00 后可以推送')
    expect(frozen.stdout).toContain('联调时段')
    const allowed = await runYunBox(sandbox, repo, ['freeze', 'check', '--at', '12:00', '--json'])
    expect(allowed.code).toBe(0)
    expect(JSON.parse(allowed.stdout)).toMatchObject({ schemaVersion: 1, status: 'allowed', time: '12:00' })
  })

  it('applies weekdays and a time zone to a scope', async () => {
    const { sandbox, repo } = await fixture()
    const set = await runYunBox(sandbox, repo, ['freeze', 'set', '10:00-12:00', 'Sa', '--days', 'weekdays', '--timezone', 'Asia/Shanghai', '--shared'])
    expect(set.code).toBe(0)
    expect(set.stdout).toContain('Mo-Fr 10:00-12:00、Sa 00:00-24:00')
    const file = await readFile(join(repo, '.yunbox', 'config'), 'utf8')
    expect(file).toContain('pushFreezeTimeZone = Asia/Shanghai')
    const list = JSON.parse((await runYunBox(sandbox, repo, ['freeze', 'list', '--json'])).stdout)
    expect(list.windows).toEqual([
      { window: 'Mo-Fr 10:00-12:00', scope: 'shared', timeZone: 'Asia/Shanghai' },
      { window: 'Sa 00:00-24:00', scope: 'shared', timeZone: 'Asia/Shanghai' },
    ])
    expect((await runYunBox(sandbox, repo, ['freeze', 'set', '10:00-12:00', '--timezone', 'Mars/Olympus'])).code).toBe(2)
    await runYunBox(sandbox, repo, ['freeze', 'set', '10:00-12:00', '--shared', '--timezone', ''])
    expect(await readFile(join(repo, '.yunbox', 'config'), 'utf8')).not.toContain('pushFreezeTimeZone')
  })

  it('warns in doctor when windows are set but nothing enforces them', async () => {
    const { sandbox, repo } = await fixture()
    await runYunBox(sandbox, repo, ['freeze', 'set', '10:00-12:00'])
    const report = JSON.parse((await runYunBox(sandbox, repo, ['doctor', '--json'])).stdout) as { steps: { title: string, status: string, fixes?: string[] }[] }
    expect(report.steps.find(step => step.title === '禁推时段')).toMatchObject({ status: 'warn', fixes: ['yunbox hook install'] })
  })

  it('rejects bad windows and usage without touching the config', async () => {
    const { sandbox, repo } = await fixture()
    expect((await runYunBox(sandbox, repo, ['freeze', 'set', '10:00-25:00'])).code).toBe(2)
    expect((await runYunBox(sandbox, repo, ['freeze', 'set'])).code).toBe(2)
    expect((await runYunBox(sandbox, repo, ['freeze', 'set', '10:00-11:00', '--shared', '--global'])).code).toBe(2)
    expect((await runYunBox(sandbox, repo, ['freeze', 'check', '--at', '9am'])).code).toBe(2)
    expect((await runYunBox(sandbox, repo, ['freeze', 'list', '--shared'])).code).toBe(2)
    expect((await runYunBox(sandbox, repo, ['freeze', 'set', '10:00-11:00', '--days', 'someday'])).code).toBe(2)
    expect((await runYunBox(sandbox, repo, ['freeze', 'list', '--json'])).stdout).toContain('"windows":[]')
    await git(sandbox, repo, 'config', 'yunbox.pushFreeze', 'lunch')
    const broken = await runYunBox(sandbox, repo, ['freeze', 'check'])
    expect(broken.code).toBe(2)
    expect(broken.stderr).toContain('本仓库 .git/config')
  })

  it('blocks the pre-push inspection inside a window but leaves manual inspection alone', async () => {
    const { sandbox, repo } = await fixture()
    await writeFile(join(repo, 'small.txt'), 'hello\n')
    await git(sandbox, repo, 'add', '-A')
    await git(sandbox, repo, 'commit', '-qm', 'test(freeze): record fixture')
    const tip = await git(sandbox, repo, 'rev-parse', 'HEAD')
    const updates = `refs/heads/main ${tip} refs/heads/main ${'0'.repeat(40)}\n`
    const hook = ['inspect', '--push', '--stdin', '--confirm']
    expect((await runYunBox(sandbox, repo, hook, updates)).code).toBe(0)
    await runYunBox(sandbox, repo, ['freeze', 'set', '00:00-24:00', '--shared', '--message', '发版冻结中'])
    const blocked = await runYunBox(sandbox, repo, hook, updates)
    expect(blocked.code).toBe(1)
    expect(blocked.stdout).toBe('')
    expect(blocked.stderr).toContain('禁止推送')
    expect(blocked.stderr).toContain('发版冻结中')
    const json = await runYunBox(sandbox, repo, ['inspect', '--push', '--stdin', '--json'], updates)
    expect(json.code).toBe(1)
    expect(JSON.parse(json.stdout)).toMatchObject({ schemaVersion: 1, status: 'frozen', freeze: { window: '24/7', scope: 'shared', until: null } })
    // The macOS app and people checking sizes do not pass --stdin.
    expect((await runYunBox(sandbox, repo, ['inspect', '--push'])).code).toBe(0)
    await git(sandbox, repo, 'config', 'yunbox.pushFreeze', 'lunch')
    const broken = await runYunBox(sandbox, repo, hook, updates)
    expect(broken.code).toBe(2)
    expect(broken.stderr).toContain('yunbox.pushFreeze')
  })
})
