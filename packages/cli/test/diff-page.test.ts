import type { CliContext } from '../src/context.ts'
import type { PushInspection } from '../src/inspect.ts'
import type { Sandbox } from './helpers.ts'
import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { textDiff } from '../src/diff-page.ts'
import { createRepository, createSandbox, git, runYunBox } from './helpers.ts'

const sandboxes: Sandbox[] = []

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(sandbox => sandbox.cleanup()))
})

describe('textDiff', () => {
  it('diffs a modified text file between its pushed versions, never the worktree', async () => {
    const sandbox = await createSandbox()
    sandboxes.push(sandbox)
    const repo = await createRepository(sandbox)
    await writeFile(join(repo, 'guide.md'), '# Guide\n\nRun the importer.\n')
    await writeFile(join(repo, 'blob.bin'), randomBytes(512))
    await writeFile(join(repo, 'art.psd'), `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 10\n`)
    await git(sandbox, repo, 'add', '-A')
    await git(sandbox, repo, 'commit', '-qm', 'test: base')
    const base = await git(sandbox, repo, 'rev-parse', 'HEAD')
    await writeFile(join(repo, 'guide.md'), '# Guide\n\nRun the importer with --fast.\n')
    await writeFile(join(repo, 'blob.bin'), randomBytes(512))
    await writeFile(join(repo, 'art.psd'), `version https://git-lfs.github.com/spec/v1\noid sha256:${'b'.repeat(64)}\nsize 12\n`)
    await writeFile(join(repo, 'added.txt'), 'new\n')
    await git(sandbox, repo, 'add', '-A')
    await git(sandbox, repo, 'commit', '-qm', 'test: change')
    await writeFile(join(repo, 'guide.md'), 'uncommitted\n')
    const result = await runYunBox(sandbox, repo, ['inspect', '--push', '--base', base, '--json'])
    const report = JSON.parse(result.stdout) as PushInspection
    const change = (path: string) => report.changes.find(change => change.path === path)!
    const context: CliContext = { cwd: repo, env: sandbox.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }
    expect(await textDiff(context, change('guide.md'))).toBe('@@ -1,3 +1,3 @@\n # Guide\n \n-Run the importer.\n+Run the importer with --fast.\n')
    expect(await textDiff(context, change('blob.bin'))).toBeUndefined()
    expect(await textDiff(context, change('art.psd'))).toBeUndefined()
    expect(await textDiff(context, change('added.txt'))).toBeUndefined()
    expect(await textDiff(context, { ...change('guide.md'), beforeOid: '--output=/tmp/x' })).toBeUndefined()
  })
})
