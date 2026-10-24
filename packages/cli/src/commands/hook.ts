import type { Stats } from 'node:fs'
import type { CliContext } from '../context.ts'
import type { ToolVersion } from '../git.ts'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { CliError, print } from '../context.ts'
import { compareVersions, detectGitLfsVersion, detectGitVersion, findRepositoryRoot, MIN_GIT_LFS_VERSION, MIN_GIT_VERSION, readGitConfig, runGit, runGitChecked, shellQuote } from '../git.ts'
import { globalHookFiles, globalHooksDirectory, manageGlobalHooks, usesGlobalHooks } from '../global-hooks.ts'

const MARKER = '# yunbox-pre-push-v1'

interface HookState {
  version: 1
  wrapper: string
  hadOriginal: boolean
}

export const hookHelp = `用法：yunbox hook install [--global] [--no-confirm | --guard <absolute-path>]
      yunbox hook uninstall [--global] | yunbox hook status [--json]

安装串行 pre-push 包装层：检查通过后才执行原有钩子（包括 git-lfs 上传）。
原钩子保留在 pre-push.yunbox-original，uninstall 恢复它。不会修改已有 Git 提交。
默认超限时询问是否继续（macOS 原生对话框，否则终端），无需打开 App。
--confirm 显式启用询问（默认）；--no-confirm 超限时直接阻止推送。
--global 可选：本机所有未自定义 core.hooksPath 的仓库；原有仓库钩子仍串行执行。
纯终端确认：git config yunbox.confirmUI terminal（macOS 也支持）；恢复自动选择用 auto。
--guard 指定额外的确认程序，例如 ~/.local/libexec/git-confirm-large-push。
有自定义 core.hooksPath 或非普通文件钩子时拒绝安装，避免改动共享配置。
`

/** Install or remove a fail-fast chain around the existing repository pre-push hook. */
export async function runHook(context: CliContext, args: string[]): Promise<number> {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    context.stdout.write(hookHelp)
    return 0
  }
  const [operation, ...rest] = args
  const { values } = parseArgs({ args: rest, options: { 'guard': { type: 'string' }, 'confirm': { type: 'boolean' }, 'no-confirm': { type: 'boolean' }, 'global': { type: 'boolean' }, 'json': { type: 'boolean' } } })
  if (!['install', 'uninstall', 'status'].includes(operation!) || (operation !== 'install' && (values.guard || values.confirm || values['no-confirm'])) || (values.guard && (values.confirm || values['no-confirm'])) || (values.confirm && values['no-confirm']) || (values.json && operation !== 'status'))
    throw new CliError(hookHelp, 2)
  if (operation === 'status') {
    const status = await hookStatus(context)
    print(context, values.json ? JSON.stringify(status) : `推送保护：${status.hook} (${status.scope ?? 'none'})${status.confirm ? '，超限询问' : ''}\n全局钩子：${status.globalInstalled ? '已安装' : '未安装'}`)
    return 0
  }
  const command = operation === 'install' ? await hookCommand(values.guard, !values['no-confirm']) : undefined
  if (values.global)
    return manageGlobalHooks(context, operation!, command)
  const root = await findRepositoryRoot(context)
  if (!root)
    throw new CliError('当前目录不在 Git 仓库里')
  const repo = { ...context, cwd: root }
  if (await readGitConfig(repo, 'core.hooksPath') !== undefined && !await usesGlobalHooks(repo))
    throw new CliError('已有自定义 core.hooksPath，请在原钩子管理器中串行接入检查，不自动修改共享钩子')
  const hook = await repositoryHookPath(repo)
  const backup = `${hook}.yunbox-original`
  const statePath = `${hook}.yunbox.json`
  const stateFile = await regularFile(statePath)
  const hookFile = await regularFile(hook)
  const backupFile = await regularFile(backup)
  let state: HookState | undefined
  if (stateFile) {
    state = JSON.parse(await readFile(statePath, 'utf8')) as HookState
    if (state.version !== 1 || typeof state.wrapper !== 'string' || typeof state.hadOriginal !== 'boolean' || !hookFile || await readFile(hook, 'utf8') !== state.wrapper || Boolean(backupFile) !== state.hadOriginal)
      throw new CliError('YunBox 钩子或备份已被修改，保留现状；请先检查 hooks 目录')
  }
  else if (backupFile || (hookFile && (await readFile(hook, 'utf8')).includes(MARKER))) {
    throw new CliError('发现未登记的 YunBox 钩子或备份，保留现状；请先检查 hooks 目录')
  }
  if (operation === 'uninstall') {
    if (!state) {
      print(context, '没有安装 YunBox pre-push 包装层')
      return 0
    }
    if (state.hadOriginal)
      await rename(backup, hook)
    else
      await unlink(hook)
    await unlink(statePath)
    print(context, '已移除 YunBox 包装层，恢复原有 pre-push 钩子')
    return 0
  }
  const hadOriginal = state?.hadOriginal ?? Boolean(hookFile)
  const originalExecutable = isExecutableMode((state ? backupFile : hookFile)?.mode ?? 0)
  const wrapper = `#!/bin/sh
${MARKER}
set -eu
input=$(mktemp "\${TMPDIR:-/tmp}/yunbox-pre-push.XXXXXX")
trap 'rm -f "$input"' EXIT HUP INT TERM
cat >"$input"
${command} <"$input" || exit $?
${originalExecutable ? `${shellQuote(backup)} "$@" <"$input"` : ':'}
`
  if (state?.wrapper === wrapper) {
    print(context, 'YunBox pre-push 包装层已安装')
    return 0
  }
  await mkdir(dirname(hook), { recursive: true })
  const temporaryHook = `${hook}.${randomUUID()}.tmp`
  const temporaryState = `${statePath}.${randomUUID()}.tmp`
  let savedOriginal = false
  let replacedHook = false
  try {
    await writeFile(temporaryHook, wrapper, { mode: 0o755, flag: 'wx' })
    await writeFile(temporaryState, JSON.stringify({ version: 1, wrapper, hadOriginal } satisfies HookState), { mode: 0o600, flag: 'wx' })
    if (!state && hookFile) {
      await rename(hook, backup)
      savedOriginal = true
    }
    await rename(temporaryHook, hook)
    replacedHook = true
    await rename(temporaryState, statePath)
  }
  catch (error) {
    // Restore the previous entry point if installation cannot finish.
    if (state && replacedHook) {
      await writeFile(hook, state.wrapper, { mode: 0o755 })
    }
    else if (savedOriginal) {
      await rename(backup, hook)
    }
    else if (replacedHook) {
      await unlink(hook).catch(() => {})
    }
    throw error
  }
  finally {
    await unlink(temporaryHook).catch(() => {})
    await unlink(temporaryState).catch(() => {})
  }
  print(context, `已安装 YunBox pre-push 包装层：检查通过后才执行原有钩子${values.guard ? '' : values['no-confirm'] ? '；超限直接阻止' : '；超限询问是否继续，关闭 App 后仍生效'}`)
  return 0
}

/**
 * What the repository's YunBox pre-push wrapper runs: `inspect` (the bundled
 * CLI, which also enforces freeze windows), `guard` (a custom program), or
 * `none` when no wrapper is installed. Never throws.
 */
export async function installedHook(context: CliContext, root: string): Promise<'inspect' | 'guard' | 'none'> {
  try {
    const repo = { ...context, cwd: root }
    return (await hookStatus(repo, false)).hook
  }
  catch {
    return 'none'
  }
}

/** The default repository hook path, independent of the optional global dispatcher. */
export async function repositoryHookPath(context: CliContext): Promise<string> {
  return resolve(context.cwd, await runGitChecked(context, ['rev-parse', '--git-common-dir']), 'hooks/pre-push')
}

async function hookCommand(guard: string | undefined, confirm: boolean): Promise<string> {
  if (guard !== undefined) {
    if (!isAbsolute(guard) || !(await regularFile(guard)) || !isExecutableMode((await lstat(guard)).mode))
      throw new CliError('--guard 必须指向已有的绝对路径可执行文件')
    return `WORKSTATION_YUNBOX_CHAIN=1 ${shellQuote(guard.replaceAll('\\', '/'))} "$@"`
  }
  // Source development uses the built CLI too; hooks must survive this process.
  const entry = process.argv[1]
  const bundled = entry !== undefined && /\.app\/Contents\/Resources\/cli\/cli\.mjs$/.test(entry.replaceAll('\\', '/'))
  const cli = bundled ? entry : fileURLToPath(new URL(new URL(import.meta.url).pathname.endsWith('.ts') ? '../../dist/cli.mjs' : './cli.mjs', import.meta.url))
  if (!(await regularFile(cli)))
    throw new CliError('请先构建并安装 YunBox CLI，或使用 --guard 指定检查程序')
  return `${shellQuote(process.execPath.replaceAll('\\', '/'))} ${shellQuote(cli.replaceAll('\\', '/'))} inspect --push --stdin --remote "$2"${confirm ? ' --confirm' : ''}`
}

/** Effective hook ownership and optional prerequisite diagnostics. */
export interface HookStatus {
  version: 1
  repository: boolean
  hook: 'inspect' | 'guard' | 'none'
  scope?: 'repository' | 'global'
  confirm: boolean
  globalInstalled: boolean
  customPath: boolean
  node?: string
  nodeReady?: boolean
  git?: ToolVersion
  lfs?: ToolVersion
  ready?: boolean
}

/** Read effective protection and prerequisites for the desktop setup flow. */
export async function hookStatus(context: CliContext, tools = true): Promise<HookStatus> {
  const root = await findRepositoryRoot(context)
  const configured = await readGitConfig(context, 'core.hooksPath')
  const global = await runGit(context, ['config', '--global', '--get', 'core.hooksPath'])
  let globalFiles: Record<string, string> | undefined
  try {
    globalFiles = await globalHookFiles(context)
  }
  catch { /* A modified dispatcher is not reported as protected. */ }
  const globalInstalled = global.stdout.trim() === globalHooksDirectory(context) && !!globalFiles
  const globalEffective = configured === globalHooksDirectory(context) && !!globalFiles
  let wrapper: string | undefined
  let scope: 'repository' | 'global' | undefined
  if (root && (configured === undefined || globalEffective)) {
    try {
      const hook = await repositoryHookPath(context)
      const state = JSON.parse(await readFile(`${hook}.yunbox.json`, 'utf8')) as HookState
      if (state.version === 1 && (await regularFile(hook)) && isExecutableMode((await lstat(hook)).mode) && await readFile(hook, 'utf8') === state.wrapper) {
        wrapper = state.wrapper
        scope = 'repository'
      }
    }
    catch { /* No intact repository wrapper. */ }
  }
  if (!wrapper && globalEffective) {
    wrapper = globalFiles?.['pre-push']
    scope = 'global'
  }
  const git = tools ? await detectGitVersion(context) : undefined
  const lfs = tools ? await detectGitLfsVersion(context) : undefined
  const major = Number(process.versions.node.split('.')[0])
  const nodeReady = major >= 26 || (major === 24 && compareVersions(process.versions.node, '24.11.0') >= 0) || (major === 22 && compareVersions(process.versions.node, '22.18.0') >= 0)
  return {
    version: 1,
    repository: !!root,
    hook: (wrapper ? wrapper.includes(' inspect --push --stdin ') ? 'inspect' : 'guard' : 'none') as 'inspect' | 'guard' | 'none',
    scope,
    confirm: !!wrapper?.includes(' --confirm'),
    globalInstalled,
    customPath: configured !== undefined && !globalEffective,
    ...(tools ? { node: process.versions.node, nodeReady, git, lfs, ready: nodeReady && !!git?.found && compareVersions(git.version, MIN_GIT_VERSION) >= 0 && !!lfs?.found && compareVersions(lfs.version, MIN_GIT_LFS_VERSION) >= 0 } : {}),
  }
}

async function regularFile(path: string): Promise<Stats | undefined> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile())
      throw new CliError('钩子路径包含符号链接或非普通文件，保留现状')
    return stat
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined
    throw error
  }
}

/**
 * Whether a file mode marks an executable. Windows has no execute bit (Node
 * never reports one); Git for Windows runs hooks and what they call through sh.
 */
function isExecutableMode(mode: number): boolean {
  return process.platform === 'win32' || (mode & 0o111) !== 0
}
