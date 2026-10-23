import type { Buffer } from 'node:buffer'
import type { CliContext } from './context.ts'
import type { InspectionRange } from './inspect-git.ts'
import type { TransferSummary } from './transfer-summary.ts'
import { formatBytes } from './commands/status.ts'
import { inspectGit, InspectionError } from './inspect-git.ts'
import { checkRemoteObjects } from './inspect-remote.ts'
import { terminalStyle, terminalText } from './terminal.ts'

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
  /**
   * Whether the content exceeds the per-file budget and is uploaded: an LFS
   * object already in COS (`onRemote`) never does.
   */
  exceedsFileLimit: boolean
  /**
   * LFS objects only, and only when `lfs.remoteChecked`: whether the storage already
   * has the object, so the push skips it. Additive to schema version 1.
   */
  onRemote?: boolean
}

/**
 * One path's net change across the pushed commits: a `git diff --stat` row with sizes.
 * Sizes of LFS files are payload sizes, not pointer sizes.
 */
export interface InspectionChange {
  path: string
  /** `transient`: added and deleted again within the pushed commits; its content is still uploaded. */
  status: 'added' | 'modified' | 'deleted' | 'transient'
  /** Where the latest known content of the path is stored. */
  storage: 'git' | 'lfs'
  /** Size before the pushed commits; `null` when the path is new or the old object is not available locally. */
  beforeBytes: number | null
  /** Size at the pushed tip; `null` when the path is deleted. */
  afterBytes: number | null
  /**
   * Content before the pushed commits: the LFS payload oid (SHA-256, stored at
   * `.git/lfs/objects/<aa>/<bb>/<oid>`) for LFS files, else the Git blob oid.
   * `null` when `beforeBytes` is. Additive to schema version 1.
   */
  beforeOid: string | null
  /** Content at the pushed tip, like `beforeOid`; `null` when `afterBytes` is. */
  afterOid: string | null
  /**
   * Content versions of this path that the push uploads: Git objects not on
   * the remote, or LFS candidates (only those missing in the storage when `lfs.remoteChecked`).
   */
  versions: number
  /** Raw bytes of those versions, before compression; shared content counts for every path that uses it. */
  pushBytes: number
  /** Whether any uploaded version exceeds the per-file budget. */
  exceedsFileLimit: boolean
}

/** Versioned, serializable push inspection result. Byte counts use binary units. */
export interface PushInspection {
  schemaVersion: 1
  status: 'ok' | 'exceeded'
  limits: InspectionLimits
  warnings: string[]
  /** Changed paths, by uploaded raw bytes descending. Additive to schema version 1. */
  changes: InspectionChange[]
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
    /** Whether every candidate was looked up in the storage (direct mode with local keys). */
    remoteChecked: boolean
    /** Which storage was looked up (`COS`, `S3`), when `remoteChecked`. Additive to schema version 1. */
    remoteStorage?: string
    /** Bytes of candidates missing in the storage; `null` unless `remoteChecked`, never a guessed `0`. */
    uploadBytes: number | null
    /** Against `uploadBytes` when known, else `candidateBytes`. */
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
  const history = await readHistory(context, range.lfs)
  const paths = history.paths
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
  const candidates = [...lfsFiles.values()].sort(compareFiles)
  const candidateBytes = sumBytes(candidates)
  const remote = await checkRemoteObjects(context, candidates)
  if (remote.status === 'failed')
    warnings.push(`未能查询存储上已有的 LFS 对象（${remote.reason}），实际上传量按未知处理`)
  const present = remote.status === 'checked' ? remote.present : new Set<string>()
  const files = remote.status === 'checked'
    ? candidates.map(file => ({ ...file, exceedsFileLimit: file.exceedsFileLimit && !present.has(file.oid), onRemote: present.has(file.oid) }))
    : candidates
  const uploadBytes = remote.status === 'checked' ? sumBytes(files.filter(file => !file.onRemote)) : null
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
  const lfs = { candidateBytes, candidateCount: files.length, remoteChecked: uploadBytes !== null, ...(remote.status === 'checked' && { remoteStorage: remote.storage }), uploadBytes, exceedsLimit: (uploadBytes ?? candidateBytes) > limits.lfsBytes, files }
  const lfsUploads = new Set(files.filter(file => !file.onRemote).map(file => file.oid))
  const changes = await readChanges(context, history.events, { blobs: allBlobs, pointers, gitBlobs: new Set(gitBlobs.map(blob => blob.oid)), lfsUploads, fileBytes: limits.fileBytes })
  return {
    schemaVersion: 1,
    status: git.exceedsLimit || lfs.exceedsLimit || [...git.files, ...files].some(file => file.exceedsFileLimit) ? 'exceeded' : 'ok',
    limits,
    warnings,
    changes,
    git,
    lfs,
  }
}

/** Display names of change statuses, shared by the terminal report and the confirmation dialog. */
export const CHANGE_LABELS: Record<InspectionChange['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  transient: '临时',
}

/** Short size for tables, such as `1.52 MiB`; exact bytes stay in JSON. */
export function compactBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = units[0]!
  for (const next of units.slice(1)) {
    if (value < 1024)
      break
    value /= 1024
    unit = next
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${unit}`
}

/** One sentence per exceeded budget, most important first. */
export function exceededReasons(report: PushInspection): string[] {
  const reasons: string[] = []
  if (report.git.exceedsLimit)
    reasons.push(`Git pack 预计${report.git.packComplete ? '' : '超过 '}${compactBytes(report.git.packComplete ? report.git.packBytes : report.git.packCapBytes)}，超出限额 ${compactBytes(report.limits.gitBytes)}`)
  if (report.lfs.exceedsLimit) {
    reasons.push(report.lfs.uploadBytes === null
      ? `LFS 候选 ${compactBytes(report.lfs.candidateBytes)}，超出限额 ${compactBytes(report.limits.lfsBytes)}`
      : `LFS 需上传 ${compactBytes(report.lfs.uploadBytes)}，超出限额 ${compactBytes(report.limits.lfsBytes)}`)
  }
  const large = new Set([...report.git.files, ...report.lfs.files].filter(file => file.exceedsFileLimit).map(file => file.oid)).size
  if (large)
    reasons.push(`${large} 个文件版本超过单文件限额 ${compactBytes(report.limits.fileBytes)}`)
  return reasons
}

/** `before → after` sizes of a change, with the signed difference when both exist. */
export function describeSizeChange(change: InspectionChange): string {
  const side = (bytes: number | null, absent: boolean): string => absent ? '无' : bytes === null ? '未知' : compactBytes(bytes)
  const text = `${side(change.beforeBytes, change.status === 'added' || change.status === 'transient')} → ${side(change.afterBytes, change.status === 'deleted' || change.status === 'transient')}`
  if (change.beforeBytes === null || change.afterBytes === null || change.beforeBytes === change.afterBytes)
    return text
  const delta = change.afterBytes - change.beforeBytes
  return `${text}（${delta > 0 ? '+' : '−'}${compactBytes(Math.abs(delta))}）`
}

/** Optional local destination information and styling for a human-readable report. */
export interface InspectionDisplay {
  style?: ReturnType<typeof terminalStyle>
  source?: string
  target?: string
  transfer?: TransferSummary
}

/** Render bounded human-readable rankings; JSON retains every change, file entry and path. */
export function formatInspection(report: PushInspection, top = 10, display: InspectionDisplay = {}): string {
  const style = display.style ?? terminalStyle()
  const lines = [
    style.title('推送检查'),
    '',
    ...(display.source ? [style.field('来源', display.source)] : []),
    ...(display.transfer ? [style.field('代码目标', display.target ?? '尚未配置 Git 远端', 'info')] : []),
    ...(display.transfer?.fields.map(({ label, value, tone }) => style.field(label, value, tone)) ?? []),
    ...(display.transfer?.warnings.map(warning => style.paint('warning', `! ${warning}`)) ?? []),
    '',
    style.paint(report.status === 'exceeded' ? 'warning' : 'success', report.status === 'exceeded' ? '! 超过限额，需要确认' : '✓ 未超限'),
    ...exceededReasons(report).map(reason => style.paint('error', `  ! ${reason}`)),
    style.field('Git 上传', `${report.git.packComplete ? compactBytes(report.git.packBytes) : `> ${compactBytes(report.git.packCapBytes)}`}（pack 估算）；预算 ${compactBytes(report.limits.gitBytes)}`, report.git.exceedsLimit ? 'error' : undefined),
    ...describeLfs(report).map(line => style.paint(report.lfs.exceedsLimit ? 'error' : 'info', line)),
    style.field('单文件预算', `${compactBytes(report.limits.fileBytes)}（原始大小）`),
  ]
  const changes = report.changes.filter(change => change.versions > 0)
  lines.push(`\n${style.paint('title', `变更文件（前 ${Math.min(top, changes.length)} / ${changes.length}，按本次上传原始大小）`)}`)
  if (!changes.length)
    lines.push(style.paint('muted', '  没有新的文件内容需要上传。'))
  for (const change of changes.slice(0, top)) {
    const versions = change.versions > 1 ? `  ${change.versions} 个版本` : ''
    const tone = change.exceedsFileLimit ? 'error' : change.status === 'added' ? 'success' : 'info'
    lines.push(style.paint(tone, `${change.exceedsFileLimit ? '[超限] ' : ''}${CHANGE_LABELS[change.status]}  ${change.storage === 'lfs' ? 'LFS' : 'Git'}  ${terminalText(JSON.stringify(change.path))}`))
    lines.push(`  上传 ${compactBytes(change.pushBytes)}  ·  ${describeSizeChange(change)}${versions}`)
  }
  if (changes.length > top)
    lines.push(style.paint('muted', '  更多文件：yunbox inspect --push --top 100；全部明细见 --json。'))
  // Objects whose path history is unreadable still need to be visible.
  const unpathed = [...report.git.files, ...report.lfs.files].filter(file => file.paths.length === 0)
  if (unpathed.length) {
    lines.push(`\n路径未知的对象（前 ${Math.min(top, unpathed.length)} / ${unpathed.length}）：`)
    for (const file of unpathed.slice(0, top))
      lines.push(`${file.exceedsFileLimit ? '[超限] ' : ''}${formatBytes(file.bytes)}  [${file.oid.slice(0, 12)}]`)
  }
  lines.push(`\nGit 文件内容原始大小合计：${formatBytes(report.git.blobBytes)}（含 ${formatBytes(report.git.pointerBytes)} LFS 指针）。`)
  lines.push('原始文件大小不等于压缩/增量后的 Git 上传量；同一文件的每个历史版本分别统计。')
  if (report.git.files.some(file => file.exceedsFileLimit))
    lines.push('普通 Git 中存在超限文件：请检查是否应忽略构建产物，或将素材纳入 LFS；已提交历史需单独处理。')
  lines.push(...report.warnings.map(warning => style.paint('warning', `提示：${terminalText(warning)}`)))
  return `${lines.join('\n')}\n`
}

/** The given blob ids whose content is a Git LFS pointer; objects missing locally are left out. */
export async function lfsPointerBlobs(context: CliContext, oids: string[]): Promise<Set<string>> {
  const pointers = await readPointers(context, await readKnownBlobs(context, [...new Set(oids)]))
  return new Set(pointers.keys())
}

function describeLfs(report: PushInspection): string[] {
  const { lfs, limits } = report
  if (lfs.uploadBytes === null) {
    const line = `LFS 候选：${compactBytes(lfs.candidateBytes)} · ${lfs.candidateCount} 个对象；预算 ${compactBytes(limits.lfsBytes)}`
    return lfs.candidateCount ? [line, 'LFS 上传：未知（尚未查询远端，已有对象可能跳过）'] : [line]
  }
  const present = lfs.files.filter(file => file.onRemote).length
  return [
    `LFS 上传：${compactBytes(lfs.uploadBytes)} · ${lfs.candidateCount - present} 个对象；预算 ${compactBytes(limits.lfsBytes)}`,
    `已存在：${present} / ${lfs.candidateCount} 个对象（已查询 ${lfs.remoteStorage ?? 'COS'}），本次跳过。`,
  ]
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

interface PathEvent {
  /** Object before and after one commit's change; `undefined` when the path held no blob. */
  before?: string
  after?: string
}

async function readHistory(context: CliContext, range: string[]): Promise<{ paths: Map<string, string[]>, events: Map<string, PathEvent[]> }> {
  const paths = new Map<string, string[]>()
  const events = new Map<string, PathEvent[]>()
  if (!range.length)
    return { paths, events }
  // NUL-delimited raw diffs preserve spaces, Unicode, control characters and deleted historical files.
  // Oldest first, so a path's first event holds its state before the push and its last event the pushed state.
  const result = await inspectGit(context, ['log', '--stdin', '--reverse', '--format=', '--raw', '-z', '--no-abbrev', '--no-color', '--no-renames', '--no-ext-diff', '--no-textconv', '--root', '-m'], revisions(range))
  const tokens = result.output.toString('utf8').split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]\d*$/.exec(tokens[i]!.trim())
    if (!match || tokens[i + 1] === undefined)
      continue
    const [, beforeMode, afterMode, before, after] = match as unknown as [string, string, string, string, string]
    const path = tokens[++i]!
    // Mode 000000 is an absent path and 160000 a submodule commit: neither is file content.
    const event = { before: blobMode(beforeMode) ? before : undefined, after: blobMode(afterMode) ? after : undefined }
    if (event.after)
      paths.set(event.after, [...new Set([...(paths.get(event.after) ?? []), path])])
    if (event.before || event.after)
      events.set(path, [...(events.get(path) ?? []), event])
  }
  return { paths, events }
}

function blobMode(mode: string): boolean {
  return mode !== '000000' && mode !== '160000'
}

interface ChangeSources {
  blobs: Map<string, Blob>
  pointers: Map<string, Blob>
  gitBlobs: Set<string>
  /** LFS payload oids the push uploads. */
  lfsUploads: Set<string>
  fileBytes: number
}

async function readChanges(context: CliContext, events: Map<string, PathEvent[]>, sources: ChangeSources): Promise<InspectionChange[]> {
  // Objects before the push are outside the pushed range; size them (and spot their LFS pointers) separately.
  const unknown = new Set<string>()
  for (const list of events.values()) {
    for (const oid of [list[0]!.before, list.at(-1)!.after]) {
      if (oid && !sources.blobs.has(oid))
        unknown.add(oid)
    }
  }
  const extra = await readKnownBlobs(context, [...unknown])
  const blobs = new Map([...sources.blobs, ...extra.map(blob => [blob.oid, blob] as const)])
  const pointers = new Map([...sources.pointers, ...await readPointers(context, extra)])
  // An LFS pointer stands for its payload; a blob missing locally (partial clone) is unknown.
  const content = (oid: string | undefined): { oid: string, bytes: number, storage: 'git' | 'lfs' } | undefined => {
    const pointer = oid === undefined ? undefined : pointers.get(oid)
    const blob = oid === undefined ? undefined : blobs.get(oid)
    return pointer ? { ...pointer, storage: 'lfs' as const } : blob ? { ...blob, storage: 'git' as const } : undefined
  }
  const changes: InspectionChange[] = []
  for (const [path, list] of events) {
    const before = list[0]!.before
    const after = list.at(-1)!.after
    const uploaded = new Map<string, number>()
    for (const { after: version } of list) {
      const pointer = version === undefined ? undefined : pointers.get(version)
      if (pointer && sources.lfsUploads.has(pointer.oid))
        uploaded.set(`lfs:${pointer.oid}`, pointer.bytes)
      else if (!pointer && version !== undefined && sources.gitBlobs.has(version))
        uploaded.set(version, blobs.get(version)!.bytes)
    }
    const latest = [...list].reverse().map(event => event.after).find(Boolean) ?? before
    changes.push({
      path,
      status: before ? after ? 'modified' : 'deleted' : after ? 'added' : 'transient',
      storage: content(latest)?.storage ?? 'git',
      beforeBytes: content(before)?.bytes ?? null,
      afterBytes: content(after)?.bytes ?? null,
      beforeOid: content(before)?.oid ?? null,
      afterOid: content(after)?.oid ?? null,
      versions: uploaded.size,
      pushBytes: sumBytes([...uploaded.values()].map(bytes => ({ bytes }))),
      exceedsFileLimit: [...uploaded.values()].some(bytes => bytes > sources.fileBytes),
    })
  }
  return changes.sort((a, b) => b.pushBytes - a.pushBytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Sizes of the given blobs that exist locally; partial clones may lack old objects. */
async function readKnownBlobs(context: CliContext, oids: string[]): Promise<Blob[]> {
  if (!oids.length)
    return []
  const result = await inspectGit(context, ['cat-file', '--batch-check=%(objecttype) %(objectsize) %(objectname)'], revisions(oids))
  const blobs: Blob[] = []
  for (const line of result.output.toString('ascii').trim().split('\n')) {
    const [type, size, oid] = line.split(' ')
    if (type === 'blob' && oid)
      blobs.push({ oid, bytes: validBytes(size!) })
  }
  return blobs
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
