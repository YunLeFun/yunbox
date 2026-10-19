import type { CliContext } from '../context.ts'
import type { ServiceUrl } from '../service-url.ts'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { CliError, print, USAGE_EXIT_CODE } from '../context.ts'
import { locationFiles } from '../cos/location.ts'
import { approveCredential, assertTokenShape, fillCredential, findCredentialHelper, suggestedHelperCommands } from '../credentials.ts'
import {
  compareVersions,
  detectGitLfsVersion,
  detectGitVersion,
  findRepositoryRoot,
  firstLine,
  MIN_GIT_LFS_VERSION,
  MIN_GIT_VERSION,
  readGitConfig,
  runGit,
  runGitChecked,
  shellQuote,
} from '../git.ts'
import { ASSET_CATEGORIES, mergeGitAttributes, selectCategories } from '../gitattributes.ts'
import { gitInstallHints, gitLfsInstallHints } from '../install-hints.ts'
import { printStep } from '../report.ts'
import { isSecureServiceUrl, parseServiceUrl, ServiceUrlError } from '../service-url.ts'
import { promptForToken, readTokenFromStdin } from '../token-input.ts'
import { runInitCos } from './init-cos.ts'

export const initHelp = `用法：git yunbox init [选项]

在当前 Git 仓库里接入 YunBox。默认直连 COS，不需要任何服务端：
  1. 检查 git 和 git-lfs 版本，执行 git lfs install
  2. 选择 COS bucket（或新建私有 bucket）和目录前缀，写进 .yunbox/config（不含密钥，提交后团队共享）
  3. 用本机密钥检查能否在这个前缀写入和读取
  4. 按素材类型生成或合并 .gitattributes（已有规则不会重复添加）
  5. 在本仓库的 .git/config 登记传输代理：git-lfs 用 git-yunbox lfs-agent 直接上传下载
  6. 设置 lfs.locksverify=false（直连模式没有文件锁服务）

.yunbox/config（或旧版的 .yunboxconfig）已存在时（例如别人已经接入、你刚 clone 下来）不会再提问，只做第 3、5、6 步。
可以重复执行，不会破坏已有配置。密钥用 yunbox login 保存在本机，不会写进仓库。

直连 COS 的选项：
  --bucket <名称>    bucket 名称（包含 -APPID），不提供时列出账号下的 bucket 让你选
  --region <地域>    bucket 地域，例如 ap-guangzhou；选已有 bucket 时自动识别
  --prefix <前缀>    bucket 里的目录前缀，默认 yunbox/<owner>/<repo>；多个项目可以共用一个 bucket
  --create           新建私有 bucket（会先确认，--yes 跳过确认）
  --read-only        只需要拉取：密钥没有写权限时不提示警告
  --yes, -y          跳过确认
  --force            .yunbox/config 或 .lfsconfig 里已有不同的配置时替换它

服务端模式（使用 YunBox 服务端和个人 token）：
  --url <地址>       YunBox 仓库地址，例如 https://lfs.example.com/team/assets；
                     .lfsconfig 里已有 lfs.url 时可以省略
  --token-stdin      从标准输入读取 token，例如 pbpaste | git yunbox init --token-stdin
  --skip-credential  不配置 token

通用选项：
  --types <类型>     只跟踪这些素材类型，逗号分隔（默认全部）：
                     ${ASSET_CATEGORIES.map(category => `${category.id}（${category.label}）`).join('、')}
  -h, --help         显示帮助
`

const LOCKS_REASON = 'YunBox G1 还没有实现 Git LFS 文件锁（Locks API）。试点期间同一个素材同一时间只能由一个人编辑，提交前先在团队里说一声'

/** Run `git yunbox init`. Returns the process exit code. */
export async function runInit(context: CliContext, args: string[]): Promise<number> {
  const values = parseInitArgs(args)
  if (values.help) {
    context.stdout.write(initHelp)
    return 0
  }

  await assertTools(context)
  const root = await findRepositoryRoot(context)
  if (root === undefined)
    throw new CliError('当前目录不在 Git 仓库里。先进入仓库目录，或用 git init 新建一个仓库后再运行 git yunbox init')
  const repo: CliContext = { ...context, cwd: root }

  // Validate everything before touching the repository.
  const lfsConfigPath = join(root, '.lfsconfig')
  const currentUrl = await readGitConfig(repo, 'lfs.url', lfsConfigPath)
  const cosOptions = values.bucket !== undefined || values.region !== undefined || values.prefix !== undefined || values.create === true
  let hasCosLocation = false
  for (const file of locationFiles(root))
    hasCosLocation ||= await readGitConfig(repo, 'cos.bucket', join(root, file)) !== undefined
  if (values.cos === true || cosOptions || (values.url === undefined && (hasCosLocation || currentUrl === undefined))) {
    if (values.url !== undefined)
      throw new CliError('--url（服务端模式）和 --cos（直连 COS）只能选一个', USAGE_EXIT_CODE)
    return await runInitCos(context, repo, root, values, parseCategories(values.types), installLfsAndAttributes)
  }
  const service = resolveService(values.url ?? currentUrl)
  if (currentUrl !== undefined && currentUrl !== service.url && !values.force) {
    throw new CliError(`.lfsconfig 里的 lfs.url 已经是 ${currentUrl}，和 ${service.url} 不同。确认要替换时加 --force`)
  }
  const categories = parseCategories(values.types)
  let token: string | undefined
  if (values['token-stdin']) {
    token = await readTokenFromStdin(context)
    assertToken(token)
  }

  await installLfsAndAttributes(context, repo, root, categories)

  if (currentUrl === service.url) {
    printStep(context, { status: 'pass', title: '.lfsconfig', detail: `lfs.url 已是 ${service.url}，未修改` })
  }
  else {
    await runGitChecked(repo, ['config', '--file', lfsConfigPath, 'lfs.url', service.url])
    printStep(context, { status: 'pass', title: '.lfsconfig', detail: `lfs.url = ${service.url}` })
  }
  const overriding = await readGitConfig(repo, 'lfs.url')
  if (overriding !== undefined && overriding !== service.url) {
    printStep(context, {
      status: 'warn',
      title: 'lfs.url',
      detail: `git config 里的 lfs.url（${overriding}）会覆盖 .lfsconfig`,
      fixes: ['git config --unset lfs.url   # 在仓库里执行；如果是全局设置，加 --global'],
    })
  }

  if (await readGitConfig(repo, 'lfs.locksverify') !== 'false')
    await runGitChecked(repo, ['config', '--local', 'lfs.locksverify', 'false'])
  printStep(context, { status: 'pass', title: 'lfs.locksverify=false', detail: LOCKS_REASON })

  const credentialStored = await configureCredential(repo, service, token, values['skip-credential'])

  print(context)
  print(context, '下一步：')
  print(context, '  git add .gitattributes .lfsconfig')
  print(context, '  git commit -m "chore: 用 YunBox 管理 LFS 素材"')
  if (!credentialStored)
    print(context, '  git yunbox init   # 在终端里重新运行，按提示输入 token')
  print(context, '  yunbox doctor     # 检查连通性和读写权限')
  return 0
}

/** `git lfs install` plus merging the asset rules into `.gitattributes`; shared by both modes. */
export async function installLfsAndAttributes(context: CliContext, repo: CliContext, root: string, categories: ReturnType<typeof selectCategories> | undefined): Promise<void> {
  const install = await runGit(repo, ['lfs', 'install'])
  if (install.code !== 0) {
    const reason = firstLine(install.stderr) || firstLine(install.stdout)
    const hint = /hook already exists/i.test(`${install.stdout}${install.stderr}`)
      ? '仓库里已有其他工具的 Git 钩子。运行 git lfs update --manual，按提示把 git-lfs 的命令加进已有钩子后重试'
      : '按上面的错误修复后重新运行 git yunbox init'
    throw new CliError(`git lfs install 失败：${reason}\n${hint}`)
  }
  printStep(context, { status: 'pass', title: 'git lfs install', detail: '已启用 LFS 过滤器和本仓库的钩子' })

  if (categories === undefined) {
    printStep(context, { status: 'skip', title: '.gitattributes', detail: '沿用仓库里已有的规则，未修改（要追加素材类型：加 --types）' })
    return
  }
  const attributesPath = join(root, '.gitattributes')
  const existingAttributes = await readFile(attributesPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return ''
    throw error
  })
  const merge = mergeGitAttributes(existingAttributes, categories)
  if (merge.content !== existingAttributes)
    await writeFile(attributesPath, merge.content)
  const addedCount = [...merge.added.values()].reduce((sum, patterns) => sum + patterns.length, 0)
  printStep(context, {
    status: 'pass',
    title: '.gitattributes',
    detail: addedCount === 0
      ? '已包含全部素材规则，未修改'
      : `新增 ${addedCount} 条规则（${categories.filter(category => merge.added.has(category.id)).map(category => `${category.label} ${merge.added.get(category.id)!.length}`).join('、')}）`,
  })
  if (merge.keptNonLfs.length > 0) {
    printStep(context, {
      status: 'warn',
      title: '.gitattributes',
      detail: `这些扩展名已有不走 LFS 的规则，保持不变：${merge.keptNonLfs.join(' ')}`,
      fixes: ['确实需要用 LFS 管理时，手动把对应规则改成 filter=lfs diff=lfs merge=lfs -text'],
    })
  }
}

function parseCategories(types: string[] | undefined): ReturnType<typeof selectCategories> {
  try {
    return selectCategories(types)
  }
  catch (error) {
    throw new CliError((error as Error).message, USAGE_EXIT_CODE)
  }
}

/** Store the token, keep an existing credential, or explain how to add one later. Returns whether a credential is in place. */
async function configureCredential(context: CliContext, service: ServiceUrl, piped: string | undefined, skip: boolean | undefined): Promise<boolean> {
  if (skip) {
    printStep(context, { status: 'skip', title: '凭据', detail: '按 --skip-credential 跳过' })
    return false
  }
  const existing = await fillCredential(context, service)
  let token = piped
  if (token === undefined) {
    if (existing !== undefined) {
      printStep(context, { status: 'pass', title: '凭据', detail: `Git 凭据管理器里已有 ${service.host} 的凭据，未修改（要换 token：加 --token-stdin）` })
      return true
    }
    token = await promptForToken(context, `请输入 ${service.host} 的 YunBox token（输入不显示，直接回车跳过）：`)
    if (token === undefined) {
      printStep(context, {
        status: 'warn',
        title: '凭据',
        detail: `还没有保存 ${service.host} 的 token，push 和 pull 时 Git 会提示输入`,
        fixes: [
          'git yunbox init   # 在终端里运行，按提示输入 token',
          'pbpaste | git yunbox init --token-stdin   # macOS 从剪贴板读取',
        ],
      })
      return false
    }
    assertToken(token)
  }

  const helper = await findCredentialHelper(context, service)
  if (helper === undefined) {
    throw new CliError([
      '没有配置 Git 凭据管理器，token 无法保存。先配置一个，再重新运行 git yunbox init：',
      ...suggestedHelperCommands().map(command => `  ${command}`),
    ].join('\n'))
  }
  await approveCredential(context, service, token, existing)
  const stored = await fillCredential(context, service)
  if (stored?.password !== token) {
    printStep(context, {
      status: 'warn',
      title: '凭据',
      detail: `已交给凭据管理器（${helper}），但读回来的不是刚才的 token`,
      fixes: [`git config --show-origin --get-all credential.helper   # 检查是否有其他凭据管理器优先`],
    })
    return false
  }
  printStep(context, { status: 'pass', title: '凭据', detail: `token 已存入 Git 凭据管理器（${helper}）` })
  return true
}

async function assertTools(context: CliContext): Promise<void> {
  const git = await detectGitVersion(context)
  if (!git.found)
    throw new CliError([`${git.reason}。请先安装 Git：`, ...gitInstallHints().map(hint => `  ${hint}`)].join('\n'))
  if (compareVersions(git.version, MIN_GIT_VERSION) < 0)
    throw new CliError([`git ${git.version} 太旧，需要 ${MIN_GIT_VERSION} 或更新：`, ...gitInstallHints().map(hint => `  ${hint}`)].join('\n'))
  printStep(context, { status: 'pass', title: 'git', detail: git.version })
  const lfs = await detectGitLfsVersion(context)
  if (!lfs.found)
    throw new CliError([`${lfs.reason}。请先安装：`, ...gitLfsInstallHints().map(hint => `  ${hint}`)].join('\n'))
  if (compareVersions(lfs.version, MIN_GIT_LFS_VERSION) < 0)
    throw new CliError([`git-lfs ${lfs.version} 太旧，需要 ${MIN_GIT_LFS_VERSION} 或更新：`, ...gitLfsInstallHints().map(hint => `  ${hint}`)].join('\n'))
  printStep(context, { status: 'pass', title: 'git-lfs', detail: lfs.version })
}

function resolveService(value: string | undefined): ServiceUrl {
  if (value === undefined)
    throw new CliError('缺少 --url，例如 git yunbox init --url https://lfs.example.com/team/assets', USAGE_EXIT_CODE)
  let service: ServiceUrl
  try {
    service = parseServiceUrl(value)
  }
  catch (error) {
    if (error instanceof ServiceUrlError)
      throw new CliError(error.message, USAGE_EXIT_CODE)
    throw error
  }
  if (!isSecureServiceUrl(service)) {
    throw new CliError(
      `${service.host} 不是本机地址，必须使用 https：token 通过 HTTP Basic 认证发送，用 http 会明文传输。\n`
      + `  git yunbox init --url ${shellQuote(service.url.replace(/^http:/, 'https:'))}`,
      USAGE_EXIT_CODE,
    )
  }
  return service
}

function assertToken(token: string): void {
  try {
    assertTokenShape(token)
  }
  catch (error) {
    throw new CliError((error as Error).message, USAGE_EXIT_CODE)
  }
}

/** Parsed `git yunbox init` options. */
export interface InitOptions {
  'url'?: string
  'cos'?: boolean
  'bucket'?: string
  'region'?: string
  'prefix'?: string
  'create'?: boolean
  'yes'?: boolean
  'read-only'?: boolean
  'types'?: string[]
  'token-stdin'?: boolean
  'skip-credential'?: boolean
  'force'?: boolean
  'help'?: boolean
}

function parseInitArgs(args: string[]): InitOptions {
  if (args.some(arg => arg === '--token' || arg.startsWith('--token=') || arg === '--password' || arg.startsWith('--password=')))
    throw new CliError('不要在命令行参数里传 token，它会留在 shell 历史和进程列表里。用 --token-stdin，或直接运行 git yunbox init 按提示输入', USAGE_EXIT_CODE)
  try {
    return parseArgs({
      args,
      options: {
        'url': { type: 'string' },
        'cos': { type: 'boolean' },
        'bucket': { type: 'string' },
        'region': { type: 'string' },
        'prefix': { type: 'string' },
        'create': { type: 'boolean' },
        'yes': { type: 'boolean', short: 'y' },
        'read-only': { type: 'boolean' },
        'types': { type: 'string', multiple: true },
        'token-stdin': { type: 'boolean' },
        'skip-credential': { type: 'boolean' },
        'force': { type: 'boolean' },
        'help': { type: 'boolean', short: 'h' },
      },
    }).values
  }
  catch (error) {
    throw new CliError(`${(error as Error).message}\n运行 git yunbox init --help 查看用法`, USAGE_EXIT_CODE)
  }
}
