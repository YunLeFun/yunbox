import type { Buffer } from 'node:buffer'
import type { CliContext } from './context.ts'
import type { InspectionRange } from './inspect-git.ts'
import { formatBytes } from './commands/status.ts'
import { inspectGit, InspectionError } from './inspect-git.ts'

/** Configurable local confirmation budgets, not hosting-provider quotas. */
export interface InspectionLimits {
  gitBytes: number
  lfsBytes: number
  fileBytes: number
}

/** One content object; a path can have multiple historical content versions. */
export interface InspectionFile {
  oid: string
  bytes: number
  paths: string[]
  exceedsFileLimit: boolean
}

/** Versioned, serializable push inspection result. Byte counts use binary units. */
export interface PushInspection {
  schemaVersion: 1
  status: 'ok' | 'exceeded'
  limits: InspectionLimits
  warnings: string[]
  git: {
    packBytes: number
    packComplete: boolean
    packCapBytes: number
    exceedsLimit: boolean
    blobBytes: number
    blobCount: number
    pointerBytes: number
    files: InspectionFile[]
  }
  lfs: {
    candidateBytes: number
    candidateCount: number
    remoteChecked: false
    uploadBytes: null
    exceedsLimit: boolean
    files: InspectionFile[]
  }
}

interface Blob {
  oid: string
  bytes: number
}

/** Inspect ordinary Git blobs and LFS pointers, without downloading or uploading content. */
export async function inspectPush(context: CliContext, range: InspectionRange, limits: InspectionLimits): Promise<PushInspection> {
  const gitBlobs = await readBlobs(context, range.git)
  const lfsBlobs = range.git.join('\n') === range.lfs.join('\n') ? gitBlobs : await readBlobs(context, range.lfs)
  const allBlobs = new Map([...gitBlobs, ...lfsBlobs].map(blob => [blob.oid, blob]))
  const pointers = await readPointers(context, [...allBlobs.values()])
  const paths = await readPaths(context, range.lfs)
  const warnings = [...range.warnings]
  if (allBlobs.size && paths.size === 0)
    warnings.push('无法确定文件路径，报告以对象 ID 标识内容')
  const packCapBytes = Math.max(10 * 1024 * 1024, limits.gitBytes)
  const pack = range.git.length
    ? await inspectGit(context, ['pack-objects', '--revs', '--stdout', '--thin', '--delta-base-offset', '-q'], revisions(range.git), packCapBytes)
    : { bytes: 0, complete: true }
  const gitFiles = gitBlobs.filter(blob => !pointers.has(blob.oid)).map(blob => fileEntry(blob, paths.get(blob.oid) ?? [], limits.fileBytes))
  const lfsFiles = new Map<string, InspectionFile>()
  let pointerBytes = 0
  for (const blob of gitBlobs) {
    if (pointers.has(blob.oid))
      pointerBytes += blob.bytes
  }
  for (const blob of lfsBlobs) {
    const pointer = pointers.get(blob.oid)
    if (!pointer)
      continue
    const previous = lfsFiles.get(pointer.oid)
    if (previous && previous.bytes !== pointer.bytes)
      throw new InspectionError('同一个 LFS 对象声明了不同大小，请修复指针后重试')
    lfsFiles.set(pointer.oid, fileEntry(pointer, [...new Set([...(previous?.paths ?? []), ...(paths.get(blob.oid) ?? [])])], limits.fileBytes))
  }
  const files = [...lfsFiles.values()].sort(compareFiles)
  const candidateBytes = sumBytes(files)
  const git = {
    packBytes: pack.bytes,
    packComplete: pack.complete,
    packCapBytes,
    exceedsLimit: pack.bytes > limits.gitBytes,
    blobBytes: sumBytes(gitBlobs),
    blobCount: gitBlobs.length,
    pointerBytes,
    files: gitFiles.sort(compareFiles),
  }
  const lfs = { candidateBytes, candidateCount: files.length, remoteChecked: false as const, uploadBytes: null, exceedsLimit: candidateBytes > limits.lfsBytes, files }
  return {
    schemaVersion: 1,
    status: git.exceedsLimit || lfs.exceedsLimit || [...git.files, ...files].some(file => file.exceedsFileLimit) ? 'exceeded' : 'ok',
    limits,
    warnings,
    git,
    lfs,
  }
}

/** Render bounded human-readable rankings; JSON retains every file entry and path. */
export function formatInspection(report: PushInspection, top = 10): string {
  const lines = [
    `推送检查：${report.status === 'exceeded' ? '超过限额，需要确认' : '未超限'}`,
    `Git pack 预计上传量：${report.git.packComplete ? formatBytes(report.git.packBytes) : `超过 ${formatBytes(report.git.packCapBytes)}`}；限额 ${formatBytes(report.limits.gitBytes)}`,
    `LFS 候选上传量：${formatBytes(report.lfs.candidateBytes)}，${report.lfs.candidateCount} 个对象；限额 ${formatBytes(report.limits.lfsBytes)}`,
    'LFS 尚未查询远端，实际需上传字节数未知；远端已有对象可能跳过。',
    `单文件原始大小限额：${formatBytes(report.limits.fileBytes)}`,
  ]
  for (const [label, files] of [['Git 文件', report.git.files], ['LFS 素材', report.lfs.files]] as const) {
    lines.push(`\n${label}（前 ${Math.min(top, files.length)} / ${files.length}）：`)
    for (const file of files.slice(0, top)) {
      const path = file.paths[0] === undefined ? '（路径未知）' : JSON.stringify(file.paths[0])
      lines.push(`${file.exceedsFileLimit ? '[超限] ' : ''}${formatBytes(file.bytes)}  ${path}  [${file.oid.slice(0, 12)}]${file.paths.length > 1 ? `（${file.paths.length} 个路径）` : ''}`)
    }
  }
  lines.push(`\nGit 文件内容原始大小合计：${formatBytes(report.git.blobBytes)}（含 ${formatBytes(report.git.pointerBytes)} LFS 指针）。`)
  lines.push('原始文件大小不等于压缩/增量后的 Git 上传量；相同内容去重，不同历史版本分别统计。')
  if (report.git.files.some(file => file.exceedsFileLimit))
    lines.push('普通 Git 中存在超限文件：请检查是否应忽略构建产物，或将素材纳入 LFS；已提交历史需单独处理。')
  lines.push(...report.warnings.map(warning => `提示：${warning}`))
  return `${lines.join('\n')}\n`
}

function revisions(oids: string[]): string {
  return `${oids.join('\n')}\n`
}

async function readBlobs(context: CliContext, range: string[]): Promise<Blob[]> {
  if (!range.length)
    return []
  const objects = await inspectGit(context, ['rev-list', '--objects', '--no-object-names', '--stdin'], revisions(range))
  const result = await inspectGit(context, ['cat-file', '--batch-check=%(objecttype) %(objectsize) %(objectname)'], objects.output.toString('ascii'))
  const blobs: Blob[] = []
  for (const line of result.output.toString('ascii').trim().split('\n').filter(Boolean)) {
    const [type, size, oid] = line.split(' ')
    if (!['blob', 'tree', 'commit', 'tag'].includes(type!) || !oid || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid))
      throw new InspectionError('本地对象不完整，无法生成可靠的推送报告')
    if (type === 'blob')
      blobs.push({ oid, bytes: validBytes(size!) })
  }
  return blobs
}

async function readPointers(context: CliContext, blobs: Blob[]): Promise<Map<string, Blob>> {
  const candidates = blobs.filter(blob => blob.bytes > 0 && blob.bytes < 1024)
  const pointers = new Map<string, Blob>()
  // Batch bounded small blobs so arbitrary binary content never becomes an argv or a line protocol.
  for (let offset = 0; offset < candidates.length; offset += 1000) {
    const group = candidates.slice(offset, offset + 1000)
    const result = await inspectGit(context, ['cat-file', '--batch'], revisions(group.map(blob => blob.oid)))
    let cursor = 0
    for (const blob of group) {
      const end = result.output.indexOf(10, cursor)
      if (end < 0 || result.output.subarray(cursor, end).toString('ascii') !== `${blob.oid} blob ${blob.bytes}`)
        throw new InspectionError('无法解析本地 Git 对象')
      cursor = end + 1
      const content = result.output.subarray(cursor, cursor + blob.bytes)
      cursor += blob.bytes + 1
      const pointer = parsePointer(content)
      if (pointer)
        pointers.set(blob.oid, pointer)
    }
    if (cursor !== result.output.length)
      throw new InspectionError('本地 Git 对象读取不完整')
  }
  return pointers
}

function parsePointer(content: Buffer): Blob | undefined {
  const text = content.toString('utf8')
  if (!/^version https:\/\/(?:git-lfs|hawser)\.github\.com\/spec\/v1\n/.test(text))
    return undefined
  const fields = text.trimEnd().split('\n')
  const oidLine = fields.filter(line => line.startsWith('oid '))
  const sizeLine = fields.filter(line => line.startsWith('size '))
  if (oidLine.length !== 1 || sizeLine.length !== 1 || !/^oid sha256:[0-9a-f]{64}$/.test(oidLine[0]!) || !/^size \d+$/.test(sizeLine[0]!))
    throw new InspectionError('发现无效的 LFS 指针，请修复后重试')
  return { oid: oidLine[0]!.slice('oid sha256:'.length), bytes: validBytes(sizeLine[0]!.slice(5)) }
}

async function readPaths(context: CliContext, range: string[]): Promise<Map<string, string[]>> {
  const paths = new Map<string, string[]>()
  if (!range.length)
    return paths
  // NUL-delimited raw diffs preserve spaces, Unicode, control characters and deleted historical files.
  const result = await inspectGit(context, ['log', '--stdin', '--format=', '--raw', '-z', '--no-abbrev', '--no-color', '--no-renames', '--no-ext-diff', '--no-textconv', '--root', '-m'], revisions(range))
  const tokens = result.output.toString('utf8').split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const match = /^:\d{6} \d{6} [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*$/.exec(tokens[i]!.trim())
    if (!match || tokens[i + 1] === undefined)
      continue
    const oid = match[1]!
    const path = tokens[++i]!
    paths.set(oid, [...new Set([...(paths.get(oid) ?? []), path])])
  }
  return paths
}

function validBytes(value: string): number {
  const bytes = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(bytes) || bytes < 0)
    throw new InspectionError('文件大小超出可精确统计的范围')
  return bytes
}

function sumBytes(files: { bytes: number }[]): number {
  const sum = files.reduce((sum, file) => sum + file.bytes, 0)
  if (!Number.isSafeInteger(sum))
    throw new InspectionError('总大小超出可精确统计的范围')
  return sum
}

function fileEntry(blob: Blob, paths: string[], limit: number): InspectionFile {
  return { ...blob, paths: paths.sort(), exceedsFileLimit: blob.bytes > limit }
}

function compareFiles(a: InspectionFile, b: InspectionFile): number {
  return b.bytes - a.bytes || a.oid.localeCompare(b.oid)
}
