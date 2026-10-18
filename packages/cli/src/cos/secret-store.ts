// @env node

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

/** A long-lived key pair saved by `yunbox login`. */
export interface StoredKeys {
  secretId: string
  secretKey: string
}

/** Where `yunbox login` keeps the key pair on this computer. */
export type SecretStoreKind = 'keychain' | 'file'

/**
 * One place that can hold the user's key pair. Implementations never log,
 * print or pass the SecretKey on a command line.
 */
export interface SecretStore {
  readonly kind: SecretStoreKind
  /** Human description of where the keys are, safe to print. */
  readonly description: string
  /** @returns `undefined` when nothing is saved. @throws {Error} when the store cannot be read. */
  read: () => Promise<StoredKeys | undefined>
  /** Save, replacing what was there. @throws {Error} when the store is unavailable. */
  write: (keys: StoredKeys) => Promise<void>
  /** @returns whether something was deleted. */
  delete: () => Promise<boolean>
}

interface StoredDocument {
  version: 1
  secretId: string
  secretKey: string
}

function encode(keys: StoredKeys): string {
  const document: StoredDocument = { version: 1, secretId: keys.secretId, secretKey: keys.secretKey }
  return JSON.stringify(document)
}

function decode(text: string): StoredKeys | undefined {
  try {
    const value = JSON.parse(text) as Partial<StoredDocument>
    if (value.version === 1 && typeof value.secretId === 'string' && typeof value.secretKey === 'string')
      return { secretId: value.secretId, secretKey: value.secretKey }
  }
  catch {}
  return undefined
}

/**
 * The per-user credentials file: `$YUNBOX_CONFIG_DIR/credentials.json`, else
 * `%APPDATA%\yunbox\` on Windows, else `$XDG_CONFIG_HOME/yunbox/` or
 * `~/.config/yunbox/`. It lives outside every repository.
 */
export function credentialsFilePath(env: NodeJS.ProcessEnv): string {
  if (env.YUNBOX_CONFIG_DIR)
    return join(env.YUNBOX_CONFIG_DIR, 'credentials.json')
  if (process.platform === 'win32' && env.APPDATA)
    return join(env.APPDATA, 'yunbox', 'credentials.json')
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config')
  return join(base, 'yunbox', 'credentials.json')
}

/** The plain JSON file with owner-only permissions (0600); the fallback on every platform. */
export class FileSecretStore implements SecretStore {
  readonly kind = 'file'
  readonly description: string

  constructor(readonly file: string) {
    this.description = file
  }

  async read(): Promise<StoredKeys | undefined> {
    if (!existsSync(this.file))
      return undefined
    const keys = decode(await readFile(this.file, 'utf8'))
    if (keys === undefined)
      throw new Error(`凭据文件 ${this.file} 格式不对。运行 yunbox login 重新保存，或删除它`)
    return keys
  }

  async write(keys: StoredKeys): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(JSON.parse(encode(keys)), null, 2)}\n`, { mode: 0o600 })
    // writeFile's mode only applies to new files; make sure a reused name is private too.
    await chmod(temporary, 0o600)
    await rename(temporary, this.file)
  }

  async delete(): Promise<boolean> {
    if (!existsSync(this.file))
      return false
    await rm(this.file)
    return true
  }
}

/** Result of running the `security` tool. */
export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Runs `/usr/bin/security` with arguments and optional standard input. The
 * default spawns the real tool; tests inject a fake to see every argv.
 */
export type SecurityRunner = (args: string[], input?: string) => Promise<CommandResult>

/** `security` exit code for "item not found" (errSecItemNotFound). */
const SECURITY_NOT_FOUND = 44
const KEYCHAIN_ACCOUNT = 'cos'
const KEYCHAIN_LABEL = 'YunBox COS credentials'

const runSecurity: SecurityRunner = (args, input) => new Promise((resolve, reject) => {
  // A locked keychain shows an unlock dialog; leave the user time to answer it.
  const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 })
  const out: Buffer[] = []
  const err: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
  child.once('error', reject)
  child.once('close', code => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }))
  child.stdin.end(input ?? '')
})

/** Options of {@link KeychainSecretStore}. */
export interface KeychainOptions {
  /** Keychain file; the user's default (login) keychain when omitted. For tests. */
  keychain?: string
  /** Generic-password service name; `yunbox` by default. */
  service?: string
  run?: SecurityRunner
}

/**
 * The macOS keychain, through the system `security` tool (no dependency).
 *
 * The item is a generic password (service `yunbox`, account `cos`) whose data
 * is the same JSON as the file. The SecretKey never appears in an argv:
 * writing sends `add-generic-password … -X <hex>` to `security -i` on stdin,
 * and reading gets the data from `find-generic-password -w` on stdout. The
 * item's access list trusts `/usr/bin/security`, which created it, so reading
 * does not prompt; any process of the same user can read it the same way.
 */
export class KeychainSecretStore implements SecretStore {
  readonly kind = 'keychain'
  readonly description: string
  readonly #keychain: string[]
  readonly #service: string
  readonly #run: SecurityRunner

  constructor(options: KeychainOptions = {}) {
    this.#service = options.service ?? 'yunbox'
    this.#keychain = options.keychain === undefined ? [] : [options.keychain]
    this.#run = options.run ?? runSecurity
    this.description = `macOS 钥匙串（${this.#service}）`
  }

  async read(): Promise<StoredKeys | undefined> {
    const result = await this.#run(['find-generic-password', '-s', this.#service, '-a', KEYCHAIN_ACCOUNT, '-w', ...this.#keychain])
    if (result.code === SECURITY_NOT_FOUND)
      return undefined
    if (result.code !== 0)
      throw new Error(`读取 macOS 钥匙串失败（${firstLine(result.stderr) || `security 退出码 ${result.code}`}）。解锁钥匙串后重试，或设置 YUNBOX_CREDENTIAL_STORE=file 改用文件`)
    const keys = decode(result.stdout.replace(/\n$/, ''))
    if (keys === undefined)
      throw new Error(`macOS 钥匙串里的 ${this.#service} 项格式不对。运行 yunbox login 重新保存，或运行 yunbox logout 删除`)
    return keys
  }

  async write(keys: StoredKeys): Promise<void> {
    const hex = Buffer.from(encode(keys), 'utf8').toString('hex')
    const command = ['add-generic-password', '-U', '-s', this.#service, '-a', KEYCHAIN_ACCOUNT, '-l', quote(KEYCHAIN_LABEL), '-X', hex, ...this.#keychain.map(quote)].join(' ')
    const result = await this.#run(['-i'], `${command}\n`)
    // `security -i` has no prompt to echo, but never let the hex payload reach a message anyway.
    if (result.code !== 0)
      throw new Error(`保存到 macOS 钥匙串失败（${firstLine(result.stderr.replaceAll(hex, '<已隐藏>')) || `security 退出码 ${result.code}`}）`)
    const saved = await this.read()
    if (saved?.secretId !== keys.secretId || saved.secretKey !== keys.secretKey)
      throw new Error('保存到 macOS 钥匙串后读回的内容不一致')
  }

  async delete(): Promise<boolean> {
    const result = await this.#run(['delete-generic-password', '-s', this.#service, '-a', KEYCHAIN_ACCOUNT, ...this.#keychain])
    if (result.code === SECURITY_NOT_FOUND)
      return false
    if (result.code !== 0)
      throw new Error(`从 macOS 钥匙串删除失败（${firstLine(result.stderr) || `security 退出码 ${result.code}`}）`)
    return true
  }
}

/** Quote one word for `security -i`, which splits its input lines like a shell. */
function quote(value: string): string {
  if (/["\\\n]/.test(value))
    throw new TypeError(`钥匙串参数不能包含引号、反斜杠或换行：${value}`)
  return `"${value}"`
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.replace(/^security:\s*/, '') ?? ''
}

/**
 * The stores `yunbox login` uses on this computer, most preferred first.
 * `YUNBOX_CREDENTIAL_STORE=file` forces the file, `keychain` forces the
 * keychain (macOS only); the default `auto` is keychain then file on macOS,
 * the file elsewhere.
 *
 * Windows has no dependency-free way that this project has verified (see
 * docs/deploy.md), so it keeps the file under `%APPDATA%`.
 *
 * @throws {Error} for an unknown setting, or `keychain` on another system.
 */
export function defaultSecretStores(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): SecretStore[] {
  const mode = env.YUNBOX_CREDENTIAL_STORE || 'auto'
  const file = new FileSecretStore(credentialsFilePath(env))
  if (mode === 'file')
    return [file]
  if (mode === 'keychain') {
    if (platform !== 'darwin')
      throw new Error('YUNBOX_CREDENTIAL_STORE=keychain 只支持 macOS；其他系统用 file')
    return [new KeychainSecretStore()]
  }
  if (mode !== 'auto')
    throw new Error(`YUNBOX_CREDENTIAL_STORE 只能是 auto、keychain 或 file，不是「${mode}」`)
  return platform === 'darwin' ? [new KeychainSecretStore(), file] : [file]
}
