import type { Sandbox } from './helpers.ts'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeCosServer } from '../../core/test/fake-cos-server.ts'
import { resolveCredentials } from '../src/cos/credentials.ts'
import { FakeCamServer } from './fake-cam-server.ts'
import { createRepository, createSandbox, runYunBox } from './helpers.ts'

const admin = { secretId: 'AKIDADMINADMINADMINADMINADMINADMIN', secretKey: 'admin-secret-key-admin-secret-key', sessionToken: 'admin-session-token' }
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

/** A sandbox logged in as the administrator through tccli, with an initialized repository. */
async function setup(): Promise<{ sandbox: Sandbox, cam: FakeCamServer, cos: FakeCosServer, repo: string }> {
  const sandbox = await createSandbox()
  cleanups.push(sandbox.cleanup)
  const cos = await new FakeCosServer(admin).start()
  cleanups.push(() => cos.close())
  const cam = await new FakeCamServer(admin).start()
  cleanups.push(() => cam.close())
  cam.onKeysCreated = keys => cos.allowKeys(keys)
  const tccli = join(sandbox.root, 'tccli.credential')
  await writeFile(tccli, JSON.stringify({ type: 'oauth', secretId: admin.secretId, secretKey: admin.secretKey, token: admin.sessionToken, expiresAt: Math.floor(Date.now() / 1000) + 3600 }))
  Object.assign(sandbox.env, {
    YUNBOX_TCCLI_CREDENTIAL: tccli,
    YUNBOX_CAM_ENDPOINT: cam.origin,
    YUNBOX_COS_ENDPOINT: cos.origin,
    YUNBOX_COS_SERVICE_ENDPOINT: cos.origin,
  })
  const repo = await createRepository(sandbox)
  const init = await runYunBox(sandbox, repo, ['init', '--bucket', 'team-assets-1250000000', '--region', 'ap-shanghai', '--prefix', 'yunbox/team/game', '--types', 'model'])
  expect(init.code).toBe(0)
  expect(init.stdout).toContain('这是 tccli 的临时密钥')
  return { sandbox, cam, cos, repo }
}

describe('yunbox subaccount', () => {
  it('creates a sub-account limited to the repository prefix and saves its long-term key locally', async () => {
    const { sandbox, cam, repo } = await setup()
    const before = await runYunBox(sandbox, repo, ['doctor'])
    expect(before.stdout).toContain('临时密钥，大约 2 小时后要重新登录')

    const created = await runYunBox(sandbox, repo, ['subaccount', 'create', 'yunbox-alice', '--save'])
    expect(created.stderr).toBe('')
    expect(created.code).toBe(0)
    expect(created.stdout).toContain('新密钥可以读写 team-assets-1250000000（ap-shanghai）/yunbox/team/game/')

    const user = cam.users.get('yunbox-alice')!
    expect(user.Remark).toContain('YunBox')
    expect(user.policies).toHaveLength(1)
    const policy = cam.policies.get(user.policies[0]!)!
    expect(policy.PolicyName).toMatch(/^yunbox-alice-[\da-f]{8}-rw$/)
    expect(JSON.parse(policy.PolicyDocument).statement[0].resource).toEqual(['qcs::cos:ap-shanghai:uid/1250000000:team-assets-1250000000/yunbox/team/game/*'])
    // The saved key is the sub-account's, never the administrator's, and is never printed.
    const saved = await resolveCredentials({ ...sandbox.env, YUNBOX_TCCLI_CREDENTIAL: '/nonexistent' })
    expect(saved?.credentials.secretId).toBe(user.keys.secretId)
    expect(created.stdout).not.toContain(user.keys.secretKey)

    const after = await runYunBox(sandbox, repo, ['doctor'])
    expect(after.code).toBe(0)
    expect(after.stdout).not.toContain('临时密钥')
  }, 60_000)

  it('shows a collaborator key once, grants another prefix, lists and deletes', async () => {
    const { sandbox, cam, repo } = await setup()
    const created = await runYunBox(sandbox, repo, ['subaccount', 'create', 'yunbox-bob', '--show-key', '--read-only'])
    expect(created.code).toBe(0)
    const bob = cam.users.get('yunbox-bob')!
    expect(created.stdout).toContain(bob.keys.secretKey)
    expect(JSON.parse(cam.policies.get(bob.policies[0]!)!.PolicyDocument).statement[0].action).toEqual(['name/cos:GetObject', 'name/cos:HeadObject'])
    expect((await resolveCredentials({ ...sandbox.env, YUNBOX_TCCLI_CREDENTIAL: '/nonexistent' }))).toBeUndefined()

    const granted = await runYunBox(sandbox, repo, ['subaccount', 'grant', 'yunbox-bob', '--prefix', 'yunbox/team/other'])
    expect(granted.code).toBe(0)
    expect(bob.policies).toHaveLength(2)
    expect((await runYunBox(sandbox, repo, ['subaccount', 'grant', 'yunbox-bob', '--prefix', 'yunbox/team/other'])).code).toBe(0)
    expect(bob.policies).toHaveLength(2)

    const listed = await runYunBox(sandbox, repo, ['subaccount', 'list'])
    expect(listed.stdout).toContain('yunbox-bob')
    expect(listed.stdout).toContain('yunbox/team/other/')

    expect((await runYunBox(sandbox, repo, ['subaccount', 'delete', 'yunbox-bob'])).code).not.toBe(0)
    expect(cam.users.has('yunbox-bob')).toBe(true)
    const deleted = await runYunBox(sandbox, repo, ['subaccount', 'delete', 'yunbox-bob', '--yes'])
    expect(deleted.code).toBe(0)
    expect(cam.users.has('yunbox-bob')).toBe(false)
    expect(cam.policies.size).toBe(0)
  }, 60_000)

  it('refuses unsafe requests and cleans up a half-made sub-account', async () => {
    const { sandbox, cam, repo } = await setup()
    expect((await runYunBox(sandbox, repo, ['subaccount', 'create', 'yunbox-carol'])).code).toBe(2)
    expect(cam.actions).not.toContain('AddUser')

    cam.failNext = 'AttachUserPolicy'
    expect((await runYunBox(sandbox, repo, ['subaccount', 'create', 'yunbox-carol', '--save'])).code).toBe(1)
    expect(cam.users.has('yunbox-carol')).toBe(false)

    cam.users.set('ops', { Uin: 1, Name: 'ops', Remark: 'created by hand', keys: admin, policies: [] })
    const notOurs = await runYunBox(sandbox, repo, ['subaccount', 'delete', 'ops', '--yes'])
    expect(notOurs.stderr).toContain('不是 YunBox 建的子账号')
    expect(cam.users.has('ops')).toBe(true)

    const noAdmin = await runYunBox(sandbox, repo, ['subaccount', 'list'])
    expect(noAdmin.code).toBe(0)
    const withoutTccli = { ...sandbox, env: { ...sandbox.env, YUNBOX_TCCLI_CREDENTIAL: '/nonexistent' } }
    const refused = await runYunBox(withoutTccli, repo, ['subaccount', 'list'])
    expect(refused.stderr).toContain('需要管理员身份')
  }, 60_000)
})
