import type { CliContext } from './context.ts'
import type { GitResult } from './git.ts'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { hookStatus, repositoryHookPath, runHook } from './commands/hook.ts'
import { CliError } from './context.ts'
import { runGit, shellQuote } from './git.ts'
import { usesGlobalHooks } from './global-hooks.ts'
import { createLineReader } from './prompt.ts'
import { printStep } from './report.ts'

/** Enable optional push protection after storage setup, without changing an existing choice. */
export async function installInitHook(context: CliContext, options: { 'no-hook'?: boolean, 'global-hook'?: boolean, 'yes'?: boolean }): Promise<void> {
  if (options['no-hook']) {
    printStep(context, { status: 'skip', title: '推送保护', detail: '已跳过；以后运行 yunbox hook install 可启用超限询问' })
    return
  }
  const status = await hookStatus(context, false)
  if (status.hook !== 'none' && !options['global-hook']) {
    printStep(context, { status: 'pass', title: '推送保护', detail: '保留已安装的钩子及其确认方式' })
    return
  }
  if (context.stdin.isTTY && !options.yes && !options['global-hook']) {
    const ask = createLineReader(context)
    try {
      const answer = await ask('为当前仓库启用推送保护？超限时询问，关闭 App 后仍生效 [Y/n]：')
      if (answer === undefined || !['', 'y', 'yes'].includes(answer.trim().toLowerCase())) {
        printStep(context, { status: 'skip', title: '推送保护', detail: '以后运行 yunbox hook install 启用；所有仓库可选 hook install --global' })
        return
      }
    }
    finally { ask.close() }
  }
  try {
    await runHook(context, ['install', ...(options['global-hook'] ? ['--global'] : [])])
  }
  catch (error) {
    // Storage is already configured. Be explicit about the incomplete protection step.
    throw new CliError(`存储已配置，但推送保护未安装：${(error as Error).message}\n处理钩子冲突后运行 yunbox hook install；也可用 init --no-hook 仅配置存储`)
  }
}

/** Install LFS without replacing YunBox's dispatcher or an existing repository wrapper. */
export async function installLfsWithHooks(context: CliContext): Promise<GitResult> {
  const global = await usesGlobalHooks(context)
  const path = await repositoryHookPath(context)
  const status = await hookStatus(context, false)
  if (status.scope !== 'repository')
    return runGit(context, [...(global ? ['-c', `core.hooksPath=${dirname(path)}`] : []), 'lfs', 'install'])

  // Generate LFS's own scripts separately; never ask it to overwrite the wrapper.
  const temporary = await mkdtemp(join(tmpdir(), 'yunbox-lfs-hooks-'))
  try {
    const install = await runGit(context, ['-c', `core.hooksPath=${temporary}`, 'lfs', 'install'])
    if (install.code !== 0)
      return install
    const statePath = `${path}.yunbox.json`
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { version: number, wrapper: string, hadOriginal: boolean }
    const backup = `${path}.yunbox-original`
    if (state.hadOriginal && !(await readFile(backup, 'utf8')).includes('git lfs pre-push'))
      throw new CliError('原有 pre-push 钩子尚未接入 git-lfs；请按 git lfs update --manual 的说明串行接入，再重试初始化')
    if (!state.hadOriginal) {
      const original = await readFile(join(temporary, 'pre-push'), 'utf8')
      const wrapper = state.wrapper.replace(/\n[^\n]*\n$/, `\n${shellQuote(backup.replaceAll('\\', '/'))} "$@" <"$input"\n`)
      await writeFile(backup, original, { mode: 0o755, flag: 'wx' })
      try {
        await writeFile(path, wrapper, { mode: 0o755 })
        await writeFile(statePath, JSON.stringify({ ...state, hadOriginal: true, wrapper }), { mode: 0o600 })
      }
      catch (error) {
        await writeFile(path, state.wrapper, { mode: 0o755 })
        await rm(backup)
        throw error
      }
    }
    for (const name of await readdir(temporary)) {
      if (name === 'pre-push')
        continue
      await writeFile(join(dirname(path), name), await readFile(join(temporary, name)), { mode: 0o755, flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST')
          throw error
      })
    }
    return install
  }
  finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
