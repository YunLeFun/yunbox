/** A group of asset file extensions tracked together. */
export interface AssetCategory {
  id: string
  label: string
  extensions: readonly string[]
}

/** Asset types `git yunbox init` tracks with Git LFS, in the order they are written. */
export const ASSET_CATEGORIES: readonly AssetCategory[] = [
  {
    id: 'texture',
    label: '贴图和图片',
    extensions: ['png', 'jpg', 'jpeg', 'tga', 'tif', 'tiff', 'bmp', 'gif', 'webp', 'exr', 'hdr', 'dds', 'ktx', 'ktx2', 'astc'],
  },
  {
    id: 'source',
    label: '设计源文件',
    extensions: ['psd', 'psb', 'ai', 'kra', 'xcf', 'spp', 'sbsar'],
  },
  {
    id: 'model',
    label: '模型和动画',
    extensions: ['fbx', 'obj', 'blend', 'max', 'ma', 'mb', '3ds', 'dae', 'glb', 'usd', 'usdc', 'usdz', 'abc', 'c4d'],
  },
  {
    id: 'audio',
    label: '音频',
    extensions: ['wav', 'mp3', 'ogg', 'flac', 'aif', 'aiff', 'bank', 'bnk', 'wem'],
  },
  {
    id: 'video',
    label: '视频',
    extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'],
  },
  {
    id: 'font',
    label: '字体',
    extensions: ['ttf', 'otf'],
  },
  {
    id: 'archive',
    label: '压缩包',
    extensions: ['zip', '7z', 'rar'],
  },
]

/** A named set of asset categories for quick selection, e.g. `--types game`. */
export interface AssetPreset {
  id: string
  label: string
  /** Category ids, in {@link ASSET_CATEGORIES} order. */
  categories: readonly string[]
}

/**
 * Common combinations of {@link ASSET_CATEGORIES}. They only name existing
 * categories, so a preset never tracks an extension a category does not.
 */
export const ASSET_PRESETS: readonly AssetPreset[] = [
  { id: 'game', label: '游戏项目（不含压缩包）', categories: ['texture', 'source', 'model', 'audio', 'video', 'font'] },
  { id: 'design', label: '设计稿', categories: ['texture', 'source', 'font'] },
  { id: 'media', label: '图片和音视频', categories: ['texture', 'audio', 'video'] },
  { id: 'all', label: '全部类型', categories: ASSET_CATEGORIES.map(category => category.id) },
]

/** The attributes `git lfs track` writes. */
export const LFS_ATTRIBUTES = 'filter=lfs diff=lfs merge=lfs -text'

/** First line of the block `git yunbox init` and `yunbox types add` append. */
export const BLOCK_HEADER = '# YunBox：以下素材由 Git LFS 管理（git yunbox init 生成）'

/** Outcome of {@link mergeGitAttributes}. */
export interface GitAttributesMerge {
  /** The new file content; equal to the input when nothing was added. */
  content: string
  /** Patterns appended, per category id. */
  added: Map<string, string[]>
  /** Patterns that already had a rule without the LFS filter; left untouched. */
  keptNonLfs: string[]
}

/**
 * Append LFS rules for the given categories to `.gitattributes` content.
 *
 * A pattern that already has any rule is never added again, whatever its
 * attributes, so running this twice is a no-op and hand-written rules win.
 * Existing lines are kept byte for byte, including their line endings.
 * Patterns in `options.exclude` are left out as if they already had a rule.
 */
export function mergeGitAttributes(existing: string, categories: readonly AssetCategory[], options: { exclude?: ReadonlySet<string> } = {}): GitAttributesMerge {
  const rules = parseRules(existing)
  const added = new Map<string, string[]>()
  const keptNonLfs: string[] = []
  for (const category of categories) {
    const missing: string[] = []
    for (const extension of category.extensions) {
      const pattern = `*.${extension}`
      if (options.exclude?.has(pattern))
        continue
      const attributes = rules.get(pattern)
      if (attributes === undefined)
        missing.push(pattern)
      else if (!attributes.includes('filter=lfs'))
        keptNonLfs.push(pattern)
    }
    if (missing.length > 0)
      added.set(category.id, missing)
  }
  if (added.size === 0)
    return { content: existing, added, keptNonLfs }

  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const lines: string[] = []
  if (!existing.includes(BLOCK_HEADER))
    lines.push(BLOCK_HEADER)
  for (const category of categories) {
    const patterns = added.get(category.id)
    if (patterns === undefined)
      continue
    lines.push(`# ${category.label}`)
    const width = Math.max(...patterns.map(pattern => pattern.length))
    for (const pattern of patterns)
      lines.push(`${pattern.padEnd(width)} ${LFS_ATTRIBUTES}`)
  }
  let prefix = existing
  if (prefix !== '' && !prefix.endsWith('\n'))
    prefix += eol
  if (prefix.trim() !== '')
    prefix += eol
  return { content: `${prefix}${lines.join(eol)}${eol}`, added, keptNonLfs }
}

/** Resolve `--types` values (category or preset ids) to categories; throws on an unknown id. */
export function selectCategories(ids: readonly string[] | undefined): AssetCategory[] {
  if (ids === undefined || ids.length === 0)
    return [...ASSET_CATEGORIES]
  const wanted = new Set<string>()
  const unknown: string[] = []
  for (const id of ids.flatMap(id => id.split(',')).map(id => id.trim()).filter(id => id !== '')) {
    const preset = ASSET_PRESETS.find(preset => preset.id === id)
    if (preset !== undefined)
      preset.categories.forEach(category => wanted.add(category))
    else if (ASSET_CATEGORIES.some(category => category.id === id))
      wanted.add(id)
    else
      unknown.push(id)
  }
  if (unknown.length > 0)
    throw new TypeError(`未知的素材类型：${unknown.join(', ')}；可选：${ASSET_CATEGORIES.map(category => category.id).join(', ')}；预置组合：${ASSET_PRESETS.map(preset => preset.id).join(', ')}`)
  return ASSET_CATEGORIES.filter(category => wanted.has(category.id))
}

/** The asset category an extension (any case) belongs to. */
export function categoryOfExtension(extension: string): AssetCategory | undefined {
  const lower = extension.toLowerCase()
  return ASSET_CATEGORIES.find(category => category.extensions.includes(lower))
}

/** Outcome of {@link removeGitAttributes}. */
export interface GitAttributesRemoval {
  /** The new file content; equal to the input when nothing was removed. */
  content: string
  /** Patterns removed, per category id. */
  removed: Map<string, string[]>
}

/**
 * Remove the rules YunBox generated for the given categories.
 *
 * Only lines YunBox itself wrote are touched: after {@link BLOCK_HEADER}, under
 * a `# <category label>` comment, in the exact aligned form
 * {@link mergeGitAttributes} writes and in the category's extension order.
 * Hand-written rules, including ones `git lfs track` appended right after the
 * block, stay byte for byte. A category comment goes when none of the lines
 * up to its last generated rule are left, and the header when no comment is.
 */
export function removeGitAttributes(existing: string, categories: readonly AssetCategory[]): GitAttributesRemoval {
  const lines = existing.split(/(?<=\n)/)
  const scan = scanYunBoxRules(lines)
  const ids = new Set(categories.map(category => category.id))
  const removed = new Map<string, string[]>()
  const drop = new Set<number>()
  for (const section of scan.sections) {
    const own = ids.has(section.category.id) ? section.rules : []
    for (const rule of own) {
      drop.add(rule.index)
      removed.set(section.category.id, [...removed.get(section.category.id) ?? [], rule.pattern])
    }
    // Lines after the section's last generated rule were appended later (by `git lfs track`, say) and do not keep the comment.
    const last = section.rules.at(-1)?.index ?? section.start
    if (own.length > 0 && last - section.start === own.length)
      drop.add(section.start)
  }
  if (drop.size === 0)
    return { content: existing, removed }
  if (scan.header !== undefined && scan.sections.every(section => drop.has(section.start)))
    drop.add(scan.header)
  // A removed run that leaves a blank line before another blank line (or the end) takes that blank line with it.
  const blank = (index: number): boolean => lines[index]!.trim() === ''
  for (let index = 0; index < lines.length; index++) {
    if (!drop.has(index) || (index > 0 && drop.has(index - 1)))
      continue
    let end = index
    while (end + 1 < lines.length && drop.has(end + 1))
      end++
    if (index > 0 && blank(index - 1) && (end + 1 === lines.length || blank(end + 1)))
      drop.add(index - 1)
  }
  const content = lines.filter((_, index) => !drop.has(index)).join('')
  return { content: content.trim() === '' ? '' : content, removed }
}

/** Patterns of the rules YunBox generated, mapped to their category id. */
export function yunBoxPatterns(content: string): Map<string, string> {
  const patterns = new Map<string, string>()
  for (const section of scanYunBoxRules(content.split(/(?<=\n)/)).sections) {
    for (const rule of section.rules)
      patterns.set(rule.pattern, section.category.id)
  }
  return patterns
}

interface YunBoxSection {
  category: AssetCategory
  /** Index of the `# <label>` comment. */
  start: number
  /** Index of the first line after the section (blank line, comment or end of file). */
  end: number
  rules: Array<{ index: number, pattern: string }>
}

function scanYunBoxRules(lines: string[]): { header?: number, sections: YunBoxSection[] } {
  const text = (index: number): string => lines[index]!.replace(/\r?\n$/, '')
  const header = lines.findIndex((_, index) => text(index).trim() === BLOCK_HEADER)
  if (header === -1)
    return { sections: [] }
  const sections: YunBoxSection[] = []
  let index = header + 1
  while (index < lines.length) {
    const category = ASSET_CATEGORIES.find(category => text(index) === `# ${category.label}`)
    if (category === undefined) {
      index++
      continue
    }
    const section: YunBoxSection = { category, start: index, end: index + 1, rules: [] }
    let order = -1
    let column: number | undefined
    for (index++; index < lines.length; index++) {
      const line = text(index)
      if (line.trim() === '' || line.trimStart().startsWith('#'))
        break
      const match = /^(\*\.(\S+))( +)(\S.*)$/.exec(line)
      if (match === null || match[4] !== LFS_ATTRIBUTES)
        continue
      const position = category.extensions.indexOf(match[2]!)
      const at = match[1]!.length + match[3]!.length
      if (position <= order || (column !== undefined && at !== column))
        continue
      order = position
      column = at
      section.rules.push({ index, pattern: match[1]! })
    }
    section.end = index
    sections.push(section)
  }
  return { header, sections }
}

/** Map each pattern in `.gitattributes` content to the attributes of its last rule. */
function parseRules(content: string): Map<string, string> {
  const rules = new Map<string, string>()
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('[attr]'))
      continue
    let pattern: string
    let rest: string
    if (line.startsWith('"')) {
      const end = line.indexOf('"', 1)
      if (end === -1)
        continue
      pattern = line.slice(1, end)
      rest = line.slice(end + 1)
    }
    else {
      const end = line.search(/\s/)
      pattern = end === -1 ? line : line.slice(0, end)
      rest = end === -1 ? '' : line.slice(end)
    }
    rules.set(pattern, rest.trim())
  }
  return rules
}
