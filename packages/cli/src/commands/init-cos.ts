// @env node

import type { CliContext } from '../context.ts'
import type { CosLocation } from '../cos/location.ts'
import type { selectCategories } from '../gitattributes.ts'
import type { AddressingStyle, S3Location } from '../s3/location.ts'
import type { AccessKeys, BucketSummary, ObjectStore, StorageLocation, StorageProvider } from '../storage/provider.ts'
import type { InitOptions } from './init.ts'
import { existsSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'
import process from 'node:process'
import { cosAppIdOf } from '@yunbox/core'
import { CliError, print, USAGE_EXIT_CODE } from '../context.ts'
import { LEGACY_LOCATION_FILE, LOCATION_FILE, normalizeLocation } from '../cos/location.ts'
import { readGitConfig, runGit, runGitChecked, shellQuote } from '../git.ts'
import { askRequired, createLineReader } from '../prompt.ts'
import { printStep } from '../report.ts'
import { isR2, normalizeS3Location, S3_PRESETS } from '../s3/location.ts'
import { describeStorage, parseProviderId, providerById, providerOf, readStorageLocation, requireStorageCredentials, sameStorage, writeStorageLocation } from '../storage/config.ts'
import { cosProvider } from '../storage/cos.ts'
import { prefixed, PROBE_OPERATIONS, READ_CHECK_KEY, StorageRequestError } from '../storage/provider.ts'
import { AGENT_NAME } from './lfs-agent.ts'

const DEFAULT_REGION = 'ap-guangzhou'

type InstallStep = (context: CliContext, repo: CliContext, root: string, categories: ReturnType<typeof selectCategories> | undefined) => Promise<void>

/**
 * `git yunbox init` in direct mode: no YunBox server. git-lfs hands every
 * object to `git-yunbox lfs-agent`, which uploads and downloads directly with
 * the user's own keys. The provider, bucket, region and prefix go into the
 * committed `.yunbox/config`; the agent registration goes into this clone's
 * `.git/config`, because git-lfs ignores transfer-agent settings in
 * `.lfsconfig` for safety.
 */
export async function runInitCos(
  context: CliContext,
  repo: CliContext,
  root: string,
  values: InitOptions,
  categories: ReturnType<typeof selectCategories>,
  install: InstallStep,
): Promise<number> {
  // 1. Where the objects go: .yunbox/config, options, or an interactive choice.
  const existing = await readStorageLocation(repo, root).catch((error: Error) => {
    throw new CliError(`存储位置的配置不对：${error.message}`)
  })
  const choosing = values.bucket !== undefined || values.region !== undefined || values.prefix !== undefined || values.create === true || existing === undefined
  const provider = choosing ? chooseProvider(values, existing) : providerOf(existing!)
  const { label } = provider

  const resolved = await requireStorageCredentials(context.env, provider)
  printStep(context, { status: 'pass', title: `${label} 密钥`, detail: `来自 ${resolved.description}，只保存在本机，不会写进仓库` })
  if (resolved.source === 'tccli') {
    printStep(context, { status: 'warn', title: `${label} 密钥`, detail: '这是 tccli 的临时密钥，大约 2 小时后过期', fixes: ['接入完成后运行 yunbox subaccount create --save，换成只给 YunBox 用的长期子账号密钥'] })
  }
  const { credentials } = resolved
  const ask = createLineReader(context)
  try {
    let location: StorageLocation
    if (!choosing) {
      location = existing!
      printStep(context, { status: 'pass', title: `${label} 位置`, detail: `沿用 ${LOCATION_FILE}：${describeStorage(location)}` })
    }
    else {
      location = provider.id === 's3'
        ? await chooseS3Location(context, repo, root, values, ask, existing)
        : await chooseCosLocation(context, repo, root, values, credentials, ask, existing)
      if (existing !== undefined && !sameStorage(existing, location) && !values.force)
        throw new CliError(`${LOCATION_FILE} 里已经配置了 ${describeStorage(existing)}，和 ${describeStorage(location)} 不同。确认要替换时加 --force`)
    }

    // 2. Check access before changing anything in the repository.
    const client = provider.connect(location, () => credentials)
    const steps = await client.probe()
    const writable = steps.length === PROBE_OPERATIONS.length && steps.every(step => step.ok)
    if (writable) {
      printStep(context, { status: 'pass', title: `${label} 权限`, detail: `可以在 ${describeStorage(location)} 写入和读取` })
    }
    else if (steps[0]?.operation === 'PUT' && steps[0].status === 403 && await canRead(client, location)) {
      printStep(context, {
        status: values['read-only'] ? 'pass' : 'warn',
        title: `${label} 权限`,
        detail: '这把密钥只能读取，可以 pull / clone，不能 push',
        fixes: values['read-only'] ? [] : [provider.restrictedKeys ? '需要推送时，请管理员给你的子账号加上这个前缀的写权限（PutObject）' : '需要推送时，请管理员换一把对这个 bucket 有写权限的密钥'],
      })
    }
    else {
      const failed = steps.find(step => !step.ok)
      throw new CliError([
        `本机密钥不能访问 ${describeStorage(location)}（${failed?.operation ?? 'PUT'} 返回 ${failed?.status || '无响应'}），仓库没有修改。`,
        ...accessHints(provider),
      ].join('\n'))
    }

    // 3. Shared steps, then the storage settings.
    // Joining a repository that is already set up must not change its committed .gitattributes.
    await install(context, repo, root, choosing || values.types !== undefined ? categories : undefined)
    let removedLegacy = false
    if (existing !== undefined && sameStorage(existing, location)) {
      printStep(context, { status: 'pass', title: `${label} 位置`, detail: `已是 ${describeStorage(location)}，未修改` })
    }
    else {
      ({ removedLegacy } = await writeStorageLocation(repo, root, location))
      printStep(context, { status: 'pass', title: LOCATION_FILE, detail: `${provider.id === 'cos' ? '' : `${label} `}bucket / region / prefix = ${describeStorage(location)}（不含密钥，提交后团队共享）` })
      if (removedLegacy)
        printStep(context, { status: 'pass', title: LEGACY_LOCATION_FILE, detail: `旧版的配置文件已删除，改用 ${LOCATION_FILE}` })
    }
    const leftoverUrl = await readGitConfig(repo, 'lfs.url', join(root, '.lfsconfig'))
    if (leftoverUrl !== undefined) {
      printStep(context, {
        status: 'warn',
        title: 'lfs.url',
        detail: `.lfsconfig 里还有服务端模式的 lfs.url（${leftoverUrl}）；直连 ${label} 时不会用到它`,
        fixes: ['git config --file .lfsconfig --unset lfs.url'],
      })
    }

    const agent = resolveAgentCommand(context)
    await runGitChecked(repo, ['config', '--local', 'lfs.standalonetransferagent', AGENT_NAME])
    await runGitChecked(repo, ['config', '--local', `lfs.customtransfer.${AGENT_NAME}.path`, agent.path])
    await runGitChecked(repo, ['config', '--local', `lfs.customtransfer.${AGENT_NAME}.args`, agent.args])
    await runGitChecked(repo, ['config', '--local', `lfs.customtransfer.${AGENT_NAME}.concurrent`, 'true'])
    // Without a server there is no Locks API to verify against.
    await runGitChecked(repo, ['config', '--local', 'lfs.locksverify', 'false'])
    printStep(context, { status: 'pass', title: '传输代理', detail: `本仓库的 git-lfs 改用 ${agent.display} 直连 ${label}（写在 .git/config，只对这份 clone 生效）` })

    print(context)
    print(context, '下一步：')
    print(context, `  git add .gitattributes ${LOCATION_FILE}${removedLegacy ? ` ${LEGACY_LOCATION_FILE}` : ''}`)
    print(context, `  git commit -m "chore: 用 YunBox 把 LFS 素材直传到 ${label}"`)
    print(context, '  git push')
    print(context)
    print(context, `协作者：安装 YunBox 命令行，用 ${provider.id === 'cos' ? 'yunbox login' : `yunbox login --provider ${provider.id}`} 保存自己的${provider.restrictedKeys ? '子账号' : ''}密钥，然后`)
    print(context, '  git yunbox clone <仓库地址>      # 新 clone')
    print(context, '  git yunbox init && git lfs pull  # 已有的 clone')
    return 0
  }
  finally {
    ask.close()
  }
}

const S3_OPTIONS = ['preset', 'endpoint', 'account-id', 'addressing'] as const

/** `--provider`, else `--cos`, else S3 when an S3-only option is given, else the configured provider, else COS. */
function chooseProvider(values: InitOptions, existing: StorageLocation | undefined): StorageProvider {
  const s3Options = S3_OPTIONS.filter(option => values[option] !== undefined)
  let provider: StorageProvider
  if (values.provider !== undefined)
    provider = providerById(parseProviderId(values.provider))
  else if (values.cos)
    provider = providerById('cos')
  else if (s3Options.length > 0)
    provider = providerById('s3')
  else
    provider = existing === undefined ? providerById('cos') : providerOf(existing)
  if (provider.id !== 's3' && s3Options.length > 0)
    throw new CliError(`${s3Options.map(option => `--${option}`).join('、')} 只用于 S3 兼容存储（--provider s3）`, USAGE_EXIT_CODE)
  if (provider.id !== 'cos' && values.cos)
    throw new CliError('--cos 和 --provider s3 只能选一个', USAGE_EXIT_CODE)
  if (provider.buckets === undefined && values.create)
    throw new CliError(`${provider.label} 不支持用 --create 新建 bucket，请先在服务的控制台里建好私有 bucket`, USAGE_EXIT_CODE)
  return provider
}

/** What to check when the keys cannot reach the location. */
function accessHints(provider: StorageProvider): string[] {
  if (provider.id === 'cos') {
    return [
      '  - 检查 bucket 名称和地域是否正确',
      '  - 确认子账号有这个前缀的 PutObject、GetObject、HeadObject 权限',
      '  - 临时密钥可能已过期：tccli auth login，或 yunbox login 重新保存',
    ]
  }
  return [
    '  - 检查 endpoint、bucket 名称和地域是否正确',
    '  - 确认密钥有这个 bucket 的对象读写权限',
    `  - 密钥可能已失效：yunbox login --provider ${provider.id} 重新保存`,
  ]
}

async function chooseCosLocation(
  context: CliContext,
  repo: CliContext,
  root: string,
  values: InitOptions,
  credentials: AccessKeys,
  ask: ReturnType<typeof createLineReader>,
  existing: StorageLocation | undefined,
): Promise<CosLocation> {
  const endpoint = context.env.YUNBOX_COS_ENDPOINT || undefined
  let bucket = values.bucket
  let region = values.region
  let create = values.create === true
  let buckets: BucketSummary[] | undefined

  if (bucket === undefined) {
    buckets = await listBuckets(context, credentials)
    print(context, '账号下的 bucket：')
    buckets.forEach((entry, index) => print(context, `  ${String(index + 1).padStart(2)}) ${entry.name}（${entry.region}）`))
    const answer = await askRequired(ask, buckets.length > 0 ? '选择 bucket 编号，或输入 n 新建私有 bucket：' : '还没有 bucket，回车新建一个私有 bucket：', '--bucket / --region')
    if (answer === '' || answer.toLowerCase() === 'n') {
      create = true
    }
    else {
      const chosen = /^\d+$/.test(answer) ? buckets[Number(answer) - 1] : undefined
      if (chosen === undefined)
        throw new CliError(`「${answer}」不是列表里的编号`, USAGE_EXIT_CODE)
      bucket = chosen.name
      region ??= chosen.region
    }
  }
  if (create) {
    buckets ??= await listBuckets(context, credentials)
    if (bucket === undefined) {
      const appId = cosAppIdOf(buckets[0]?.name ?? '')
      const name = await askRequired(ask, `新 bucket 名称${appId === undefined ? '（包含 -APPID）' : `（会自动加上 -${appId}）`}：`, '--bucket')
      bucket = appId !== undefined && cosAppIdOf(name) === undefined ? `${name}-${appId}` : name
    }
    region ??= (await askRequired(ask, `地域 [${DEFAULT_REGION}]：`, '--region')) || DEFAULT_REGION
    if (buckets.some(entry => entry.name === bucket)) {
      create = false
      print(context, `bucket ${bucket} 已经存在，直接使用它`)
    }
  }
  if (region === undefined) {
    buckets ??= await listBuckets(context, credentials)
    region = buckets.find(entry => entry.name === bucket)?.region
    if (region === undefined)
      throw new CliError(`列表里没有 bucket ${bucket}，请用 --region 指定地域`, USAGE_EXIT_CODE)
  }

  const suggested = existing?.prefix || await suggestPrefix(repo, root)
  const prefix = values.prefix ?? ((await askRequired(ask, `bucket 里的目录前缀 [${suggested}]：`, '--prefix')) || suggested)
  let location: CosLocation
  try {
    location = normalizeLocation({ bucket: bucket!, region, prefix, ...(endpoint === undefined ? {} : { endpoint }) })
  }
  catch (error) {
    throw new CliError((error as Error).message, USAGE_EXIT_CODE)
  }

  if (create) {
    if (!values.yes) {
      const answer = await askRequired(ask, `确认新建私有 bucket ${location.bucket}（${location.region}）？COS 会按存储量和流量计费 [y/N]：`, '--yes')
      if (!/^y(?:es)?$/i.test(answer))
        throw new CliError('已取消，没有做任何修改')
    }
    await cosProvider.buckets.create(location, credentials, context.env)
    printStep(context, { status: 'pass', title: '新建 bucket', detail: `${location.bucket}（${location.region}），私有读写` })
  }
  return location
}

async function listBuckets(context: CliContext, credentials: AccessKeys): Promise<BucketSummary[]> {
  try {
    return await cosProvider.buckets.list(credentials, context.env)
  }
  catch (error) {
    if (error instanceof StorageRequestError && error.status === 403)
      throw new CliError('这把密钥不能列出 bucket（受限的子账号通常如此）。请直接指定：git yunbox init --bucket <名称-APPID> --region <地域> --prefix <前缀>', USAGE_EXIT_CODE)
    throw new CliError(`列出 bucket 失败：${(error as Error).message}`)
  }
}

async function chooseS3Location(
  context: CliContext,
  repo: CliContext,
  root: string,
  values: InitOptions,
  ask: ReturnType<typeof createLineReader>,
  existing: StorageLocation | undefined,
): Promise<S3Location> {
  const previous = existing?.provider === 's3' ? existing : undefined
  let preset = values.preset === undefined ? undefined : S3_PRESETS.find(entry => entry.id === values.preset)
  if (values.preset !== undefined && preset === undefined)
    throw new CliError(`--preset 只能是 ${S3_PRESETS.map(entry => entry.id).join('、')}，不是「${values.preset}」`, USAGE_EXIT_CODE)
  if (preset === undefined && values['account-id'] !== undefined)
    preset = S3_PRESETS.find(entry => entry.id === 'r2')
  let endpoint = values.endpoint
  if (endpoint === undefined && preset === undefined && previous === undefined) {
    const answer = (await askRequired(ask, `存储服务：${S3_PRESETS.map(entry => `${entry.id}（${entry.label}）`).join('、')}，或者直接输入 endpoint 地址 [r2]：`, '--preset 或 --endpoint')) || 'r2'
    if (/^https?:\/\//i.test(answer)) {
      endpoint = answer
    }
    else {
      preset = S3_PRESETS.find(entry => entry.id === answer.toLowerCase())
      if (preset === undefined)
        throw new CliError(`「${answer}」不是 ${S3_PRESETS.map(entry => entry.id).join('、')} 之一，也不是 http(s) 地址`, USAGE_EXIT_CODE)
    }
  }
  // Changing only the bucket or prefix keeps the configured service.
  const fromPrevious = preset === undefined && values.endpoint === undefined ? previous : undefined
  const region = values.region ?? fromPrevious?.region ?? preset?.region ?? 'us-east-1'
  if (endpoint === undefined) {
    if (preset?.endpoint !== undefined) {
      let accountId: string | undefined
      if (preset.id === 'r2') {
        accountId = (values['account-id'] ?? await askRequired(ask, 'Cloudflare 账户 ID（R2 概览页右侧的 Account ID）：', '--account-id')).trim().toLowerCase()
        if (!/^[\da-f]{32}$/.test(accountId))
          throw new CliError('R2 账户 ID 是 32 位十六进制字符，在 Cloudflare 控制台的 R2 概览页可以复制', USAGE_EXIT_CODE)
      }
      endpoint = preset.endpoint({ region, accountId })
    }
    else if (fromPrevious !== undefined) {
      endpoint = fromPrevious.endpoint
    }
    else {
      endpoint = await askRequired(ask, `${preset?.label ?? 'S3'} 的 endpoint 地址（不含 bucket，例如 https://minio.example.com）：`, '--endpoint')
    }
  }
  const addressingStyle = (values.addressing ?? preset?.addressingStyle ?? fromPrevious?.addressingStyle ?? 'path') as AddressingStyle
  const bucket = values.bucket ?? previous?.bucket ?? await askRequired(ask, 'bucket 名称（先在服务的控制台里建好私有 bucket）：', '--bucket')
  const suggested = existing?.prefix || await suggestPrefix(repo, root)
  const prefix = values.prefix ?? ((await askRequired(ask, `bucket 里的目录前缀 [${suggested}]：`, '--prefix')) || suggested)
  let location: S3Location
  try {
    location = normalizeS3Location({ endpoint, bucket, region, prefix, addressingStyle })
  }
  catch (error) {
    throw new CliError((error as Error).message, USAGE_EXIT_CODE)
  }
  if (isR2(location)) {
    printStep(context, {
      status: 'warn',
      title: 'R2 权限范围',
      detail: 'R2 的 API token 只能限定到 bucket，不能限定到前缀：能访问这个 bucket 的 token 可以读写其中所有前缀的素材',
      fixes: ['每个项目单独建一个 R2 bucket，给协作者的 token 只授权这个 bucket 的「对象读和写」（只需要拉取的人给「对象只读」）'],
    })
  }
  return location
}

/** Whether the keys can at least read: a HEAD of a key that never exists answers 404 rather than 403. */
export async function canRead(client: ObjectStore, location: StorageLocation): Promise<boolean> {
  try {
    await client.head(prefixed(location, READ_CHECK_KEY))
    return true
  }
  catch {
    return false
  }
}

/** `yunbox/<owner>/<repo>` from the origin remote, else `yunbox/<directory name>`. */
async function suggestPrefix(repo: CliContext, root: string): Promise<string> {
  const remote = await runGit(repo, ['remote', 'get-url', 'origin'])
  const match = remote.code === 0 ? /[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.stdout.trim()) : null
  const name = match === null ? basename(root) : `${match[1]}/${match[2]}`
  return `yunbox/${name.replace(/[^\w./-]/g, '-')}`
}

/**
 * Desktop bundles use their own CLI; standalone installs prefer the command
 * on PATH (survives upgrades), else this Node.js and script by absolute path.
 */
function resolveAgentCommand(context: CliContext): { path: string, args: string, display: string } {
  // git-lfs starts agents through sh (Git for Windows' sh on Windows), which ignores
  // PATHEXT: only an extension-less `git-yunbox` script works by name. npm and pnpm
  // create one next to the .cmd shim.
  const script = process.argv[1]
  const bundled = script !== undefined && /\.app\/Contents\/Resources\/cli\/cli\.mjs$/.test(script.replaceAll('\\', '/'))
  const onPath = (context.env.PATH ?? '').split(delimiter).some(directory => directory !== '' && existsSync(join(directory, 'git-yunbox')))
  if (!bundled && onPath)
    return { path: 'git-yunbox', args: 'lfs-agent', display: 'git-yunbox lfs-agent' }
  if (script === undefined || !/(?:git-yunbox|yunbox|cli\.m?js)$/.test(script))
    throw new CliError('找不到 git-yunbox 命令。先全局安装 YunBox 命令行（见 README「安装命令行」），再重新运行 git yunbox init')
  // git-lfs quotes the executable itself on every platform, then passes args to sh.
  // Git for Windows also uses sh, so normalize its paths and quote only the args.
  const node = process.platform === 'win32' ? process.execPath.replaceAll('\\', '/') : process.execPath
  const entry = process.platform === 'win32' ? script.replaceAll('\\', '/') : script
  return { path: node, args: `${shellQuote(entry)} lfs-agent`, display: `${basename(node)} ${entry} lfs-agent` }
}
