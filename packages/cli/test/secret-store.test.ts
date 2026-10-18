import type { CommandResult, SecretStore, SecretStoreKind, StoredKeys } from '../src/cos/secret-store.ts'
import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteCredentials, resolveCredentials, saveCredentials } from '../src/cos/credentials.ts'
import { defaultSecretStores, FileSecretStore, KeychainSecretStore } from '../src/cos/secret-store.ts'

const keys: StoredKeys = { secretId: 'AKIDTESTTESTTESTTESTTESTTESTTEST', secretKey: 'test-secret-key-test-secret-key' }
const older: StoredKeys = { secretId: 'AKIDOLDOLDOLDOLDOLDOLDOLDOLDOLD', secretKey: 'old-secret-key-old-secret-key-xx' }
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/** An in-memory store that can be told to fail. */
class MemoryStore implements SecretStore {
  keys: StoredKeys | undefined
  failRead = false
  failWrite = false
  failDelete = false

  constructor(readonly kind: SecretStoreKind, readonly description: string, keys?: StoredKeys) {
    this.keys = keys
  }

  async read(): Promise<StoredKeys | undefined> {
    if (this.failRead)
      throw new Error(`${this.description} 读取失败`)
    return this.keys
  }

  async write(keys: StoredKeys): Promise<void> {
    if (this.failWrite)
      throw new Error(`${this.description} 不可用`)
    this.keys = keys
  }

  async delete(): Promise<boolean> {
    if (this.failDelete)
      throw new Error(`${this.description} 删除失败`)
    const had = this.keys !== undefined
    this.keys = undefined
    return had
  }
}

async function emptyHome(): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), 'yunbox-secret-test-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  // No TENCENTCLOUD_* and a tccli file that does not exist.
  return { HOME: home, YUNBOX_TCCLI_CREDENTIAL: join(home, 'no-tccli') }
}

describe('credential resolution order', () => {
  it('prefers environment variables, then the keychain, then the file, then tccli', async () => {
    const env = await emptyHome()
    const keychain = new MemoryStore('keychain', '钥匙串', keys)
    const file = new MemoryStore('file', '文件', older)
    const stores = [keychain, file]
    const tccli = join(env.HOME!, 'tccli.json')
    await writeFile(tccli, JSON.stringify({ secretId: 'AKIDTCCLI', secretKey: 'tccli-key', token: 't', expiresAt: Math.floor(Date.now() / 1000) + 3600 }))
    env.YUNBOX_TCCLI_CREDENTIAL = tccli

    const fromEnv = await resolveCredentials({ ...env, TENCENTCLOUD_SECRETID: 'AKIDENV', TENCENTCLOUD_SECRETKEY: 'env-key' }, stores)
    expect(fromEnv?.source).toBe('env')
    expect((await resolveCredentials(env, stores))).toMatchObject({ source: 'keychain', credentials: keys })
    keychain.keys = undefined
    expect((await resolveCredentials(env, stores))).toMatchObject({ source: 'file', credentials: older })
    file.keys = undefined
    expect((await resolveCredentials(env, stores))).toMatchObject({ source: 'tccli', credentials: { secretId: 'AKIDTCCLI', sessionToken: 't' } })
  })

  it('skips an unreadable keychain, and reports it only when nothing else is configured', async () => {
    const env = await emptyHome()
    const keychain = new MemoryStore('keychain', '钥匙串', keys)
    keychain.failRead = true
    const file = new MemoryStore('file', '文件', older)
    expect((await resolveCredentials(env, [keychain, file]))?.source).toBe('file')
    file.keys = undefined
    await expect(resolveCredentials(env, [keychain, file])).rejects.toThrow('钥匙串 读取失败')
    expect(await resolveCredentials(env, [new MemoryStore('keychain', '钥匙串'), file])).toBeUndefined()
  })
})

describe('saveCredentials and deleteCredentials', () => {
  it('saves to the keychain and removes the older plain-text copy', async () => {
    const env = await emptyHome()
    const keychain = new MemoryStore('keychain', '钥匙串')
    const file = new MemoryStore('file', '文件', older)
    const result = await saveCredentials(env, keys, [keychain, file])
    expect(result.store).toBe(keychain)
    expect(result.skipped).toEqual([])
    expect(result.cleaned).toEqual([file])
    expect(keychain.keys).toEqual(keys)
    expect(file.keys).toBeUndefined()
  })

  it('falls back to the file when the keychain fails, and removes a stale keychain copy that would shadow it', async () => {
    const env = await emptyHome()
    const keychain = new MemoryStore('keychain', '钥匙串', older)
    keychain.failWrite = true
    const file = new MemoryStore('file', '文件')
    const result = await saveCredentials(env, keys, [keychain, file])
    expect(result.store).toBe(file)
    expect(result.skipped).toEqual([{ store: keychain, reason: '钥匙串 不可用' }])
    expect(result.cleaned).toEqual([keychain])
    expect((await resolveCredentials(env, [keychain, file]))).toMatchObject({ source: 'file', credentials: keys })
  })

  it('fails without saving when no store accepts the keys', async () => {
    const env = await emptyHome()
    const file = new MemoryStore('file', '文件')
    file.failWrite = true
    await expect(saveCredentials(env, keys, [file])).rejects.toThrow('没有保存')
  })

  it('logout deletes from every store and reports failures', async () => {
    const env = await emptyHome()
    const keychain = new MemoryStore('keychain', '钥匙串', keys)
    const file = new MemoryStore('file', '文件', older)
    expect(await deleteCredentials(env, [keychain, file])).toEqual({ removed: [keychain, file], failed: [] })
    expect(await deleteCredentials(env, [keychain, file])).toEqual({ removed: [], failed: [] })
    file.keys = older
    keychain.failDelete = true
    expect(await deleteCredentials(env, [keychain, file])).toEqual({ removed: [file], failed: [{ store: keychain, reason: '钥匙串 删除失败' }] })
  })
})

describe('defaultSecretStores', () => {
  it('uses the keychain then the file on macOS, the file elsewhere, and honours YUNBOX_CREDENTIAL_STORE', () => {
    expect(defaultSecretStores({}, 'darwin').map(store => store.kind)).toEqual(['keychain', 'file'])
    expect(defaultSecretStores({}, 'linux').map(store => store.kind)).toEqual(['file'])
    expect(defaultSecretStores({}, 'win32').map(store => store.kind)).toEqual(['file'])
    expect(defaultSecretStores({ YUNBOX_CREDENTIAL_STORE: 'file' }, 'darwin').map(store => store.kind)).toEqual(['file'])
    expect(defaultSecretStores({ YUNBOX_CREDENTIAL_STORE: 'keychain' }, 'darwin').map(store => store.kind)).toEqual(['keychain'])
    expect(() => defaultSecretStores({ YUNBOX_CREDENTIAL_STORE: 'keychain' }, 'linux')).toThrow('只支持 macOS')
    expect(() => defaultSecretStores({ YUNBOX_CREDENTIAL_STORE: 'vault' }, 'darwin')).toThrow('auto、keychain 或 file')
  })
})

describe('fileSecretStore', () => {
  it.skipIf(process.platform === 'win32')('writes an owner-only file and reads it back', async () => {
    const env = await emptyHome()
    const store = new FileSecretStore(join(env.HOME!, 'config', 'credentials.json'))
    expect(await store.read()).toBeUndefined()
    await store.write(keys)
    expect((await stat(store.file)).mode & 0o777).toBe(0o600)
    expect(await store.read()).toEqual(keys)
    expect(await store.delete()).toBe(true)
    expect(await store.delete()).toBe(false)
  })
})

describe('keychainSecretStore with a fake security tool', () => {
  /** Records every call and keeps one item, the way `security` would. */
  function fakeSecurity(): { calls: Array<{ args: string[], input?: string }>, run: (args: string[], input?: string) => Promise<CommandResult> } {
    const calls: Array<{ args: string[], input?: string }> = []
    let data: string | undefined
    return {
      calls,
      run: async (args, input) => {
        calls.push({ args, input })
        if (args[0] === '-i') {
          const hex = /-X (\w+)/.exec(input ?? '')?.[1]
          data = Buffer.from(hex ?? '', 'hex').toString('utf8')
          return { code: 0, stdout: '', stderr: '' }
        }
        if (args[0] === 'find-generic-password')
          return data === undefined ? { code: 44, stdout: '', stderr: 'security: The specified item could not be found in the keychain.\n' } : { code: 0, stdout: `${data}\n`, stderr: '' }
        if (args[0] === 'delete-generic-password') {
          const had = data !== undefined
          data = undefined
          return had ? { code: 0, stdout: '', stderr: '' } : { code: 44, stdout: '', stderr: '' }
        }
        return { code: 1, stdout: '', stderr: '' }
      },
    }
  }

  it('never puts the SecretKey in an argv; it only travels on stdin as hex', async () => {
    const security = fakeSecurity()
    const store = new KeychainSecretStore({ run: security.run })
    expect(await store.read()).toBeUndefined()
    await store.write(keys)
    expect(await store.read()).toEqual(keys)
    expect(await store.delete()).toBe(true)
    expect(await store.delete()).toBe(false)
    for (const call of security.calls) {
      expect(call.args.join(' ')).not.toContain(keys.secretKey)
      expect(call.input ?? '').not.toContain(keys.secretKey)
    }
    expect(security.calls.find(call => call.args[0] === '-i')?.input).toMatch(/^add-generic-password -U -s yunbox -a cos -l "YunBox COS credentials" -X [\da-f]+\n$/)
  })

  it('keeps the payload out of error messages', async () => {
    let echoed = ''
    const store = new KeychainSecretStore({
      run: async (args, input) => {
        echoed = /-X (\w+)/.exec(input ?? '')?.[1] ?? ''
        return { code: 2, stdout: '', stderr: `security: bad ${echoed}\n` }
      },
    })
    const error = await store.write(keys).then(() => undefined, (error: Error) => error)
    expect(error?.message).toContain('保存到 macOS 钥匙串失败')
    expect(error?.message).not.toContain(echoed)
  })
})

// Opt-in: YUNBOX_TEST_KEYCHAIN=1 pnpm test. Uses a throwaway keychain file, never the login keychain.
describe.skipIf(process.platform !== 'darwin' || process.env.YUNBOX_TEST_KEYCHAIN !== '1')('keychainSecretStore with the real security tool', () => {
  it('saves, reads, replaces and deletes an item', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yunbox-keychain-test-'))
    const keychain = join(directory, 'test.keychain-db')
    const security = promisify(execFile)
    // Test-only password for a throwaway keychain.
    await security('/usr/bin/security', ['create-keychain', '-p', 'yunbox-test', keychain])
    cleanups.push(async () => {
      await security('/usr/bin/security', ['delete-keychain', keychain]).catch(() => {})
      await rm(directory, { recursive: true, force: true })
    })
    await security('/usr/bin/security', ['unlock-keychain', '-p', 'yunbox-test', keychain])

    const store = new KeychainSecretStore({ keychain, service: 'yunbox-test' })
    expect(await store.read()).toBeUndefined()
    await store.write(older)
    await store.write(keys)
    expect(await store.read()).toEqual(keys)
    expect(await store.delete()).toBe(true)
    expect(await store.read()).toBeUndefined()
  })
})
