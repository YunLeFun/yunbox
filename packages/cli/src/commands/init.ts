import type { CliContext } from '../context.ts'
import type { ServiceUrl } from '../service-url.ts'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { committedOutsideLfs, extensionOf, filterAttributes, indexEntries } from '../asset-files.ts'
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
  runGitChecked,
  shellQuote,
} from '../git.ts'
import { ASSET_CATEGORIES, ASSET_PRESETS, categoryOfExtension, mergeGitAttributes, selectCategories } from '../gitattributes.ts'
import { installInitHook, installLfsWithHooks } from '../init-hooks.ts'
import { lfsPointerBlobs } from '../inspect.ts'
import { gitInstallHints, gitLfsInstallHints } from '../install-hints.ts'
import { printStep } from '../report.ts'
import { isSecureServiceUrl, parseServiceUrl, ServiceUrlError } from '../service-url.ts'
import { promptForToken, readTokenFromStdin } from '../token-input.ts'
import { runInitCos } from './init-cos.ts'

export const initHelp = `用法：git yunbox init [选项]

在当前 Git 仓库里接入 YunBox。默认直连腾讯云 COS，也可以直连 S3 兼容存储（Cloudflare R2、AWS S3、
MinIO 等），都不需要任何服务端：
  1. 检查 git 和 git-lfs 版本，执行 git lfs install
  2. 选择 bucket（COS 可以新建私有 bucket）和目录前缀，写进 .yunbox/config（不含密钥，提交后团队共享）
  3. 用本机密钥检查能否在这个前缀写入和读取
  4. 按素材类型生成或合并 .gitattributes（已有规则不会重复添加）
  5. 在本仓库的 .git/config 登记传输代理：git-lfs 用 git-yunbox lfs-agent 直接上传下载
  6. 设置 lfs.locksverify=false（直连模式没有文件锁服务）
  7. 安装本仓库的推送保护，默认超限询问（关闭 App 后仍生效）

.yunbox/config（或旧版的 .yunboxconfig）已存在时（例如别人已经接入、你刚 clone 下来）沿用存储设置，并检查权限、登记代理及推送保护。
可以重复执行，不会破坏已有配置。密钥用 yunbox login 保存在本机，不会写进仓库。

直连 COS 的选项：
  --bucket <名称>    bucket 名称（包含 -APPID），不提供时列出账号下的 bucket 让你选
  --region <地域>    bucket 地域，例如 ap-guangzhou；选已有 bucket 时自动识别
  --prefix <前缀>    bucket 里的目录前缀，默认 yunbox/<owner>/<repo>；多个项目可以共用一个 bucket
  --create           新建私有 bucket（会先确认，--yes 跳过确认）
  --read-only        只需要拉取：密钥没有写权限时不提示警告
  --yes, -y          跳过确认
  --force            .yunbox/config 或 .lfsconfig 里已有不同的配置时替换它

直连 S3 兼容存储的选项（密钥用 yunbox login --provider s3 保存）：
  --provider <名称>  cos（默认）或 s3；给出下面任一选项时自动选 s3
  --preset <预设>    r2（Cloudflare R2）、aws（AWS S3）或 minio
  --account-id <id>  R2 的账户 ID，endpoint 为 https://<账户 ID>.r2.cloudflarestorage.com
  --endpoint <地址>  服务地址（不含 bucket），例如 https://minio.example.com；必须是 https，本机地址除外
  --addressing <风格>  path（<endpoint>/<bucket>/…，R2、MinIO 默认）或 virtual（<bucket>.<endpoint>/…，AWS 默认）
  --bucket、--region、--prefix 同上；R2 的 region 是 auto，AWS 默认 us-east-1

服务端模式（使用 YunBox 服务端和个人 token）：
  --url <地址>       YunBox 仓库地址，例如 https://lfs.example.com/team/assets；
                     .lfsconfig 里已有 lfs.url 时可以省略
  --token-stdin      从标准输入读取 token，例如 pbpaste | git yunbox init --token-stdin
  --skip-credential  不配置 token

通用选项：
  --no-hook          跳过 YunBox 推送保护，只配置 Git LFS 和存储
  --global-hook      可选：为本机所有未自定义钩子目录的仓库启用推送保护
  --types <类型>     只跟踪这些素材类型，逗号分隔（默认全部）：
                     ${ASSET_CATEGORIES.map(category => `${category.id}（${category.label}）`).join('、')}
                     也可以写预置组合：${ASSET_PRESETS.map(preset => `${preset.id}（${preset.label}）`).join('、')}
                     以后增删类型用 git yunbox types
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
  if (values['no-hook'] && values['global-hook'])
    throw new CliError('--no-hook 和 --global-hook 只能选一个', USAGE_EXIT_CODE)

  await assertTools(context)
  const root = await findRepositoryRoot(context)
  if (root === undefined)
    throw new CliError('当前目录不在 Git 仓库里。先进入仓库目录，或用 git init 新建一个仓库后再运行 git yunbox init')
  const repo: CliContext = { ...context, cwd: root }

  // Validate everything before touching the repository.
  const lfsConfigPath = join(root, '.lfsconfig')
  const currentUrl = await readGitConfig(repo, 'lfs.url', lfsConfigPath)
  const cosOptions = values.bucket !== undefined || values.region !== undefined || values.prefix !== undefined || values.create === true
    || values.provider !== undefined || values.preset !== undefined || values.endpoint !== undefined || values['account-id'] !== undefined || values.addressing !== undefined
  let hasCosLocation = false
  for (const file of locationFiles(root)) {
    hasCosLocation ||= await readGitConfig(repo, 'cos.bucket', join(root, file)) !== undefined
    hasCosLocation ||= await readGitConfig(repo, 'storage.provider', join(root, file)) !== undefined
  }
  if (values.cos === true || cosOptions || (values.url === undefined && (hasCosLocation || currentUrl === undefined))) {
    if (values.url !== undefined)
      throw new CliError('--url（服务端模式）和 --cos（直连 COS）只能选一个；--provider、--bucket 等直连存储的选项也不能和 --url 一起用', USAGE_EXIT_CODE)
    const code = await runInitCos(context, repo, root, values, parseCategories(values.types), installLfsAndAttributes)
    if (code === 0)
      await installInitHook(repo, values)
    return code
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
  await installInitHook(repo, values)

  print(context)
  print(context, '下一步：')
  print(context, '  git add .gitattributes .lfsconfig')
  print(context, '  git commit -m "chore: 用 YunBox 管理 LFS 素材"')
  if (!credentialStored)
    print(context, '  git yunbox init   # 在终端里重新运行，按提示输入 token')
  print(context, '  yunbox doctor     # 检查连通性和读写权限')
  return 0
}

/** Options for {@link installLfsAndAttributes}. */
export interface AssetRuleOptions {
  /**
   * Also add rules that catch files committed as ordinary files, and stage
   * those files again as LFS pointers (`git add --renormalize`). History is
   * left as it is.
   */
  renormalize?: boolean
}

/** `git lfs install` plus merging the asset rules into `.gitattributes`; shared by both modes and `yunbox types add`. */
export async function installLfsAndAttributes(context: CliContext, repo: CliContext, root: string, categories: ReturnType<typeof selectCategories> | undefined, options: AssetRuleOptions = {}): Promise<void> {
  const install = await installLfsWithHooks(repo)
  if (install.code !== 0) {
    const reason = firstLine(install.stderr) || firstLine(install.stdout)
    const hint = /hook already exists/i.test(`${install.stdout}${install.stderr}`)
      ? '仓库里已有其他工具的 Git 钩子。运行 git lfs update --manual，按提示把 git-lfs 的命令加进已有钩子后重试'
      : '按上面的错误修复后重试'
    throw new CliError(`git lfs install 失败：${reason}\n${hint}`)
  }
  printStep(context, { status: 'pass', title: 'git lfs install', detail: '已启用 LFS 过滤器和本仓库的钩子' })

  if (categories === undefined) {
    printStep(context, { status: 'skip', title: '.gitattributes', detail: '沿用仓库里已有的规则，未修改（要追加素材类型：加 --types）' })
    return
  }
  const attributesPath = join(root, '.gitattributes')
  let existed = true
  const existingAttributes = await readFile(attributesPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT')
      throw error
    existed = false
    return ''
  })
  let merge = mergeGitAttributes(existingAttributes, categories)
  let captured = new Map<string, string[]>()
  if (merge.content !== existingAttributes) {
    captured = await committedOutsideLfs(repo, attributesPath, merge.content, [...merge.added.values()].flat())
    if (captured.size > 0 && !options.renormalize)
      merge = mergeGitAttributes(existingAttributes, categories, { exclude: new Set(captured.keys()) })
    if (merge.content !== existingAttributes)
      await writeFile(attributesPath, merge.content)
    else if (existed)
      await writeFile(attributesPath, existingAttributes)
    else
      await rm(attributesPath, { force: true })
  }
  const addedCount = [...merge.added.values()].reduce((sum, patterns) => sum + patterns.length, 0)
  printStep(context, {
    status: 'pass',
    title: '.gitattributes',
    detail: addedCount === 0
      ? '已包含全部素材规则，未修改'
      : `新增 ${addedCount} 条规则（${categories.filter(category => merge.added.has(category.id)).map(category => `${category.label} ${merge.added.get(category.id)!.length}`).join('、')}）`,
  })
  if (captured.size > 0 && !options.renormalize) {
    const patterns = [...captured.keys()]
    const ids = [...new Set(patterns.map(pattern => categoryOfExtension(pattern.slice('*.'.length))!.id))]
    printStep(context, {
      status: 'warn',
      title: '.gitattributes',
      detail: `这些类型已有文件作为普通文件提交过，没有为它们加 LFS 规则，否则这些文件会显示为已修改：${[...captured].map(([pattern, files]) => `${pattern}（${files.length === 1 ? files[0] : `${files[0]} 等 ${files.length} 个`}）`).join('、')}`,
      fixes: [
        `git yunbox types add ${ids.join(',')} --renormalize   # 确实要从下一次提交起改用 LFS 时（历史不变）`,
        `或者手动：git lfs track ${patterns.map(shellQuote).join(' ')}`,
        `          git add .gitattributes && git add --renormalize -- ${patterns.map(shellQuote).join(' ')}`,
      ],
    })
  }
  if (merge.keptNonLfs.length > 0) {
    printStep(context, {
      status: 'warn',
      title: '.gitattributes',
      detail: `这些扩展名已有不走 LFS 的规则，保持不变：${merge.keptNonLfs.join(' ')}`,
      fixes: ['确实需要用 LFS 管理时，手动把对应规则改成 filter=lfs diff=lfs merge=lfs -text'],
    })
  }
  if (options.renormalize)
    await renormalizeCommittedAssets(context, repo, root, categories)
}

/**
 * Stage the files of these categories that an LFS rule now catches but whose
 * staged content is still an ordinary blob, so the next commit stores them as
 * LFS pointers. Earlier commits keep the ordinary blobs.
 */
async function renormalizeCommittedAssets(context: CliContext, repo: CliContext, root: string, categories: ReturnType<typeof selectCategories>): Promise<void> {
  const extensions = new Set(categories.flatMap(category => category.extensions))
  const entries = (await indexEntries(repo)).filter(entry => extensions.has(extensionOf(entry.path)))
  const filters = await filterAttributes(repo, entries.map(entry => entry.path))
  const pointers = await lfsPointerBlobs(repo, entries.map(entry => entry.oid))
  const plain = entries.filter(entry => filters.get(entry.path) === 'lfs' && !pointers.has(entry.oid)).map(entry => entry.path)
  if (plain.length === 0) {
    printStep(context, { status: 'skip', title: 'git add --renormalize', detail: '没有需要改存为 LFS 的已提交文件' })
    return
  }
  if (await access(join(root, '.gitattributes')).then(() => true, () => false))
    await runGitChecked(repo, ['add', '--', '.gitattributes'])
  // Literal pathspecs: file names may contain glob characters such as [ or *.
  await runGitChecked(repo, ['--literal-pathspecs', 'add', '--renormalize', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: `${plain.join('\0')}\0` })
  printStep(context, {
    status: 'pass',
    title: 'git add --renormalize',
    detail: `${plain.length} 个已提交的文件改存为 LFS 指针，已和 .gitattributes 一起加入暂存区（历史不变）：${plain.length <= 3 ? plain.join('、') : `${plain.slice(0, 3).join('、')} 等`}`,
  })
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
  'no-hook'?: boolean
  'global-hook'?: boolean
  'url'?: string
  'cos'?: boolean
  'provider'?: string
  'preset'?: string
  'endpoint'?: string
  'account-id'?: string
  'addressing'?: string
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
        'no-hook': { type: 'boolean' },
        'global-hook': { type: 'boolean' },
        'url': { type: 'string' },
        'cos': { type: 'boolean' },
        'provider': { type: 'string' },
        'preset': { type: 'string' },
        'endpoint': { type: 'string' },
        'account-id': { type: 'string' },
        'addressing': { type: 'string' },
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
