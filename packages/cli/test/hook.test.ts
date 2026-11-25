import type { Sandbox } from './helpers.ts'
import { Buffer } from 'node:buffer'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
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
  it('installs always-confirm hooks and reports the effective confirmation policy', async () => {
    const { sandbox, repo, hook, guard } = await fixture()
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--confirm-always'])).code).toBe(0)
    expect(await readFile(hook, 'utf8')).toContain(' --confirm-always')
    const status = () => runYunBox(sandbox, repo, ['hook', 'status', '--json']).then(result => JSON.parse(result.stdout))
    expect(await status()).toMatchObject({ confirm: true, confirmAlways: true })
    expect((await runYunBox(sandbox, repo, ['hook', 'install'])).code).toBe(0)
    expect(await status()).toMatchObject({ confirm: true, confirmAlways: false })
    await git(sandbox, repo, 'config', 'yunbox.confirmMode', 'always')
    expect(await status()).toMatchObject({ confirm: true, confirmAlways: true })
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--confirm-mode', 'exceeded'])).code).toBe(0)
    expect(await status()).toMatchObject({ confirm: true, confirmAlways: false })
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--no-confirm'])).code).toBe(0)
    expect(await status()).toMatchObject({ confirm: false, confirmAlways: false })
    for (const args of [['--no-confirm'], ['--guard', guard]])
      expect((await runYunBox(sandbox, repo, ['hook', 'install', '--confirm-always', ...args])).code).toBe(2)
  })

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
    await writeFile(join(repo, 'allow'), '')
    await git(sandbox, repo, 'hook', 'run', 'pre-push', '--', 'origin', 'https://example.com/repo.git')
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
  it.each([false, true])('allows git init with global protection and forwards template reference hooks (bare: %s)', async (bare) => {
    const sandbox = await createSandbox()
    sandboxes.push(sandbox)
    expect((await runYunBox(sandbox, sandbox.root, ['hook', 'install', '--global'])).code).toBe(0)
    const template = join(sandbox.root, 'template')
    await mkdir(join(template, 'hooks'), { recursive: true })
    await writeFile(join(template, 'hooks', 'reference-transaction'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$GIT_DIR/reference-events"\n', { mode: 0o755 })
    const repo = join(sandbox.root, bare ? 'bare.git' : 'new-repo')
    await git(sandbox, sandbox.root, 'init', ...(bare ? ['--bare'] : []), '--initial-branch=main', `--template=${template}`, repo)
    const phases = await readFile(join(repo, ...(bare ? [] : ['.git']), 'reference-events'), 'utf8')
    expect(phases).toContain('preparing\n')
    expect(phases).toContain('committed\n')
    expect(JSON.parse((await runYunBox(sandbox, sandbox.root, ['hook', 'status', '--json'])).stdout)).toMatchObject({ hook: 'inspect', scope: 'global', globalInstalled: true })
  })

  it('stops an under-budget push before the original upload when always-confirm has no UI', async () => {
    const { sandbox, repo, hook } = await fixture()
    const remote = join(sandbox.root, 'origin.git')
    await git(sandbox, sandbox.root, 'init', '--bare', remote)
    await git(sandbox, repo, 'remote', 'add', 'origin', remote)
    await writeFile(hook, '#!/bin/sh\ncat > uploaded-input\n', { mode: 0o755 })
    await writeFile(join(repo, 'small.txt'), 'small\n')
    await git(sandbox, repo, 'add', 'small.txt')
    await git(sandbox, repo, 'commit', '-qm', 'test(hook): add small file')
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--global', '--confirm-always'])).code).toBe(0)
    await expect(git(sandbox, repo, 'push', 'origin', 'HEAD:main')).rejects.toThrow()
    await expect(readFile(join(repo, 'uploaded-input'))).rejects.toThrow()
    expect(await git(sandbox, remote, 'for-each-ref', '--format=%(refname)')).toBe('')
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--global'])).code).toBe(0)
    await git(sandbox, repo, 'push', 'origin', 'HEAD:main')
    expect(await readFile(join(repo, 'uploaded-input'), 'utf8')).toContain('refs/heads/main')
  })

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

  it('blocks a stale first push if fetching fails and otherwise fetches before sending the pack', async () => {
    const { sandbox, repo, hook } = await fixture()
    const remote = join(sandbox.root, 'origin.git')
    const maintainer = join(sandbox.root, 'maintainer')
    await writeFile(join(repo, 'historical-asset.bin'), randomBytes(1280 * 1024))
    await git(sandbox, repo, 'add', '.')
    await git(sandbox, repo, 'commit', '-qm', 'Record historical asset')
    const oldMain = await git(sandbox, repo, 'rev-parse', 'HEAD')
    await git(sandbox, sandbox.root, 'clone', '-q', '--bare', '--no-local', repo, remote)
    await git(sandbox, sandbox.root, 'clone', '-q', remote, maintainer)
    await git(sandbox, maintainer, 'commit', '--allow-empty', '-qm', 'Advance remote main')
    await git(sandbox, maintainer, 'push', remote, 'HEAD:main')
    const remoteMain = await git(sandbox, remote, 'rev-parse', 'refs/heads/main')
    await git(sandbox, remote, 'update-ref', 'refs/pull/254/head', oldMain)
    await git(sandbox, remote, 'config', 'receive.hideRefs', 'refs/pull')
    await git(sandbox, remote, 'config', 'http.receivepack', 'true')
    await git(sandbox, repo, 'switch', '-qc', 'landing')
    await writeFile(join(repo, 'landing.md'), 'New landing page\n')
    await git(sandbox, repo, 'add', 'landing.md')
    await git(sandbox, repo, 'commit', '-qm', 'Update landing page')
    const landing = await git(sandbox, repo, 'rev-parse', 'HEAD')
    await writeFile(join(repo, 'landing.md'), 'Uncommitted edits\n')
    await git(sandbox, repo, 'config', 'http.postBuffer', '2m')
    await writeFile(hook, '#!/bin/sh\ncat > uploaded-input\n', { mode: 0o755 })
    expect((await runYunBox(sandbox, repo, ['hook', 'install', '--global', '--no-confirm'])).code).toBe(0)

    const uploads: number[] = []
    let allowFetch = true
    const server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://localhost')
      if (!allowFetch && url.searchParams.get('service') === 'git-upload-pack') {
        response.writeHead(403).end()
        return
      }
      if (url.pathname.endsWith('/git-receive-pack'))
        uploads.push(Number(request.headers['content-length']))
      const child = spawn('git', ['http-backend'], { env: {
        ...sandbox.env,
        GIT_PROJECT_ROOT: sandbox.root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers['content-type'],
        CONTENT_LENGTH: request.headers['content-length'],
        HTTP_GIT_PROTOCOL: request.headers['git-protocol'] as string | undefined,
      }, stdio: ['pipe', 'pipe', 'ignore'] })
      const output: Buffer[] = []
      child.stdout.on('data', chunk => output.push(chunk))
      child.stdin.on('error', () => {})
      child.on('error', () => response.destroy())
      child.on('close', (code) => {
        if (code !== 0) {
          response.writeHead(500).end()
          return
        }
        const result = Buffer.concat(output)
        const end = result.indexOf('\r\n\r\n')
        for (const line of result.subarray(0, end).toString().split('\r\n')) {
          const separator = line.indexOf(':')
          const value = line.slice(separator + 1).trim()
          if (line.startsWith('Status:'))
            response.statusCode = Number.parseInt(value)
          else
            response.setHeader(line.slice(0, separator), value)
        }
        response.end(result.subarray(end + 4))
      })
      request.pipe(child.stdin)
    })
    server.listen(0, '127.0.0.1')
    try {
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Missing test server address')
      const destination = `http://127.0.0.1:${address.port}/origin.git`
      await git(sandbox, repo, 'remote', 'add', 'origin', destination)
      await git(sandbox, repo, 'update-ref', 'refs/remotes/origin/main', oldMain)
      await writeFile(join(repo, '.git', 'FETCH_HEAD'), `${oldMain}\t\tprevious fetch\n`)
      expect(await git(sandbox, repo, 'ls-remote', 'origin', 'refs/pull/254/head')).toContain(oldMain)
      await expect(git(sandbox, repo, 'cat-file', '-e', remoteMain)).rejects.toThrow()

      const manual = await runYunBox(sandbox, repo, ['inspect', '--push', '--remote', 'origin', '--json'])
      expect(manual.code).toBe(1)
      await expect(git(sandbox, repo, 'cat-file', '-e', remoteMain)).rejects.toThrow()

      allowFetch = false
      await expect(git(sandbox, repo, 'push', 'origin', 'HEAD:refs/heads/landing')).rejects.toThrow()
      expect(uploads).toEqual([])
      await expect(readFile(join(repo, 'uploaded-input'))).rejects.toThrow()
      expect(await git(sandbox, remote, 'for-each-ref', 'refs/heads/landing')).toBe('')

      allowFetch = true
      const retried = await git(sandbox, repo, 'push', 'origin', 'HEAD:refs/heads/landing')
      expect(retried).toContain('已补齐远端默认分支对象')
      expect(uploads).toHaveLength(1)
      expect(uploads[0]).toBeLessThan(4096)
      expect(await readFile(join(repo, 'uploaded-input'), 'utf8')).toContain('refs/heads/landing')
      expect(await git(sandbox, remote, 'rev-parse', 'refs/heads/landing')).toBe(landing)
      await git(sandbox, repo, 'cat-file', '-e', remoteMain)
      expect(await git(sandbox, repo, 'rev-parse', 'HEAD')).toBe(landing)
      expect(await git(sandbox, repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(oldMain)
      expect(await readFile(join(repo, '.git', 'FETCH_HEAD'), 'utf8')).toBe(`${oldMain}\t\tprevious fetch\n`)
      expect(await readFile(join(repo, 'landing.md'), 'utf8')).toBe('Uncommitted edits\n')
    }
    finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
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
