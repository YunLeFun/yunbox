import type { CliContext } from '../context.ts'
import type { AssetCategory } from '../gitattributes.ts'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { extensionOf, filterAttributes, indexEntries } from '../asset-files.ts'
import { CliError, print, USAGE_EXIT_CODE } from '../context.ts'
import { findRepositoryRoot, shellQuote } from '../git.ts'
import { ASSET_CATEGORIES, ASSET_PRESETS, categoryOfExtension, removeGitAttributes, selectCategories, yunBoxPatterns } from '../gitattributes.ts'
import { lfsPointerBlobs } from '../inspect.ts'
import { printStep } from '../report.ts'
import { installLfsAndAttributes } from './init.ts'

export const typesHelp = `用法：
  git yunbox types [list] [--json]
  git yunbox types add <类型>... [--renormalize]
  git yunbox types remove <类型>...

按素材类型管理 .gitattributes 里的 LFS 规则。只增删 YunBox 生成的那一段，
手写的规则（包括 git lfs track 加的）不会改动。不改动历史，也不会提交。

类型：
${ASSET_CATEGORIES.map(category => `  ${category.id.padEnd(8)} ${category.label}：${category.extensions.join(' ')}`).join('\n')}
预置组合（可以和类型混写，逗号或空格分隔）：
${ASSET_PRESETS.map(preset => `  ${preset.id.padEnd(8)} ${preset.label}：${preset.categories.join(',')}`).join('\n')}

子命令：
  list     每个类型、每个扩展名现在是否走 LFS，仓库里有多少这类文件；
           并列出作为普通文件提交的素材（不是 LFS 指针），包括大小写不同的扩展名（默认）
  add      追加这些类型的规则。会匹配到已作为普通文件提交的文件的规则默认不加
  remove   删除 YunBox 为这些类型生成的规则；已经是 LFS 指针的文件只提示，不改动

选项：
  --renormalize  add 时把这些规则也加上，并对被匹配到的已提交文件执行
                 git add --renormalize，下一次提交起改存为 LFS 指针（历史不变）。
                 会把这些文件当前的内容和 .gitattributes 一起加入暂存区
  --json         list 只输出一个 JSON 对象（schemaVersion 1），供图形界面读取
  -h, --help     显示帮助

例子：
  git yunbox types
  git yunbox types add model audio
  git yunbox types add game
  git yunbox types add archive --renormalize
  git yunbox types remove video
`

/** One extension's state in {@link TypesReport}. */
export interface TypesExtension {
  extension: string
  pattern: string
  /** Whether a file with this extension at the repository root goes through LFS (`git check-attr filter`). */
  lfs: boolean
  /** Whether the rule is in the block YunBox generated (and `types remove` can delete it). */
  managed: boolean
  /** Files in the index with this extension, in any case. */
  files: number
  /** How many of them are staged as LFS pointers. */
  lfsFiles: number
}

/** A file whose extension belongs to an asset category but that is staged as an ordinary Git blob. */
export interface TypesPlainFile {
  path: string
  category: string
  extension: string
  /**
   * - `case`: the extension differs in case and the lower-case rule does not catch it (`core.ignorecase=false`, e.g. Linux)
   * - `not-renormalized`: an LFS rule catches it but it was committed before; it shows as modified
   * - `no-rule`: no LFS rule catches it
   */
  reason: 'case' | 'not-renormalized' | 'no-rule'
}

/** `yunbox types list --json` output. */
export interface TypesReport {
  schemaVersion: 1
  status: 'ok'
  categories: Array<{
    id: string
    label: string
    /** `lfs`: every extension goes through LFS; `partial`: some do; `none`: none do. */
    state: 'lfs' | 'partial' | 'none'
    extensions: TypesExtension[]
  }>
  presets: Array<{ id: string, label: string, categories: string[] }>
  plainFiles: TypesPlainFile[]
}

// A root-level name no rule is likely to mention, so only extension rules decide.
const PROBE = 'yunbox-types-probe'

/** Run `yunbox types`: list, add and remove the LFS rules per asset category. Returns the exit code. */
export async function runTypes(context: CliContext, args: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        renormalize: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  }
  catch (error) {
    throw new CliError(`${(error as Error).message}\n运行 git yunbox types --help 查看用法`, USAGE_EXIT_CODE)
  }
  const { values, positionals } = parsed
  if (values.help) {
    context.stdout.write(typesHelp)
    return 0
  }
  const [operation = 'list', ...ids] = positionals
  const json = values.json === true
  try {
    return await runOperation(context, operation, ids, values)
  }
  catch (error) {
    if (!json)
      throw error
    const message = error instanceof Error ? error.message : String(error)
    context.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: 'error', error: { code: 'TYPES_FAILED', message } })}\n`)
    return error instanceof CliError ? error.exitCode : 1
  }
}

async function runOperation(context: CliContext, operation: string, ids: string[], values: { renormalize?: boolean, json?: boolean }): Promise<number> {
  const usage = (message: string): CliError => new CliError(`${message}\n运行 git yunbox types --help 查看用法`, USAGE_EXIT_CODE)
  if (!['list', 'add', 'remove'].includes(operation))
    throw usage(`未知子命令：${operation}`)
  if (values.json && operation !== 'list')
    throw usage(`${operation} 不接受 --json`)
  if (values.renormalize && operation !== 'add')
    throw usage(`${operation} 不接受 --renormalize`)
  if (operation === 'list' && ids.length > 0)
    throw usage('list 不接受类型参数')
  if (operation !== 'list' && ids.length === 0)
    throw usage(`请给出至少一个类型，例如 git yunbox types ${operation} model,audio`)
  let categories: AssetCategory[] = []
  if (operation !== 'list') {
    try {
      categories = selectCategories(ids)
    }
    catch (error) {
      throw usage((error as Error).message)
    }
  }

  const root = await findRepositoryRoot(context)
  if (root === undefined)
    throw new CliError('当前目录不在 Git 仓库里')
  const repo: CliContext = { ...context, cwd: root }

  if (operation === 'list') {
    const report = await readTypes(repo, root)
    context.stdout.write(values.json ? `${JSON.stringify(report)}\n` : formatTypes(report))
    return 0
  }
  if (operation === 'add') {
    await installLfsAndAttributes(context, repo, root, categories, { renormalize: values.renormalize })
    print(context)
    print(context, '下一步：确认改动后提交')
    print(context, '  git add .gitattributes')
    print(context, `  git commit -m "chore: 用 LFS 管理${categories.map(category => category.label).join('、')}"`)
    return 0
  }
  await removeTypes(context, repo, root, categories)
  return 0
}

async function readAttributes(root: string): Promise<string> {
  return readFile(join(root, '.gitattributes'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return ''
    throw error
  })
}

/** Collect the per-category state that `list` prints. */
export async function readTypes(repo: CliContext, root: string): Promise<TypesReport> {
  const managed = yunBoxPatterns(await readAttributes(root))
  const extensions = ASSET_CATEGORIES.flatMap(category => category.extensions)
  const probes = await filterAttributes(repo, extensions.map(extension => `${PROBE}.${extension}`))
  const lfs = (extension: string): boolean => probes.get(`${PROBE}.${extension}`) === 'lfs'

  const entries = (await indexEntries(repo)).filter(entry => categoryOfExtension(extensionOf(entry.path)) !== undefined)
  const filters = await filterAttributes(repo, entries.map(entry => entry.path))
  const pointers = await lfsPointerBlobs(repo, entries.map(entry => entry.oid))
  const counts = new Map<string, { files: number, lfsFiles: number }>()
  const plainFiles: TypesPlainFile[] = []
  for (const entry of entries) {
    const extension = extensionOf(entry.path)
    const count = counts.get(extension) ?? { files: 0, lfsFiles: 0 }
    count.files++
    counts.set(extension, count)
    if (pointers.has(entry.oid)) {
      count.lfsFiles++
      continue
    }
    const actual = entry.path.slice(entry.path.lastIndexOf('.') + 1)
    const reason = filters.get(entry.path) === 'lfs'
      ? 'not-renormalized'
      : actual !== extension && lfs(extension) ? 'case' : 'no-rule'
    plainFiles.push({ path: entry.path, category: categoryOfExtension(extension)!.id, extension: actual, reason })
  }
  plainFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

  return {
    schemaVersion: 1,
    status: 'ok',
    categories: ASSET_CATEGORIES.map((category) => {
      const rows = category.extensions.map(extension => ({
        extension,
        pattern: `*.${extension}`,
        lfs: lfs(extension),
        managed: managed.get(`*.${extension}`) === category.id,
        files: counts.get(extension)?.files ?? 0,
        lfsFiles: counts.get(extension)?.lfsFiles ?? 0,
      }))
      const tracked = rows.filter(row => row.lfs).length
      return {
        id: category.id,
        label: category.label,
        state: tracked === rows.length ? 'lfs' : tracked === 0 ? 'none' : 'partial',
        extensions: rows,
      }
    }),
    presets: ASSET_PRESETS.map(preset => ({ id: preset.id, label: preset.label, categories: [...preset.categories] })),
    plainFiles,
  }
}

const STATE_SYMBOLS = { lfs: '✓', partial: '~', none: '-' } as const

/** Human-readable `list` output. */
export function formatTypes(report: TypesReport): string {
  const lines = ['素材类型（按仓库根目录的规则判断是否走 LFS；文件数是已加入 Git 的文件）：']
  for (const category of report.categories) {
    const rows = category.extensions
    const tracked = rows.filter(row => row.lfs)
    const files = rows.reduce((sum, row) => sum + row.files, 0)
    const lfsFiles = rows.reduce((sum, row) => sum + row.lfsFiles, 0)
    const state = category.state === 'lfs'
      ? '全部走 LFS'
      : category.state === 'none' ? '未走 LFS' : `${tracked.length}/${rows.length} 走 LFS，未走：${rows.filter(row => !row.lfs).map(row => row.pattern).join(' ')}`
    const handWritten = tracked.filter(row => !row.managed).length
    const source = tracked.length > 0 && handWritten > 0 ? `（${handWritten} 条来自其他规则）` : ''
    lines.push(`  ${STATE_SYMBOLS[category.state]} ${category.id.padEnd(8)} ${category.label}：${state}${source}；文件 ${files} 个${files > 0 ? `，LFS 指针 ${lfsFiles} 个` : ''}`)
  }
  lines.push(`预置组合：${report.presets.map(preset => `${preset.id}（${preset.categories.join(',')}）`).join('、')}`)

  if (report.plainFiles.length > 0) {
    lines.push('', `作为普通文件提交的素材（${report.plainFiles.length} 个，不是 LFS 指针）：`)
    const reasons = {
      'case': '扩展名大小写不同，小写规则匹配不到（core.ignorecase=false，例如 Linux 和 CI）',
      'not-renormalized': '已有 LFS 规则，但提交时还没有这条规则，会显示为已修改',
      'no-rule': '没有 LFS 规则',
    }
    for (const file of report.plainFiles.slice(0, 20))
      lines.push(`  ${file.path}：${reasons[file.reason]}`)
    if (report.plainFiles.length > 20)
      lines.push(`  …… 还有 ${report.plainFiles.length - 20} 个，用 --json 查看全部`)
    const missing = [...new Set(report.plainFiles.filter(file => file.reason !== 'case').map(file => file.category))]
    const cased = [...new Set(report.plainFiles.filter(file => file.reason === 'case').map(file => `*.${file.extension}`))]
    lines.push('建议（从下一次提交起改用 LFS，历史不变）：')
    if (missing.length > 0)
      lines.push(`  git yunbox types add ${missing.join(',')} --renormalize`)
    if (cased.length > 0) {
      lines.push(`  git lfs track ${cased.map(shellQuote).join(' ')}   # 大小写不同的扩展名要单独加规则`)
      lines.push(`  git add .gitattributes && git add --renormalize -- ${cased.map(shellQuote).join(' ')}`)
    }
  }
  return `${lines.join('\n')}\n`
}

async function removeTypes(context: CliContext, repo: CliContext, root: string, categories: AssetCategory[]): Promise<void> {
  const attributesPath = join(root, '.gitattributes')
  const existing = await readAttributes(root)
  const removal = removeGitAttributes(existing, categories)
  const labels = categories.map(category => category.label).join('、')
  if (removal.removed.size === 0) {
    printStep(context, { status: 'skip', title: '.gitattributes', detail: `没有 YunBox 为${labels}生成的规则，未修改` })
  }
  else {
    const extensions = new Set(categories.flatMap(category => category.extensions))
    const entries = (await indexEntries(repo)).filter(entry => extensions.has(extensionOf(entry.path)))
    const before = await filterAttributes(repo, entries.map(entry => entry.path))
    await writeFile(attributesPath, removal.content)
    const after = await filterAttributes(repo, entries.map(entry => entry.path))
    const count = [...removal.removed.values()].reduce((sum, patterns) => sum + patterns.length, 0)
    printStep(context, {
      status: 'pass',
      title: '.gitattributes',
      detail: `删除 ${count} 条规则（${categories.filter(category => removal.removed.has(category.id)).map(category => `${category.label} ${removal.removed.get(category.id)!.length}`).join('、')}）`,
    })
    const changed = entries.filter(entry => before.get(entry.path) === 'lfs' && after.get(entry.path) !== 'lfs')
    const pointers = await lfsPointerBlobs(repo, changed.map(entry => entry.oid))
    const stranded = changed.filter(entry => pointers.has(entry.oid)).map(entry => entry.path)
    if (stranded.length > 0) {
      printStep(context, {
        status: 'warn',
        title: 'LFS 文件',
        detail: `${stranded.length} 个已提交的文件是 LFS 指针，不再匹配 LFS 规则后会显示为已修改，未做改动：${stranded.length <= 3 ? stranded.join('、') : `${stranded.slice(0, 3).join('、')} 等`}`,
        fixes: [
          `git checkout -- .gitattributes   # 撤销：继续用 LFS（或 git yunbox types add ${categories.map(category => category.id).join(',')}）`,
          'git add .gitattributes && git add --renormalize .   # 从下一次提交起改存为普通 Git 文件；历史里的 LFS 对象不变，旧版本仍要从 LFS 下载',
        ],
      })
    }
  }
  const probes = await filterAttributes(repo, categories.flatMap(category => category.extensions).map(extension => `${PROBE}.${extension}`))
  const still = [...probes].filter(([, value]) => value === 'lfs').map(([path]) => `*.${path.slice(PROBE.length + 1)}`)
  if (still.length > 0)
    printStep(context, { status: 'warn', title: '.gitattributes', detail: `这些扩展名仍由其他规则（手写或 git lfs track）走 LFS，未改动：${still.join(' ')}` })
}
