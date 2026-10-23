import type { CliContext } from '../context.ts'
import { parseArgs } from 'node:util'
import { CliError, print, USAGE_EXIT_CODE } from '../context.ts'
import { findRepositoryRoot, runGitChecked } from '../git.ts'
import { describePush } from '../push-context.ts'
import { terminalFor, terminalText } from '../terminal.ts'
import { readTransferSummary } from '../transfer-summary.ts'

export const statusHelp = `用法：yunbox status [选项]

列出当前仓库 LFS 对象的数量和总大小（读取 git lfs ls-files，不访问网络），
以及 Git 目标、COS / S3 直连配置或 LFS 服务端地址。
只读取本地配置，不检查密钥或远端连通性；完整自检使用 yunbox doctor。

选项：
  --all        统计所有分支、标签和历史版本，而不只是当前检出的提交
  -h, --help   显示帮助
`

/** Summary of the LFS objects referenced by a repository. */
export interface LfsUsage {
  /** Files that are LFS pointers. Several files may share one object. */
  files: number
  /** Distinct objects (by oid). */
  objects: number
  /** Total size of the distinct objects in bytes. */
  bytes: number
  /** Distinct objects present in the local LFS cache. */
  downloadedObjects: number
  downloadedBytes: number
}

interface LsFilesEntry {
  name: string
  size: number
  oid: string
  downloaded: boolean
}

/** Run `yunbox status`. */
export async function runStatus(context: CliContext, args: string[]): Promise<number> {
  const values = parseStatusArgs(args)
  if (values.help) {
    context.stdout.write(statusHelp)
    return 0
  }
  const root = await findRepositoryRoot(context)
  if (root === undefined)
    throw new CliError('当前目录不在 Git 仓库里')
  const repo: CliContext = { ...context, cwd: root }
  const [transfer, push, usage] = await Promise.all([
    readTransferSummary(repo),
    describePush(repo, {}),
    readLfsUsage(repo, values.all ?? false),
  ])
  const style = terminalFor(context)

  print(context, style.title('仓库状态'))
  print(context)
  print(context, style.field('仓库', terminalText(root)))
  print(context, style.field('代码目标', push.target ?? '尚未配置 Git 远端', 'info'))
  for (const { label, value, tone } of transfer.fields)
    print(context, style.field(label, value, tone))
  for (const warning of transfer.warnings)
    print(context, style.paint('warning', `! ${warning}`))
  print(context)
  const scope = values.all ? '所有分支和历史' : '当前提交'
  if (usage.objects === 0) {
    print(context, style.field(`LFS 对象（${scope}）`, '0 个'))
    return 0
  }
  print(context, style.field(`LFS 对象（${scope}）`, `${usage.objects} 个，共 ${formatBytes(usage.bytes)}${values.all ? '' : `，对应 ${usage.files} 个文件`}`))
  const missing = usage.objects - usage.downloadedObjects
  print(context, style.field('本地已下载', `${usage.downloadedObjects} 个，${formatBytes(usage.downloadedBytes)}${missing === 0 ? '' : `；还有 ${missing} 个未下载（git lfs pull 下载）`}`, missing ? 'warning' : 'success'))
  return 0
}

/** Count the LFS objects referenced by HEAD, or by every ref with `all`, from `git lfs ls-files --json`. */
export async function readLfsUsage(context: CliContext, all: boolean): Promise<LfsUsage> {
  const hasHead = (await runGitChecked(context, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')) !== ''
  if (!hasHead && !all)
    return { files: 0, objects: 0, bytes: 0, downloadedObjects: 0, downloadedBytes: 0 }
  const output = await runGitChecked(context, ['lfs', 'ls-files', '--json', ...(all ? ['--all'] : [])])
  const parsed = JSON.parse(output) as { files: LsFilesEntry[] | null }
  const files = parsed.files ?? []
  const objects = new Map<string, LsFilesEntry>()
  for (const file of files)
    objects.set(file.oid, file)
  let bytes = 0
  let downloadedObjects = 0
  let downloadedBytes = 0
  for (const object of objects.values()) {
    bytes += object.size
    if (object.downloaded) {
      downloadedObjects += 1
      downloadedBytes += object.size
    }
  }
  return { files: files.length, objects: objects.size, bytes, downloadedObjects, downloadedBytes }
}

/** Format a byte count as `1.5 MiB (1,572,864 字节)`. */
export function formatBytes(bytes: number): string {
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  if (bytes < 1024)
    return `${bytes} 字节`
  let value = bytes
  let unit = 'B'
  for (const next of units) {
    if (value < 1024)
      break
    value /= 1024
    unit = next
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${unit}（${bytes.toLocaleString('en-US')} 字节）`
}

function parseStatusArgs(args: string[]): { all?: boolean, help?: boolean } {
  try {
    return parseArgs({
      args,
      options: {
        all: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values
  }
  catch (error) {
    throw new CliError(`${(error as Error).message}\n运行 yunbox status --help 查看用法`, USAGE_EXIT_CODE)
  }
}
