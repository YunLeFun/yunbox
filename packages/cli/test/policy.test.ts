import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCosPolicy, cosObjectResource } from '../src/cos/policy.ts'
import { createRepository, createSandbox, runYunBox } from './helpers.ts'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

const location = { bucket: 'team-assets-1250000000', region: 'ap-guangzhou', prefix: 'yunbox/team/game' }

describe('buildCosPolicy', () => {
  it('grants object write and read under the prefix only', () => {
    expect(buildCosPolicy(location)).toEqual({
      version: '2.0',
      statement: [{
        effect: 'allow',
        action: ['name/cos:PutObject', 'name/cos:GetObject', 'name/cos:HeadObject'],
        resource: ['qcs::cos:ap-guangzhou:uid/1250000000:team-assets-1250000000/yunbox/team/game/*'],
      }],
    })
  })

  it('grants read only with readOnly', () => {
    const policy = buildCosPolicy(location, { readOnly: true })
    expect(policy.statement).toHaveLength(1)
    expect(policy.statement[0]!.action).toEqual(['name/cos:GetObject', 'name/cos:HeadObject'])
    expect(policy.statement[0]!.resource).toEqual(buildCosPolicy(location).statement[0]!.resource)
  })

  it('never grants listing, deletion or wildcard actions', () => {
    for (const policy of [buildCosPolicy(location), buildCosPolicy(location, { readOnly: true })]) {
      const actions = policy.statement.flatMap(statement => statement.action)
      expect(actions.every(action => /^name\/cos:(?:Put|Get|Head)Object$/.test(action))).toBe(true)
    }
  })

  it('takes the APPID from the bucket suffix and trims slashes from the prefix', () => {
    expect(cosObjectResource({ bucket: 'a-b-1300000001', region: 'ap-shanghai', prefix: '/x/y/' })).toBe('qcs::cos:ap-shanghai:uid/1300000001:a-b-1300000001/x/y/*')
    expect(cosObjectResource({ bucket: 'a-1300000001', region: 'ap-shanghai', prefix: '' })).toBe('qcs::cos:ap-shanghai:uid/1300000001:a-1300000001/*')
    expect(() => cosObjectResource({ bucket: 'no-appid', region: 'ap-shanghai', prefix: '' })).toThrow(/APPID/)
  })
})

describe('yunbox policy', () => {
  it('prints the policy for the repository\'s .yunboxconfig on stdout and guidance on stderr', async () => {
    const sandbox = await createSandbox()
    cleanups.push(sandbox.cleanup)
    const repo = await createRepository(sandbox)
    await writeFile(join(repo, '.yunboxconfig'), `[cos]\n\tbucket = ${location.bucket}\n\tregion = ${location.region}\n\tprefix = ${location.prefix}\n`)

    const run = await runYunBox(sandbox, repo, ['policy'])
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout)).toEqual(buildCosPolicy(location))
    expect(run.stderr).toContain('没有修改任何云端设置')

    const readOnly = await runYunBox(sandbox, repo, ['policy', '--read-only', '--prefix', 'yunbox/team/other'])
    expect(JSON.parse(readOnly.stdout)).toEqual(buildCosPolicy({ ...location, prefix: 'yunbox/team/other' }, { readOnly: true }))
  })

  it('works outside a repository with --bucket and --region, and warns about an empty prefix', async () => {
    const sandbox = await createSandbox()
    cleanups.push(sandbox.cleanup)
    const run = await runYunBox(sandbox, sandbox.root, ['policy', '--bucket', 'assets-1250000000', '--region', 'ap-beijing'])
    expect(run.code).toBe(0)
    expect(JSON.parse(run.stdout).statement[0].resource).toEqual(['qcs::cos:ap-beijing:uid/1250000000:assets-1250000000/*'])
    expect(run.stderr).toContain('整个 bucket')
  })

  it('explains what is missing and rejects bad values', async () => {
    const sandbox = await createSandbox()
    cleanups.push(sandbox.cleanup)
    const missing = await runYunBox(sandbox, sandbox.root, ['policy'])
    expect(missing.code).toBe(2)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toContain('--bucket')
    const bad = await runYunBox(sandbox, sandbox.root, ['policy', '--bucket', 'assets-1250000000', '--region', 'ap-beijing', '--prefix', 'a/../b'])
    expect(bad.code).toBe(2)
    expect(bad.stdout).toBe('')
  })
})
