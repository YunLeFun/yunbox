import type { CliContext } from './context.ts'
import { basename } from 'node:path'
import { inspectGit } from './inspect-git.ts'
import { terminalText as visible } from './terminal.ts'

/** Both ends of a push, as the confirmation names and links them. */
export interface PushEnds {
  /** Repository root, for Finder, the editor and the YunBox client. */
  root: string
  /** `本地仓库 name（branch）`. */
  source: string
  /** Credential-free remote name, e.g. `github.com/owner/repo`. */
  target?: string
  /** The remote's probable web page. */
  web?: string
}

/**
 * Credential-free parts of a URL or scp-style remote; undefined for remote names and
 * local paths. `web` is the forge page guessed from it (`https://host/owner/repo`).
 */
function parseRemote(remote: string): { name: string, web?: string } | undefined {
  let host: string
  let path: string
  let web: string | undefined
  try {
    const url = new URL(remote)
    if (url.protocol === 'file:' || !url.host)
      return undefined
    host = url.host
    path = url.pathname
    // HTTP remotes keep their port; SSH ports are not where the forge serves pages.
    web = url.protocol === 'http:' || url.protocol === 'https:' ? `${url.protocol}//${url.host}` : url.protocol === 'ssh:' || url.protocol === 'git:' ? `https://${url.hostname}` : undefined
  }
  catch {
    // `user@host:path`; a one-letter "host" is a Windows drive.
    const scp = /^(?:[^@/]+@)?([^:/\\]{2,}):(?!\/\/)(.+)$/.exec(remote)
    if (!scp)
      return undefined
    host = scp[1]!
    // URL paths arrive percent-encoded; encode scp paths to match.
    path = encodeURI(scp[2]!)
    web = `https://${host}`
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
  let name = `${host}/${path}`
  try {
    name = decodeURI(name)
  }
  catch {}
  // The name reaches the terminal prompt: never let it carry escape sequences.
  return { name: visible(name), web: web && path ? `${web}/${path}` : undefined }
}

/**
 * A short, credential-free name for a remote: `github.com/owner/repo` for URLs and
 * scp-style addresses, the value itself for remote names and local paths.
 */
export function describeRemote(remote: string | undefined): string | undefined {
  return remote ? parseRemote(remote)?.name ?? visible(remote) : undefined
}

/** The web page a remote probably has (`https://github.com/owner/repo`), if it is a URL. */
export function remoteWebUrl(remote: string | undefined): string | undefined {
  return remote ? parseRemote(remote)?.web : undefined
}

/**
 * Which local repository and refs a push comes from, e.g. `本地仓库 yunbox（main）`.
 * `updates` are pre-push lines; without them `branch` names what is inspected.
 */
export function describeSource(root: string, options: { updates?: string, branch?: string } = {}): string {
  const short = (ref: string): string => ref.startsWith('refs/heads/') ? ref.slice(11) : ref.startsWith('refs/tags/') ? `标签 ${ref.slice(10)}` : ref
  const refs = options.updates === undefined
    ? options.branch ? [options.branch] : []
    : options.updates.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(fields => fields.length === 4 && !/^0+$/.test(fields[1]!)).map(([local, , remote]) => short(local!) === short(remote!) ? short(local!) : `${short(local!)} → ${short(remote!)}`)
  const unique = [...new Set(refs)]
  const listed = unique.length > 3 ? `${unique.slice(0, 3).join('、')} 等 ${unique.length} 个引用` : unique.join('、')
  return `本地仓库 ${visible(basename(root))}${listed ? `（${visible(listed)}）` : ''}`
}

/**
 * Name both ends of the push. `context.cwd` is the repository root. Without `--remote`
 * (a manual check), the target is the current branch's upstream remote, if any.
 */
export async function describePush(context: CliContext, options: { remote?: string, updates?: string, head?: string }): Promise<PushEnds> {
  const git = async (args: string[]): Promise<string | undefined> => {
    try {
      return (await inspectGit(context, args)).output.toString('utf8').trim() || undefined
    }
    catch {
      return undefined
    }
  }
  const branch = options.updates === undefined ? options.head ?? await git(['symbolic-ref', '--short', '-q', 'HEAD']) : undefined
  let remote = options.remote
  if (remote === undefined && options.updates === undefined && options.head === undefined && branch) {
    const name = await git(['config', '--get', `branch.${branch}.pushRemote`])
      ?? await git(['config', '--get', 'remote.pushDefault'])
      ?? await git(['config', '--get', `branch.${branch}.remote`])
    remote = name && name !== '.' ? name : undefined
  }
  if (remote === undefined && await git(['remote', 'get-url', '--push', 'origin']))
    remote = 'origin'
  // A remote name (`origin`) is shown as its URL so the dialog says where it really goes.
  if (remote !== undefined && !parseRemote(remote) && /^[\w.-]+$/.test(remote))
    remote = await git(['remote', 'get-url', '--push', '--', remote]) ?? remote
  return { root: context.cwd, source: describeSource(context.cwd, { updates: options.updates, branch }), target: describeRemote(remote), web: remoteWebUrl(remote) }
}
