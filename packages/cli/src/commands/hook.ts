import type { Stats } from 'node:fs'
import type { CliContext } from '../context.ts'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { CliError, print } from '../context.ts'
import { findRepositoryRoot, readGitConfig, runGitChecked, shellQuote } from '../git.ts'

const MARKER = '# yunbox-pre-push-v1'

interface HookState {
  version: 1
  wrapper: string
  hadOriginal: boolean
}

export const hookHelp = `用法：yunbox hook install [--confirm | --guard <absolute-path>] | yunbox hook uninstall

安装串行 pre-push 包装层：检查通过后才执行原有钩子（包括 git-lfs 上传）。
原钩子保留在 pre-push.yunbox-original，uninstall 恢复它。不会修改已有 Git 提交。
默认调用当前已构建的 YunBox CLI，超限时阻止推送。
--confirm 超限时列出各文件的大小变化并询问是否继续（macOS 原生对话框，否则终端）。
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
  const { values } = parseArgs({ args: rest, options: { guard: { type: 'string' }, confirm: { type: 'boolean' } } })
  if (!['install', 'uninstall'].includes(operation!) || (operation === 'uninstall' && (values.guard || values.confirm)) || (values.guard && values.confirm))
    throw new CliError(hookHelp, 2)
  const root = await findRepositoryRoot(context)
  if (!root)
    throw new CliError('当前目录不在 Git 仓库里')
  const repo = { ...context, cwd: root }
  if (await readGitConfig(repo, 'core.hooksPath') !== undefined)
    throw new CliError('已有自定义 core.hooksPath，请在原钩子管理器中串行接入检查，不自动修改共享钩子')
  const hook = resolve(root, await runGitChecked(repo, ['rev-parse', '--git-path', 'hooks/pre-push']))
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
  const guard = values.guard
  let command: string
  if (guard !== undefined) {
    if (!isAbsolute(guard) || !(await regularFile(guard)))
      throw new CliError('--guard 必须指向已有的绝对路径可执行文件')
    const stat = await lstat(guard)
    if (!isExecutableMode(stat.mode))
      throw new CliError('--guard 文件不可执行')
    command = `WORKSTATION_YUNBOX_CHAIN=1 ${shellQuote(guard)} "$@"`
  }
  else {
    // Bundled CLI/index/chunks all live beside cli.mjs. Source-mode installation requires --guard.
    const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url))
    if (!(await regularFile(cli)))
      throw new CliError('请先构建并安装 YunBox CLI，或使用 --guard 指定检查程序')
    command = `${shellQuote(process.execPath)} ${shellQuote(cli)} inspect --push --stdin --remote "$2"${values.confirm ? ' --confirm' : ''}`
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
  print(context, '已安装 YunBox pre-push 包装层：检查通过后才执行原有钩子')
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
    if (await readGitConfig(repo, 'core.hooksPath') !== undefined)
      return 'none'
    const hook = resolve(root, await runGitChecked(repo, ['rev-parse', '--git-path', 'hooks/pre-push']))
    const state = JSON.parse(await readFile(`${hook}.yunbox.json`, 'utf8')) as HookState
    if (await readFile(hook, 'utf8') !== state.wrapper)
      return 'none'
    return state.wrapper.includes(' inspect --push --stdin ') ? 'inspect' : 'guard'
  }
  catch {
    return 'none'
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
