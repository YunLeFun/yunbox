import type { CliContext } from './context.ts'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'

const MAX_OUTPUT = 64 * 1024 * 1024
const TIMEOUT_MS = 60_000

/** A failed inspection; messages never contain subprocess output or remote URLs. */
export class InspectionError extends Error {}

/** Run a bounded, non-interactive Git query, or count a pack stream up to a cap. */
export async function inspectGit(context: CliContext, args: string[], input = '', packCap?: number, signal?: AbortSignal): Promise<{ output: Buffer, bytes: number, complete: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: context.cwd,
      env: { ...context.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      signal,
    })
    let bytes = 0
    let failure: string | undefined
    let capped = false
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      failure = 'Git 检查超时，请缩小检查范围或稍后重试'
      child.kill('SIGKILL')
    }, TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
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
        }
        else {
          chunks.push(chunk)
        }
      }
    })
    child.stdin.on('error', () => {})
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
    child.stdin.end(input)
  })
}

/** Git object ranges used by inspection; LFS new-branch candidates retain full history. */
export interface InspectionRange {
  git: string[]
  lfs: string[]
  warnings: string[]
}

/** Resolve hook updates or an explicit comparison without reading the index or worktree. */
export async function resolveInspectionRange(context: CliContext, options: { updates?: string, base?: string, head?: string, remote?: string }): Promise<InspectionRange> {
  const tips = new Set<string>()
  const bases = new Set<string>()
  const warnings: string[] = []
  let discoverRemote = false
  const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
  if (options.updates !== undefined) {
    for (const line of options.updates.split(/\r?\n/).filter(line => line.trim() !== '')) {
      const fields = line.trim().split(/\s+/)
      if (fields.length !== 4 || !oidPattern.test(fields[1]!) || !oidPattern.test(fields[3]!))
        throw new InspectionError('无效的 pre-push 输入，应为 local-ref local-oid remote-ref remote-oid')
      const [, local, , remote] = fields as [string, string, string, string]
      if (/^0+$/.test(local))
        continue
      tips.add(local)
      if (/^0+$/.test(remote)) {
        discoverRemote = true
      }
      else {
        const known = await localObjects(context, [remote])
        if (known.length) {
          bases.add(remote)
        }
        else {
          throw new InspectionError('远端基准提交不在本地，无法可靠计算增量上传量和文件状态。请先运行 git fetch，再重试推送检查。')
        }
      }
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
  const lfs = [...tips, ...[...bases].map(oid => `^${oid}`)]
  if (tips.size && discoverRemote && options.remote !== undefined) {
    try {
      const result = await inspectGit(context, ['ls-remote', '--refs', '--', options.remote])
      const advertised = result.output.toString('utf8').split('\n').map(line => line.split(/\s+/)[0]!).filter(oid => oidPattern.test(oid))
      const known = await localObjects(context, [...new Set(advertised)])
      if (known.length < new Set(advertised).size)
        warnings.push('部分远端引用不在本地，Git pack 为保守估算；先运行 git fetch 可改进增量估算')
      for (const oid of known)
        bases.add(oid)
    }
    catch {
      warnings.push('无法读取远端引用，Git pack 采用保守估算')
    }
  }
  return { git: tips.size ? [...tips, ...[...bases].map(oid => `^${oid}`)] : [], lfs: tips.size ? lfs : [], warnings: [...new Set(warnings)] }
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
