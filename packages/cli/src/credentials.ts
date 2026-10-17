import type { CliContext } from './context.ts'
import type { ServiceUrl } from './service-url.ts'
import process from 'node:process'
import { readGitConfigForUrl, runGit } from './git.ts'

/** The username stored with YunBox tokens. The server ignores it; only the password (token) matters. */
export const CREDENTIAL_USERNAME = 'yunbox'

/** A credential returned by the configured Git credential helpers. */
export interface StoredCredential {
  username: string
  password: string
}

/**
 * Settings that stop `git credential fill` from asking anyone: no terminal
 * prompt, no askpass program, and no Git Credential Manager dialog. Lookups
 * must only read what the helpers already hold.
 */
const NON_INTERACTIVE_CONFIG = ['-c', 'core.askPass=', '-c', 'credential.interactive=false']
const NON_INTERACTIVE_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GCM_INTERACTIVE: 'never',
}

/** The credential helper Git uses for `service`, or `undefined` when none is configured. */
export async function findCredentialHelper(context: CliContext, service: ServiceUrl): Promise<string | undefined> {
  const helper = await readGitConfigForUrl(context, 'credential.helper', `${service.origin}/`)
  return helper === undefined || helper.trim() === '' ? undefined : helper.trim()
}

/** Look up the stored credential for the service host without prompting. */
export async function fillCredential(context: CliContext, service: ServiceUrl): Promise<StoredCredential | undefined> {
  const result = await runGit(context, [...NON_INTERACTIVE_CONFIG, 'credential', 'fill'], {
    input: credentialInput(service),
    env: NON_INTERACTIVE_ENV,
  })
  if (result.code !== 0)
    return undefined
  const fields = parseCredentialOutput(result.stdout)
  const password = fields.get('password')
  if (password === undefined || password === '')
    return undefined
  return { username: fields.get('username') ?? '', password }
}

/**
 * Store a token for the service host in the Git credential helpers, replacing
 * any credential they already hold for it.
 */
export async function approveCredential(context: CliContext, service: ServiceUrl, token: string, previous?: StoredCredential): Promise<void> {
  if (previous !== undefined)
    await rejectCredential(context, service, previous)
  const result = await runGit(context, ['credential', 'approve'], {
    input: credentialInput(service, { username: CREDENTIAL_USERNAME, password: token }),
    env: NON_INTERACTIVE_ENV,
  })
  if (result.code !== 0)
    throw new Error('git credential approve 失败，凭据没有保存')
}

/** Ask the credential helpers to forget a credential. */
export async function rejectCredential(context: CliContext, service: ServiceUrl, credential: StoredCredential): Promise<void> {
  await runGit(context, ['credential', 'reject'], {
    input: credentialInput(service, credential),
    env: NON_INTERACTIVE_ENV,
  })
}

/** Shell command that removes the stored credential for the service, for fix hints. */
export function rejectCommand(service: ServiceUrl): string {
  return `printf 'protocol=${service.protocol}\\nhost=${service.host}\\n\\n' | git credential reject`
}

/** Command that configures a credential helper suitable for this platform, for fix hints. */
export function suggestedHelperCommands(platform: NodeJS.Platform = process.platform): string[] {
  switch (platform) {
    case 'darwin':
      return ['git config --global credential.helper osxkeychain']
    case 'win32':
      return ['git config --global credential.helper manager']
    default:
      return [
        'git config --global credential.helper libsecret   # 有桌面钥匙串时',
        'git config --global credential.helper \'cache --timeout=86400\'   # 只保存在内存，一天后过期',
      ]
  }
}

/** Validate a personal token's shape before storing it. */
export function assertTokenShape(token: string): void {
  if (token === '')
    throw new TypeError('没有读到 token')
  if (/\s/.test(token))
    throw new TypeError('token 不能包含空白字符')
  if (!/^ybx_[\w-]{16,}$/.test(token))
    throw new TypeError('这不像 YunBox token（应以 ybx_ 开头）；请检查是否复制完整')
}

function credentialInput(service: ServiceUrl, credential?: StoredCredential): string {
  const lines = [`protocol=${service.protocol}`, `host=${service.host}`]
  if (credential !== undefined)
    lines.push(`username=${credential.username}`, `password=${credential.password}`)
  return `${lines.join('\n')}\n\n`
}

function parseCredentialOutput(output: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator > 0)
      fields.set(line.slice(0, separator), line.slice(separator + 1))
  }
  return fields
}
