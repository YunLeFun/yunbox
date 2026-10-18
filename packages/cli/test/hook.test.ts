import type { Sandbox } from './helpers.ts'
import { execFile } from 'node:child_process'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createRepository, createSandbox, git, runYunBox } from './helpers.ts'

const execute = promisify(execFile)
const sandboxes: Sandbox[] = []

async function fixture() {
  const sandbox = await createSandbox()
  sandboxes.push(sandbox)
  const repo = await createRepository(sandbox)
  const hook = join(repo, '.git', 'hooks', 'pre-push')
  const guard = join(sandbox.root, 'guard')
  await writeFile(guard, '#!/bin/sh\ncat > guard-input\nprintf "%s\\n" "$@" > guard-args\n[ "$WORKSTATION_YUNBOX_CHAIN" = 1 ] || exit 9\n[ -f allow ]\n', { mode: 0o755 })
  return { sandbox, repo, hook, guard }
}

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(sandbox => sandbox.cleanup()))
})

describe('composed pre-push hook', () => {
  it('supports repositories initialized without a hooks template', async () => {
    const { sandbox, repo, hook, guard } = await fixture()
    await rm(join(repo, '.git', 'hooks'), { recursive: true, force: true })
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--guard', guard])).code).toBe(0)
    expect(await readFile(hook, 'utf8')).toContain('# yunbox-pre-push-v1')
    expect((await runYunBox(sandbox, repo, ['hook', 'uninstall'])).code).toBe(0)
    await expect(readFile(hook)).rejects.toThrow()
  })

  it('blocks the original upload hook on rejection and restores its exact bytes on uninstall', async () => {
    const { sandbox, repo, hook, guard } = await fixture()
    const original = '#!/bin/sh\ncat > original-input\nprintf "%s\\n" "$@" > original-args\n'
    await writeFile(hook, original, { mode: 0o755 })
    const install = ['hook', 'install', '--guard', guard]
    expect((await runYunBox(sandbox, repo, install)).code).toBe(0)
    expect((await runYunBox(sandbox, repo, install)).code).toBe(0)
    expect(await readFile(`${hook}.yunbox-original`, 'utf8')).toBe(original)
    const input = join(repo, 'updates')
    const updates = `refs/heads/main ${'a'.repeat(40)} refs/heads/main ${'0'.repeat(40)}\n`
    await writeFile(input, updates)
    // Run Git itself: a failed independent named hook would still execute the original.
    const args = ['hook', 'run', '--to-stdin', input, 'pre-push', '--', 'origin', 'https://github.com/example/repo.git']
    await expect(execute('git', args, { cwd: repo, env: sandbox.env })).rejects.toThrow()
    await expect(readFile(join(repo, 'original-input'))).rejects.toThrow()
    await writeFile(join(repo, 'allow'), '')
    await execute('git', args, { cwd: repo, env: sandbox.env })
    expect(await readFile(join(repo, 'guard-input'), 'utf8')).toBe(updates)
    expect(await readFile(join(repo, 'original-input'), 'utf8')).toBe(updates)
    expect(await readFile(join(repo, 'original-args'), 'utf8')).toBe(await readFile(join(repo, 'guard-args'), 'utf8'))
    expect((await runYunBox(sandbox, repo, ['hook', 'uninstall'])).code).toBe(0)
    expect(await readFile(hook, 'utf8')).toBe(original)
    expect((await runYunBox(sandbox, repo, ['hook', 'uninstall'])).code).toBe(0)
  })

  it('preserves the original git-lfs pre-push hook', async () => {
    const { sandbox, repo, hook, guard } = await fixture()
    await git(sandbox, repo, 'lfs', 'install', '--local')
    const original = await readFile(hook, 'utf8')
    expect(original).toContain('git lfs pre-push')
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--guard', guard])).code).toBe(0)
    expect(await readFile(`${hook}.yunbox-original`, 'utf8')).toBe(original)
    expect((await runYunBox(sandbox, repo, ['hook', 'uninstall'])).code).toBe(0)
    expect(await readFile(hook, 'utf8')).toBe(original)
  })

  it('refuses to overwrite modified wrappers, shared hook paths and non-executable guards', async () => {
    const { sandbox, repo, hook, guard } = await fixture()
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--guard', guard])).code).toBe(0)
    await writeFile(hook, '#!/bin/sh\n# user change\n')
    expect((await runYunBox(sandbox, repo, ['hook', 'uninstall'])).code).toBe(1)
    expect(await readFile(hook, 'utf8')).toContain('user change')
    await git(sandbox, repo, 'config', 'core.hooksPath', '/custom/hooks')
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--guard', guard])).code).toBe(1)
    const fresh = await createRepository(sandbox, 'fresh')
    await chmod(guard, 0o644)
    expect((await runYunBox(sandbox, fresh, ['hook', 'install', '--guard', guard])).code).toBe(1)
  })
})
