import type { PushInspection } from '../src/inspect.ts'
import type { Sandbox } from './helpers.ts'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { askPush } from '../src/confirm.ts'
import { createRepository, createSandbox, git, runYunBox } from './helpers.ts'

const sandboxes: Sandbox[] = []

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(sandbox => sandbox.cleanup()))
})

// Exercise the real dialog process boundary without displaying a window in CI.
describe.skipIf(process.platform === 'win32')('confirmation previews', () => {
  it('opens before generating diffs, then prepares only the requested committed file once', async () => {
    const sandbox = await createSandbox()
    sandboxes.push(sandbox)
    const repo = await createRepository(sandbox)
    for (const name of ['first.txt', 'second.txt'])
      await writeFile(join(repo, name), 'before\n')
    await git(sandbox, repo, 'add', '.')
    await git(sandbox, repo, 'commit', '-qm', 'test: base')
    const base = await git(sandbox, repo, 'rev-parse', 'HEAD')
    for (const name of ['first.txt', 'second.txt'])
      await writeFile(join(repo, name), 'after\n')
    await git(sandbox, repo, 'add', '.')
    await git(sandbox, repo, 'commit', '-qm', 'test: change')
    await writeFile(join(repo, 'first.txt'), 'uncommitted\n')
    const inspected = await runYunBox(sandbox, repo, ['inspect', '--push', '--base', base, '--json', '--file-limit', '1'])
    const report = JSON.parse(inspected.stdout) as PushInspection
    const resultFile = join(sandbox.root, 'dialog-result.json')
    const traceFile = join(sandbox.root, 'git-trace.log')
    const dialog = join(sandbox.root, 'osascript')
    await writeFile(dialog, `#!/usr/bin/env node
const { readFileSync, writeFileSync, readdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { preview } = JSON.parse(process.argv.at(-1));
const result = { initialFiles: readdirSync(preview.dir), diffRows: preview.diffRows || [] };
(async () => {
  if (result.diffRows.includes(0)) {
    // Requests can span stdout chunks and be repeated. Invalid row numbers are ignored.
    process.stdout.write('yunbox-pre');
    await new Promise(resolve => setTimeout(resolve, 20));
    process.stdout.write('view:0\\nyunbox-preview:0\\nyunbox-preview:999999\\n');
    const ready = join(preview.dir, '0', 'diff.json');
    const deadline = Date.now() + 3000;
    while (!existsSync(ready) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    if (existsSync(ready)) {
      result.diff = JSON.parse(readFileSync(ready, 'utf8'));
      result.html = readFileSync(join(preview.dir, '0', result.diff.name), 'utf8');
    }
    result.preparedRows = readdirSync(preview.dir);
  }
  result.directory = preview.dir;
  writeFileSync(process.env.TEST_DIALOG_RESULT, JSON.stringify(result));
  process.stdout.write('cancel\\n先压缩图片');
})().catch(() => process.exitCode = 1);
`, { mode: 0o700 })
    const answer = await askPush({
      cwd: repo,
      env: { ...sandbox.env, PATH: `${sandbox.root}:${sandbox.env.PATH}`, TEST_DIALOG_RESULT: resultFile, GIT_TRACE: traceFile },
      stdin: Readable.from([]),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }, report, { ui: 'dialog' })
    const result = JSON.parse(await readFile(resultFile, 'utf8'))
    expect(result.initialFiles).toEqual([])
    expect(result.diffRows).toEqual([0, 1])
    expect(result.preparedRows).toEqual(['0'])
    expect(result.html).toContain('before')
    expect(result.html).toContain('after')
    expect(result.html).not.toContain('uncommitted')
    expect(result.html).not.toContain('<script')
    expect((await readFile(traceFile, 'utf8')).match(/built-in: git diff /g)).toHaveLength(1)
    expect(answer).toEqual({ answer: 'cancel', note: '先压缩图片' })
    await expect(readFile(join(result.directory, '0', 'diff.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the continue answer and note while cancelling an unfinished diff on close', async () => {
    const sandbox = await createSandbox()
    sandboxes.push(sandbox)
    const repo = await createRepository(sandbox)
    await writeFile(join(repo, 'file.txt'), 'before\n')
    await git(sandbox, repo, 'add', '.')
    await git(sandbox, repo, 'commit', '-qm', 'test: base')
    const base = await git(sandbox, repo, 'rev-parse', 'HEAD')
    await writeFile(join(repo, 'file.txt'), 'after\n')
    await git(sandbox, repo, 'add', '.')
    await git(sandbox, repo, 'commit', '-qm', 'test: change')
    const inspected = await runYunBox(sandbox, repo, ['inspect', '--push', '--base', base, '--json', '--file-limit', '1'])
    const report = JSON.parse(inspected.stdout) as PushInspection
    const realGit = execFileSync('which', ['git'], { env: sandbox.env, encoding: 'utf8' }).trim()
    const started = join(sandbox.root, 'diff-started.json')
    const resultFile = join(sandbox.root, 'dialog-directory')
    await writeFile(join(sandbox.root, 'git'), `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
if (process.argv[2] === 'diff') {
  writeFileSync(process.env.TEST_DIFF_STARTED, JSON.stringify({ pid: process.pid }));
  setTimeout(() => {}, 15000);
} else {
  process.exitCode = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' }).status;
}
`, { mode: 0o700 })
    await writeFile(join(sandbox.root, 'osascript'), `#!/usr/bin/env node
const { existsSync, writeFileSync } = require('node:fs');
const { preview } = JSON.parse(process.argv.at(-1));
writeFileSync(process.env.TEST_DIALOG_RESULT, preview.dir);
process.stdout.write('yunbox-preview:0\\n');
(async () => {
  const deadline = Date.now() + 3000;
  while (!existsSync(process.env.TEST_DIFF_STARTED) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  process.stdout.write('continue\\nyunbox-preview:0 已核对素材');
})();
`, { mode: 0o700 })
    const answer = await askPush({
      cwd: repo,
      env: { ...sandbox.env, PATH: `${sandbox.root}:${sandbox.env.PATH}`, TEST_DIFF_STARTED: started, TEST_DIALOG_RESULT: resultFile },
      stdin: Readable.from([]),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }, report, { ui: 'dialog' })
    const { pid } = JSON.parse(await readFile(started, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
    expect(answer).toEqual({ answer: 'continue', note: 'yunbox-preview:0 已核对素材' })
    const directory = await readFile(resultFile, 'utf8')
    await expect(readFile(join(directory, '0', 'diff.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
