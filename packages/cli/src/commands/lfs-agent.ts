// @env node

import type { CliContext } from '../context.ts'
import type { ObjectStore, StorageLocation } from '../storage/provider.ts'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { findRepositoryRoot, runGitChecked } from '../git.ts'
import { providerOf, readStorageLocation, requireStorageCredentials } from '../storage/config.ts'
import { objectKey } from '../storage/provider.ts'

/** Name under which `git yunbox init` registers the agent with git-lfs. */
export const AGENT_NAME = 'yunbox'

export const lfsAgentHelp = `用法：git yunbox lfs-agent

git-lfs 的独立传输代理（standalone transfer agent），由 git-lfs 调用，不需要手动运行。
它读取 .yunbox/config（旧版为 .yunboxconfig）里的存储位置（bucket / region / prefix），用本机配置的密钥
直接在对象存储上传和下载 LFS 对象，不经过任何服务端。git yunbox init 会在本仓库的
.git/config 里登记它。
`

interface TransferEvent {
  event: 'init' | 'upload' | 'download' | 'terminate'
  operation?: 'upload' | 'download'
  oid?: string
  size?: number
  path?: string
}

const PROGRESS_INTERVAL_BYTES = 1024 * 1024

/**
 * Speak the git-lfs custom transfer protocol on stdin/stdout: one JSON
 * message per line. Errors are reported per object; nothing secret is ever
 * written, and stderr is left to git-lfs's own logging.
 *
 * @see https://github.com/git-lfs/git-lfs/blob/main/docs/custom-transfers.md
 */
export async function runLfsAgent(context: CliContext, args: string[]): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    context.stdout.write(lfsAgentHelp)
    return 0
  }
  const send = (message: object): void => {
    context.stdout.write(`${JSON.stringify(message)}\n`)
  }
  let client: ObjectStore | undefined
  let location: StorageLocation | undefined
  let temporaryDirectory = ''

  const lines = createInterface({ input: context.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '')
      continue
    let event: TransferEvent
    try {
      event = JSON.parse(line) as TransferEvent
    }
    catch {
      send({ error: { code: 2, message: 'YunBox 收到了无法解析的传输消息' } })
      continue
    }

    if (event.event === 'init') {
      try {
        const root = await findRepositoryRoot(context)
        if (root === undefined)
          throw new Error('不在 Git 仓库里')
        location = await readStorageLocation({ ...context, cwd: root }, root)
        if (location === undefined)
          throw new Error('仓库里没有 .yunbox/config，先运行 git yunbox init')
        const provider = providerOf(location)
        const { credentials } = await requireStorageCredentials(context.env, provider)
        client = provider.connect(location, () => credentials)
        const commonDir = await runGitChecked(context, ['rev-parse', '--git-common-dir'])
        const gitDir = isAbsolute(commonDir.trim()) ? commonDir.trim() : join(context.cwd, commonDir.trim())
        temporaryDirectory = join(gitDir, 'lfs', 'tmp')
        await mkdir(temporaryDirectory, { recursive: true })
        send({})
      }
      catch (error) {
        send({ error: { code: 32, message: `YunBox 无法初始化：${(error as Error).message}` } })
      }
      continue
    }
    if (event.event === 'terminate')
      break

    const oid = event.oid ?? ''
    const size = event.size ?? 0
    if (client === undefined || location === undefined || !/^[a-f\d]{64}$/.test(oid)) {
      send({ event: 'complete', oid, error: { code: 2, message: 'YunBox 传输代理没有初始化，或对象 ID 无效' } })
      continue
    }
    let soFar = 0
    let unreported = 0
    const progress = (bytes: number): void => {
      soFar += bytes
      unreported += bytes
      if (unreported >= PROGRESS_INTERVAL_BYTES || soFar === size) {
        send({ event: 'progress', oid, bytesSoFar: soFar, bytesSinceLast: unreported })
        unreported = 0
      }
    }
    try {
      if (event.event === 'upload') {
        if (event.path === undefined)
          throw new Error('git-lfs 没有给出要上传的文件路径')
        const result = await client.uploadFile(objectKey(location, oid), event.path, { oid, size }, progress)
        if (result === 'skipped' && size > 0)
          send({ event: 'progress', oid, bytesSoFar: size, bytesSinceLast: size })
        send({ event: 'complete', oid })
      }
      else if (event.event === 'download') {
        const destination = join(temporaryDirectory, `${oid}-${randomUUID()}`)
        await client.downloadFile(objectKey(location, oid), destination, { oid, size }, progress)
        send({ event: 'complete', oid, path: destination })
      }
      else {
        send({ event: 'complete', oid, error: { code: 2, message: `YunBox 不支持传输事件 ${String(event.event)}` } })
      }
    }
    catch (error) {
      send({ event: 'complete', oid, error: { code: 2, message: (error as Error).message } })
    }
  }
  return 0
}
