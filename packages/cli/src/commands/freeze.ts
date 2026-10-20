import type { CliContext } from '../context.ts'
import type { FreezeConfig } from '../freeze.ts'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { CliError, print, USAGE_EXIT_CODE } from '../context.ts'
import { LOCATION_FILE } from '../cos/location.ts'
import {
  activePauses,
  checkFreeze,
  formatFreezeBlock,
  formatPauseEnd,
  FREEZE_KEY,
  FREEZE_MESSAGE_KEY,
  FREEZE_PAUSE_KEY,
  FREEZE_TIME_ZONE_KEY,
  freezeTimeline,
  isValidTimeZone,
  parseDays,
  parseFreezeWindow,
  parseMoment,
  pauseEnd,
  readFreezeConfig,
  SCOPE_LABELS,
  weekdayLabel,
  withDays,
} from '../freeze.ts'
import { findRepositoryRoot, runGit, runGitChecked } from '../git.ts'
import { installedHook } from './hook.ts'

export const freezeHelp = `用法：
  yunbox freeze [list] [--json]
  yunbox freeze set <时段>... [--days <星期>] [--message <说明>] [--timezone <时区>] [--shared | --global]
  yunbox freeze clear [--shared | --global]
  yunbox freeze off [--for <时长> | --until "[星期] HH:MM"] [--global]
  yunbox freeze on [--global]
  yunbox freeze check [--at "[星期] HH:MM"] [--json]

设置禁推时段。处在任一时段内时，yunbox hook install 安装的 pre-push 包装层
直接中断推送并显示提示，不再检查体积，--confirm 也不能放行。

时段采用 OpenStreetMap opening_hours 写法（的子集），每个参数是一组规则：
  Mo-Fr 09:00-18:00                   工作日的工作时间
  Mo-Fr 09:00-12:00,14:00-18:00       一天里多个时段用逗号分隔
  Sa,Su                               只写星期表示全天；24/7 表示每天全天
  Fr 22:00-02:00                      跨过午夜，算在开始那天（周五夜里到周六 02:00）
  Mo-Fr 09:00-18:00; We off           多条规则用「;」分隔，后面的规则覆盖前面的同一天
  时段左闭右开：09:00-18:00 表示 09:00 起禁止、18:00 起允许。
  星期写 Mo Tu We Th Fr Sa Su，范围 Mo-Fr，列表 Sa,Su；也接受 weekdays / weekends / 工作日 / 周末。
  多个参数、多个位置的时段同时生效。暂不支持节假日（PH）。

保存位置：
  默认       本仓库 .git/config，只影响这份 clone
  --shared   仓库的 ${LOCATION_FILE}，提交后对整个团队生效
  --global   ~/.gitconfig，影响这台电脑上的所有仓库

子命令：
  list     列出所有生效的时段、说明和时区（默认）
  set      替换该位置的全部时段
  clear    删除该位置的全部时段、说明和时区
  off      快速关闭：所有时段暂不生效，规则保留；--for / --until 到点自动恢复，否则直到 on。
           默认只关本仓库，--global 关本机所有仓库；不能写进团队配置
  on       提前恢复（删除该位置的关闭）
  check    判断现在（或 --at 指定的本机时间）能否推送：退出码 0 可以，1 处于禁推时段

选项：
  --days <星期>       给没写星期的规则加上星期，例如 --days Mo-Fr
  --message <说明>    被拦截时显示的说明；"" 删除
  --timezone <时区>   按这个 IANA 时区计算该位置的时段，例如 Asia/Shanghai；"" 删除，改用本机时区。
                      团队成员不在同一时区时，给 --shared 的时段设上
  --for <时长>        off 的时长：30m、1h、1h30m、2d（最长 30 天）
  --until <时间>      off 到这个本机时间为止，例如 18:00、"Mo 09:00"；24:00 表示今天结束
  --json              list / check 输出 JSON（schemaVersion 1），便于脚本和 AI 工具读取
  -h, --help          显示帮助

例子：
  yunbox freeze set "Mo-Fr 09:00-18:00" --message "工作时间禁止推送，请在 18:00 后推送"
  yunbox freeze set "Fr 18:00-24:00; Sa,Su" --shared --timezone Asia/Shanghai
  yunbox freeze check --at "Fr 17:30"
  yunbox freeze off --for 1h            # 紧急修复：本仓库 1 小时内不拦截
  yunbox freeze off --global --until 24:00
`

type Scope = 'local' | 'shared' | 'global'

/** Run `yunbox freeze`: manage and check the windows in which pushes are blocked. */
export async function runFreeze(context: CliContext, args: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        days: { type: 'string' },
        message: { type: 'string' },
        timezone: { type: 'string' },
        shared: { type: 'boolean' },
        global: { type: 'boolean' },
        at: { type: 'string' },
        for: { type: 'string' },
        until: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  }
  catch (error) {
    throw new CliError(`${(error as Error).message}\n运行 yunbox freeze --help 查看用法`, USAGE_EXIT_CODE)
  }
  const { values, positionals } = parsed
  if (values.help) {
    context.stdout.write(freezeHelp)
    return 0
  }
  const [operation = 'list', ...rest] = positionals
  const usage = (message: string): CliError => new CliError(`${message}\n运行 yunbox freeze --help 查看用法`, USAGE_EXIT_CODE)
  const accepted: Record<string, string[]> = {
    list: ['json'],
    check: ['json', 'at'],
    set: ['days', 'message', 'timezone', 'shared', 'global'],
    clear: ['shared', 'global'],
    off: ['for', 'until', 'global'],
    on: ['global'],
  }
  if (!(operation in accepted))
    throw usage(`未知子命令：${operation}`)
  const extra = Object.keys(values).filter(name => !accepted[operation]!.includes(name))
  if (extra.length)
    throw usage(`${operation} 不接受 ${extra.map(name => `--${name}`).join('、')}`)
  if (values.shared && values.global)
    throw usage('--shared 和 --global 只能选一个')
  if (operation !== 'set' && rest.length)
    throw usage(`${operation} 不接受时段参数`)
  if (operation === 'set' && !rest.length)
    throw usage('请给出至少一个时段，例如 yunbox freeze set 10:00-12:00 14:00-18:00')

  if (values.for !== undefined && values.until !== undefined)
    throw usage('--for 和 --until 只能选一个')

  const root = await findRepositoryRoot(context)
  if (operation === 'off' || operation === 'on') {
    const scope: Scope = values.global ? 'global' : 'local'
    if (scope === 'local' && root === undefined)
      throw new CliError('当前目录不在 Git 仓库里；要关闭本机所有仓库的禁推时段请加 --global')
    const repo = { ...context, cwd: root ?? context.cwd }
    const target = await scopeArgs(scope, root, false)
    const now = new Date()
    if (operation === 'off') {
      let until: string | null = null
      try {
        if (values.for !== undefined || values.until !== undefined)
          until = pauseEnd({ for: values.for, until: values.until }, now).toISOString()
      }
      catch (error) {
        throw usage((error as Error).message)
      }
      await runGitChecked(repo, ['config', ...target, FREEZE_PAUSE_KEY, until ?? 'forever'])
      print(context, `已关闭禁推时段（${SCOPE_LABELS[scope]}），${until === null ? '直到运行 yunbox freeze on' : `${formatPauseEnd(until, now)} 自动恢复`}`)
      print(context, '规则都保留；关闭期间推送不会被拦截，pre-push 会提示一句')
    }
    else {
      await unsetAll(repo, target, FREEZE_PAUSE_KEY)
      print(context, `已恢复禁推时段（${SCOPE_LABELS[scope]}）`)
      const others = activePauses(await readConfig(repo, root), now)
      for (const pause of others)
        print(context, `注意：${SCOPE_LABELS[pause.scope]} 仍然关闭，${formatPauseEnd(pause.until, now)}；用 yunbox freeze on${pause.scope === 'global' ? ' --global' : ''} 恢复`)
    }
    return 0
  }
  if (operation === 'set' || operation === 'clear') {
    const scope: Scope = values.shared ? 'shared' : values.global ? 'global' : 'local'
    if (scope !== 'global' && root === undefined)
      throw new CliError('当前目录不在 Git 仓库里；要对这台电脑上的所有仓库生效请加 --global')
    const repo = { ...context, cwd: root ?? context.cwd }
    if (operation === 'set') {
      let windows: string[]
      try {
        const days = values.days === undefined ? undefined : parseDays(values.days)
        windows = rest.map(text => withDays(parseFreezeWindow(text), days).window)
      }
      catch (error) {
        throw usage((error as Error).message)
      }
      if (values.timezone && !isValidTimeZone(values.timezone))
        throw usage(`「${values.timezone}」不是有效的 IANA 时区，例如 Asia/Shanghai`)
      const target = await scopeArgs(scope, root, true)
      await unsetAll(repo, target, FREEZE_KEY)
      for (const window of windows)
        await runGitChecked(repo, ['config', ...target, '--add', FREEZE_KEY, window])
      await setOrUnset(repo, target, FREEZE_MESSAGE_KEY, values.message)
      await setOrUnset(repo, target, FREEZE_TIME_ZONE_KEY, values.timezone)
      print(context, `已设置禁推时段（${SCOPE_LABELS[scope]}）：${windows.join('、')}`)
    }
    else {
      const target = await scopeArgs(scope, root, false)
      const keys = [FREEZE_KEY, FREEZE_MESSAGE_KEY, FREEZE_TIME_ZONE_KEY, ...(scope === 'shared' ? [] : [FREEZE_PAUSE_KEY])]
      for (const key of keys)
        await unsetAll(repo, target, key)
      print(context, `已清除禁推时段（${SCOPE_LABELS[scope]}）`)
    }
    printList(context, await readConfig(repo, root))
    if (scope === 'shared')
      print(context, `提交 ${LOCATION_FILE} 后对团队生效：git add ${LOCATION_FILE} && git commit`)
    if (operation === 'set' && root !== undefined) {
      const hook = await installedHook(context, root)
      if (hook === 'none')
        print(context, '提示：拦截推送需要 pre-push 包装层，在每份 clone 里运行 yunbox hook install')
      else if (hook === 'guard')
        print(context, '提示：当前包装层使用 --guard，不会检查禁推时段；改用 yunbox hook install，或让 guard 先运行 yunbox freeze check')
    }
    return 0
  }

  const repo = { ...context, cwd: root ?? context.cwd }
  const config = await readConfig(repo, root)
  if (operation === 'list') {
    if (values.json) {
      const now = new Date()
      context.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        windows: config.windows.map(({ window, scope }) => ({ window, scope, ...(config.timeZones[scope] ? { timeZone: config.timeZones[scope] } : {}) })),
        messages: config.messages,
        // What a pre-push would see right now, and whether this clone's wrapper enforces it.
        check: checkFreeze(config, now),
        week: freezeTimeline(config, now),
        pauses: activePauses(config, now),
        hook: root === undefined ? null : await installedHook(context, root),
      })}\n`)
    }
    else {
      printList(context, config)
    }
    return 0
  }
  let moment: Date
  try {
    moment = values.at === undefined ? new Date() : parseMoment(values.at)
  }
  catch (error) {
    throw usage((error as Error).message)
  }
  const check = checkFreeze(config, moment)
  if (values.json)
    context.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...check })}\n`)
  else if (check.status === 'frozen')
    context.stdout.write(formatFreezeBlock(check))
  else if (check.status === 'paused')
    print(context, `${weekdayLabel(check.weekday)} ${check.time} 可以推送：禁推时段已关闭（${SCOPE_LABELS[check.pause!.scope]}，${formatPauseEnd(check.pause!.until, moment)}），${check.window} 暂不生效`)
  else
    print(context, `${weekdayLabel(check.weekday)} ${check.time} 可以推送`)
  return check.status === 'frozen' ? 1 : 0
}

async function readConfig(context: CliContext, root: string | undefined): Promise<FreezeConfig> {
  try {
    return await readFreezeConfig(context, root)
  }
  catch (error) {
    throw new CliError((error as Error).message, USAGE_EXIT_CODE)
  }
}

function printList(context: CliContext, config: FreezeConfig): void {
  const now = new Date()
  for (const pause of activePauses(config, now))
    print(context, `已关闭（${SCOPE_LABELS[pause.scope]}）：${formatPauseEnd(pause.until, now)}，期间不拦截推送`)
  if (!config.windows.length) {
    print(context, '没有设置禁推时段')
    return
  }
  print(context, '禁推时段：')
  for (const { window, scope } of config.windows)
    print(context, `  ${window}  ${SCOPE_LABELS[scope]}  ${config.timeZones[scope] ?? '本机时区'}`)
  for (const [scope, message] of Object.entries(config.messages))
    print(context, `说明（${SCOPE_LABELS[scope as keyof typeof SCOPE_LABELS]}）：${message}`)
}

async function scopeArgs(scope: Scope, root: string | undefined, create: boolean): Promise<string[]> {
  if (scope === 'global')
    return ['--global']
  if (scope === 'local')
    return ['--local']
  const file = join(root!, LOCATION_FILE)
  if (create)
    await mkdir(dirname(file), { recursive: true })
  return ['--file', file]
}

/** Leave the key alone when `value` is undefined, remove it when empty, else set it. */
async function setOrUnset(context: CliContext, target: string[], key: string, value: string | undefined): Promise<void> {
  if (value === '')
    await unsetAll(context, target, key)
  else if (value !== undefined)
    await runGitChecked(context, ['config', ...target, key, value])
}

async function unsetAll(context: CliContext, target: string[], key: string): Promise<void> {
  const result = await runGit(context, ['config', ...target, '--unset-all', key])
  // Exit 5 means there was nothing to remove.
  if (result.code !== 0 && result.code !== 5)
    throw new CliError(`无法修改 Git 配置 ${key}：${result.stderr.trim() || `退出码 ${result.code ?? '未知'}`}`)
}
