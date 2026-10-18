import type { CliContext } from '../src/context.ts'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { PassThrough, Readable } from 'node:stream'
import { runCli } from '../src/run.ts'

/** An isolated HOME whose only credential helper is a plain file, so tests never touch a real keychain. */
export interface Sandbox {
  root: string
  env: NodeJS.ProcessEnv
  credentialsFile: string
  cleanup: () => Promise<void>
}

/** Create a sandbox with its own global Git config and a `store` credential helper. */
export async function createSandbox(options: { credentialHelper?: boolean } = {}): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), 'yunbox-cli-test-'))
  const home = join(root, 'home')
  await mkdir(home)
  const credentialsFile = join(home, 'git-credentials')
  const globalConfig = join(home, '.gitconfig')
  // An empty helper value clears any inherited helper list.
  const helper = options.credentialHelper === false ? '' : `store --file='${credentialsFile}'`
  await writeFile(globalConfig, `[credential]\n\thelper =\n${helper === '' ? '' : `\thelper = ${helper}\n`}[init]\n\tdefaultBranch = main\n`)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'YunBox Test',
    GIT_AUTHOR_EMAIL: 'yunbox-test@example.invalid',
    GIT_COMMITTER_NAME: 'YunBox Test',
    GIT_COMMITTER_EMAIL: 'yunbox-test@example.invalid',
    LC_ALL: 'C',
  }
  // Never let a developer's real cloud keys or YunBox settings reach a test.
  for (const name of Object.keys(env)) {
    if (name.startsWith('TENCENTCLOUD_') || name.startsWith('YUNBOX_'))
      delete env[name]
  }
  // Keep `yunbox login` away from the developer's real macOS keychain.
  env.YUNBOX_CREDENTIAL_STORE = 'file'
  delete env.GIT_ASKPASS
  delete env.SSH_ASKPASS
  delete env.GIT_DIR
  delete env.GIT_WORK_TREE
  return { root, env, credentialsFile, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** Captured result of an in-process CLI run. */
export interface CliRun {
  code: number
  stdout: string
  stderr: string
}

/** Run the CLI in-process with `stdin` as piped input. */
export async function runYunBox(sandbox: Sandbox, cwd: string, argv: string[], stdin = ''): Promise<CliRun> {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const out: Buffer[] = []
  const err: Buffer[] = []
  stdout.on('data', (chunk: Buffer) => out.push(chunk))
  stderr.on('data', (chunk: Buffer) => err.push(chunk))
  const context: CliContext = {
    cwd,
    env: sandbox.env,
    stdin: Readable.from(stdin === '' ? [] : [Buffer.from(stdin)]),
    stdout,
    stderr,
  }
  const code = await runCli(argv, context)
  return { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }
}

/** Run git in the sandbox and return trimmed stdout; rejects on failure. */
export function git(sandbox: Sandbox, cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: sandbox.env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error)
        reject(new Error(`git ${args.join(' ')} failed: ${stderr}`))
      else
        resolve(stdout.trim())
    })
  })
}

/** Create a repository with an initial commit-less working tree inside the sandbox. */
export async function createRepository(sandbox: Sandbox, name = 'repo'): Promise<string> {
  const directory = join(sandbox.root, name)
  await mkdir(directory)
  await git(sandbox, directory, 'init', '--quiet')
  return directory
}
