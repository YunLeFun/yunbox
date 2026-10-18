import type { CommandIo } from '../src/token-command.ts'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeCosServer } from '../../core/test/fake-cos-server.ts'
import { runCosCommand } from '../src/cos-command.ts'
import { readStorageRoutes } from '../src/storage-routes.ts'

const credentials = {
  secretId: 'AKIDTESTTESTTESTTESTTESTTESTTEST',
  secretKey: 'test-secret-key-test-secret-key',
  sessionToken: 'temporary-session-token',
}

describe('yunbox-server cos', () => {
  let cos: FakeCosServer
  let directory: string
  let config: string
  let output: string[]
  let questions: string[]

  beforeEach(async () => {
    cos = await new FakeCosServer(credentials).start()
    cos.buckets.push({ name: 'assets-1250000000', region: 'ap-shanghai' }, { name: 'shared-1250000000', region: 'ap-guangzhou' })
    directory = await mkdtemp(join(tmpdir(), 'yunbox-cos-command-'))
    config = join(directory, 'yunbox.storage.json')
    output = []
    questions = []
  })

  afterEach(async () => {
    await cos.close()
    await rm(directory, { recursive: true, force: true })
  })

  /** IO with tccli-style credentials and scripted answers, in order. */
  async function io(answers: string[] = [], env: NodeJS.ProcessEnv = {}): Promise<CommandIo> {
    const credentialFile = join(directory, 'default.credential')
    await writeFile(credentialFile, JSON.stringify({ type: 'oauth', secretId: credentials.secretId, secretKey: credentials.secretKey, token: credentials.sessionToken, expiresAt: Math.floor(Date.now() / 1000) + 3600 }))
    return {
      stdout: line => output.push(line),
      env: { YUNBOX_TCCLI_CREDENTIAL: credentialFile, YUNBOX_COS_SERVICE_ENDPOINT: cos.origin, ...env },
      prompt: async (question) => {
        questions.push(question)
        const answer = answers.shift()
        if (answer === undefined)
          throw new Error(`unexpected question: ${question}`)
        return answer
      },
    }
  }

  it('lists buckets with tccli login credentials without printing them', async () => {
    await runCosCommand(['list'], await io())
    const text = output.join('\n')
    expect(text).toContain('temporary Tencent Cloud credentials from tccli login')
    expect(text).toContain('1) shared-1250000000  (ap-guangzhou)')
    expect(text).toContain('2) assets-1250000000  (ap-shanghai)')
    expect(text).not.toMatch(new RegExp(`${credentials.secretKey}|${credentials.sessionToken}`))
  })

  it('sets up a route interactively from an existing bucket and adds more routes later', async () => {
    await runCosCommand(['setup', '--config', config, '--endpoint', cos.origin], await io(['2', 'yunbox/game-a', 'team/game-a', 'y']))
    expect(questions.map(question => question.split(' ')[0])).toEqual(['Bucket', 'Key', 'Repositories', 'Save'])
    expect(readStorageRoutes(config).routes).toEqual([
      { repos: 'team/game-a', bucket: 'assets-1250000000', region: 'ap-shanghai', prefix: 'yunbox/game-a', endpoint: cos.origin },
    ])
    expect(output.join('\n')).toContain('Access check: PUT ok, HEAD ok, GET ok, DELETE ok')
    expect(cos.objects.size).toBe(0)

    output = []
    await runCosCommand(['setup', '--config', config, '--bucket', 'assets-1250000000', '--prefix', 'yunbox/shared', '--repos', '*', '--endpoint', cos.origin, '--yes'], await io())
    expect(readStorageRoutes(config).routes.map(route => route.repos)).toEqual(['team/game-a', '*'])
    expect(output.join('\n')).toContain('This bucket is also used by team/game-a (prefix yunbox/game-a)')

    output = []
    await runCosCommand(['check', '--config', config], await io())
    expect(output.filter(line => line.startsWith('ok  '))).toHaveLength(2)
  })

  it('creates a private bucket after confirmation, adding the account APPID', async () => {
    await runCosCommand(['setup', '--config', config, '--endpoint', cos.origin], await io(['n', 'yunbox-e2e', '', 'y', '', '', 'y']))
    expect(cos.createdBucketAcls).toEqual(['private'])
    expect(readStorageRoutes(config).routes).toEqual([
      { repos: '*', bucket: 'yunbox-e2e-1250000000', region: 'ap-guangzhou', prefix: 'yunbox', endpoint: cos.origin },
    ])
  })

  it('changes nothing when creation is declined or access fails', async () => {
    await expect(runCosCommand(['setup', '--config', config, '--endpoint', cos.origin], await io(['n', 'yunbox-e2e', 'ap-guangzhou', 'n'])))
      .rejects
      .toThrow(/Cancelled; nothing was changed/)
    expect(cos.createdBucketAcls).toEqual([])

    // The bucket accepts other keys only, so listing works but the access check is denied.
    const otherAccount = await new FakeCosServer({ ...credentials, secretKey: 'another-account-key' }).start()
    try {
      await expect(runCosCommand(['setup', '--config', config, '--bucket', 'assets-1250000000', '--prefix', 'yunbox', '--repos', '*', '--endpoint', otherAccount.origin, '--yes'], await io()))
        .rejects
        .toThrow(/cannot write, read and delete under this prefix; nothing was saved/)
      expect(output.join('\n')).toContain('Access check: PUT failed (403)')
    }
    finally {
      await otherAccount.close()
    }
    expect(existsSync(config)).toBe(false)
  })

  it('refuses unattended setup without the needed options, and expired tccli logins', async () => {
    const noPrompt = { ...await io(), prompt: undefined }
    await expect(runCosCommand(['setup', '--config', config], noPrompt)).rejects.toThrow(/without an interactive terminal; pass the matching option/)

    const expired = join(directory, 'expired.credential')
    await writeFile(expired, JSON.stringify({ secretId: 'a', secretKey: 'b', token: 'c', expiresAt: 1 }))
    await expect(runCosCommand(['list'], { ...await io(), env: { YUNBOX_TCCLI_CREDENTIAL: expired } })).rejects.toThrow(/tccli login has expired/)
    expect(await readFile(expired, 'utf8')).toContain('"secretKey":"b"')
  })
})
