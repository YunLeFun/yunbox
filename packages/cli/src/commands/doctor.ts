import type { CliContext } from '../context.ts'
import type { StoredCredential } from '../credentials.ts'
import type { ProbeResult } from '../probe.ts'
import type { StepReport } from '../report.ts'
import type { ServiceUrl } from '../service-url.ts'
import { parseArgs } from 'node:util'
import { CliError, print, USAGE_EXIT_CODE } from '../context.ts'
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

export const doctorHelp = `用法：yunbox doctor [选项]

逐项检查当前仓库能否通过 YunBox 拉取和推送 LFS 素材：git 和 git-lfs 版本、
是否在 Git 仓库里、lfs.url、HTTPS、Git 凭据、服务连通性，以及读写权限。
每个失败项都附带可以直接照做的修复命令。全部通过时退出码为 0，否则为 1。

读写权限通过两次 batch 请求试探（download 和 upload 各一次），不会上传或修改任何数据。

选项：
  --read-only   只需要拉取素材时使用：不要求写权限
  -h, --help    显示帮助
`

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
    printStep(context, step)
  }
  await diagnose(context, report, values['read-only'] ?? false)
  const failures = steps.filter(step => step.status === 'fail').length
  print(context)
  if (failures === 0) {
    print(context, values['read-only'] ? '全部检查通过，可以拉取素材。' : '全部检查通过，可以推送和拉取素材。')
    return 0
  }
  print(context, `${failures} 项检查未通过，按上面的修复命令处理后重新运行 yunbox doctor。`)
  return 1
}

async function diagnose(context: CliContext, report: (step: StepReport) => void, readOnly: boolean): Promise<void> {
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

  const configured = await readLfsUrl(repo, root)
  if (configured === undefined) {
    report({
      status: 'fail',
      title: 'lfs.url',
      detail: '没有配置，git-lfs 会把素材推到代码托管平台自带的 LFS',
      fixes: ['git yunbox init --url https://<YunBox 服务地址>/<owner>/<repo>'],
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

function parseDoctorArgs(args: string[]): { 'read-only'?: boolean, 'help'?: boolean } {
  try {
    return parseArgs({
      args,
      options: {
        'read-only': { type: 'boolean' },
        'help': { type: 'boolean', short: 'h' },
      },
    }).values
  }
  catch (error) {
    throw new CliError(`${(error as Error).message}\n运行 yunbox doctor --help 查看用法`, USAGE_EXIT_CODE)
  }
}
