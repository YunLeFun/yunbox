import { readPushHistory, recordPushHistory } from './push-history.ts'

/** Projects shown by the recent-blocked shortcut; full history has its own retention policy. */
export const BLOCKED_PUSH_LIMIT = 20

/** Why the pre-push hook stopped a push. */
export type BlockedPushReason = 'freeze' | 'exceeded' | 'cancelled'

/** The latest blocked decision for a repository. */
export interface BlockedPush {
  root: string
  at: string
  reason: BlockedPushReason
  summary: string
  note?: string
}

/** Legacy latest-per-project path, retained for import and older clients. */
export { legacyBlockedPushesPath as blockedPushesPath } from './push-history.ts'

/** Read the latest blocked decision per project; confirmed continuations remain in full history. */
export async function readBlockedPushes(env: NodeJS.ProcessEnv): Promise<BlockedPush[]> {
  try {
    const seen = new Set<string>()
    return (await readPushHistory(env)).filter(entry => entry.outcome !== 'continued' && !seen.has(entry.root) && !!seen.add(entry.root)).slice(0, BLOCKED_PUSH_LIMIT).map(entry => ({
      root: entry.root,
      at: entry.at,
      reason: entry.outcome === 'cancelled' ? 'cancelled' : entry.reason,
      summary: [entry.note && `原因：${entry.note}`, entry.summary].filter(Boolean).join('；'),
    }))
  }
  catch { return [] }
}

/** Append a blocked decision to local history without changing the push verdict on errors. */
export async function recordBlockedPush(env: NodeJS.ProcessEnv, entry: BlockedPush): Promise<void> {
  await recordPushHistory(env, {
    root: entry.root,
    at: entry.at,
    reason: entry.reason === 'freeze' ? 'freeze' : 'exceeded',
    outcome: entry.reason === 'cancelled' ? 'cancelled' : 'blocked',
    summary: entry.summary,
    note: entry.note,
  })
}
