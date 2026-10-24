import type { ConfirmUi, PushAnswer } from '../confirm.ts'
import type { CliContext } from '../context.ts'
import { Buffer } from 'node:buffer'
import { parseArgs } from 'node:util'
import { recordBlockedPush } from '../blocked-pushes.ts'
import { askPush } from '../confirm.ts'
import { checkFreeze, formatFreezeBlock, formatPauseEnd, readFreezeConfig, SCOPE_LABELS } from '../freeze.ts'
import { inspectGit, InspectionError, resolveInspectionRange } from '../inspect-git.ts'
import { exceededReasons, formatInspection, inspectPush } from '../inspect.ts'
import { describePush } from '../push-context.ts'
import { recordPushHistory } from '../push-history.ts'
import { terminalFor } from '../terminal.ts'
import { readTransferSummary } from '../transfer-summary.ts'

export const inspectHelp = `用法：yunbox inspect --push [选项]

本地检查 Git pack 和 LFS 候选上传量，列出大文件；不上传、不修改仓库，无需 YunBox 服务或 git-lfs。
默认比较 HEAD 与本地 upstream；没有 upstream 时扫描 HEAD 的全部历史。

选项：
  --push              检查待推送的已提交内容
  --base <ref>        指定已存在的基准引用
  --head <ref>        指定待推送引用（默认 HEAD）
  --stdin             从 stdin 读取 Git pre-push 的引用更新，支持多个分支和删除；
                      处在禁推时段（yunbox freeze）时直接中断，退出码 1；
                      保护决定（含确认继续）记入本机配置目录的 push-history.json
  --remote <name/url>  新分支或旧 tip 缺失时，查询远端 Git refs 以改进 pack 估算
  --git-limit <size>  Git pack 限额（默认 900k）
  --lfs-limit <size>  LFS 候选总量限额（默认 100m）
  --file-limit <size> 单文件原始大小限额（默认 10m，适用于 Git 和 LFS）
  --top <number>      文本排行条数（默认 10）；JSON 始终包含全部明细
  --json              输出 schemaVersion=1 的 JSON，包括错误
  --confirm           超限时询问是否继续（macOS 原生对话框，否则终端）；确认后退出码为 0
                      可附一句原因（对话框底部，或终端里写在 y / n 后面），会写进输出
  --confirm-ui <mode> 配合 --confirm，选择 auto / dialog / terminal / none
  -h, --help          显示帮助

size 支持字节及 k/m/g、KiB/MiB/GiB（1024 进制）。退出码：0 未超限，1 超限，2 检查失败。
Git 配置：yunbox.inspectGitBytes / yunbox.inspectLfsBytes / yunbox.inspectFileBytes；命令行优先。
确认界面：--confirm-ui > YUNBOX_CONFIRM_UI > git config yunbox.confirmUI > auto。
macOS 可选原生对话框或纯终端；Windows / Linux 使用控制终端。NO_COLOR=1 关闭颜色。
直连对象存储（COS 或 S3）的仓库在本机有密钥时，用 HEAD 查询 LFS 候选是否已在存储里（并发 8，共 5 秒），
已有的不计入上传量；查询失败或超时时上传量按未知处理，不影响推送。其他情况下 LFS 候选量
不等于实际上传量，远端已有对象可能跳过。YUNBOX_INSPECT_REMOTE_TIMEOUT_MS=0 关闭查询。
`

/** CLI entry for the versioned push inspection contract. */
export async function runInspect(context: CliContext, args: string[]): Promise<number> {
  const json = args.includes('--json')
  try {
    const { values } = parseArgs({ args, options: {
      'push': { type: 'boolean' },
      'stdin': { type: 'boolean' },
      'base': { type: 'string' },
      'head': { type: 'string' },
      'remote': { type: 'string' },
      'git-limit': { type: 'string' },
      'lfs-limit': { type: 'string' },
      'file-limit': { type: 'string' },
      'top': { type: 'string' },
      'json': { type: 'boolean' },
      'confirm': { type: 'boolean' },
      'confirm-ui': { type: 'string' },
      'help': { type: 'boolean', short: 'h' },
    } })
    if (values.help) {
      context.stdout.write(inspectHelp)
      return 0
    }
    if (!values.push || (values.stdin && (values.base !== undefined || values.head !== undefined)))
      throw new InspectionError('请指定 --push；--stdin 不能与 --base / --head 同时使用')
    if (values.confirm && json)
      throw new InspectionError('--confirm 不能与 --json 同时使用')
    if (values['confirm-ui'] !== undefined && (!values.confirm || !['auto', 'dialog', 'terminal', 'none'].includes(values['confirm-ui'])))
      throw new InspectionError('--confirm-ui 需配合 --confirm，且只能是 auto / dialog / terminal / none')
    if (values.remote?.startsWith('-') || values.remote === '')
      throw new InspectionError('无效的远端名称')
    const top = Number(values.top ?? '10')
    if (!Number.isSafeInteger(top) || top < 1 || top > 100)
      throw new InspectionError('--top 必须是 1–100 的整数')
    const root = await inspectGit(context, ['rev-parse', '--show-toplevel'])
    const repo = { ...context, cwd: root.output.toString('utf8').replace(/\r?\n$/, '') }
    // --stdin means Git is pushing right now: a freeze window blocks before any size check.
    if (values.stdin) {
      let freeze
      try {
        freeze = checkFreeze(await readFreezeConfig(repo, repo.cwd), new Date())
      }
      catch (error) {
        throw new InspectionError(error instanceof TypeError ? error.message : '无法读取禁推时段配置')
      }
      if (freeze.status === 'paused' && !json)
        context.stderr.write(`禁推时段已关闭（${SCOPE_LABELS[freeze.pause!.scope]}，${formatPauseEnd(freeze.pause!.until, new Date())}），本次推送不受 ${freeze.window} 限制。\n`)
      if (freeze.status === 'frozen') {
        await recordBlockedPush(context.env, { root: repo.cwd, at: new Date().toISOString(), reason: 'freeze', summary: `禁推时段 ${freeze.window}（${SCOPE_LABELS[freeze.scope!]}）` })
        if (json)
          context.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: 'frozen', freeze })}\n`)
        else
          context.stderr.write(formatFreezeBlock(freeze))
        return 1
      }
    }
    const limits = {
      gitBytes: await readLimit(repo, values['git-limit'], 'yunbox.inspectGitBytes', 900 * 1024),
      lfsBytes: await readLimit(repo, values['lfs-limit'], 'yunbox.inspectLfsBytes', 100 * 1024 * 1024),
      fileBytes: await readLimit(repo, values['file-limit'], 'yunbox.inspectFileBytes', 10 * 1024 * 1024),
    }
    const updates = values.stdin ? await readUpdates(context) : undefined
    const range = await resolveInspectionRange(repo, { updates, base: values.base, head: values.head, remote: values.remote })
    const report = await inspectPush(repo, range, limits)
    if (values.json) {
      context.stdout.write(`${JSON.stringify(report)}\n`)
    }
    else {
      const [push, transfer] = await Promise.all([
        describePush(repo, { remote: values.remote, updates, head: values.head }),
        readTransferSummary(repo),
      ])
      context.stdout.write(formatInspection(report, top, { ...push, transfer, style: terminalFor(context) }))
    }
    if (report.status === 'ok')
      return 0
    const reply = values.confirm ? await askPush(repo, report, { remote: values.remote, updates, head: values.head, ui: values['confirm-ui'] as ConfirmUi | undefined }) : undefined
    if (values.confirm)
      context.stderr.write(terminalFor(context, 'stderr').paint(reply?.answer === 'continue' ? 'success' : 'warning', formatReply(reply)))
    if (reply?.answer === 'continue') {
      if (values.stdin)
        await recordPushHistory(context.env, { root: repo.cwd, at: new Date().toISOString(), reason: 'exceeded', outcome: 'continued', summary: exceededReasons(report).join('；'), note: reply.note })
      return 0
    }
    // Only a real push (from the hook) is remembered; manual checks block nothing.
    if (values.stdin) {
      const summary = exceededReasons(report).join('；')
      await recordBlockedPush(context.env, { root: repo.cwd, at: new Date().toISOString(), reason: reply ? 'cancelled' : 'exceeded', summary, note: reply?.note })
    }
    return 1
  }
  catch (error) {
    // parseArgs and subprocess errors may contain user-supplied URLs: only emit controlled messages.
    const message = error instanceof InspectionError ? error.message : '检查失败：请核对参数、Git 安装及仓库状态（yunbox inspect --help）'
    if (json)
      context.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: 'error', error: { code: 'INSPECTION_FAILED', message } })}\n`)
    else
      context.stderr.write(`推送检查失败：${message}\n`)
    return 2
  }
}

/**
 * What the confirmation decided, for whoever ran the push. That is often a coding
 * assistant reading the hook's stderr, so a cancel says plainly not to work around it.
 */
function formatReply(reply: PushAnswer | undefined): string {
  if (reply?.answer === 'continue')
    return reply.note ? `已确认，继续推送。原因：${reply.note}\n` : '已确认，继续推送。\n'
  if (!reply)
    return '已取消推送。\n'
  return `${reply.note ? `已取消推送，原因：${reply.note}` : '已取消推送。'}\n`
    + `这是人工确认的结果：${reply.note ? '请按原因处理，' : ''}不要提高限额或用 --no-verify 绕过检查后重新推送。\n`
}

async function readLimit(context: CliContext, supplied: string | undefined, key: string, fallback: number): Promise<number> {
  let value = supplied
  if (value === undefined) {
    // Config lookup is read-only; a missing setting uses the shared CLI default.
    try {
      value = (await inspectGit(context, ['config', '--get', key])).output.toString('utf8').trim()
    }
    catch {
      return fallback
    }
  }
  const match = /^(\d+)([kmgb]|kib|mib|gib)?$/i.exec(value)
  const scale: Record<string, number> = { b: 1, k: 1024, kib: 1024, m: 1024 ** 2, mib: 1024 ** 2, g: 1024 ** 3, gib: 1024 ** 3 }
  const bytes = match ? Number(match[1]) * (scale[match[2]?.toLowerCase() ?? 'b'] ?? 1) : Number.NaN
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes >= Number.MAX_SAFE_INTEGER)
    throw new InspectionError('限额必须是非负整数字节数或 k/m/g、KiB/MiB/GiB 大小')
  return bytes
}

async function readUpdates(context: CliContext): Promise<string> {
  if (context.stdin.isTTY)
    throw new InspectionError('--stdin 需要通过管道传入 pre-push 引用更新')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of context.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    bytes += buffer.length
    if (bytes > 2 * 1024 * 1024)
      throw new InspectionError('pre-push 输入超过 2 MiB')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
