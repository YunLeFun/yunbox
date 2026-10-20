import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { configDirectory } from './cos/secret-store.ts'

/** Repositories kept in the record; older ones drop off. */
export const BLOCKED_PUSH_LIMIT = 20

/** Longest summary kept, in characters. */
const SUMMARY_LIMIT = 200

/**
 * Why the pre-push hook stopped a push: a freeze window, a budget it could not
 * ask about, or the user answering “cancel” in the confirmation.
 */
export type BlockedPushReason = 'freeze' | 'exceeded' | 'cancelled'

/** The latest blocked push of one repository. */
export interface BlockedPush {
  /** Absolute path of the repository's working tree. */
  root: string
  /** ISO 8601 time of the block. */
  at: string
  reason: BlockedPushReason
  /** Short human summary, e.g. the window or the exceeded budgets. Never holds a URL or token. */
  summary: string
}

interface BlockedPushDocument {
  version: 1
  entries: BlockedPush[]
}

/**
 * The per-user record of recently blocked pushes: `blocked-pushes.json` beside
 * the credentials file, never inside a repository. The macOS client reads it.
 */
export function blockedPushesPath(env: NodeJS.ProcessEnv): string {
  return join(configDirectory(env), 'blocked-pushes.json')
}

/** Read the record, newest first; a missing or unreadable file reads as empty. */
export async function readBlockedPushes(env: NodeJS.ProcessEnv): Promise<BlockedPush[]> {
  try {
    const document = JSON.parse(await readFile(blockedPushesPath(env), 'utf8')) as Partial<BlockedPushDocument>
    if (document.version !== 1 || !Array.isArray(document.entries))
      return []
    return document.entries.filter(isBlockedPush)
  }
  catch {
    return []
  }
}

/**
 * Put `entry` at the top of the record, replacing that repository's previous
 * one, and keep the newest {@link BLOCKED_PUSH_LIMIT}. Never throws: the push
 * is already blocked, and failing to remember it must not change the outcome.
 */
export async function recordBlockedPush(env: NodeJS.ProcessEnv, entry: BlockedPush): Promise<void> {
  const file = blockedPushesPath(env)
  const temporary = `${file}.${process.pid}.tmp`
  try {
    const summary = entry.summary.replace(/\s+/g, ' ').trim()
    const latest: BlockedPush = { root: entry.root, at: entry.at, reason: entry.reason, summary: summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT - 1)}…` : summary }
    const entries = [latest, ...(await readBlockedPushes(env)).filter(item => item.root !== entry.root)].slice(0, BLOCKED_PUSH_LIMIT)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(temporary, `${JSON.stringify({ version: 1, entries } satisfies BlockedPushDocument, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
  }
  catch {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function isBlockedPush(value: unknown): value is BlockedPush {
  const item = value as Partial<BlockedPush> | null
  return typeof item === 'object' && item !== null && typeof item.root === 'string' && typeof item.at === 'string'
    && (item.reason === 'freeze' || item.reason === 'exceeded' || item.reason === 'cancelled') && typeof item.summary === 'string'
}
