import type { CliContext } from '../context.ts'
import { isAbsolute, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { CliError, print } from '../context.ts'
import { findRepositoryRoot } from '../git.ts'
import { clearPushHistory, PUSH_HISTORY_POLICY, pushHistoryPath, pushHistoryProjectKey, readPushHistory } from '../push-history.ts'

export const historyHelp = `用法：yunbox history [--all] [--json]
      yunbox history clear [--all] --yes

查看当前项目的推送保护历史；--all 查看本机所有项目。
--project <绝对路径> 选择指定项目（目录已删除时仍可查看和清理历史）。
记录禁推、超限阻止、用户取消和用户确认继续，不代表后续 Git 上传成功。
仅保存在本机，保留最近 90 天、每项目最多 200 条、全部最多 5000 条。
clear 清理当前项目；--all 清理全部。必须加 --yes，不修改钩子、素材、密钥或 Git 配置。
`

/** Inspect or clear local push protection history; `--all` also works outside a repository. */
export async function runHistory(context: CliContext, args: string[]): Promise<number> {
  const clear = args[0] === 'clear'
  const { values } = parseArgs({ args: clear ? args.slice(1) : args, options: {
    all: { type: 'boolean' },
    project: { type: 'string' },
    json: { type: 'boolean' },
    yes: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } })
  if (values.help) {
    context.stdout.write(historyHelp)
    return 0
  }
  if (values.project !== undefined && (values.all || !isAbsolute(values.project)))
    throw new CliError('--project 需要绝对路径，且不能与 --all 一起使用', 2)
  const root = values.all ? undefined : values.project !== undefined ? resolve(values.project) : await findRepositoryRoot(context)
  if (!values.all && !root)
    throw new CliError('请进入项目目录，或使用 --all 查看或清理全部项目历史')
  if (clear) {
    if (!values.yes)
      throw new CliError(`清理历史需要显式确认：yunbox history clear${values.all ? ' --all' : ''} --yes`, 2)
    await clearPushHistory(context.env, root)
  }
  const entries = (await readPushHistory(context.env)).filter(entry => !root || pushHistoryProjectKey(entry.root) === pushHistoryProjectKey(root))
  if (values.json) {
    print(context, JSON.stringify({ version: 1, entries, retention: PUSH_HISTORY_POLICY, file: pushHistoryPath(context.env) }))
  }
  else if (clear) {
    print(context, values.all ? '已清理全部本机推送历史' : '已清理当前项目的本机推送历史')
  }
  else {
    const outcomes = { blocked: '已阻止', cancelled: '用户取消', continued: '已确认继续' }
    print(context, entries.length ? entries.map(entry => [entry.at, entry.root, outcomes[entry.outcome], entry.summary, entry.note].filter(Boolean).join(' · ')).join('\n') : '没有推送保护历史')
  }
  return 0
}
