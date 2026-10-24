import type { Sandbox } from './helpers.ts'
import { execFile } from 'node:child_process'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
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
  it('asks on exceeded budgets by default and supports explicit rejection mode', async () => {
    const { sandbox, repo, hook } = await fixture()
    expect((await runYunBox(sandbox, repo, ['hook', 'install'])).code).toBe(0)
    expect(await readFile(hook, 'utf8')).toContain(' --confirm')
    const status = JSON.parse((await runYunBox(sandbox, repo, ['hook', 'status', '--json'])).stdout)
    expect(status).toMatchObject({ version: 1, repository: true, hook: 'inspect', scope: 'repository', confirm: true, globalInstalled: false, ready: true })
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--no-confirm'])).code).toBe(0)
    expect(await readFile(hook, 'utf8')).not.toContain(' --confirm')
  })

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
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--guard', guard, '--confirm'])).code).toBe(2)
    await git(sandbox, repo, 'config', 'core.hooksPath', '/custom/hooks')
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--guard', guard])).code).toBe(1)
    // Windows has no execute bit to check; Git for Windows runs hooks through sh.
    if (process.platform !== 'win32') {
      const fresh = await createRepository(sandbox, 'fresh')
      await chmod(guard, 0o644)
      expect((await runYunBox(sandbox, fresh, ['hook', 'install', '--guard', guard])).code).toBe(1)
    }
  })
})

describe('optional global hook dispatcher', () => {
  it('enforces the real CLI during push while the desktop app is absent', async () => {
    const { sandbox, repo, hook } = await fixture()
    const remote = join(sandbox.root, 'origin.git')
    await git(sandbox, sandbox.root, 'init', '--bare', remote)
    await git(sandbox, repo, 'remote', 'add', 'origin', remote)
    await writeFile(hook, '#!/bin/sh\ncat > uploaded-input\n', { mode: 0o755 })
    await writeFile(join(repo, 'asset.txt'), 'some content exceeding one byte\n')
    await git(sandbox, repo, 'add', 'asset.txt')
    await git(sandbox, repo, 'commit', '-m', 'test: add asset')
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--global'])).code).toBe(0)
    await git(sandbox, repo, 'config', 'yunbox.inspectFileBytes', '1')
    await expect(git(sandbox, repo, 'push', 'origin', 'HEAD:main')).rejects.toThrow()
    await expect(readFile(join(repo, 'uploaded-input'))).rejects.toThrow()
    expect(await git(sandbox, remote, 'for-each-ref', '--format=%(refname)')).toBe('')
    await git(sandbox, repo, 'config', 'yunbox.inspectFileBytes', '1024')
    await git(sandbox, repo, 'push', 'origin', 'HEAD:main')
    expect(await readFile(join(repo, 'uploaded-input'), 'utf8')).toContain('refs/heads/main')
    expect(await git(sandbox, remote, 'rev-parse', 'refs/heads/main')).toBe(await git(sandbox, repo, 'rev-parse', 'HEAD'))
  })

  it('blocks uploads before the original hook and forwards stdin, other events and worktrees', async () => {
    const { sandbox, repo, hook, guard } = await fixture()
    const original = '#!/bin/sh\ncat > original-input\nprintf "%s\\n" "$@" > original-args\n'
    await writeFile(hook, original, { mode: 0o755 })
    await writeFile(join(repo, '.git/hooks/post-checkout'), '#!/bin/sh\nprintf "%s\\n" "$@" > checkout-args\n', { mode: 0o755 })
    expect((await runYunBox(sandbox, sandbox.root, ['hook', 'install', '--global', '--guard', guard])).code).toBe(0)
    const input = join(repo, 'updates')
    const updates = `refs/heads/main ${'a'.repeat(40)} refs/heads/main ${'0'.repeat(40)}\n`
    await writeFile(input, updates)
    const args = ['hook', 'run', '--to-stdin', input, 'pre-push', '--', 'origin', 'https://example.com/repo.git']
    await expect(execute('git', args, { cwd: repo, env: sandbox.env })).rejects.toThrow()
    await expect(readFile(join(repo, 'original-input'))).rejects.toThrow()
    await writeFile(join(repo, 'allow'), '')
    await execute('git', args, { cwd: repo, env: sandbox.env })
    expect(await readFile(join(repo, 'original-input'), 'utf8')).toBe(updates)
    expect(await readFile(join(repo, 'guard-input'), 'utf8')).toBe(updates)
    expect(await readFile(join(repo, 'original-args'), 'utf8')).toBe(await readFile(join(repo, 'guard-args'), 'utf8'))
    await git(sandbox, repo, 'commit', '--allow-empty', '-m', 'test: initial commit')
    const worktree = join(sandbox.root, 'linked tree')
    await git(sandbox, repo, 'worktree', 'add', '-b', 'linked', worktree)
    expect(await readFile(join(worktree, 'checkout-args'), 'utf8')).toContain('1')
    await writeFile(join(worktree, 'allow'), '')
    await execute('git', args, { cwd: worktree, env: sandbox.env })
    expect(await readFile(join(worktree, 'original-input'), 'utf8')).toBe(updates)
    expect((await runYunBox(sandbox, sandbox.root, ['hook', 'uninstall', '--global'])).code).toBe(0)
    expect(await readFile(hook, 'utf8')).toBe(original)
    await expect(git(sandbox, repo, 'config', '--global', '--get', 'core.hooksPath')).rejects.toThrow()
  })

  it('keeps repository wrappers authoritative instead of checking twice', async () => {
    const { sandbox, repo, guard } = await fixture()
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--guard', guard])).code).toBe(0)
    const failingGlobal = join(sandbox.root, 'fail-global')
    await writeFile(failingGlobal, '#!/bin/sh\nexit 99\n', { mode: 0o755 })
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--global', '--guard', failingGlobal])).code).toBe(0)
    await writeFile(join(repo, 'allow'), '')
    await git(sandbox, repo, 'hook', 'run', 'pre-push', '--', 'origin', 'https://example.com/r')
    const status = JSON.parse((await runYunBox(sandbox, repo, ['hook', 'status', '--json'])).stdout)
    expect(status).toMatchObject({ hook: 'guard', scope: 'repository', globalInstalled: true })
  })

  it('preserves other managers, reports overrides, and refuses modified managed files', async () => {
    const { sandbox, repo, guard } = await fixture()
    await git(sandbox, repo, 'config', '--global', 'core.hooksPath', '/custom/hooks')
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--global', '--guard', guard])).code).toBe(1)
    expect(await git(sandbox, repo, 'config', '--global', '--get', 'core.hooksPath')).toBe('/custom/hooks')
    await git(sandbox, repo, 'config', '--global', '--unset', 'core.hooksPath')
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--global', '--guard', guard])).code).toBe(0)
    const directory = await git(sandbox, repo, 'config', '--global', '--get', 'core.hooksPath')
    await git(sandbox, repo, 'config', '--local', 'core.hooksPath', '/custom/project-hooks')
    expect(JSON.parse((await runYunBox(sandbox, repo, ['hook', 'status', '--json'])).stdout)).toMatchObject({ hook: 'none', globalInstalled: true, customPath: true })
    await writeFile(join(directory, 'post-commit'), '#!/bin/sh\n# user changes\n')
    expect((await runYunBox(sandbox, repo, ['hook', 'uninstall', '--global'])).code).toBe(1)
    expect(await readFile(join(directory, 'post-commit'), 'utf8')).toContain('user changes')
  })
})
