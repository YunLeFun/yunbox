import type { CliContext } from './context.ts'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'

const MAX_OUTPUT = 64 * 1024 * 1024
const TIMEOUT_MS = 60_000
const OID = '[0-9a-f]{40}(?:[0-9a-f]{24})?'
const oidPattern = new RegExp(`^${OID}$`)
const advertisedRef = new RegExp(`^(${OID}) (?:refs/|\\.have(?:$|\\\\0)|capabilities\\^\\{\\})`)
const missingPushBaseWarning = '部分远端推送引用对应的对象不在本地，Git 可能重发历史对象。运行 git fetch 可补齐对象'

interface GitInspectionResult {
  output: Buffer
  bytes: number
  complete: boolean
}

/** A failed inspection; messages never contain subprocess output or remote URLs. */
export class InspectionError extends Error {}

/** Run a bounded, non-interactive Git query, or count a pack stream up to a cap. */
export async function inspectGit(context: CliContext, args: string[], input = '', packCap?: number, signal?: AbortSignal): Promise<GitInspectionResult> {
  return runInspectionGit(context, args, { input, packCap, signal })
}

function runInspectionGit(context: CliContext, args: string[], { input = '', packCap, signal, tracePackets }: { input?: string, packCap?: number, signal?: AbortSignal, tracePackets?: boolean }): Promise<GitInspectionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: context.cwd,
      env: {
        ...context.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_NO_LAZY_FETCH: '1',
        GIT_OPTIONAL_LOCKS: '0',
        ...(tracePackets ? { GIT_TRACE_PACKET: '2' } : {}),
      },
      stdio: ['pipe', tracePackets ? 'ignore' : 'pipe', tracePackets ? 'pipe' : 'ignore'],
      windowsHide: true,
      signal,
    })
    const stdin = child.stdin!
    const output = (tracePackets ? child.stderr : child.stdout)!
    let bytes = 0
    let failure: string | undefined
    let capped = false
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      failure = 'Git 检查超时，请缩小检查范围或稍后重试'
      child.kill('SIGKILL')
      output.destroy()
    }, TIMEOUT_MS)
    output.on('data', (chunk: Buffer) => {
      if (capped || failure)
        return
      bytes += chunk.length
      if (packCap !== undefined && bytes > packCap) {
        bytes = packCap + 1
        capped = true
        child.kill('SIGKILL')
      }
      else if (packCap === undefined) {
        if (bytes > MAX_OUTPUT) {
          failure = 'Git 检查结果超过 64 MiB，请缩小检查范围'
          child.kill('SIGKILL')
          output.destroy()
        }
        else {
          chunks.push(chunk)
        }
      }
    })
    stdin.on('error', () => {})
    child.on('error', () => {
      failure = signal?.aborted ? 'Git 检查已取消' : '无法启动 Git，请检查安装和 PATH'
      // An aborted child can emit error before exiting. Wait for close so callers
      // can safely remove preview files and know the subprocess has been reaped.
      if (child.pid === undefined) {
        clearTimeout(timer)
        reject(new InspectionError(failure))
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (failure || (!capped && code !== 0))
        reject(new InspectionError(failure ?? 'Git 对象检查失败，请确认引用有效且本地历史完整（必要时先 fetch）'))
      else
        resolve({ output: Buffer.concat(chunks), bytes, complete: !capped })
    })
    stdin.end(input)
  })
}

/** Git object ranges used by inspection; LFS new-branch candidates retain full history. */
export interface InspectionRange {
  git: string[]
  lfs: string[]
  warnings: string[]
  /** Push-advertised objects missing locally when creating a branch. */
  missingNewBranchBases?: string[]
}

/** Resolve hook updates or an explicit comparison without reading the index or worktree. */
export async function resolveInspectionRange(context: CliContext, options: { updates?: string, base?: string, head?: string, remote?: string }): Promise<InspectionRange> {
  const tips = new Set<string>()
  const bases = new Set<string>()
  const warnings: string[] = []
  let discoverRemote = options.updates !== undefined
  let createsBranch = false
  let missingNewBranchBases: string[] | undefined
  if (options.updates !== undefined) {
    for (const line of options.updates.split(/\r?\n/).filter(line => line.trim() !== '')) {
      const fields = line.trim().split(/\s+/)
      if (fields.length !== 4 || !oidPattern.test(fields[1]!) || !oidPattern.test(fields[3]!))
        throw new InspectionError('无效的 pre-push 输入，应为 local-ref local-oid remote-ref remote-oid')
      const [, local, remoteRef, remote] = fields as [string, string, string, string]
      if (/^0+$/.test(local))
        continue
      tips.add(local)
      if (/^0+$/.test(remote)) {
        createsBranch ||= remoteRef.startsWith('refs/heads/')
        continue
      }
      if (!(await localObjects(context, [remote])).length)
        throw new InspectionError('远端基准提交不在本地，无法可靠计算增量上传量和文件状态。请先运行 git fetch，再重试推送检查。')
      bases.add(remote)
    }
  }
  else {
    tips.add(await resolveObject(context, options.head ?? 'HEAD'))
    if (options.base !== undefined) {
      bases.add(await resolveObject(context, options.base))
    }
    else {
      try {
        bases.add(await resolveObject(context, '@{upstream}'))
        warnings.push('使用本地 upstream 快照；未查询远端最新状态')
      }
      catch {
        warnings.push('没有可用的 upstream，检查所选提交的全部历史')
        discoverRemote = true
      }
    }
  }
  // Other Git refs establish pack boundaries, but do not prove the LFS payloads are present.
  const lfs = [...tips, ...[...bases].map(oid => `^${oid}`)]
  const [firstTip] = tips
  if (firstTip && discoverRemote && options.remote !== undefined) {
    try {
      const advertised = await readPushAdvertisement(context, options.remote, firstTip)
      const known = new Set(await localObjects(context, advertised))
      if (known.size < advertised.length) {
        warnings.push(missingPushBaseWarning)
        if (createsBranch)
          missingNewBranchBases = advertised.filter(oid => !known.has(oid))
      }
      for (const oid of known)
        bases.add(oid)
    }
    catch {
      warnings.push('无法读取远端引用，Git pack 采用保守估算')
    }
  }
  return {
    git: tips.size ? [...tips, ...[...bases].map(oid => `^${oid}`)] : [],
    lfs: tips.size ? lfs : [],
    warnings: [...new Set(warnings)],
    ...(missingNewBranchBases && { missingNewBranchBases }),
  }
}

/** Fetch a missing, push-advertised default branch tip into the object store. */
export async function refreshNewBranchBases(context: CliContext, range: InspectionRange, remote: string): Promise<InspectionRange | undefined> {
  const { missingNewBranchBases: missing, ...rest } = range
  if (!missing?.length)
    return undefined
  try {
    const { output } = await inspectGit(context, ['ls-remote', '--', remote, 'HEAD'])
    const head = /^([0-9a-f]+)\tHEAD$/m.exec(output.toString('ascii'))?.[1]
    if (head === undefined || !missing.includes(head))
      return undefined
    // Fetch the exact advertised tip without destinations, tag following or
    // local tracking updates. The parent Git push can use the downloaded objects.
    await inspectGit(context, [
      'fetch',
      '--no-tags',
      '--no-prune',
      '--no-prune-tags',
      '--no-write-fetch-head',
      '--no-recurse-submodules',
      '--no-auto-gc',
      '--no-write-commit-graph',
      '--refmap=',
      '--',
      remote,
      head,
    ])
    const known = await localObjects(context, missing)
    if (!known.length)
      return undefined
    const warnings = known.length === missing.length ? range.warnings.filter(warning => warning !== missingPushBaseWarning) : range.warnings
    return {
      ...rest,
      git: [...range.git, ...known.map(oid => `^${oid}`)],
      warnings: [...warnings, '已补齐远端默认分支对象并重新估算 Git 上传量'],
    }
  }
  catch {
    return undefined
  }
}

async function readPushAdvertisement(context: CliContext, remote: string, tip: string): Promise<string[]> {
  // Git's dry run uses the push transport and credentials without transferring
  // objects or updating refs. Skip re-entering this hook and fetch negotiation.
  const { output } = await runInspectionGit(context, [
    '-c',
    'protocol.version=0',
    '-c',
    'push.negotiate=false',
    'push',
    '--dry-run',
    '--no-verify',
    '--no-follow-tags',
    '--no-signed',
    '--recurse-submodules=no',
    '--',
    remote,
    `+${tip}:refs/yunbox/inspect`,
  ], { tracePackets: true })
  let advertised: Set<string> | undefined
  let batch: Set<string> | undefined
  for (const line of output.toString('utf8').split(/\r?\n/)) {
    // Local and SSH transports trace as "push"; the HTTP helper traces as "git".
    const packet = /\bpacket:\s+(?:push|git)< (.*)$/.exec(line)?.[1]
    if (packet === undefined)
      continue
    const oid = advertisedRef.exec(packet)?.[1]
    if (oid !== undefined) {
      batch ??= new Set()
      if (!/^0+$/.test(oid))
        batch.add(oid)
    }
    else if (packet === '0000' && batch) {
      // A named remote can have multiple push URLs. Exclude only objects that
      // every destination advertises. HTTP may trace the same list twice.
      const received = batch
      advertised = advertised === undefined ? received : new Set([...advertised].filter(oid => received.has(oid)))
      batch = undefined
    }
  }
  if (advertised === undefined || batch !== undefined)
    throw new InspectionError('无法读取远端引用')
  return [...advertised]
}

async function resolveObject(context: CliContext, ref: string): Promise<string> {
  const result = await inspectGit(context, ['rev-parse', '--verify', '--end-of-options', `${ref}^{object}`])
  return result.output.toString('ascii').trim()
}

async function localObjects(context: CliContext, oids: string[]): Promise<string[]> {
  if (!oids.length)
    return []
  const result = await inspectGit(context, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${oids.join('\n')}\n`)
  return result.output.toString('ascii').trim().split('\n').filter(line => / (?:commit|tree|blob|tag)$/.test(line)).map(line => line.split(' ')[0]!)
}
