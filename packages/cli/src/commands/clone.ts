import type { CliContext } from '../context.ts'
import { basename, resolve } from 'node:path'
import { CliError, print, USAGE_EXIT_CODE } from '../context.ts'
import { LOCATION_FILE } from '../cos/location.ts'
import { firstLine, runGit } from '../git.ts'
import { printStep } from '../report.ts'
import { readStorageLocation } from '../storage/config.ts'
import { runInit } from './init.ts'

export const cloneHelp = `用法：git yunbox clone <仓库地址> [目录]

clone 一个用 YunBox 直连 COS 的仓库：
  1. 先 clone Git 历史，暂不下载 LFS 素材（git-lfs 还不知道去哪里下载）
  2. 在新目录里运行 git yunbox init，登记直连 COS 的传输代理
  3. git lfs pull 下载当前版本的素材

需要先用 yunbox login 保存自己的腾讯云密钥。
`

/** Run `git yunbox clone`. */
export async function runClone(context: CliContext, args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    context.stdout.write(cloneHelp)
    return 0
  }
  const [url, directory, ...rest] = args
  if (url === undefined || rest.length > 0)
    throw new CliError('用法：git yunbox clone <仓库地址> [目录]', USAGE_EXIT_CODE)
  const target = resolve(context.cwd, directory ?? basename(url.replace(/\/+$/, '')).replace(/\.git$/, ''))

  // git-lfs cannot fetch until the agent is registered in the new clone.
  const clone = await runGit(context, ['clone', url, target], { env: { GIT_LFS_SKIP_SMUDGE: '1' } })
  if (clone.code !== 0)
    throw new CliError(`git clone 失败：${firstLine(clone.stderr) || firstLine(clone.stdout)}`)
  printStep(context, { status: 'pass', title: 'git clone', detail: `${target}（暂未下载素材）` })

  const repo: CliContext = { ...context, cwd: target }
  if (await readStorageLocation(repo, target) === undefined) {
    throw new CliError(`clone 完成，但仓库里没有 ${LOCATION_FILE}，它还没有用 YunBox 直连 COS 管理素材，所以没有下载素材。\n`
      + `  在 ${target} 里运行 git yunbox init 接入，或者用普通的 git lfs pull`)
  }
  const code = await runInit(repo, [])
  if (code !== 0)
    return code
  const pull = await runGit(repo, ['lfs', 'pull'])
  if (pull.code !== 0)
    throw new CliError(`git lfs pull 失败：${firstLine(pull.stderr) || firstLine(pull.stdout)}\n修复后在 ${target} 里运行 git lfs pull`)
  printStep(context, { status: 'pass', title: 'git lfs pull', detail: '已下载当前版本的素材' })
  print(context, `完成：cd ${target}`)
  return 0
}
