// @env node

import type { CosBucketSummary } from '@yunbox/core'
import type { CliContext } from '../context.ts'
import type { CosLocation } from '../cos/location.ts'
import type { selectCategories } from '../gitattributes.ts'
import type { InitOptions } from './init.ts'
import { existsSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'
import process from 'node:process'
import { cosAppIdOf, CosRequestError, createCosBucket, listCosBuckets } from '@yunbox/core'
import { CliError, print, USAGE_EXIT_CODE } from '../context.ts'
import { CosDirectClient, PROBE_OPERATIONS } from '../cos/client.ts'
import { requireCredentials } from '../cos/credentials.ts'
import { describeLocation, LEGACY_LOCATION_FILE, LOCATION_FILE, normalizeLocation, readLocation, sameLocation, writeLocation } from '../cos/location.ts'
import { readGitConfig, runGit, runGitChecked } from '../git.ts'
import { askRequired, createLineReader } from '../prompt.ts'
import { printStep } from '../report.ts'
import { AGENT_NAME } from './lfs-agent.ts'

const DEFAULT_REGION = 'ap-guangzhou'

type InstallStep = (context: CliContext, repo: CliContext, root: string, categories: ReturnType<typeof selectCategories> | undefined) => Promise<void>

/**
 * `git yunbox init` in COS mode: no YunBox server. git-lfs hands every object
 * to `git-yunbox lfs-agent`, which uploads and downloads directly with the
 * user's own Tencent Cloud keys. The bucket, region and prefix go into the
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
  const resolved = await requireCredentials(context.env)
  printStep(context, { status: 'pass', title: 'COS 密钥', detail: `来自 ${resolved.description}，只保存在本机，不会写进仓库` })
  if (resolved.source === 'tccli') {
    printStep(context, { status: 'warn', title: 'COS 密钥', detail: '这是 tccli 的临时密钥，大约 2 小时后过期', fixes: ['接入完成后运行 yunbox subaccount create --save，换成只给 YunBox 用的长期子账号密钥'] })
  }
  const { credentials } = resolved
  const ask = createLineReader(context)
  try {
    // 1. Where the objects go: .yunbox/config, options, or an interactive choice.
    const existing = await readLocation(repo, root).catch((error: Error) => {
      throw new CliError(`COS 位置的配置不对：${error.message}`)
    })
    const choosing = values.bucket !== undefined || values.region !== undefined || values.prefix !== undefined || values.create === true || existing === undefined
    let location: CosLocation
    if (!choosing) {
      location = existing!
      printStep(context, { status: 'pass', title: 'COS 位置', detail: `沿用 ${LOCATION_FILE}：${describeLocation(location)}` })
    }
    else {
      location = await chooseLocation(context, repo, root, values, credentials, ask, existing)
      if (existing !== undefined && !sameLocation(existing, location) && !values.force)
        throw new CliError(`${LOCATION_FILE} 里已经配置了 ${describeLocation(existing)}，和 ${describeLocation(location)} 不同。确认要替换时加 --force`)
    }

    // 2. Check access before changing anything in the repository.
    const client = new CosDirectClient(location, () => credentials)
    const steps = await client.probe()
    const writable = steps.length === PROBE_OPERATIONS.length && steps.every(step => step.ok)
    if (writable) {
      printStep(context, { status: 'pass', title: 'COS 权限', detail: `可以在 ${describeLocation(location)} 写入和读取` })
    }
    else if (steps[0]?.operation === 'PUT' && steps[0].status === 403 && await canRead(client, location)) {
      printStep(context, {
        status: values['read-only'] ? 'pass' : 'warn',
        title: 'COS 权限',
        detail: '这把密钥只能读取，可以 pull / clone，不能 push',
        fixes: values['read-only'] ? [] : ['需要推送时，请管理员给你的子账号加上这个前缀的写权限（PutObject）'],
      })
    }
    else {
      const failed = steps.find(step => !step.ok)
      throw new CliError([
        `本机密钥不能访问 ${describeLocation(location)}（${failed?.operation ?? 'PUT'} 返回 ${failed?.status || '无响应'}），仓库没有修改。`,
        '  - 检查 bucket 名称和地域是否正确',
        '  - 确认子账号有这个前缀的 PutObject、GetObject、HeadObject 权限',
        '  - 临时密钥可能已过期：tccli auth login，或 yunbox login 重新保存',
      ].join('\n'))
    }

    // 3. Shared steps, then the COS settings.
    // Joining a repository that is already set up must not change its committed .gitattributes.
    await install(context, repo, root, choosing || values.types !== undefined ? categories : undefined)
    let removedLegacy = false
    if (existing !== undefined && sameLocation(existing, location)) {
      printStep(context, { status: 'pass', title: 'COS 位置', detail: `已是 ${describeLocation(location)}，未修改` })
    }
    else {
      ({ removedLegacy } = await writeLocation(repo, root, location))
      printStep(context, { status: 'pass', title: LOCATION_FILE, detail: `bucket / region / prefix = ${describeLocation(location)}（不含密钥，提交后团队共享）` })
      if (removedLegacy)
        printStep(context, { status: 'pass', title: LEGACY_LOCATION_FILE, detail: `旧版的配置文件已删除，改用 ${LOCATION_FILE}` })
    }
    const leftoverUrl = await readGitConfig(repo, 'lfs.url', join(root, '.lfsconfig'))
    if (leftoverUrl !== undefined) {
      printStep(context, {
        status: 'warn',
        title: 'lfs.url',
        detail: `.lfsconfig 里还有服务端模式的 lfs.url（${leftoverUrl}）；直连 COS 时不会用到它`,
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
    printStep(context, { status: 'pass', title: '传输代理', detail: `本仓库的 git-lfs 改用 ${agent.display} 直连 COS（写在 .git/config，只对这份 clone 生效）` })

    print(context)
    print(context, '下一步：')
    print(context, `  git add .gitattributes ${LOCATION_FILE}${removedLegacy ? ` ${LEGACY_LOCATION_FILE}` : ''}`)
    print(context, '  git commit -m "chore: 用 YunBox 把 LFS 素材直传到 COS"')
    print(context, '  git push')
    print(context)
    print(context, '协作者：安装 YunBox 命令行，用 yunbox login 保存自己的子账号密钥，然后')
    print(context, '  git yunbox clone <仓库地址>      # 新 clone')
    print(context, '  git yunbox init && git lfs pull  # 已有的 clone')
    return 0
  }
  finally {
    ask.close()
  }
}

async function chooseLocation(
  context: CliContext,
  repo: CliContext,
  root: string,
  values: InitOptions,
  credentials: Parameters<typeof listCosBuckets>[0]['credentials'],
  ask: ReturnType<typeof createLineReader>,
  existing: CosLocation | undefined,
): Promise<CosLocation> {
  const endpoint = context.env.YUNBOX_COS_ENDPOINT || undefined
  const serviceEndpoint = context.env.YUNBOX_COS_SERVICE_ENDPOINT || undefined
  let bucket = values.bucket
  let region = values.region
  let create = values.create === true
  let buckets: CosBucketSummary[] | undefined

  if (bucket === undefined) {
    buckets = await listBuckets(credentials, serviceEndpoint)
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
    buckets ??= await listBuckets(credentials, serviceEndpoint)
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
    buckets ??= await listBuckets(credentials, serviceEndpoint)
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
    await createCosBucket(location.bucket, location.region, { credentials, endpoint })
    printStep(context, { status: 'pass', title: '新建 bucket', detail: `${location.bucket}（${location.region}），私有读写` })
  }
  return location
}

async function listBuckets(credentials: Parameters<typeof listCosBuckets>[0]['credentials'], endpoint: string | undefined): Promise<CosBucketSummary[]> {
  try {
    return await listCosBuckets({ credentials, endpoint })
  }
  catch (error) {
    if (error instanceof CosRequestError && error.status === 403)
      throw new CliError('这把密钥不能列出 bucket（受限的子账号通常如此）。请直接指定：git yunbox init --bucket <名称-APPID> --region <地域> --prefix <前缀>', USAGE_EXIT_CODE)
    throw new CliError(`列出 bucket 失败：${(error as Error).message}`)
  }
}

async function canRead(client: CosDirectClient, location: CosLocation): Promise<boolean> {
  try {
    await client.head(`${location.prefix === '' ? '' : `${location.prefix}/`}_yunbox/read-check`)
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
 * How git-lfs should start the agent: `git-yunbox lfs-agent` when it is on
 * PATH (survives upgrades), else this Node.js and script by absolute path.
 */
function resolveAgentCommand(context: CliContext): { path: string, args: string, display: string } {
  // git-lfs starts agents through sh (Git for Windows' sh on Windows), which ignores
  // PATHEXT: only an extension-less `git-yunbox` script works by name. npm and pnpm
  // create one next to the .cmd shim.
  const onPath = (context.env.PATH ?? '').split(delimiter).some(directory => directory !== '' && existsSync(join(directory, 'git-yunbox')))
  if (onPath)
    return { path: 'git-yunbox', args: 'lfs-agent', display: 'git-yunbox lfs-agent' }
  const script = process.argv[1]
  if (script === undefined || !/(?:git-yunbox|yunbox|cli\.m?js)$/.test(script))
    throw new CliError('找不到 git-yunbox 命令。先全局安装 YunBox 命令行（见 README「安装命令行」），再重新运行 git yunbox init')
  if (process.platform === 'win32') {
    // sh joins path and args into one command line: quote both and use forward slashes.
    const node = process.execPath.replaceAll('\\', '/')
    return { path: `"${node}"`, args: `"${script.replaceAll('\\', '/')}" lfs-agent`, display: `${node} ${script} lfs-agent` }
  }
  return { path: process.execPath, args: `"${script}" lfs-agent`, display: `${basename(process.execPath)} ${script} lfs-agent` }
}
