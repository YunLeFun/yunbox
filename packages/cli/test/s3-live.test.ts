import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { EMPTY_PAYLOAD_SHA256, signSigV4 } from '@yunbox/core'
import { describe, expect, it } from 'vitest'
import { s3Address } from '../src/s3/client.ts'
import { normalizeS3Location } from '../src/s3/location.ts'
import { createRepository, createSandbox, git, installGitYunbox, runYunBox } from './helpers.ts'

/**
 * Runs the direct S3 workflow against a real bucket, such as Cloudflare R2.
 *
 * Skipped unless `YUNBOX_S3_E2E=1`. Needs `YUNBOX_S3_E2E_ENDPOINT` (for R2
 * `https://<account id>.r2.cloudflarestorage.com`), `YUNBOX_S3_E2E_BUCKET`,
 * `YUNBOX_S3_E2E_ACCESS_KEY_ID`, `YUNBOX_S3_E2E_SECRET_ACCESS_KEY`, and
 * optionally `YUNBOX_S3_E2E_REGION` (default `auto`),
 * `YUNBOX_S3_E2E_ADDRESSING` (default `path`) and `YUNBOX_S3_E2E_PREFIX`
 * (default `yunbox-e2e`). Objects go under a random sub-prefix and are deleted
 * afterwards when the keys may delete (an R2 "Object Read & Write" token can).
 */
const live = process.env.YUNBOX_S3_E2E === '1'

describe.skipIf(!live)('git LFS directly to a real S3-compatible bucket', () => {
  it('pushes, clones, restores history, keeps repeated pushes idempotent and refuses overwrites', async () => {
    const settings = process.env
    const location = normalizeS3Location({
      endpoint: settings.YUNBOX_S3_E2E_ENDPOINT!,
      bucket: settings.YUNBOX_S3_E2E_BUCKET!,
      region: settings.YUNBOX_S3_E2E_REGION || 'auto',
      prefix: `${settings.YUNBOX_S3_E2E_PREFIX || 'yunbox-e2e'}/${randomUUID()}`,
      addressingStyle: (settings.YUNBOX_S3_E2E_ADDRESSING || 'path') as 'path' | 'virtual',
    })
    const keys = { accessKeyId: settings.YUNBOX_S3_E2E_ACCESS_KEY_ID!, secretAccessKey: settings.YUNBOX_S3_E2E_SECRET_ACCESS_KEY! }
    const request = async (method: 'HEAD' | 'DELETE' | 'PUT', key: string, headers: Record<string, string> = {}, body?: Buffer): Promise<Response> => {
      const { path, url } = s3Address(location, key)
      const signed = signSigV4({
        credentials: keys,
        method,
        path,
        headers: { host: url.host, ...headers },
        payloadHash: body === undefined ? EMPTY_PAYLOAD_SHA256 : createHash('sha256').update(body).digest('hex'),
        region: location.region,
        service: 's3',
        date: new Date(),
      })
      const { host: _host, ...sent } = signed.headers
      return fetch(url, { method, headers: sent, body })
    }

    const sandbox = await createSandbox()
    await installGitYunbox(sandbox)
    Object.assign(sandbox.env, { YUNBOX_S3_ACCESS_KEY_ID: keys.accessKeyId, YUNBOX_S3_SECRET_ACCESS_KEY: keys.secretAccessKey })
    const written: string[] = [`${location.prefix}/_yunbox/probe`]
    try {
      const origin = join(sandbox.root, 'origin.git')
      await git(sandbox, sandbox.root, 'init', '--bare', '--quiet', origin)
      const repo = await createRepository(sandbox, 'game')
      await git(sandbox, repo, 'remote', 'add', 'origin', origin)
      const init = await runYunBox(sandbox, repo, ['init', '--provider', 's3', '--endpoint', location.endpoint, '--region', location.region, '--addressing', location.addressingStyle, '--bucket', location.bucket, '--prefix', location.prefix, '--types', 'model'])
      expect(init.stderr).toBe('')
      expect(init.code).toBe(0)
      expect((await runYunBox(sandbox, repo, ['doctor'])).code).toBe(0)

      const versions = [randomBytes(2 * 1024 * 1024), randomBytes(512 * 1024)]
      const commits: string[] = []
      for (const content of versions) {
        await writeFile(join(repo, 'car.fbx'), content)
        await git(sandbox, repo, 'add', '.')
        await git(sandbox, repo, 'commit', '--quiet', '-m', 'car')
        commits.push(await git(sandbox, repo, 'rev-parse', 'HEAD'))
        await git(sandbox, repo, 'push', '--quiet', 'origin', 'HEAD:main')
        const oid = createHash('sha256').update(content).digest('hex')
        written.push(`${location.prefix}/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`)
      }

      // Pushing everything again uploads nothing: the stored objects keep their timestamps.
      const before = await Promise.all(written.slice(1).map(async key => (await request('HEAD', key)).headers.get('last-modified')))
      await new Promise(resolve => setTimeout(resolve, 1100))
      await git(sandbox, repo, 'lfs', 'push', '--all', 'origin')
      const after = await Promise.all(written.slice(1).map(async key => (await request('HEAD', key)).headers.get('last-modified')))
      expect(after).toEqual(before)

      // The service honours If-None-Match: * (412); a 501 means YunBox falls back to HEAD before PUT.
      const conditional = await request('PUT', written[1]!, { 'if-none-match': '*', 'content-length': '1' }, Buffer.from('x'))
      expect([412, 501]).toContain(conditional.status)
      process.stdout.write(`If-None-Match: * on an existing key answered HTTP ${conditional.status}\n`)

      const clone = await runYunBox(sandbox, sandbox.root, ['clone', origin, 'teammate'])
      expect(clone.stderr).toBe('')
      expect(clone.code).toBe(0)
      const teammate = join(sandbox.root, 'teammate')
      expect(createHash('sha256').update(await readFile(join(teammate, 'car.fbx'))).digest('hex')).toBe(createHash('sha256').update(versions[1]!).digest('hex'))
      await git(sandbox, teammate, 'checkout', '--quiet', commits[0]!)
      expect(createHash('sha256').update(await readFile(join(teammate, 'car.fbx'))).digest('hex')).toBe(createHash('sha256').update(versions[0]!).digest('hex'))
    }
    finally {
      for (const key of written) {
        const response = await request('DELETE', key).catch(() => undefined)
        if (response === undefined || (response.status !== 204 && response.status !== 200))
          process.stderr.write(`could not delete ${key} (HTTP ${response?.status ?? 'error'}); remove it by hand\n`)
      }
      await sandbox.cleanup()
    }
  }, 300_000)
})
