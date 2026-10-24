import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { configDirectory } from './cos/secret-store.ts'

/** Local retention limits, shared with desktop clients through `history --json`. */
export const PUSH_HISTORY_POLICY = { days: 90, perRepository: 200, total: 5000 } as const

/** A push protection decision, not the outcome of the later Git upload. */
export interface PushHistoryEntry {
  id: string
  root: string
  at: string
  reason: 'freeze' | 'exceeded'
  outcome: 'blocked' | 'cancelled' | 'continued'
  summary: string
  note?: string
}

/** The per-user history file; never stored inside a Git repository. */
export function pushHistoryPath(env: NodeJS.ProcessEnv): string {
  return join(configDirectory(env), 'push-history.json')
}

/** The old snapshot file, used only to import existing records. */
export function legacyBlockedPushesPath(env: NodeJS.ProcessEnv): string {
  return join(configDirectory(env), 'blocked-pushes.json')
}

/** Match Git paths and macOS standardized file URLs, even after a project is deleted. */
export function pushHistoryProjectKey(root: string): string {
  const path = resolve(root)
  if (process.platform === 'darwin')
    return path.replace(/^\/private(?=\/(?:tmp|var)(?:\/|$))/, '')
  return process.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path
}

function text(value: string, limit: number): string {
  const characters = Array.from(value.replace(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, ' ').replace(/\s+/g, ' ').trim())
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : characters.join('')
}

/** Apply age and size limits without merging separate decisions for one project. */
export function retainedPushHistory(entries: PushHistoryEntry[], now = Date.now()): PushHistoryEntry[] {
  const counts = new Map<string, number>()
  const ids = new Set<string>()
  return entries.filter(entry => Date.parse(entry.at) >= now - PUSH_HISTORY_POLICY.days * 86400000)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .filter((entry) => {
      const project = pushHistoryProjectKey(entry.root)
      const count = counts.get(project) ?? 0
      if (ids.has(entry.id) || count >= PUSH_HISTORY_POLICY.perRepository)
        return false
      ids.add(entry.id)
      counts.set(project, count + 1)
      return true
    })
    .slice(0, PUSH_HISTORY_POLICY.total)
}

async function legacyEntries(env: NodeJS.ProcessEnv): Promise<PushHistoryEntry[]> {
  try {
    const data = JSON.parse(await readFile(join(configDirectory(env), 'blocked-pushes.json'), 'utf8'))
    if (data.version !== 1 || !Array.isArray(data.entries))
      return []
    return data.entries.flatMap((entry: Record<string, unknown>) => {
      if (!entry || typeof entry !== 'object' || typeof entry.root !== 'string' || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at)) || !['freeze', 'exceeded', 'cancelled'].includes(String(entry.reason)))
        return []
      return [{
        id: `legacy-${createHash('sha256').update(JSON.stringify(entry)).digest('hex')}`,
        root: entry.root,
        at: entry.at,
        reason: entry.reason === 'freeze' ? 'freeze' as const : 'exceeded' as const,
        outcome: entry.reason === 'cancelled' ? 'cancelled' as const : 'blocked' as const,
        summary: typeof entry.summary === 'string' ? text(entry.summary, 200) : '',
      }]
    })
  }
  catch { return [] }
}

/** Read retained history, importing the old latest-per-project record until first write. */
export async function readPushHistory(env: NodeJS.ProcessEnv): Promise<PushHistoryEntry[]> {
  let content: string
  try {
    content = await readFile(pushHistoryPath(env), 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return retainedPushHistory(await legacyEntries(env))
    throw new Error('无法读取本机推送历史')
  }
  try {
    const data = JSON.parse(content)
    if (data.version !== 1 || !Array.isArray(data.entries))
      throw new Error('invalid history')
    return retainedPushHistory(data.entries.filter((entry: Partial<PushHistoryEntry> | null): entry is PushHistoryEntry => !!entry
      && typeof entry.id === 'string' && typeof entry.root === 'string' && typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at))
      && ['freeze', 'exceeded'].includes(entry.reason ?? '') && ['blocked', 'cancelled', 'continued'].includes(entry.outcome ?? '')
      && typeof entry.summary === 'string' && (entry.note === undefined || typeof entry.note === 'string')))
  }
  catch { throw new Error('本机推送历史格式不正确；可清理全部历史后重新记录') }
}

async function writeHistory(env: NodeJS.ProcessEnv, entries: PushHistoryEntry[]): Promise<void> {
  const file = pushHistoryPath(env)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, entries })}\n`, { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
  }
  finally { await rm(temporary, { force: true }).catch(() => {}) }
}

async function locked<T>(env: NodeJS.ProcessEnv, operation: () => Promise<T>): Promise<T> {
  const file = pushHistoryPath(env)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const lock = `${file}.lock`
  const ownerFile = join(lock, 'owner.json')
  const token = randomUUID()
  const deadline = Date.now() + 2000
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 })
      await writeFile(ownerFile, JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flag: 'wx' })
      break
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw error
      const stat = await lstat(lock).catch(() => undefined)
      if (stat?.isDirectory()) {
        const owner = await readFile(ownerFile, 'utf8').then(value => JSON.parse(value) as { pid?: number }).catch(() => undefined)
        let abandoned = (!Number.isSafeInteger(owner?.pid) || (owner?.pid ?? 0) <= 0) && Date.now() - stat.mtimeMs > 30000
        if (Number.isSafeInteger(owner?.pid) && owner!.pid! > 0) {
          try {
            process.kill(owner!.pid!, 0)
          }
          catch (error) { abandoned = (error as NodeJS.ErrnoException).code === 'ESRCH' }
        }
        if (abandoned) {
          await rm(ownerFile, { force: true }).catch(() => {})
          await rmdir(lock).catch(() => {})
        }
      }
      if (Date.now() >= deadline)
        throw new Error('推送历史正在更新，请稍后重试')
      await setTimeout(20)
    }
  }
  try {
    return await operation()
  }
  finally {
    const owner = await readFile(ownerFile, 'utf8').then(value => JSON.parse(value) as { token?: string }).catch(() => undefined)
    if (owner?.token === token) {
      await rm(ownerFile, { force: true }).catch(() => {})
      await rmdir(lock).catch(() => {})
    }
  }
}

/** Append a decision without ever changing the push verdict when local persistence fails. */
export async function recordPushHistory(env: NodeJS.ProcessEnv, entry: Omit<PushHistoryEntry, 'id'>): Promise<void> {
  try {
    await locked(env, async () => {
      const note = entry.note && text(entry.note, 500)
      const next: PushHistoryEntry = { ...entry, id: randomUUID(), summary: text(entry.summary, 200), ...(note ? { note } : {}) }
      await writeHistory(env, retainedPushHistory([next, ...await readPushHistory(env)]))
    })
  }
  catch { /* History is local convenience; recording must never permit or block a push. */ }
}

/** Clear one project's decisions, or all local history, while preserving every Git/storage setting. */
export async function clearPushHistory(env: NodeJS.ProcessEnv, root?: string): Promise<void> {
  await locked(env, async () => {
    const project = root === undefined ? undefined : pushHistoryProjectKey(root)
    const entries = project === undefined ? [] : (await readPushHistory(env)).filter(entry => pushHistoryProjectKey(entry.root) !== project)
    await writeHistory(env, entries)
    // An empty canonical file prevents old snapshots from reappearing after clearing.
    const legacy = join(configDirectory(env), 'blocked-pushes.json')
    if (project === undefined) {
      await rm(legacy, { force: true })
    }
    else {
      try {
        const data = JSON.parse(await readFile(legacy, 'utf8'))
        if (data.version === 1 && Array.isArray(data.entries)) {
          data.entries = data.entries.filter((entry: { root?: unknown }) => typeof entry.root !== 'string' || pushHistoryProjectKey(entry.root) !== project)
          await writeFile(legacy, `${JSON.stringify(data)}\n`, { mode: 0o600 })
        }
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw new Error('历史已清理，但旧版最近拦截记录未能清理')
      }
    }
  })
}
