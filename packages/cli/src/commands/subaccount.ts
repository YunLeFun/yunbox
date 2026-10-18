// @env node

import type { CosCredentials } from '@yunbox/core'
import type { CliContext } from '../context.ts'
import type { CosLocation } from '../cos/location.ts'
import { createHash } from 'node:crypto'
import { userInfo } from 'node:os'
import { parseArgs } from 'node:util'
import { CliError, print, USAGE_EXIT_CODE } from '../context.ts'
import { CosDirectClient } from '../cos/client.ts'
import { resolveCredentials, saveCredentials } from '../cos/credentials.ts'
import { describeLocation, LOCATION_FILE, normalizeLocation, readLocation } from '../cos/location.ts'
import { buildCosPolicy } from '../cos/policy.ts'
import { callTencentApi, TencentApiError } from '../cos/tencent-api.ts'
import { findRepositoryRoot } from '../git.ts'
import { createLineReader } from '../prompt.ts'
import { printStep } from '../report.ts'

/** Marker in the CAM remark of sub-accounts this command created. */
const REMARK = 'Created by YunBox (yunbox subaccount)'
const NAME_PATTERN = /^[\w+=,.@-]{1,64}$/
/** CAM changes reach every COS front end within about a minute (docs/plan.md section 12). */
const PROPAGATION_TIMEOUT_MS = 120_000

export const subaccountHelp = `用法：yunbox subaccount create [名称] (--save | --show-key) [--read-only]
      yunbox subaccount grant <名称> [--read-only]
      yunbox subaccount list
      yunbox subaccount delete <名称> [--yes]

用管理员身份（tccli auth login，或 TENCENTCLOUD_* 环境变量）管理只给 YunBox 用的
CAM 子账号：每个子账号只能编程访问，只被授权读写某个仓库在 COS 里的前缀
（策略和 yunbox policy 输出的一样），密钥长期有效、可以随时在 CAM 里禁用。

  create   新建子账号、挂上当前仓库前缀的策略、生成 API 密钥
           --save      给自己用：把密钥存进本机（macOS 钥匙串），并等待权限生效后检查读写
           --show-key  给协作者：在终端里显示一次密钥，请通过安全渠道转交，之后无法再查看
  grant    给已有子账号再授权当前仓库的前缀（一个人参与多个项目时用）
  list     列出 YunBox 建的子账号和它们能访问的前缀
  delete   删除子账号（连同它的密钥）和 YunBox 为它建的策略

通用选项：
  --read-only        只授权拉取（GetObject、HeadObject）
  --bucket / --region / --prefix   不在仓库里时指定 COS 位置，默认读取 ${LOCATION_FILE}
  --yes, -y          跳过确认
  -h, --help         显示帮助

名称默认 yunbox-<本机用户名>。密钥不会写进任何仓库或日志。
`

interface Options {
  'save'?: boolean
  'show-key'?: boolean
  'read-only'?: boolean
  'bucket'?: string
  'region'?: string
  'prefix'?: string
  'yes'?: boolean
  'help'?: boolean
}

interface CamUser { Uin: number, Name: string, Remark?: string }
interface CamPolicySummary { PolicyId: number | string, PolicyName: string, Description?: string }

/** Run `yunbox subaccount`. */
export async function runSubaccount(context: CliContext, args: string[]): Promise<number> {
  let parsed: { values: Options, positionals: string[] }
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        'save': { type: 'boolean' },
        'show-key': { type: 'boolean' },
        'read-only': { type: 'boolean' },
        'bucket': { type: 'string' },
        'region': { type: 'string' },
        'prefix': { type: 'string' },
        'yes': { type: 'boolean', short: 'y' },
        'help': { type: 'boolean', short: 'h' },
      },
    })
  }
  catch (error) {
    throw new CliError(`${(error as Error).message}\n运行 yunbox subaccount --help 查看用法`, USAGE_EXIT_CODE)
  }
  const { values, positionals } = parsed
  const [command, name] = positionals
  if (values.help || command === undefined) {
    context.stdout.write(subaccountHelp)
    return command === undefined && !values.help ? USAGE_EXIT_CODE : 0
  }
  const cam = await camClient(context)
  switch (command) {
    case 'create':
      return await create(context, cam, name ?? defaultName(), values)
    case 'grant':
      return await grant(context, cam, requireName(name), values)
    case 'list':
      return await list(context, cam)
    case 'delete':
      return await remove(context, cam, requireName(name), values)
    default:
      throw new CliError(`未知子命令：${command}。可用：create、grant、list、delete`, USAGE_EXIT_CODE)
  }
}

type Cam = <T>(action: string, params: Record<string, unknown>) => Promise<T>

/** CAM calls signed with administrator keys: environment variables or tccli, never what `yunbox login` saved. */
async function camClient(context: CliContext): Promise<Cam> {
  // An empty store list skips the keychain and file: those hold the sub-account's own keys.
  const admin = await resolveCredentials(context.env, [])
  if (admin === undefined)
    throw new CliError('管理子账号需要管理员身份：先运行 tccli auth login（浏览器登录腾讯云），或设置 TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY')
  printStep(context, { status: 'pass', title: '管理员身份', detail: `来自 ${admin.description}` })
  return async <T>(action: string, params: Record<string, unknown>): Promise<T> => {
    try {
      return await callTencentApi<T>({ credentials: admin.credentials, service: 'cam', version: '2019-01-16', action, params, endpoint: context.env.YUNBOX_CAM_ENDPOINT || undefined })
    }
    catch (error) {
      if (error instanceof TencentApiError && error.code.startsWith('AuthFailure'))
        throw new CliError(`腾讯云拒绝了 ${action}（${error.code}）：当前身份没有访问管理（CAM）权限，或登录已过期。请用主账号或有 CAM 权限的管理员重新运行 tccli auth login`)
      throw error
    }
  }
}

async function create(context: CliContext, cam: Cam, name: string, values: Options): Promise<number> {
  assertName(name)
  if (!values.save && !values['show-key'])
    throw new CliError('请选择密钥的去向：--save 存进本机（给自己用），或 --show-key 显示一次（转交给协作者）', USAGE_EXIT_CODE)
  if (values.save && values['show-key'])
    throw new CliError('--save 和 --show-key 只能选一个', USAGE_EXIT_CODE)
  const location = await resolveLocation(context, values)
  if (await findUser(cam, name) !== undefined)
    throw new CliError(`子账号 ${name} 已经存在。给它授权当前仓库：yunbox subaccount grant ${name}；或换一个名称`)

  const policyId = await ensurePolicy(cam, name, location, values['read-only'] === true)
  const user = await cam<CamUser & { SecretId: string, SecretKey: string }>('AddUser', { Name: name, Remark: REMARK, ConsoleLogin: 0, UseApi: 1 })
  try {
    await cam('AttachUserPolicy', { PolicyId: policyId, AttachUin: user.Uin })
  }
  catch (error) {
    // Leave nothing half-made behind: a sub-account with keys but no policy.
    await cam('DeleteUser', { Name: name, Force: 1 }).catch(() => {})
    throw error
  }
  printStep(context, { status: 'pass', title: '子账号', detail: `${name}（只能编程访问，${values['read-only'] ? '只读' : '可读写'} ${describeLocation(location)}）` })
  const keys = { secretId: user.SecretId, secretKey: user.SecretKey }

  if (values['show-key']) {
    print(context)
    print(context, '下面的密钥只显示这一次，请通过安全渠道（例如密码管理器的共享）转交给协作者，不要发在聊天记录里：')
    print(context, `  SecretId:  ${keys.secretId}`)
    print(context, `  SecretKey: ${keys.secretKey}`)
    print(context)
    print(context, `协作者在自己电脑上运行 yunbox login 保存它。停用：yunbox subaccount delete ${name}`)
    return 0
  }

  const saved = await saveCredentials(context.env, keys)
  printStep(context, { status: 'pass', title: '长期密钥', detail: `已保存到${saved.store.description}，不会过期，也不会写进仓库` })
  await waitForAccess(context, location, keys, values['read-only'] === true)
  print(context)
  print(context, `完成。这台电脑之后用这个子账号直连 COS，不用再 tccli auth login。停用：yunbox subaccount delete ${name}`)
  return 0
}

async function grant(context: CliContext, cam: Cam, name: string, values: Options): Promise<number> {
  const location = await resolveLocation(context, values)
  const user = await findUser(cam, name)
  if (user === undefined)
    throw new CliError(`没有子账号 ${name}。新建：yunbox subaccount create ${name} --save`)
  const policyId = await ensurePolicy(cam, name, location, values['read-only'] === true)
  try {
    await cam('AttachUserPolicy', { PolicyId: policyId, AttachUin: user.Uin })
  }
  catch (error) {
    if (!(error instanceof TencentApiError && /attached|exist/i.test(`${error.code} ${error.message}`)))
      throw error
  }
  printStep(context, { status: 'pass', title: '授权', detail: `${name} 现在可以${values['read-only'] ? '读取' : '读写'} ${describeLocation(location)}；约一分钟后生效` })
  return 0
}

async function list(context: CliContext, cam: Cam): Promise<number> {
  const users = (await cam<{ Data?: CamUser[] }>('ListUsers', {})).Data ?? []
  const ours = users.filter(user => user.Remark === REMARK)
  if (ours.length === 0) {
    print(context, '还没有 YunBox 建的子账号。新建：yunbox subaccount create --save')
    return 0
  }
  for (const user of ours) {
    print(context, `${user.Name}（UIN ${user.Uin}）`)
    for (const policy of await yunboxPolicies(cam, user)) {
      // ListAttachedUserPolicies does not return descriptions; GetPolicy does.
      const detail = await cam<{ Description?: string }>('GetPolicy', { PolicyId: Number(policy.PolicyId) }).catch(() => undefined)
      print(context, `  ${detail?.Description || policy.PolicyName}`)
    }
  }
  return 0
}

async function remove(context: CliContext, cam: Cam, name: string, values: Options): Promise<number> {
  const user = await findUser(cam, name)
  if (user === undefined)
    throw new CliError(`没有子账号 ${name}`)
  if (user.Remark !== REMARK)
    throw new CliError(`${name} 不是 YunBox 建的子账号，为安全起见不删除。请在腾讯云访问管理控制台里处理`)
  if (!values.yes) {
    const ask = createLineReader(context)
    try {
      const answer = await ask(`删除子账号 ${name} 和它的密钥？用这把密钥的人会立即无法访问 COS [y/N]：`)
      if (answer === undefined || !/^y(?:es)?$/i.test(answer.trim()))
        throw new CliError('已取消，没有删除任何东西')
    }
    finally {
      ask.close()
    }
  }
  const policies = await yunboxPolicies(cam, user)
  await cam('DeleteUser', { Name: name, Force: 1 })
  if (policies.length > 0)
    await cam('DeletePolicy', { PolicyId: policies.map(policy => Number(policy.PolicyId)) })
  printStep(context, { status: 'pass', title: '已删除', detail: `子账号 ${name}、它的密钥和 ${policies.length} 条 YunBox 策略` })
  return 0
}

/** Create the policy for this sub-account and location, or reuse the one an earlier run made. */
async function ensurePolicy(cam: Cam, name: string, location: CosLocation, readOnly: boolean): Promise<number> {
  const scope = createHash('sha256').update(`${location.bucket}/${location.prefix}`).digest('hex').slice(0, 8)
  const policyName = `${policyPrefix(name)}${scope}-${readOnly ? 'ro' : 'rw'}`
  const description = `YunBox ${readOnly ? '只读' : '读写'} ${describeLocation(location)}`
  try {
    const created = await cam<{ PolicyId: number }>('CreatePolicy', { PolicyName: policyName, PolicyDocument: JSON.stringify(buildCosPolicy(location, { readOnly })), Description: description })
    return created.PolicyId
  }
  catch (error) {
    if (!(error instanceof TencentApiError && /NameInUse|exist/i.test(`${error.code} ${error.message}`)))
      throw error
    const found = ((await cam<{ List?: CamPolicySummary[] }>('ListPolicies', { Keyword: policyName, Scope: 'Local', Rp: 200 })).List ?? [])
      .find(policy => policy.PolicyName === policyName)
    if (found === undefined)
      throw error
    return Number(found.PolicyId)
  }
}

async function yunboxPolicies(cam: Cam, user: CamUser): Promise<CamPolicySummary[]> {
  const attached = (await cam<{ List?: CamPolicySummary[] }>('ListAttachedUserPolicies', { TargetUin: user.Uin, Page: 1, Rp: 200 })).List ?? []
  const prefix = policyPrefix(user.Name)
  // Exact shape, so that `yunbox-a` never picks up the policies of `yunbox-a-b`.
  return attached.filter(policy => policy.PolicyName.startsWith(prefix) && /^[\da-f]{8}-(?:rw|ro)$/.test(policy.PolicyName.slice(prefix.length)))
}

async function findUser(cam: Cam, name: string): Promise<CamUser | undefined> {
  try {
    return await cam<CamUser>('GetUser', { Name: name })
  }
  catch (error) {
    if (error instanceof TencentApiError && /NotExist|NotFound/i.test(error.code))
      return undefined
    throw error
  }
}

/** Probe with the new keys until CAM has propagated, so the user knows they work. */
async function waitForAccess(context: CliContext, location: CosLocation, keys: CosCredentials, readOnly: boolean): Promise<void> {
  const client = new CosDirectClient(location, () => keys)
  const deadline = Date.now() + PROPAGATION_TIMEOUT_MS
  print(context, '等待权限生效（通常不到一分钟）…')
  while (true) {
    const steps = await client.probe()
    const ok = readOnly ? await client.head(`${location.prefix === '' ? '' : `${location.prefix}/`}_yunbox/read-check`).then(() => true, () => false) : steps.every(step => step.ok)
    if (ok) {
      printStep(context, { status: 'pass', title: 'COS 权限', detail: `新密钥可以${readOnly ? '读取' : '读写'} ${describeLocation(location)}` })
      return
    }
    if (Date.now() > deadline) {
      printStep(context, { status: 'warn', title: 'COS 权限', detail: '两分钟内还没生效', fixes: ['稍后运行 yunbox doctor 再检查'] })
      return
    }
    await new Promise(resolve => setTimeout(resolve, 5000))
  }
}

async function resolveLocation(context: CliContext, values: Options): Promise<CosLocation> {
  const root = await findRepositoryRoot(context)
  const fromRepo = root === undefined ? undefined : await readLocation({ ...context, cwd: root }, root).catch(() => undefined)
  const bucket = values.bucket ?? fromRepo?.bucket
  const region = values.region ?? fromRepo?.region
  if (bucket === undefined || region === undefined)
    throw new CliError(`不在已接入的仓库里：请在有 ${LOCATION_FILE} 的仓库里运行，或者用 --bucket、--region、--prefix 指定`, USAGE_EXIT_CODE)
  try {
    // Keep the repository's endpoint override (tests) unless the bucket itself was overridden.
    const endpoint = values.bucket === undefined && values.region === undefined ? fromRepo?.endpoint : undefined
    return normalizeLocation({ bucket, region, prefix: values.prefix ?? fromRepo?.prefix ?? '', ...(endpoint === undefined ? {} : { endpoint }) })
  }
  catch (error) {
    throw new CliError((error as Error).message, USAGE_EXIT_CODE)
  }
}

/** Policies are named `<prefix><8 hex>-rw|ro`; names that already start with `yunbox-` are not prefixed twice. */
function policyPrefix(name: string): string {
  return name.startsWith('yunbox-') ? `${name}-` : `yunbox-${name}-`
}

function defaultName(): string {
  return `yunbox-${userInfo().username.replace(/[^\w+=,.@-]/g, '-')}`.slice(0, 64)
}

function requireName(name: string | undefined): string {
  if (name === undefined)
    throw new CliError('请给出子账号名称，例如 yunbox subaccount grant yunbox-alice', USAGE_EXIT_CODE)
  assertName(name)
  return name
}

function assertName(name: string): void {
  if (!NAME_PATTERN.test(name))
    throw new CliError('子账号名称只能包含字母、数字和 + = , . @ - _，最长 64 个字符', USAGE_EXIT_CODE)
}
