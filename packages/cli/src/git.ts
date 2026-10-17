import type { CliContext } from './context.ts'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** Lowest Git version `git yunbox` is tested against. */
export const MIN_GIT_VERSION = '2.30.0'
/** Lowest git-lfs version; `git lfs ls-files --json`, used by `yunbox status`, arrived in 3.2.0. */
export const MIN_GIT_LFS_VERSION = '3.2.0'

/** Result of one `git` invocation. `code` is `undefined` when git could not be started. */
export interface GitResult {
  code: number | undefined
  stdout: string
  stderr: string
}

/** Options for {@link runGit}. */
export interface RunGitOptions {
  /** Written to the child's stdin, which is otherwise closed. */
  input?: string
  /** Extra environment variables on top of the context's environment. */
  env?: NodeJS.ProcessEnv
}

/** Run `git` with the context's working directory and environment, never throwing on a non-zero exit. */
export function runGit(context: CliContext, args: string[], options: RunGitOptions = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: context.cwd,
      env: { ...context.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      resolve({ code: undefined, stdout: '', stderr: error.message })
    })
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    child.stdin.end(options.input ?? '')
  })
}

/** Run `git` and return trimmed stdout, or throw with git's stderr when it fails. */
export async function runGitChecked(context: CliContext, args: string[], options?: RunGitOptions): Promise<string> {
  const result = await runGit(context, args, options)
  if (result.code !== 0)
    throw new Error(`git ${args[0] ?? ''} 失败：${firstLine(result.stderr) || `退出码 ${result.code ?? '未知'}`}`)
  return result.stdout.trim()
}

/** A tool's detected version, or why it could not be detected. */
export type ToolVersion
  = | { found: true, version: string, raw: string }
    | { found: false, reason: string }

/** Detect the installed Git version from `git --version`. */
export async function detectGitVersion(context: CliContext): Promise<ToolVersion> {
  const result = await runGit(context, ['--version'])
  if (result.code === undefined)
    return { found: false, reason: '找不到 git 命令' }
  const version = parseVersion(result.stdout)
  if (result.code !== 0 || version === undefined)
    return { found: false, reason: firstLine(result.stderr) || '无法识别 git --version 的输出' }
  return { found: true, version, raw: result.stdout.trim() }
}

/** Detect the installed git-lfs version from `git lfs version`. */
export async function detectGitLfsVersion(context: CliContext): Promise<ToolVersion> {
  const result = await runGit(context, ['lfs', 'version'])
  if (result.code === undefined)
    return { found: false, reason: '找不到 git 命令' }
  const version = /git-lfs\/(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1]
  if (result.code !== 0 || version === undefined)
    return { found: false, reason: '没有安装 git-lfs（git lfs version 失败）' }
  return { found: true, version, raw: result.stdout.trim() }
}

/** Extract the first `major.minor.patch` from text such as `git version 2.45.1.windows.1`. */
export function parseVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1]
}

/** Compare two `major.minor.patch` versions; negative when `a < b`. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0)
      return difference
  }
  return 0
}

/** The working tree root of the repository containing the context's directory, if any. */
export async function findRepositoryRoot(context: CliContext): Promise<string | undefined> {
  const result = await runGit(context, ['rev-parse', '--show-toplevel'])
  if (result.code !== 0)
    return undefined
  return result.stdout.trim() || undefined
}

/** Read one Git config value; `file` reads a specific file such as `.lfsconfig`. */
export async function readGitConfig(context: CliContext, key: string, file?: string): Promise<string | undefined> {
  const args = file === undefined ? ['config', '--get', key] : ['config', '--file', file, '--get', key]
  const result = await runGit(context, args)
  if (result.code !== 0)
    return undefined
  return result.stdout.replace(/\r?\n$/, '')
}

/** Read the value Git applies to `url` for a `section.<url>.key` style setting. */
export async function readGitConfigForUrl(context: CliContext, key: string, url: string): Promise<string | undefined> {
  const result = await runGit(context, ['config', '--get-urlmatch', key, url])
  if (result.code !== 0)
    return undefined
  return result.stdout.replace(/\r?\n$/, '')
}

/** Where the effective `lfs.url` came from. */
export interface ConfiguredLfsUrl {
  url: string
  /** `.lfsconfig` (shared, committed) or `git config` (local or global, overrides `.lfsconfig`). */
  source: '.lfsconfig' | 'git config'
  /** The `.lfsconfig` value when `git config` overrides it with something else. */
  shadowed?: string
}

/**
 * Resolve `lfs.url` the way git-lfs does: Git config wins over the
 * repository's `.lfsconfig`.
 */
export async function readLfsUrl(context: CliContext, root: string): Promise<ConfiguredLfsUrl | undefined> {
  const fromLfsConfig = await readGitConfig(context, 'lfs.url', join(root, '.lfsconfig'))
  const fromGitConfig = await readGitConfig(context, 'lfs.url')
  if (fromGitConfig !== undefined) {
    return {
      url: fromGitConfig,
      source: 'git config',
      ...(fromLfsConfig !== undefined && fromLfsConfig !== fromGitConfig ? { shadowed: fromLfsConfig } : {}),
    }
  }
  return fromLfsConfig === undefined ? undefined : { url: fromLfsConfig, source: '.lfsconfig' }
}

/** The first non-empty line of some command output. */
export function firstLine(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).find(line => line !== '') ?? ''
}

/** Quote an argument for display in a copy-and-paste POSIX shell command. */
export function shellQuote(value: string): string {
  return /^[\w%+,./:=@-]+$/.test(value) ? value : `'${value.replaceAll('\'', `'\\''`)}'`
}
