import type { CliContext } from './context.ts'
import packageJson from '../package.json' with { type: 'json' }
import { runBuckets } from './commands/buckets.ts'
import { runClone } from './commands/clone.ts'
import { runDoctor } from './commands/doctor.ts'
import { runFreeze } from './commands/freeze.ts'
import { runHook } from './commands/hook.ts'
import { runInit } from './commands/init.ts'
import { runInspect } from './commands/inspect.ts'
import { runLfsAgent } from './commands/lfs-agent.ts'
import { runLogin, runLogout } from './commands/login.ts'
import { runPolicy } from './commands/policy.ts'
import { runStatus } from './commands/status.ts'
import { runSubaccount } from './commands/subaccount.ts'
import { runTypes } from './commands/types.ts'
import { CliError, printError, USAGE_EXIT_CODE } from './context.ts'
import { recordCurrentRepository } from './used-repositories.ts'

/** Version reported by `yunbox --version`. */
export const CLI_VERSION: string = packageJson.version

export const mainHelp = `云匣 YunBox 命令行（版本 ${CLI_VERSION}）

用法：
  git yunbox <命令> [选项]
  yunbox <命令> [选项]

命令：
  login    在这台电脑上保存自己的 COS 或 S3 兼容存储密钥（logout 删除）
  subaccount  用管理员身份新建 / 授权 / 删除只给 YunBox 用的子账号，并保存长期密钥
  policy   输出给协作者子账号用的最小权限 CAM 策略 JSON（不改动账号）
  init     在当前仓库接入 YunBox：.gitattributes、.yunbox/config，git-lfs 直连 COS 或 S3 兼容存储
  types    按素材类型查看、添加、移除 .gitattributes 里的 LFS 规则（支持 game 等预置组合）
  clone    clone 一个直连对象存储的仓库并下载素材
  buckets  列出本机密钥能看到的 COS bucket
  doctor   检查配置、连通性和读写权限，并给出修复命令
  status   列出当前仓库 LFS 对象的数量和总大小
  inspect  推送前分别检查 Git/LFS 大小、超限文件和 JSON 明细
  hook     安装/撤销检查通过后才执行原钩子的 pre-push 包装层
  freeze   设置禁推时段（如工作时间 Mo-Fr 09:00-18:00），时段内 pre-push 直接中断推送
  help     显示帮助；help <命令> 显示该命令的帮助

两种写法完全一样。注意 git yunbox --help 会被 Git 当成 git help yunbox，
请用 git yunbox help 或 git yunbox <命令> -h。
`

const COMMANDS: Record<string, (context: CliContext, args: string[]) => Promise<number>> = {
  'login': runLogin,
  'buckets': runBuckets,
  'subaccount': runSubaccount,
  'logout': runLogout,
  'policy': runPolicy,
  'init': runInit,
  'types': runTypes,
  'clone': runClone,
  // Started by git-lfs, not by people; see lfs-agent.ts.
  'lfs-agent': runLfsAgent,
  'doctor': runDoctor,
  'status': runStatus,
  'inspect': runInspect,
  'hook': runHook,
  'freeze': runFreeze,
}

/** Commands that act on the current repository; running one adds it to the record the macOS client reads. */
const REPOSITORY_COMMANDS = new Set(['init', 'types', 'doctor', 'status', 'inspect', 'hook', 'freeze'])

/**
 * Run the `yunbox` / `git-yunbox` command line and return the exit code.
 * Never throws for user errors; they are printed to stderr instead.
 */
export async function runCli(argv: string[], context: CliContext): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === '-h' || command === '--help') {
    context.stdout.write(mainHelp)
    return command === undefined ? USAGE_EXIT_CODE : 0
  }
  if (command === '-v' || command === '--version' || command === 'version') {
    context.stdout.write(`${CLI_VERSION}\n`)
    return 0
  }
  if (command === 'help') {
    const target = rest[0]
    if (target === undefined) {
      context.stdout.write(mainHelp)
      return 0
    }
    return runCli([target, '--help'], context)
  }
  const handler = COMMANDS[command]
  if (handler === undefined) {
    printError(context, `未知命令：${command}。可用命令：${Object.keys(COMMANDS).join('、')}（yunbox help 查看帮助）`)
    return USAGE_EXIT_CODE
  }
  try {
    return await handler(context, rest)
  }
  catch (error) {
    if (error instanceof CliError) {
      printError(context, `错误：${error.message}`)
      return error.exitCode
    }
    printError(context, `错误：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  finally {
    if (REPOSITORY_COMMANDS.has(command) && !rest.some(arg => arg === '-h' || arg === '--help'))
      await recordCurrentRepository(context)
  }
}
