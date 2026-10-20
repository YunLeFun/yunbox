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

/** The attributes `git lfs track` writes. */
export const LFS_ATTRIBUTES = 'filter=lfs diff=lfs merge=lfs -text'

const BLOCK_HEADER = '# YunBox：以下素材由 Git LFS 管理（git yunbox init 生成）'

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

/** Resolve `--types` values to categories; throws on an unknown id. */
export function selectCategories(ids: readonly string[] | undefined): AssetCategory[] {
  if (ids === undefined || ids.length === 0)
    return [...ASSET_CATEGORIES]
  const wanted = new Set(ids.flatMap(id => id.split(',')).map(id => id.trim()).filter(id => id !== ''))
  const unknown = [...wanted].filter(id => !ASSET_CATEGORIES.some(category => category.id === id))
  if (unknown.length > 0)
    throw new TypeError(`未知的素材类型：${unknown.join(', ')}；可选：${ASSET_CATEGORIES.map(category => category.id).join(', ')}`)
  return ASSET_CATEGORIES.filter(category => wanted.has(category.id))
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
