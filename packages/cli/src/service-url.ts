import { assertRepository } from '@yunbox/core'

/** A validated YunBox repository endpoint, the value of `lfs.url`. */
export interface ServiceUrl {
  /** Normalized `<origin>/<owner>/<repo>` without a trailing slash. */
  url: string
  origin: string
  /** `http` or `https`, as Git credential helpers expect it. */
  protocol: 'http' | 'https'
  /** Host and port as Git credential helpers key them, such as `127.0.0.1:8080`. */
  host: string
  owner: string
  repo: string
  /** Whether the host is this machine, the only place plain HTTP is accepted. */
  loopback: boolean
}

/** Why a value cannot be used as `lfs.url`. */
export class ServiceUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServiceUrlError'
  }
}

/**
 * Parse a YunBox repository URL such as `https://lfs.example.com/team/assets`.
 *
 * Rejects embedded credentials, query strings, fragments and paths that are
 * not exactly `/<owner>/<repo>`. Plain HTTP is parsed (so `doctor` can report
 * it) but marked through {@link ServiceUrl.loopback}; callers decide whether to
 * accept it with {@link isSecureServiceUrl}.
 */
export function parseServiceUrl(value: string): ServiceUrl {
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    throw new ServiceUrlError(`不是有效的地址：${value}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new ServiceUrlError('地址必须以 https:// 开头')
  if (url.username !== '' || url.password !== '')
    throw new ServiceUrlError('地址里不能包含用户名、密码或 token；token 只存在 Git 凭据管理器里')
  if (url.search !== '' || url.hash !== '')
    throw new ServiceUrlError('地址不能包含查询参数或 #')
  const segments = url.pathname.replace(/\/+$/, '').split('/').slice(1)
  if (segments.length !== 2)
    throw new ServiceUrlError('地址必须是 <服务地址>/<owner>/<repo>，例如 https://lfs.example.com/team/assets')
  // Percent-encoded segments are left encoded so they fail the component check.
  const [owner, repo] = segments as [string, string]
  try {
    assertRepository({ owner, repo })
  }
  catch {
    throw new ServiceUrlError('owner 和 repo 只能包含字母、数字、点、下划线和连字符，并以字母或数字开头和结尾')
  }
  return {
    url: `${url.origin}/${owner}/${repo}`,
    origin: url.origin,
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    host: url.host,
    owner,
    repo,
    loopback: isLoopbackHostname(url.hostname),
  }
}

/** HTTPS, or plain HTTP to this machine. Anything else would send the token in clear text. */
export function isSecureServiceUrl(service: ServiceUrl): boolean {
  return service.protocol === 'https' || service.loopback
}

/** Whether a URL hostname (IPv6 in brackets) refers to this machine. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)
}
