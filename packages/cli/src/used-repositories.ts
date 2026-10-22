import type { CliContext } from './context.ts'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { configDirectory } from './cos/secret-store.ts'
import { findRepositoryRoot } from './git.ts'

/** Repositories kept in the record; older ones drop off. */
export const USED_REPOSITORY_LIMIT = 30

/** The latest use of one repository by a `yunbox` command. */
export interface UsedRepository {
  /** Absolute path of the repository's working tree. */
  root: string
  /** ISO 8601 time of the use. */
  at: string
}

interface UsedRepositoryDocument {
  version: 1
  entries: UsedRepository[]
}

/**
 * The per-user record of repositories `yunbox` ran in: `repositories.json`
 * beside the credentials file, never inside a repository. The macOS client
 * adds them to its recent list.
 */
export function usedRepositoriesPath(env: NodeJS.ProcessEnv): string {
  return join(configDirectory(env), 'repositories.json')
}

/** Read the record, newest first; a missing or unreadable file reads as empty. */
export async function readUsedRepositories(env: NodeJS.ProcessEnv): Promise<UsedRepository[]> {
  try {
    const document = JSON.parse(await readFile(usedRepositoriesPath(env), 'utf8')) as Partial<UsedRepositoryDocument>
    if (document.version !== 1 || !Array.isArray(document.entries))
      return []
    return document.entries.filter(isUsedRepository)
  }
  catch {
    return []
  }
}

/**
 * Put `entry` at the top of the record, replacing that repository's previous
 * one, and keep the newest {@link USED_REPOSITORY_LIMIT}. Never throws: the
 * record is a convenience and must not change a command's outcome.
 */
export async function recordUsedRepository(env: NodeJS.ProcessEnv, entry: UsedRepository): Promise<void> {
  const file = usedRepositoriesPath(env)
  const temporary = `${file}.${process.pid}.tmp`
  try {
    const entries = [{ root: entry.root, at: entry.at }, ...(await readUsedRepositories(env)).filter(item => item.root !== entry.root)].slice(0, USED_REPOSITORY_LIMIT)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(temporary, `${JSON.stringify({ version: 1, entries } satisfies UsedRepositoryDocument, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
  }
  catch {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/** Record the repository containing the context's directory, if there is one. Never throws. */
export async function recordCurrentRepository(context: CliContext): Promise<void> {
  try {
    const root = await findRepositoryRoot(context)
    if (root !== undefined)
      await recordUsedRepository(context.env, { root, at: new Date().toISOString() })
  }
  catch {}
}

function isUsedRepository(value: unknown): value is UsedRepository {
  const item = value as Partial<UsedRepository> | null
  return typeof item === 'object' && item !== null && typeof item.root === 'string' && typeof item.at === 'string'
}
