import type { CliContext } from '../context.ts'
import type { CosLocation } from '../cos/location.ts'
import { parseArgs } from 'node:util'
import { CliError, printError, USAGE_EXIT_CODE } from '../context.ts'
import { describeLocation, LOCATION_FILE, normalizeLocation } from '../cos/location.ts'
import { buildCosPolicy } from '../cos/policy.ts'
import { findRepositoryRoot } from '../git.ts'
import { readStorageLocation, requireCapability } from '../storage/config.ts'

export const policyHelp = `用法：yunbox policy [--read-only] [--bucket <名称-APPID>] [--region <地域>] [--prefix <前缀>]

输出给协作者子账号用的最小权限 CAM 策略（JSON），可以直接粘贴到腾讯云访问管理控制台
「策略 → 新建自定义策略 → 按策略语法创建」。只输出，不会调用 CAM 接口，也不需要密钥。

默认读取当前仓库的 ${LOCATION_FILE}；参数会覆盖其中对应的值，不在仓库里时必须给出 --bucket 和 --region。

  --read-only        只能拉取：GetObject、HeadObject（默认还有 PutObject，可以推送）
  --bucket <名称>    bucket 名称，带 APPID 后缀，例如 assets-1250000000
  --region <地域>    例如 ap-guangzhou
  --prefix <前缀>    对象前缀，例如 yunbox/team/game；为空表示整个 bucket
  -h, --help         显示帮助

策略只授权这个前缀下的对象：不能列出 bucket、不能删除、碰不到其他前缀。
策略 JSON 写到标准输出，说明写到标准错误，所以可以 yunbox policy | pbcopy。
`

interface PolicyOptions {
  'bucket'?: string
  'region'?: string
  'prefix'?: string
  'read-only'?: boolean
  'help'?: boolean
}

/** Run `yunbox policy`: print a least-privilege CAM policy for the repository's COS prefix. Never calls CAM. */
export async function runPolicy(context: CliContext, args: string[]): Promise<number> {
  let values: PolicyOptions
  try {
    values = parseArgs({
      args,
      options: {
        'bucket': { type: 'string' },
        'region': { type: 'string' },
        'prefix': { type: 'string' },
        'read-only': { type: 'boolean' },
        'help': { type: 'boolean', short: 'h' },
      },
    }).values
  }
  catch (error) {
    throw new CliError(`${(error as Error).message}\n运行 yunbox policy --help 查看用法`, USAGE_EXIT_CODE)
  }
  if (values.help) {
    context.stdout.write(policyHelp)
    return 0
  }

  const location = await chooseLocation(context, values)
  const readOnly = values['read-only'] === true
  context.stdout.write(`${JSON.stringify(buildCosPolicy(location, { readOnly }), null, 2)}\n`)

  printError(context, '')
  printError(context, `上面是 ${describeLocation(location)} 的${readOnly ? '只读' : '读写'}策略（${readOnly ? 'GetObject、HeadObject' : 'PutObject、GetObject、HeadObject'}）。`)
  if (location.prefix === '')
    printError(context, '注意：前缀为空，这份策略覆盖整个 bucket。多个仓库共用 bucket 时，请给每个仓库单独的前缀')
  printError(context, '给协作者开子账号：访问管理 → 用户 → 新建用户（只勾选「编程访问」）→ 策略 → 新建自定义策略 →')
  printError(context, '按策略语法创建，粘贴上面的 JSON → 关联给这个子账号 → 把 SecretId / SecretKey 交给协作者运行 yunbox login。')
  printError(context, '本命令没有修改任何云端设置。')
  return 0
}

async function chooseLocation(context: CliContext, values: PolicyOptions): Promise<CosLocation> {
  const root = await findRepositoryRoot(context)
  let existing: CosLocation | undefined
  if (root !== undefined) {
    const found = await readStorageLocation({ ...context, cwd: root }, root).catch((error: Error) => {
      throw new CliError(`COS 位置的配置不对：${error.message}`)
    })
    if (found !== undefined && values.bucket === undefined)
      requireCapability(found, 'policy', 'yunbox policy')
    existing = found as CosLocation | undefined
  }
  const bucket = values.bucket ?? existing?.bucket
  const region = values.region ?? existing?.region
  if (bucket === undefined || region === undefined) {
    throw new CliError(root === undefined
      ? `不在 Git 仓库里。用 --bucket 和 --region 指定，或在已接入的仓库里运行`
      : `仓库里没有 ${LOCATION_FILE}。用 --bucket 和 --region 指定，或先运行 git yunbox init`, USAGE_EXIT_CODE)
  }
  try {
    return normalizeLocation({ bucket, region, prefix: values.prefix ?? existing?.prefix ?? '' })
  }
  catch (error) {
    throw new CliError((error as Error).message, USAGE_EXIT_CODE)
  }
}
