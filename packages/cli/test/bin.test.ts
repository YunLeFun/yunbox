import type { Sandbox } from './helpers.ts'
import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createRepository, createSandbox, runYunBox } from './helpers.ts'

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url))
const cliSource = join(workspaceRoot, 'packages', 'cli', 'src', 'cli.ts')
const tsxLoader = pathToFileURL(join(workspaceRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
const sandboxes: Sandbox[] = []

afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map(sandbox => sandbox.cleanup()))
})

function exec(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, env }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr })
    })
  })
}

describe('package bins', () => {
  it('registers yunbox and git-yunbox for the same entry', async () => {
    const manifest = JSON.parse(await readFile(join(workspaceRoot, 'packages', 'cli', 'package.json'), 'utf8')) as { bin: Record<string, string> }
    expect(manifest.bin).toEqual({ 'git-yunbox': './dist/cli.mjs', 'yunbox': './dist/cli.mjs' })
  })
})

// The npm-generated shims differ on Windows; that path still needs a manual check (docs/plan.md section 12).
describe.skipIf(process.platform === 'win32')('git-yunbox executable', () => {
  it('runs the same command as `git yunbox` and as `yunbox`', async () => {
    const sandbox = await createSandbox()
    sandboxes.push(sandbox)
    const repo = await createRepository(sandbox)
    const bin = join(sandbox.root, 'bin')
    await mkdir(bin)
    // Stand-ins for the two package bins, both pointing at the same entry like package.json does.
    for (const name of ['git-yunbox', 'yunbox']) {
      const shim = join(bin, name)
      await writeFile(shim, `#!/bin/sh\nexec "${process.execPath}" --no-warnings --import "${tsxLoader}" "${cliSource}" "$@"\n`)
      await chmod(shim, 0o755)
    }
    const env: NodeJS.ProcessEnv = {
      ...sandbox.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      TSX_TSCONFIG_PATH: join(workspaceRoot, 'tsconfig.json'),
    }

    const viaGit = await exec('git', ['yunbox', 'init', '--url', 'http://127.0.0.1:8080/team/assets', '--skip-credential'], repo, env)
    expect(viaGit.stderr).toBe('')
    expect(viaGit.code).toBe(0)
    expect(await readFile(join(repo, '.lfsconfig'), 'utf8')).toContain('url = http://127.0.0.1:8080/team/assets')

    const gitStatus = await exec('git', ['yunbox', 'status'], repo, env)
    const plainStatus = await exec('yunbox', ['status'], repo, env)
    const inProcess = await runYunBox(sandbox, repo, ['status'])
    expect(gitStatus.code).toBe(0)
    expect(gitStatus.stdout).toBe(plainStatus.stdout)
    expect(gitStatus.stdout).toBe(inProcess.stdout)

    // `git yunbox --help` becomes `git help yunbox`, so `help` is the portable spelling.
    const help = await exec('git', ['yunbox', 'help', 'doctor'], repo, env)
    expect(help.stdout).toContain('用法：yunbox doctor')

    const unknown = await exec('git', ['yunbox', 'nope'], repo, env)
    expect(unknown.code).toBe(2)
    expect(unknown.stderr).toContain('未知命令：nope')
  })
})
