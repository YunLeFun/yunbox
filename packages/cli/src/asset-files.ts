import type { CliContext } from './context.ts'
import { writeFile } from 'node:fs/promises'
import { CliError } from './context.ts'
import { firstLine, runGit } from './git.ts'

/** One regular file in the index. */
export interface IndexEntry {
  path: string
  /** Blob id of the staged content. */
  oid: string
}

/** Lower-case extension of the last path component; `''` when there is none (dotfiles have none). */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Regular files staged in the index; symlinks and submodules are left out, they can never be LFS pointers. */
export async function indexEntries(repo: CliContext): Promise<IndexEntry[]> {
  const result = await runGit(repo, ['ls-files', '--stage', '-z'])
  if (result.code !== 0)
    throw new CliError(`git ls-files 失败：${firstLine(result.stderr)}`)
  const entries: IndexEntry[] = []
  for (const record of result.stdout.split('\0')) {
    // <mode> <oid> <stage>\t<path>
    const match = /^(100644|100755) ([0-9a-f]+) 0\t(.*)$/s.exec(record)
    if (match !== null)
      entries.push({ path: match[3]!, oid: match[2]! })
  }
  return entries
}

/** The `filter` attribute of each path, as `git check-attr` sees it now. */
export async function filterAttributes(repo: CliContext, paths: string[]): Promise<Map<string, string>> {
  const values = new Map<string, string>()
  if (paths.length === 0)
    return values
  // runGitChecked would trim the output, and paths may start or end with spaces.
  const result = await runGit(repo, ['check-attr', '-z', '--stdin', 'filter'], { input: `${paths.join('\0')}\0` })
  if (result.code !== 0)
    throw new CliError(`git check-attr 失败：${firstLine(result.stderr)}`)
  const fields = result.stdout.split('\0')
  for (let index = 0; index + 2 < fields.length; index += 3)
    values.set(fields[index]!, fields[index + 2]!)
  return values
}

/**
 * Tracked files that `merged` would put under the LFS filter although they
 * were committed as ordinary files, grouped by the added pattern that
 * catches them. Git itself decides what matches (case folding, nested
 * `.gitattributes`), so this briefly writes `merged` and asks `git check-attr`.
 * The caller rewrites the file afterwards.
 */
export async function committedOutsideLfs(repo: CliContext, attributesPath: string, merged: string, patterns: string[]): Promise<Map<string, string[]>> {
  const captured = new Map<string, string[]>()
  const extensions = new Set(patterns.map(pattern => pattern.slice('*.'.length)))
  const listed = await runGit(repo, ['ls-files', '-z'])
  if (listed.code !== 0)
    return captured
  const candidates = listed.stdout.split('\0').filter(path => extensions.has(extensionOf(path)))
  if (candidates.length === 0)
    return captured
  const before = await filterAttributes(repo, candidates)
  await writeFile(attributesPath, merged)
  const after = await filterAttributes(repo, candidates)
  for (const path of candidates) {
    if (before.get(path) === 'lfs' || after.get(path) !== 'lfs')
      continue
    const pattern = `*.${extensionOf(path)}`
    captured.set(pattern, [...captured.get(pattern) ?? [], path])
  }
  return captured
}
