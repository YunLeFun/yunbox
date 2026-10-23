import type { CliContext } from './context.ts'
import type { Tone } from './terminal.ts'
import { AGENT_NAME } from './commands/lfs-agent.ts'
import { readGitConfig, readLfsUrl } from './git.ts'
import { describeStorage, providerOf, readStorageLocation } from './storage/config.ts'
import { terminalText } from './terminal.ts'

/** Local configuration facts, not a network or credential health check. */
export interface TransferSummary {
  fields: Array<{ label: string, value: string, tone?: Tone }>
  warnings: string[]
}

/** Describe where LFS is configured to go, without fetching objects or reading keys. */
export async function readTransferSummary(context: CliContext): Promise<TransferSummary> {
  const [agent, path, service] = await Promise.all([
    readGitConfig(context, 'lfs.standalonetransferagent'),
    readGitConfig(context, `lfs.customtransfer.${AGENT_NAME}.path`),
    readLfsUrl(context, context.cwd),
  ])
  let location
  try {
    location = await readStorageLocation(context, context.cwd)
  }
  catch {
    return { fields: [{ label: '素材目标', value: '存储配置无效，无法确认', tone: 'error' }], warnings: ['运行 yunbox doctor 检查 .yunbox/config 或旧版 .yunboxconfig。'] }
  }
  const warnings: string[] = []
  const fields: TransferSummary['fields'] = []
  if (agent === AGENT_NAME && path?.trim() && location) {
    fields.push({ label: '素材目标', value: `${providerOf(location).label} · ${terminalText(describeStorage(location))}（直连）`, tone: 'info' })
    fields.push({ label: '传输代理', value: '已登记 yunbox（仅当前 clone）' })
    fields.push({ label: '传输说明', value: 'LFS 素材直传对象存储；Git 远端接收代码和 LFS 指针' })
    if (service)
      fields.push({ label: 'lfs.url', value: '已有设置，当前独立传输代理不会使用' })
  }
  else if (location || agent === AGENT_NAME) {
    fields.push({ label: '素材目标', value: 'YunBox 直连尚未就绪', tone: 'warning' })
    if (location)
      fields.push({ label: '素材配置', value: `${providerOf(location).label} · ${terminalText(describeStorage(location))}` })
    warnings.push(agent && agent !== AGENT_NAME
      ? `当前使用其他传输代理（${terminalText(agent)}）；运行 yunbox doctor 检查，确认要切换后运行 git yunbox init。`
      : '运行 git yunbox init 为这份 clone 登记传输代理，再运行 yunbox doctor 检查。')
  }
  else if (agent) {
    fields.push({ label: '素材目标', value: `自定义传输代理 · ${terminalText(agent)}（由该代理决定）` })
  }
  else if (service) {
    fields.push({ label: '素材目标', value: 'LFS 服务端' })
    fields.push({ label: 'lfs.url', value: `${safeServiceUrl(service.url)}（来自 ${service.source}）` })
  }
  else {
    fields.push({ label: '素材目标', value: 'Git 远端默认 LFS 服务（未接入 YunBox）' })
    warnings.push('要将素材直传对象存储，运行 git yunbox init。')
  }
  return { fields, warnings }
}

function safeServiceUrl(value: string): string {
  try {
    const url = new URL(value)
    return terminalText(`${url.protocol}//${url.host}${url.pathname}`)
  }
  catch {
    return '地址格式无效（yunbox doctor 可以检查）'
  }
}
