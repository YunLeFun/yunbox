import type { CliContext } from './context.ts'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { CliError, print } from './context.ts'
import { readGitConfig, runGit, runGitChecked, shellQuote } from './git.ts'
import { GIT_HOOK_EVENTS, globalHooksDirectory } from './global-hooks.ts'

const MANIFEST = 'yunbox-hooks.json'
const MARKER = '# yunbox-compatible-hooks-v1'
type ConfigScope = 'local' | 'worktree'

interface CompatibilityState {
  version: 1
  configScope: ConfigScope
  previousValues: string[]
  originalPath: string
  files: Record<string, string>
}

/** Diagnostics remain available even when a hook manager replaces core.hooksPath. */
export interface CompatibilityStatus {
  registered: boolean
  state: 'active' | 'overridden' | 'modified' | 'pending' | 'missing'
  originalPath?: string
  missing?: 'dependencies' | 'directory'
}

/** Resolve the local dispatcher, honoring Git's optional per-worktree configuration. */
export async function compatibilityLocation(context: CliContext): Promise<{ directory: string, configScope: ConfigScope }> {
  const perWorktree = await readGitConfig(context, 'extensions.worktreeConfig') === 'true'
  const [gitDir, commonDir] = await Promise.all([
    runGitChecked(context, ['rev-parse', '--git-dir']),
    runGitChecked(context, ['rev-parse', '--git-common-dir']),
  ])
  const worktreeDirectory = resolve(context.cwd, gitDir, 'yunbox-worktree-hooks')
  const sharedDirectory = resolve(context.cwd, commonDir, 'yunbox-hooks')
  // Keep finding an existing registration if worktreeConfig was toggled later.
  if (await exists(worktreeDirectory))
    return { directory: worktreeDirectory, configScope: perWorktree ? 'worktree' : 'local' }
  if (await exists(sharedDirectory))
    return { directory: sharedDirectory, configScope: 'local' }
  return { directory: perWorktree ? worktreeDirectory : sharedDirectory, configScope: perWorktree ? 'worktree' : 'local' }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return false
    throw error
  }
}

async function readState(directory: string): Promise<CompatibilityState | undefined> {
  if (!await exists(directory))
    return undefined
  try {
    if (!(await lstat(directory)).isDirectory() || !(await lstat(join(directory, MANIFEST))).isFile())
      throw new Error('invalid directory')
    const state = JSON.parse(await readFile(join(directory, MANIFEST), 'utf8')) as CompatibilityState
    if (state.version !== 1 || !['local', 'worktree'].includes(state.configScope) || !Array.isArray(state.previousValues) || !state.previousValues.every(value => typeof value === 'string') || typeof state.originalPath !== 'string' || !state.originalPath || Object.keys(state.files).sort().join() !== [...GIT_HOOK_EVENTS].sort().join())
      throw new Error('invalid manifest')
    if ((await readdir(directory)).sort().join() !== [...GIT_HOOK_EVENTS, MANIFEST].sort().join())
      throw new Error('unexpected files')
    for (const event of GIT_HOOK_EVENTS) {
      const path = join(directory, event)
      const info = await lstat(path)
      if (!info.isFile() || (process.platform !== 'win32' && !(info.mode & 0o111)) || typeof state.files[event] !== 'string' || await readFile(path, 'utf8') !== state.files[event])
        throw new Error('modified hook')
    }
    return state
  }
  catch {
    throw new CliError('本机兼容调度器或登记文件已被修改，保留现状；请检查 Git 元数据目录中的 yunbox-hooks')
  }
}

async function pathValue(context: CliContext): Promise<string | undefined> {
  const result = await runGit(context, ['config', '--path', '--get', 'core.hooksPath'])
  if (result.code === 1)
    return undefined
  if (result.code !== 0)
    throw new CliError('无法读取钩子目录配置')
  return result.stdout.replace(/\r?\n$/, '')
}

async function configValues(context: CliContext, scope: ConfigScope): Promise<string[]> {
  const result = await runGit(context, ['config', `--${scope}`, '--no-includes', '--null', '--get-all', 'core.hooksPath'])
  if (result.code === 1)
    return []
  if (result.code !== 0)
    throw new CliError('无法读取本机钩子配置')
  return result.stdout.slice(0, -1).split('\0')
}

async function restoreValues(context: CliContext, scope: ConfigScope, values: string[]): Promise<void> {
  const removed = await runGit(context, ['config', `--${scope}`, '--unset-all', 'core.hooksPath'])
  if (removed.code !== 0 && removed.code !== 5)
    throw new CliError('无法恢复本机钩子配置')
  for (const value of values)
    await runGitChecked(context, ['config', `--${scope}`, '--add', 'core.hooksPath', value])
}

async function missingDirectory(context: CliContext, path: string): Promise<CompatibilityStatus['missing']> {
  try {
    if ((await stat(resolve(context.cwd, path))).isDirectory())
      return undefined
  }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      throw error
  }
  // This is a recovery hint, never a claim that a missing path is safe to discard.
  return /(?:^|[/\\])(?:\.husky|node_modules)(?:[/\\]|$)/.test(path) ? 'dependencies' : 'directory'
}

function missingMessage(missing: CompatibilityStatus['missing']): string {
  return missing === 'dependencies'
    ? '原钩子目录不存在，可能尚未安装项目依赖；请安装依赖并重建钩子后重试。确认是遗留配置可运行 yunbox hook clear-missing'
    : '原钩子目录不存在；请恢复项目钩子目录，确认是遗留配置可运行 yunbox hook clear-missing'
}

/** Return compatibility ownership and health; missing original directories fail closed. */
export async function compatibilityStatus(context: CliContext): Promise<{ compatibility?: CompatibilityStatus, wrapper?: string }> {
  const { directory } = await compatibilityLocation(context)
  const configured = await pathValue(context)
  let state: CompatibilityState | undefined
  try {
    state = await readState(directory)
  }
  catch { return { compatibility: { registered: true, state: 'modified' } } }
  if (state) {
    const missing = await missingDirectory(context, state.originalPath)
    const active = configured === directory
    let effectiveWrapper: string | undefined = state.files['pre-push']
    if (active && !missing) {
      const original = resolve(context.cwd, state.originalPath, 'pre-push')
      const info = await stat(original).catch(() => undefined)
      const text = info?.isFile() && (process.platform === 'win32' || (info.mode & 0o111)) ? await readFile(original, 'utf8') : undefined
      if (text?.split('\n')[1] === '# yunbox-pre-push-v1') {
        const saved = await readFile(`${original}.yunbox.json`, 'utf8').then(text => JSON.parse(text) as { wrapper?: string }).catch(() => ({} as { wrapper?: string }))
        // The original repository wrapper is authoritative, just like in global mode.
        effectiveWrapper = saved?.wrapper === text ? text : undefined
      }
    }
    return {
      compatibility: { registered: true, state: active ? missing ? 'missing' : 'active' : 'overridden', originalPath: state.originalPath, ...(missing ? { missing } : {}) },
      ...(active && !missing ? { wrapper: effectiveWrapper } : {}),
    }
  }
  if (configured !== undefined && configured !== globalHooksDirectory(context)) {
    const missing = await missingDirectory(context, configured)
    return { compatibility: { registered: false, state: missing ? 'missing' : 'pending', originalPath: configured, ...(missing ? { missing } : {}) } }
  }
  return {}
}

function wrapper(event: string, originalPath: string, command: string): string {
  // Keep relative paths relative to Git's hook cwd, including linked worktrees.
  const head = `#!/bin/sh
${MARKER}
set -eu
original_dir=${shellQuote(originalPath.replaceAll('\\', '/'))}
if [ ! -d "$original_dir" ]; then
  echo 'YunBox: 原钩子目录不存在，请恢复依赖或钩子目录后重试（yunbox hook status）。' >&2
  exit 1
fi
original="$original_dir/${event}"
`
  if (event !== 'pre-push')
    return `${head}if [ -x "$original" ]; then exec "$original" "$@"; fi\nexit ${event === 'fsmonitor-watchman' ? 1 : 0}\n`
  return `${head}# An existing YunBox repository wrapper already owns this serial chain.
if [ -x "$original" ] && [ "$(sed -n '2p' "$original")" = '# yunbox-pre-push-v1' ]; then
  exec "$original" "$@"
fi
input=$(mktemp "\${TMPDIR:-/tmp}/yunbox-pre-push.XXXXXX")
trap 'rm -f "$input"' EXIT
trap 'exit 1' HUP INT TERM
cat >"$input"
${command} <"$input" || exit $?
if [ -x "$original" ]; then "$original" "$@" <"$input"; fi
`
}

/** Install, explicitly repair, or remove a local dispatcher without editing team hooks. */
export async function manageCompatibilityHooks(context: CliContext, operation: string, command?: string): Promise<number> {
  const { directory, configScope } = await compatibilityLocation(context)
  // Serialize mutations; never guess whether another install's lock is stale.
  const lock = `${directory}.lock`
  try {
    await mkdir(lock)
  }
  catch { throw new CliError('兼容接入正在修改或上次操作留下锁目录，请确认后重试') }
  try {
    const previous = await readState(directory)
    if (previous && previous.configScope !== configScope)
      throw new CliError('worktree 配置范围已变化，请先恢复原配置范围后卸载兼容接入')
    const configured = await pathValue(context)
    const values = await configValues(context, configScope)
    const ownsConfig = values.length === 1 && values[0] === directory
    if (operation === 'uninstall') {
      if (!previous)
        throw new CliError('未找到本机兼容接入登记')
      if (ownsConfig)
        await restoreValues(context, configScope, previous.previousValues)
      // Retain files if a later config still references them (e.g. an include).
      const remaining = await pathValue(context)
      if (remaining !== undefined && (remaining === directory || await realpath(resolve(context.cwd, remaining)).catch(() => '') === await realpath(directory)))
        throw new CliError('其他配置仍引用本机调度器，已保留文件；请移除该引用后重试卸载')
      await rm(directory, { recursive: true })
      print(context, ownsConfig ? '已移除兼容接入并恢复原本机钩子配置' : '已移除兼容接入；保留后来修改的钩子配置')
      return 0
    }
    if (operation === 'clear-missing') {
      if (previous)
        throw new CliError('请先运行 yunbox hook uninstall 恢复原配置，再清理失效目录配置')
      if (configured === undefined || !await missingDirectory(context, configured))
        throw new CliError('当前钩子目录存在，没有可清理的失效配置')
      const effectiveRaw = await readGitConfig(context, 'core.hooksPath')
      if (values.length !== 1 || values[0] !== effectiveRaw)
        throw new CliError('失效目录来自继承配置或有多条配置，请在其来源中手动清理')
      await restoreValues(context, configScope, [])
      print(context, '已清理本机失效钩子目录配置；请运行 yunbox hook status 查看实际保护状态')
      return 0
    }
    if (previous && configured !== directory && operation !== 'repair')
      throw new CliError('保护已被覆盖；运行 yunbox hook repair 接入当前钩子目录，或 hook uninstall 保留当前配置并移除兼容接入')
    if (!previous && operation === 'repair')
      throw new CliError('尚未兼容接入，请运行 yunbox hook install --compatible')
    const keepOriginal = !!previous && configured === directory
    const originalPath = keepOriginal ? previous.originalPath : configured
    if (!originalPath || originalPath === globalHooksDirectory(context) || resolve(context.cwd, originalPath) === directory)
      throw new CliError('兼容接入需要已有的自定义钩子目录；普通仓库请使用 hook install 或 hook install --global')
    const missing = await missingDirectory(context, originalPath)
    if (missing)
      throw new CliError(missingMessage(missing))
    if (await realpath(resolve(context.cwd, originalPath)) === await realpath(directory).catch(() => directory))
      throw new CliError('原钩子目录指向 YunBox 调度器，拒绝递归接入')
    const original = join(resolve(context.cwd, originalPath), 'pre-push')
    if (await exists(original) && (await readFile(original, 'utf8')).includes(MARKER))
      throw new CliError('原目录已有兼容调度器，拒绝重复嵌套')
    const files = Object.fromEntries(GIT_HOOK_EVENTS.map(event => [event, wrapper(event, originalPath, command!)]))
    const next: CompatibilityState = {
      version: 1,
      configScope,
      previousValues: keepOriginal || ownsConfig ? previous!.previousValues : values,
      originalPath,
      files,
    }
    const staging = await mkdtemp(join(dirname(directory), '.yunbox-hooks-'))
    const backup = `${staging}-previous`
    let saved = false
    let installed = false
    let configuredNew = false
    let committed = false
    try {
      for (const [event, content] of Object.entries(files))
        await writeFile(join(staging, event), content, { mode: 0o755, flag: 'wx' })
      await writeFile(join(staging, MANIFEST), JSON.stringify(next), { mode: 0o600, flag: 'wx' })
      if (previous) {
        await rename(directory, backup)
        saved = true
      }
      await rename(staging, directory)
      installed = true
      await runGitChecked(context, ['config', `--${configScope}`, '--replace-all', 'core.hooksPath', directory])
      configuredNew = true
      if (await pathValue(context) !== directory)
        throw new CliError('更高优先级的 Git 配置覆盖了兼容接入，请在其来源中处理')
      committed = true
    }
    catch (error) {
      if (configuredNew)
        await restoreValues(context, configScope, values)
      if (installed)
        await rm(directory, { recursive: true })
      if (saved) {
        await rename(backup, directory)
        saved = false
      }
      throw error
    }
    finally {
      await rm(staging, { recursive: true, force: true })
      if (committed && saved)
        await rm(backup, { recursive: true, force: true })
    }
    print(context, '已启用本机兼容接入：检查通过后运行原 pre-push，其他钩子转发到原目录；安装依赖后可用 hook status 检查是否被覆盖')
    return 0
  }
  finally { await rm(lock, { recursive: true }) }
}
