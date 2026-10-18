import type { CliContext } from '../context.ts'
import type { CosLocation } from '../cos/location.ts'
import type { StoredCredential } from '../credentials.ts'
import type { ProbeResult } from '../probe.ts'
import type { StepReport } from '../report.ts'
import type { ServiceUrl } from '../service-url.ts'
import { parseArgs } from 'node:util'
import { CliError, print, USAGE_EXIT_CODE } from '../context.ts'
import { CosDirectClient, PROBE_OPERATIONS } from '../cos/client.ts'
import { resolveCredentials } from '../cos/credentials.ts'
import { describeLocation, readLocation } from '../cos/location.ts'
import { defaultSecretStores } from '../cos/secret-store.ts'
import { fillCredential, findCredentialHelper, rejectCommand, suggestedHelperCommands } from '../credentials.ts'
import {
  compareVersions,
  detectGitLfsVersion,
  detectGitVersion,
  findRepositoryRoot,
  MIN_GIT_LFS_VERSION,
  MIN_GIT_VERSION,
  readGitConfig,
  readGitConfigForUrl,
  readLfsUrl,
  shellQuote,
} from '../git.ts'
import { gitInstallHints, gitLfsInstallHints } from '../install-hints.ts'
import { probeBatch } from '../probe.ts'
import { printStep } from '../report.ts'
import { isSecureServiceUrl, parseServiceUrl, ServiceUrlError } from '../service-url.ts'
import { AGENT_NAME } from './lfs-agent.ts'

export const doctorHelp = `用法：yunbox doctor [选项]

逐项检查当前仓库能否通过 YunBox 拉取和推送 LFS 素材：git 和 git-lfs 版本、
是否在 Git 仓库里、lfs.url、HTTPS、Git 凭据、服务连通性，以及读写权限。
每个失败项都附带可以直接照做的修复命令。全部通过时退出码为 0，否则为 1。

读写权限通过两次 batch 请求试探（download 和 upload 各一次），不会上传或修改任何数据。

选项：
  --read-only   只需要拉取素材时使用：不要求写权限
  --json        只输出一个 JSON 对象（schemaVersion 1），供图形界面等工具读取
  -h, --help    显示帮助
`

/** What `yunbox doctor --json` prints. */
export interface DoctorJson {
  schemaVersion: 1
  status: 'ok' | 'failed'
  /** How this repository uses YunBox: direct COS, a YunBox server, or not set up. */
  mode: 'cos' | 'server' | 'none'
  location?: { bucket: string, region: string, prefix: string }
  steps: StepReport[]
}

/** Facts `diagnose` learns on the way, for the JSON output. */
interface DoctorSummary {
  mode: DoctorJson['mode']
  location?: CosLocation
}

/** Run `yunbox doctor`. Returns 0 when every check passes, otherwise 1. */
export async function runDoctor(context: CliContext, args: string[]): Promise<number> {
  const values = parseDoctorArgs(args)
  if (values.help) {
    context.stdout.write(doctorHelp)
    return 0
  }
  const steps: StepReport[] = []
  const report = (step: StepReport): void => {
    steps.push(step)
    if (!values.json)
      printStep(context, step)
  }
  const summary: DoctorSummary = { mode: 'none' }
  await diagnose(context, report, values['read-only'] ?? false, summary)
  const failures = steps.filter(step => step.status === 'fail').length
  if (values.json) {
    const output: DoctorJson = {
      schemaVersion: 1,
      status: failures === 0 ? 'ok' : 'failed',
      mode: summary.mode,
      ...(summary.location === undefined ? {} : { location: { bucket: summary.location.bucket, region: summary.location.region, prefix: summary.location.prefix } }),
      steps,
    }
    context.stdout.write(`${JSON.stringify(output)}\n`)
    return failures === 0 ? 0 : 1
  }
  print(context)
  if (failures === 0) {
    print(context, values['read-only'] ? '全部检查通过，可以拉取素材。' : '全部检查通过，可以推送和拉取素材。')
    return 0
  }
  print(context, `${failures} 项检查未通过，按上面的修复命令处理后重新运行 yunbox doctor。`)
  return 1
}

async function diagnose(context: CliContext, report: (step: StepReport) => void, readOnly: boolean, summary: DoctorSummary): Promise<void> {
  const git = await detectGitVersion(context)
  if (!git.found) {
    report({ status: 'fail', title: 'git', detail: git.reason, fixes: gitInstallHints() })
    report({ status: 'skip', title: '其余检查', detail: '需要先安装 git' })
    return
  }
  report(compareVersions(git.version, MIN_GIT_VERSION) < 0
    ? { status: 'fail', title: 'git', detail: `${git.version} 太旧，需要 ${MIN_GIT_VERSION} 或更新`, fixes: gitInstallHints() }
    : { status: 'pass', title: 'git', detail: git.version })

  const lfs = await detectGitLfsVersion(context)
  if (!lfs.found)
    report({ status: 'fail', title: 'git-lfs', detail: lfs.reason, fixes: gitLfsInstallHints() })
  else if (compareVersions(lfs.version, MIN_GIT_LFS_VERSION) < 0)
    report({ status: 'fail', title: 'git-lfs', detail: `${lfs.version} 太旧，需要 ${MIN_GIT_LFS_VERSION} 或更新`, fixes: gitLfsInstallHints() })
  else
    report({ status: 'pass', title: 'git-lfs', detail: lfs.version })

  const root = await findRepositoryRoot(context)
  if (root === undefined) {
    report({ status: 'fail', title: 'Git 仓库', detail: '当前目录不在 Git 仓库里', fixes: ['cd <你的仓库目录>   # 然后重新运行 yunbox doctor'] })
    return
  }
  report({ status: 'pass', title: 'Git 仓库', detail: root })
  const repo: CliContext = { ...context, cwd: root }

  if (lfs.found) {
    const lfsFilter = await readGitConfig(repo, 'filter.lfs.process')
    report(lfsFilter === undefined
      ? { status: 'fail', title: 'LFS 过滤器', detail: '没有启用，git 会把素材当普通文件提交', fixes: ['git lfs install'] }
      : { status: 'pass', title: 'LFS 过滤器', detail: '已启用' })
  }

  let location: CosLocation | undefined
  try {
    location = await readLocation(repo, root)
  }
  catch (error) {
    report({ status: 'fail', title: '.yunboxconfig', detail: (error as Error).message, fixes: ['git yunbox init --cos --force   # 重新选择 bucket 和前缀'] })
    return
  }
  if (location !== undefined) {
    summary.mode = 'cos'
    summary.location = location
    await diagnoseCos(repo, location, report, readOnly)
    return
  }

  const configured = await readLfsUrl(repo, root)
  if (configured !== undefined)
    summary.mode = 'server'
  if (configured === undefined) {
    report({
      status: 'fail',
      title: 'YunBox',
      detail: '这个仓库还没有接入 YunBox，git-lfs 会把素材推到代码托管平台自带的 LFS',
      fixes: ['git yunbox init   # 直连 COS（推荐）', 'git yunbox init --url https://<YunBox 服务地址>/<owner>/<repo>   # 使用服务端'],
    })
    return
  }
  let service: ServiceUrl
  try {
    service = parseServiceUrl(configured.url)
  }
  catch (error) {
    if (!(error instanceof ServiceUrlError))
      throw error
    report({
      status: 'fail',
      title: 'lfs.url',
      detail: `${redactUrl(configured.url)}（来自 ${configured.source}）不可用：${error.message}`,
      fixes: [configured.source === '.lfsconfig'
        ? 'git yunbox init --force --url https://<YunBox 服务地址>/<owner>/<repo>'
        : 'git config --unset lfs.url   # 然后运行 git yunbox init --url ...'],
    })
    return
  }
  report({ status: 'pass', title: 'lfs.url', detail: `${service.url}（来自 ${configured.source}）` })
  if (configured.shadowed !== undefined) {
    report({
      status: 'warn',
      title: 'lfs.url',
      detail: `git config 里的值覆盖了 .lfsconfig 里的 ${configured.shadowed}，其他协作者用的是 .lfsconfig`,
      fixes: ['git config --unset lfs.url   # 全局设置加 --global'],
    })
  }

  if (!isSecureServiceUrl(service)) {
    report({
      status: 'fail',
      title: 'HTTPS',
      detail: `${service.host} 不是本机地址却使用 http，token 会明文传输`,
      fixes: [`git yunbox init --force --url ${shellQuote(service.url.replace(/^http:/, 'https:'))}`],
    })
    report({ status: 'skip', title: '凭据、连通性和读写权限', detail: '为避免明文发送 token，改用 https 之后再检查' })
    return
  }
  report({ status: 'pass', title: 'HTTPS', detail: service.protocol === 'https' ? '使用 https' : '本机地址，允许 http' })

  const locksVerify = await readGitConfigForUrl(repo, 'lfs.locksverify', service.url)
  report(locksVerify === 'false'
    ? { status: 'pass', title: 'lfs.locksverify', detail: 'false（YunBox 还没有实现文件锁）' }
    : { status: 'warn', title: 'lfs.locksverify', detail: '没有设为 false，每次 push 都会提示服务器不支持文件锁', fixes: ['git config lfs.locksverify false'] })

  const credential = await checkCredential(repo, service, report)
  const anonymous = await probeBatch(service, 'download')
  if (!reportConnectivity(service, anonymous, report))
    return
  if (credential === undefined) {
    report({ status: 'skip', title: '读写权限', detail: '缺少凭据' })
    return
  }
  const read = await probeBatch(service, 'download', credential.password)
  const readable = reportPermission(service, 'read', read, report)
  if (!readable) {
    report({ status: 'skip', title: '写权限', detail: '读权限检查没有通过' })
    return
  }
  const write = await probeBatch(service, 'upload', credential.password)
  if (readOnly) {
    const writable = write.kind === 'response' && write.status === 200
    report({ status: 'pass', title: '写权限', detail: writable ? '有（--read-only 模式不要求）' : '没有（--read-only 模式不要求）' })
    return
  }
  reportPermission(service, 'write', write, report)
}

async function checkCredential(context: CliContext, service: ServiceUrl, report: (step: StepReport) => void): Promise<StoredCredential | undefined> {
  const helper = await findCredentialHelper(context, service)
  const credential = await fillCredential(context, service)
  if (credential !== undefined) {
    report({ status: 'pass', title: '凭据', detail: `Git 凭据管理器里有 ${service.host} 的 token${helper === undefined ? '' : `（${helper}）`}` })
    return credential
  }
  const fixes = helper === undefined
    ? [...suggestedHelperCommands(), 'git yunbox init   # 配置好凭据管理器后运行，按提示输入 token']
    : ['git yunbox init   # 按提示输入 token', 'pbpaste | git yunbox init --token-stdin   # macOS 从剪贴板读取']
  report({
    status: 'fail',
    title: '凭据',
    detail: helper === undefined
      ? '没有配置 Git 凭据管理器，token 无法保存'
      : `凭据管理器（${helper}）里没有 ${service.host} 的 token`,
    fixes,
  })
  return undefined
}

/** Report whether the service answered like a Git LFS server; returns false when later probes are pointless. */
function reportConnectivity(service: ServiceUrl, result: ProbeResult, report: (step: StepReport) => void): boolean {
  if (result.kind === 'network-error') {
    report({
      status: 'fail',
      title: '服务连通性',
      detail: `${service.origin} ${result.message}`,
      fixes: [`curl -sS -o /dev/null -w '%{http_code}\\n' ${shellQuote(`${service.origin}/`)}   # 确认网络和地址；地址错了就重新运行 git yunbox init --force --url ...`],
    })
    return false
  }
  if (result.status >= 300 && result.status < 400) {
    report({
      status: 'fail',
      title: '服务连通性',
      detail: `${service.url} 返回 HTTP ${result.status} 重定向${result.location === undefined ? '' : `到 ${result.location}`}`,
      fixes: ['git yunbox init --force --url <重定向后的地址>   # git-lfs 和 yunbox 都不会把 token 发给重定向后的地址'],
    })
    return false
  }
  if (!result.lfs || result.status === 404) {
    report({
      status: 'fail',
      title: '服务连通性',
      detail: `${service.url} 能连上，但不是 Git LFS 服务（HTTP ${result.status}）`,
      fixes: ['检查 lfs.url 是否为 <YunBox 服务地址>/<owner>/<repo>，然后运行 git yunbox init --force --url <正确地址>'],
    })
    return false
  }
  if (result.status === 401 || result.status === 200) {
    report({ status: 'pass', title: '服务连通性', detail: `${service.origin} 响应正常` })
    return true
  }
  report({
    status: 'fail',
    title: '服务连通性',
    detail: `${service.origin} 返回 HTTP ${result.status}${describeServerMessage(result)}`,
    fixes: [result.status >= 500 ? '稍后重试；一直失败时把 request_id 发给管理员查看服务端日志' : '把上面的信息发给管理员'],
  })
  return false
}

/** Report one permission probe; returns whether access was granted. */
function reportPermission(service: ServiceUrl, access: 'read' | 'write', result: ProbeResult, report: (step: StepReport) => void): boolean {
  const title = access === 'read' ? '读权限' : '写权限'
  const repository = `${service.owner}/${service.repo}`
  if (result.kind === 'network-error') {
    report({ status: 'fail', title, detail: result.message, fixes: ['检查网络后重新运行 yunbox doctor'] })
    return false
  }
  if (result.status === 200) {
    report({ status: 'pass', title, detail: access === 'read' ? `可以从 ${repository} 拉取素材` : `可以向 ${repository} 推送素材` })
    return true
  }
  if (result.status === 401) {
    report({
      status: 'fail',
      title,
      detail: `token 无效、已过期或已被吊销（HTTP 401）${describeServerMessage(result)}`,
      fixes: [
        `${rejectCommand(service)}   # 删除旧 token`,
        '向管理员要一个新 token，然后运行 git yunbox init 按提示输入',
      ],
    })
    return false
  }
  if (result.status === 403) {
    report({
      status: 'fail',
      title,
      detail: access === 'read'
        ? `token 没有 ${repository} 的权限（HTTP 403）${describeServerMessage(result)}`
        : `token 对 ${repository} 只有读权限（HTTP 403）${describeServerMessage(result)}`,
      fixes: access === 'read'
        ? [`请管理员创建有权限的 token：yunbox-server token create --name <你的名字> --write ${shellQuote(repository)}`, '然后运行 git yunbox init --token-stdin 换上新 token']
        : [
            '只需要拉取素材时，运行 yunbox doctor --read-only',
            `需要推送时，请管理员创建可写的 token：yunbox-server token create --name <你的名字> --write ${shellQuote(repository)}`,
            '然后运行 git yunbox init --token-stdin 换上新 token',
          ],
    })
    return false
  }
  report({
    status: 'fail',
    title,
    detail: `服务端返回 HTTP ${result.status}${describeServerMessage(result)}`,
    fixes: ['稍后重试；一直失败时把 request_id 发给管理员查看服务端日志'],
  })
  return false
}

function describeServerMessage(result: Extract<ProbeResult, { kind: 'response' }>): string {
  if (result.message === undefined && result.requestId === undefined)
    return ''
  const requestId = result.requestId === undefined ? '' : `（request_id=${result.requestId}）`
  return `。服务端返回：${result.message ?? ''}${requestId}`
}

/** Hide credentials if someone did put them in the URL. */
function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.username !== '' || url.password !== '') {
      url.username = '***'
      url.password = ''
    }
    url.search = ''
    return url.toString()
  }
  catch {
    return value
  }
}

/** Checks for COS mode: the agent registration, local keys and access to the prefix. */
async function diagnoseCos(repo: CliContext, location: CosLocation, report: (step: StepReport) => void, readOnly: boolean): Promise<void> {
  report({ status: 'pass', title: 'COS 位置', detail: `${describeLocation(location)}（来自 .yunboxconfig）` })
  const agent = await readGitConfig(repo, 'lfs.standalonetransferagent')
  const agentPath = await readGitConfig(repo, `lfs.customtransfer.${AGENT_NAME}.path`)
  report(agent === AGENT_NAME && agentPath !== undefined
    ? { status: 'pass', title: '传输代理', detail: `git-lfs 通过 ${agentPath} 直连 COS` }
    : { status: 'fail', title: '传输代理', detail: '这份 clone 还没有登记直连 COS 的传输代理，push / pull 会失败', fixes: ['git yunbox init'] })
  if (await readGitConfig(repo, 'lfs.locksverify') !== 'false') {
    report({ status: 'warn', title: 'lfs.locksverify', detail: '直连模式没有文件锁服务，push 时 git-lfs 可能去代码托管平台查询锁', fixes: ['git config lfs.locksverify false'] })
  }

  let resolved: Awaited<ReturnType<typeof resolveCredentials>>
  try {
    resolved = await resolveCredentials(repo.env)
  }
  catch (error) {
    report({ status: 'fail', title: 'COS 密钥', detail: (error as Error).message, fixes: ['yunbox login', 'tccli auth login'] })
    return
  }
  if (resolved === undefined) {
    report({ status: 'fail', title: 'COS 密钥', detail: '这台电脑还没有配置腾讯云密钥', fixes: ['yunbox login   # 保存自己的子账号 SecretId / SecretKey'] })
    return
  }
  // resolveCredentials already validated YUNBOX_CREDENTIAL_STORE, so this cannot throw.
  if (resolved.source === 'file' && defaultSecretStores(repo.env).some(store => store.kind === 'keychain'))
    report({ status: 'warn', title: 'COS 密钥', detail: `来自 ${resolved.description}（明文文件）`, fixes: ['yunbox login   # 重新保存到 macOS 钥匙串，会删除这个文件'] })
  else if (resolved.source === 'tccli')
    report({ status: 'warn', title: 'COS 密钥', detail: `来自 ${resolved.description}：临时密钥，大约 2 小时后要重新登录`, fixes: ['yunbox subaccount create --save   # 用当前登录新建只给 YunBox 用的子账号，长期密钥存进本机'] })
  else
    report({ status: 'pass', title: 'COS 密钥', detail: `来自 ${resolved.description}` })

  const client = new CosDirectClient(location, () => resolved.credentials)
  const steps = await client.probe()
  if (steps.length === PROBE_OPERATIONS.length && steps.every(step => step.ok)) {
    report({ status: 'pass', title: 'COS 权限', detail: '可以写入和读取' })
    return
  }
  const failed = steps.find(step => !step.ok)
  if (failed?.operation === 'PUT' && failed.status === 403) {
    const readable = await client.head(`${location.prefix === '' ? '' : `${location.prefix}/`}_yunbox/read-check`).then(() => true, () => false)
    if (readable) {
      report(readOnly
        ? { status: 'pass', title: 'COS 权限', detail: '只读：可以拉取' }
        : { status: 'fail', title: 'COS 权限', detail: '只能读取，不能推送', fixes: ['请管理员给你的子账号加上这个前缀的 PutObject 权限；只需要拉取时用 yunbox doctor --read-only'] })
      return
    }
  }
  report({
    status: 'fail',
    title: 'COS 权限',
    detail: `${failed?.operation ?? 'PUT'} 返回 ${failed?.status || '无响应'}`,
    fixes: ['检查 .yunboxconfig 里的 bucket 和 region', '确认子账号有这个前缀的 PutObject、GetObject、HeadObject 权限', 'yunbox login   # 密钥失效时重新保存'],
  })
}

function parseDoctorArgs(args: string[]): { 'read-only'?: boolean, 'json'?: boolean, 'help'?: boolean } {
  try {
    return parseArgs({
      args,
      options: {
        'read-only': { type: 'boolean' },
        'json': { type: 'boolean' },
        'help': { type: 'boolean', short: 'h' },
      },
    }).values
  }
  catch (error) {
    throw new CliError(`${(error as Error).message}\n运行 yunbox doctor --help 查看用法`, USAGE_EXIT_CODE)
  }
}
