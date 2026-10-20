// @env node

import type { CliContext } from '../context.ts'
import type { StorageLocation, StorageProvider } from '../storage/provider.ts'
import { parseArgs } from 'node:util'
import { CosRequestError, listCosBuckets } from '@yunbox/core'
import { CliError, print, printError, USAGE_EXIT_CODE } from '../context.ts'
import { deleteCredentials, saveCredentials } from '../cos/credentials.ts'
import { findRepositoryRoot } from '../git.ts'
import { printStep } from '../report.ts'
import { describeStorage, parseProviderId, providerById, providerOf, readStorageLocation } from '../storage/config.ts'
import { prefixed, PROVIDER_IDS, READ_CHECK_KEY } from '../storage/provider.ts'
import { promptForToken, readTokenFromStdin } from '../token-input.ts'

export const loginHelp = `用法：yunbox login [--provider cos|s3] [--secret-id <SecretId>] [--secret-key-stdin]
      yunbox logout [--provider cos|s3]

把你自己的云存储密钥保存在这台电脑上（不进任何仓库），供 git-lfs 直连对象存储。
  cos  腾讯云 API 密钥（SecretId / SecretKey）。建议用管理员分配给你的子账号密钥，只授权团队 bucket 里对应的前缀
  s3   S3 兼容存储（Cloudflare R2、AWS S3、MinIO 等）的 Access Key ID / Secret Access Key。
       R2 的 token 只能限定到 bucket，建议每个项目一个 bucket
不写 --provider 时，在已接入的仓库里用仓库配置的存储，否则是 cos。两种密钥分开保存，互不覆盖。

  --provider <名称>    cos 或 s3
  --secret-id <id>     SecretId 或 Access Key ID（不是秘密，可以写在参数里）；不提供时会提示输入
                       （--access-key-id 是同一个选项）
  --secret-key-stdin   从标准输入读取 SecretKey / Secret Access Key，例如 pbpaste | yunbox login --secret-id AKID... --secret-key-stdin
  -h, --help           显示帮助

SecretKey 不接受命令行参数，以免留在 shell 历史里；在终端里会提示输入（不显示）。

保存位置：
  macOS      登录钥匙串里的「yunbox」项（用系统自带的 security 命令，密钥不经过命令行参数）；
             钥匙串不可用时改存文件
  其他系统   文件 credentials.json（权限 600）：${'$'}YUNBOX_CONFIG_DIR，Windows 为 %APPDATA%\\yunbox，
             其他为 ~/.config/yunbox
  YUNBOX_CREDENTIAL_STORE=file 强制用文件，=keychain 强制用钥匙串（只限 macOS）
  S3 的密钥存在钥匙串的「yunbox / s3」项，文件为 credentials-s3.json
保存成功后会删除另一处的旧副本。logout 两处都删除；不写 --provider 时删除所有存储的密钥。

读取顺序：
  cos  TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY 环境变量 > 钥匙串 > 文件 > tccli auth login
  s3   YUNBOX_S3_ACCESS_KEY_ID / YUNBOX_S3_SECRET_ACCESS_KEY 环境变量 > 钥匙串 > 文件（不读 AWS_* 环境变量）
`

interface LoginOptions {
  'provider'?: string
  'secret-id'?: string
  'access-key-id'?: string
  'secret-key-stdin'?: boolean
  'help'?: boolean
}

/** Run `yunbox login`. */
export async function runLogin(context: CliContext, args: string[]): Promise<number> {
  if (args.some(arg => /^--(?:secret-?key|secret-access-key)(?:=|$)/.test(arg)))
    throw new CliError('不要在命令行参数里传 SecretKey，它会留在 shell 历史里。用 --secret-key-stdin，或直接运行 yunbox login 按提示输入', USAGE_EXIT_CODE)
  let values: LoginOptions
  try {
    values = parseArgs({ args, options: { 'provider': { type: 'string' }, 'secret-id': { type: 'string' }, 'access-key-id': { type: 'string' }, 'secret-key-stdin': { type: 'boolean' }, 'help': { type: 'boolean', short: 'h' } } }).values
  }
  catch (error) {
    throw new CliError(`${(error as Error).message}\n运行 yunbox login --help 查看用法`, USAGE_EXIT_CODE)
  }
  if (values.help) {
    context.stdout.write(loginHelp)
    return 0
  }
  const { provider, location } = await loginTarget(context, values.provider)
  const cos = provider.id === 'cos'

  const secretId = (values['secret-id'] ?? values['access-key-id'] ?? await promptForToken(context, cos ? 'SecretId：' : 'Access Key ID：') ?? '').trim()
  const secretKey = values['secret-key-stdin']
    ? await readTokenFromStdin(context)
    : (await promptForToken(context, cos ? 'SecretKey（输入不显示）：' : 'Secret Access Key（输入不显示）：') ?? '')
  if (secretId === '' || secretKey === '')
    throw new CliError(cos ? '需要 SecretId 和 SecretKey。在终端里运行 yunbox login，或用 --secret-id 加 --secret-key-stdin' : '需要 Access Key ID 和 Secret Access Key。在终端里运行 yunbox login --provider s3，或用 --access-key-id 加 --secret-key-stdin', USAGE_EXIT_CODE)
  if (cos && !/^AKID[\w-]{10,}$/.test(secretId))
    throw new CliError('SecretId 一般以 AKID 开头，请检查是否复制完整', USAGE_EXIT_CODE)
  if (!cos && !/^[\w+/=.-]{8,128}$/.test(secretId))
    throw new CliError('Access Key ID 格式不对（太短或包含空白），请检查是否复制完整', USAGE_EXIT_CODE)
  if (!/^\S{16,}$/.test(secretKey))
    throw new CliError(`${cos ? 'SecretKey' : 'Secret Access Key'} 格式不对（太短或包含空白），请检查是否复制完整`, USAGE_EXIT_CODE)

  // Check the key works before saving it.
  if (cos)
    await verifyCosKeys(context, secretId, secretKey)
  else
    await verifyS3Keys(context, provider, location, { secretId, secretKey })

  const saved = await saveCredentials(context.env, { secretId, secretKey }, provider.credentialStores(context.env))
  for (const { store, reason } of saved.skipped)
    printStep(context, { status: 'warn', title: `没有存进${store.description}`, detail: reason })
  printStep(context, {
    status: 'pass',
    title: '已保存',
    detail: saved.store.kind === 'file' ? `${saved.store.description}（权限 600，只有你自己能读）` : saved.store.description,
  })
  for (const store of saved.cleaned)
    printStep(context, { status: 'pass', title: '已删除旧副本', detail: store.description })
  if (cos && context.env.TENCENTCLOUD_SECRETID)
    print(context, '注意：当前设置了 TENCENTCLOUD_SECRETID 环境变量，它会优先于刚保存的密钥')
  if (!cos && context.env.YUNBOX_S3_ACCESS_KEY_ID)
    print(context, '注意：当前设置了 YUNBOX_S3_ACCESS_KEY_ID 环境变量，它会优先于刚保存的密钥')
  return 0
}

/** `--provider`, else the provider of the repository in the working directory, else COS. */
async function loginTarget(context: CliContext, option: string | undefined): Promise<{ provider: StorageProvider, location?: StorageLocation }> {
  const root = await findRepositoryRoot(context).catch(() => undefined)
  const location = root === undefined ? undefined : await readStorageLocation({ ...context, cwd: root }, root).catch(() => undefined)
  const provider = option !== undefined ? providerById(parseProviderId(option)) : location !== undefined ? providerOf(location) : providerById('cos')
  return { provider, ...(location !== undefined && providerOf(location) === provider ? { location } : {}) }
}

/** A restricted sub-account may not list buckets; that is fine. */
async function verifyCosKeys(context: CliContext, secretId: string, secretKey: string): Promise<void> {
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
}

/**
 * S3 keys are usually limited to one bucket and cannot list buckets, so they
 * are checked against the repository's bucket: a GET of a key that never
 * exists answers 404 with working keys, and names the problem otherwise.
 * Outside a repository there is nothing to check against.
 */
async function verifyS3Keys(context: CliContext, provider: StorageProvider, location: StorageLocation | undefined, keys: { secretId: string, secretKey: string }): Promise<void> {
  if (location === undefined) {
    printStep(context, { status: 'skip', title: '密钥有效', detail: '不在接入了 S3 的仓库里，没有可以检查的 bucket；接入后运行 yunbox doctor 检查' })
    return
  }
  let result: { status: number, code?: string }
  try {
    result = await provider.connect(location, () => keys).check(prefixed(location, READ_CHECK_KEY))
  }
  catch (error) {
    throw new CliError(`暂时无法验证密钥（${(error as Error).message}）。检查网络后重试，没有保存`)
  }
  if (result.status === 404 || result.status === 200) {
    printStep(context, { status: 'pass', title: '密钥有效', detail: `可以读取 ${describeStorage(location)}` })
    return
  }
  if (result.status === 403 && (result.code === 'InvalidAccessKeyId' || result.code === 'SignatureDoesNotMatch'))
    throw new CliError(`存储服务拒绝了这对密钥（${result.code}）：Access Key ID 或 Secret Access Key 不对，或者已被删除。没有保存`)
  if (result.status === 403) {
    printStep(context, { status: 'warn', title: '密钥', detail: `这对密钥不能读取 ${describeStorage(location)}（${result.code ?? 'HTTP 403'}），仍然保存；请确认它有这个 bucket 的权限` })
    return
  }
  throw new CliError(`暂时无法验证密钥（HTTP ${result.status}${result.code === undefined ? '' : ` ${result.code}`}）。没有保存`)
}

/** Run `yunbox logout`. */
export async function runLogout(context: CliContext, args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    context.stdout.write(loginHelp)
    return 0
  }
  let option: string | undefined
  try {
    option = parseArgs({ args, options: { provider: { type: 'string' } } }).values.provider
  }
  catch (error) {
    throw new CliError(`${(error as Error).message}\n运行 yunbox logout --help 查看用法`, USAGE_EXIT_CODE)
  }
  const providers = option === undefined ? PROVIDER_IDS.map(providerById) : [providerById(parseProviderId(option))]
  let removedAny = false
  let failedAny = false
  for (const provider of providers) {
    let stores
    try {
      stores = provider.credentialStores(context.env)
    }
    catch (error) {
      throw new CliError((error as Error).message)
    }
    const { removed, failed } = await deleteCredentials(context.env, stores)
    for (const store of removed)
      print(context, `已删除 ${store.description} 里的${provider.id === 'cos' ? '' : ` ${provider.label} `}密钥`)
    for (const { reason } of failed)
      printError(context, reason)
    removedAny ||= removed.length > 0
    failedAny ||= failed.length > 0
    const remaining = await provider.resolveCredentials(context.env).catch(() => undefined)
    if (remaining !== undefined)
      print(context, `仍然可以使用：${remaining.description}`)
  }
  if (!removedAny && !failedAny)
    print(context, '这台电脑上没有 yunbox login 保存的密钥')
  return failedAny ? 1 : 0
}
