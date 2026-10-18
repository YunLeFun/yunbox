import type { CliContext } from '../context.ts'
import { parseArgs } from 'node:util'
import { CosRequestError, listCosBuckets } from '@yunbox/core'
import { CliError, print, USAGE_EXIT_CODE } from '../context.ts'
import { requireCredentials } from '../cos/credentials.ts'

export const bucketsHelp = `用法：yunbox buckets [--json]

用本机保存的腾讯云密钥列出账号下的 COS bucket（名称和地域）。受限的子账号
通常没有列出 bucket 的权限，这时请向管理员要 bucket 名称和地域。

选项：
  --json      只输出一个 JSON 对象（schemaVersion 1）：{ status, buckets: [{ name, region }] }
  -h, --help  显示帮助
`

/** Run `yunbox buckets`. */
export async function runBuckets(context: CliContext, args: string[]): Promise<number> {
  let values: { json?: boolean, help?: boolean }
  try {
    values = parseArgs({ args, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }).values
  }
  catch (error) {
    throw new CliError(`${(error as Error).message}\n运行 yunbox buckets --help 查看用法`, USAGE_EXIT_CODE)
  }
  if (values.help) {
    context.stdout.write(bucketsHelp)
    return 0
  }
  const fail = (code: string, message: string): number => {
    if (!values.json)
      throw new CliError(message)
    context.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: 'error', error: { code, message } })}\n`)
    return 1
  }

  let credentials
  try {
    credentials = (await requireCredentials(context.env)).credentials
  }
  catch (error) {
    return fail('NO_CREDENTIALS', (error as Error).message)
  }
  let buckets
  try {
    buckets = await listCosBuckets({ credentials, endpoint: context.env.YUNBOX_COS_SERVICE_ENDPOINT || undefined })
  }
  catch (error) {
    if (error instanceof CosRequestError && error.status === 403 && error.code === 'AccessDenied')
      return fail('ACCESS_DENIED', '这把密钥不能列出 bucket（受限子账号通常如此），请向管理员要 bucket 名称和地域')
    if (error instanceof CosRequestError && error.status === 403)
      return fail('INVALID_CREDENTIALS', `腾讯云拒绝了本机的密钥（${error.code ?? 'HTTP 403'}），请重新运行 yunbox login`)
    return fail('REQUEST_FAILED', `列出 bucket 失败：${(error as Error).message}`)
  }
  if (values.json) {
    context.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: 'ok', buckets: buckets.map(({ name, region }) => ({ name, region })) })}\n`)
    return 0
  }
  if (buckets.length === 0)
    print(context, '账号下还没有 bucket。运行 git yunbox init 时可以新建一个私有 bucket')
  for (const bucket of buckets)
    print(context, `${bucket.name}（${bucket.region}）`)
  return 0
}
