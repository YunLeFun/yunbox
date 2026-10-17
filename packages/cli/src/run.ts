import type { CliContext } from './context.ts'
import { runDoctor } from './commands/doctor.ts'
import { runInit } from './commands/init.ts'
import { runStatus } from './commands/status.ts'
import { CliError, printError, USAGE_EXIT_CODE } from './context.ts'

/** Version reported by `yunbox --version`. */
export const CLI_VERSION = '0.0.0'

export const mainHelp = `云匣 YunBox 命令行（版本 ${CLI_VERSION}）

用法：
  git yunbox <命令> [选项]
  yunbox <命令> [选项]

命令：
  init     在当前仓库接入 YunBox：.gitattributes、.lfsconfig、凭据
  doctor   检查配置、连通性和读写权限，并给出修复命令
  status   列出当前仓库 LFS 对象的数量和总大小
  help     显示帮助；help <命令> 显示该命令的帮助

两种写法完全一样。注意 git yunbox --help 会被 Git 当成 git help yunbox，
请用 git yunbox help 或 git yunbox <命令> -h。
`

const COMMANDS: Record<string, (context: CliContext, args: string[]) => Promise<number>> = {
  init: runInit,
  doctor: runDoctor,
  status: runStatus,
}

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
}
