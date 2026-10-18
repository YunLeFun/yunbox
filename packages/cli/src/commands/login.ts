// @env node

import type { CliContext } from '../context.ts'
import { parseArgs } from 'node:util'
import { CosRequestError, listCosBuckets } from '@yunbox/core'
import { CliError, print, printError, USAGE_EXIT_CODE } from '../context.ts'
import { deleteCredentials, resolveCredentials, saveCredentials } from '../cos/credentials.ts'
import { printStep } from '../report.ts'
import { promptForToken, readTokenFromStdin } from '../token-input.ts'

export const loginHelp = `用法：yunbox login [--secret-id <SecretId>] [--secret-key-stdin]
      yunbox logout

把你自己的腾讯云 API 密钥保存在这台电脑上（不进任何仓库），供 git-lfs 直连 COS。
建议用管理员分配给你的子账号密钥，只授权团队 bucket 里对应的前缀。

  --secret-id <id>     SecretId（不是秘密，可以写在参数里）；不提供时会提示输入
  --secret-key-stdin   从标准输入读取 SecretKey，例如 pbpaste | yunbox login --secret-id AKID... --secret-key-stdin
  -h, --help           显示帮助

SecretKey 不接受命令行参数，以免留在 shell 历史里；在终端里会提示输入（不显示）。

保存位置：
  macOS      登录钥匙串里的「yunbox」项（用系统自带的 security 命令，密钥不经过命令行参数）；
             钥匙串不可用时改存文件
  其他系统   文件 credentials.json（权限 600）：${'$'}YUNBOX_CONFIG_DIR，Windows 为 %APPDATA%\\yunbox，
             其他为 ~/.config/yunbox
  YUNBOX_CREDENTIAL_STORE=file 强制用文件，=keychain 强制用钥匙串（只限 macOS）
保存成功后会删除另一处的旧副本。logout 两处都删除。

读取顺序：TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY 环境变量 > 钥匙串 > 文件 > tccli auth login。
`

/** Run `yunbox login`. */
export async function runLogin(context: CliContext, args: string[]): Promise<number> {
  if (args.some(arg => /^--secret-?key(?:=|$)/.test(arg)))
    throw new CliError('不要在命令行参数里传 SecretKey，它会留在 shell 历史里。用 --secret-key-stdin，或直接运行 yunbox login 按提示输入', USAGE_EXIT_CODE)
  let values: { 'secret-id'?: string, 'secret-key-stdin'?: boolean, 'help'?: boolean }
  try {
    values = parseArgs({ args, options: { 'secret-id': { type: 'string' }, 'secret-key-stdin': { type: 'boolean' }, 'help': { type: 'boolean', short: 'h' } } }).values
  }
  catch (error) {
    throw new CliError(`${(error as Error).message}\n运行 yunbox login --help 查看用法`, USAGE_EXIT_CODE)
  }
  if (values.help) {
    context.stdout.write(loginHelp)
    return 0
  }

  const secretId = (values['secret-id'] ?? await promptForToken(context, 'SecretId：') ?? '').trim()
  const secretKey = values['secret-key-stdin']
    ? await readTokenFromStdin(context)
    : (await promptForToken(context, 'SecretKey（输入不显示）：') ?? '')
  if (secretId === '' || secretKey === '')
    throw new CliError('需要 SecretId 和 SecretKey。在终端里运行 yunbox login，或用 --secret-id 加 --secret-key-stdin', USAGE_EXIT_CODE)
  if (!/^AKID[\w-]{10,}$/.test(secretId))
    throw new CliError('SecretId 一般以 AKID 开头，请检查是否复制完整', USAGE_EXIT_CODE)
  if (!/^\S{16,}$/.test(secretKey))
    throw new CliError('SecretKey 格式不对（太短或包含空白），请检查是否复制完整', USAGE_EXIT_CODE)

  // Check the key works before saving it. A restricted sub-account may not list buckets; that is fine.
  try {
    const buckets = await listCosBuckets({ credentials: { secretId, secretKey }, endpoint: context.env.YUNBOX_COS_SERVICE_ENDPOINT || undefined })
    printStep(context, { status: 'pass', title: '密钥有效', detail: `可以看到 ${buckets.length} 个 bucket` })
  }
  catch (error) {
    if (error instanceof CosRequestError && error.status === 403 && error.code === 'AccessDenied') {
      printStep(context, { status: 'pass', title: '密钥有效', detail: '这个子账号不能列出 bucket，这是受限子账号的正常情况' })
    }
    else if (error instanceof CosRequestError && error.status === 403) {
      throw new CliError(`腾讯云拒绝了这对密钥（${error.code ?? 'HTTP 403'}）：SecretId 或 SecretKey 不对，或密钥已被禁用。没有保存`)
    }
    else {
      throw new CliError(`暂时无法验证密钥（${(error as Error).message}）。检查网络后重试，没有保存`)
    }
  }

  const saved = await saveCredentials(context.env, { secretId, secretKey })
  for (const { store, reason } of saved.skipped)
    printStep(context, { status: 'warn', title: `没有存进${store.description}`, detail: reason })
  printStep(context, {
    status: 'pass',
    title: '已保存',
    detail: saved.store.kind === 'file' ? `${saved.store.description}（权限 600，只有你自己能读）` : saved.store.description,
  })
  for (const store of saved.cleaned)
    printStep(context, { status: 'pass', title: '已删除旧副本', detail: store.description })
  if (context.env.TENCENTCLOUD_SECRETID)
    print(context, '注意：当前设置了 TENCENTCLOUD_SECRETID 环境变量，它会优先于刚保存的密钥')
  return 0
}

/** Run `yunbox logout`. */
export async function runLogout(context: CliContext, args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    context.stdout.write(loginHelp)
    return 0
  }
  const { removed, failed } = await deleteCredentials(context.env)
  for (const store of removed)
    print(context, `已删除 ${store.description} 里的密钥`)
  if (removed.length === 0 && failed.length === 0)
    print(context, '这台电脑上没有 yunbox login 保存的密钥')
  for (const { reason } of failed)
    printError(context, reason)
  const remaining = await resolveCredentials(context.env).catch(() => undefined)
  if (remaining !== undefined)
    print(context, `仍然可以使用：${remaining.description}`)
  return failed.length === 0 ? 0 : 1
}
