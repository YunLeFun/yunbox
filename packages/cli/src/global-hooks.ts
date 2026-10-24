import type { CliContext } from './context.ts'
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { CliError, print } from './context.ts'
import { configDirectory } from './cos/secret-store.ts'
import { readGitConfig, runGit, runGitChecked } from './git.ts'

// Forward the standard Git hooks to the repository, including LFS checkout hooks.
const EVENTS = ['applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge', 'pre-push', 'pre-receive', 'update', 'proc-receive', 'post-receive', 'post-update', 'reference-transaction', 'push-to-checkout', 'pre-auto-gc', 'post-rewrite', 'sendemail-validate', 'fsmonitor-watchman', 'p4-changelist', 'p4-prepare-changelist', 'p4-post-changelist', 'p4-pre-submit', 'post-index-change']
const MANIFEST = 'yunbox-hooks.json'

/** Directory owned exclusively by YunBox's optional global hook dispatcher. */
export function globalHooksDirectory(context: CliContext): string {
  return resolve(configDirectory(context.env), 'hooks')
}

/** Read and verify every owned file before using, replacing or removing global hooks. */
export async function globalHookFiles(context: CliContext): Promise<Record<string, string> | undefined> {
  const directory = globalHooksDirectory(context)
  try {
    if (!(await lstat(directory)).isDirectory())
      throw new Error('not a directory')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return undefined
    throw new CliError('全局钩子目录不是普通目录，保留现状')
  }
  try {
    if (!(await lstat(join(directory, MANIFEST))).isFile())
      throw new Error('not a file')
    const state = JSON.parse(await readFile(join(directory, MANIFEST), 'utf8')) as { version: number, files: Record<string, string> }
    if (state.version !== 1 || Object.keys(state.files).sort().join() !== [...EVENTS].sort().join())
      throw new Error('invalid manifest')
    if ((await readdir(directory)).sort().join() !== [...EVENTS, MANIFEST].sort().join())
      throw new Error('unexpected files')
    for (const name of EVENTS) {
      const stat = await lstat(join(directory, name))
      if (!stat.isFile() || ((stat.mode & 0o111) === 0 && process.platform !== 'win32') || await readFile(join(directory, name), 'utf8') !== state.files[name])
        throw new Error('modified hook')
    }
    return state.files
  }
  catch {
    throw new CliError('全局 YunBox 钩子或登记文件已被修改，保留现状；请检查钩子目录')
  }
}

/** Whether the current repository actually uses YunBox's intact global dispatcher. */
export async function usesGlobalHooks(context: CliContext): Promise<boolean> {
  return await readGitConfig(context, 'core.hooksPath') === globalHooksDirectory(context) && !!await globalHookFiles(context)
}

/** Install/uninstall the opt-in global dispatcher without replacing any other hook manager. */
export async function manageGlobalHooks(context: CliContext, operation: string, command?: string): Promise<number> {
  const directory = globalHooksDirectory(context)
  const configured = await runGit(context, ['config', '--global', '--get-all', 'core.hooksPath'])
  const values = configured.code === 1 ? [] : configured.stdout.trimEnd().split('\n')
  if (configured.code !== 0 && configured.code !== 1)
    throw new CliError('无法读取全局 Git 配置')
  if (values.length > 1 || (values.length === 1 && values[0] !== directory))
    throw new CliError('已有自定义全局 core.hooksPath，保留现状；请在原钩子管理器中串行接入 YunBox')
  // A system-level manager must not be silently masked either.
  const system = await runGit(context, ['config', '--system', '--get', 'core.hooksPath'])
  if (operation === 'install' && system.code === 0)
    throw new CliError('已有系统级 core.hooksPath，保留现状；请在原钩子管理器中串行接入 YunBox')
  const previous = await globalHookFiles(context)
  if (operation === 'uninstall') {
    if (values.length)
      await runGitChecked(context, ['config', '--global', '--unset-all', 'core.hooksPath'])
    if (previous)
      await rm(directory, { recursive: true })
    print(context, '已移除全局推送检查，仓库原有钩子保持不变')
    return 0
  }
  const files = Object.fromEntries(EVENTS.map(event => [event, globalWrapper(event, command!)]))
  await mkdir(dirname(directory), { recursive: true })
  const staging = await mkdtemp(join(dirname(directory), '.hooks-'))
  const backup = `${staging}-previous`
  let saved = false
  let installed = false
  let committed = false
  try {
    for (const [name, content] of Object.entries(files))
      await writeFile(join(staging, name), content, { mode: 0o755, flag: 'wx' })
    await writeFile(join(staging, MANIFEST), JSON.stringify({ version: 1, files }), { mode: 0o600, flag: 'wx' })
    if (previous) {
      await rename(directory, backup)
      saved = true
    }
    await rename(staging, directory)
    installed = true
    await runGitChecked(context, ['config', '--global', 'core.hooksPath', directory])
    committed = true
  }
  catch (error) {
    if (installed)
      await rm(directory, { recursive: true })
    if (saved)
      await rename(backup, directory)
    saved = false
    throw error
  }
  finally {
    await rm(staging, { recursive: true, force: true })
    if (committed && saved)
      await rm(backup, { recursive: true, force: true })
  }
  print(context, '已启用全局推送检查：检查通过后才执行仓库原有钩子；仓库自定义 core.hooksPath 会覆盖全局设置')
  return 0
}

function globalWrapper(event: string, command: string): string {
  const head = `#!/bin/sh
${event === 'pre-push' ? '# yunbox-pre-push-v1' : '# yunbox-global-hooks-v1'}
set -eu
common=$(git rev-parse --git-common-dir)
original="$common/hooks/${event}"
`
  if (event !== 'pre-push')
    return `${head}[ ! -x "$original" ] || exec "$original" "$@"\n${event === 'fsmonitor-watchman' ? 'exit 1\n' : ''}`
  return `${head}# A repository wrapper already owns the check and the upload chain.
if [ -x "$original" ] && [ "$(sed -n '2p' "$original")" = '# yunbox-pre-push-v1' ]; then
  exec "$original" "$@"
fi
input=$(mktemp "\${TMPDIR:-/tmp}/yunbox-pre-push.XXXXXX")
trap 'rm -f "$input"' EXIT HUP INT TERM
cat >"$input"
${command} <"$input" || exit $?
if [ -x "$original" ]; then "$original" "$@" <"$input"; fi
`
}
