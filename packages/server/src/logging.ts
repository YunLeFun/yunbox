/** One structured access-log entry. It never contains headers, query strings, URLs or token secrets. */
export interface RequestLogEntry {
  time: string
  requestId: string
  method: string
  /** Request path without the query string, which may carry an action signature. */
  path: string
  status: number
  durationMs: number
  /** Id (not secret) of the token that authenticated the request. */
  tokenId?: string
  /** Redacted description of a server-side failure. */
  error?: string
  /** True when the connection closed before the response finished. */
  aborted?: boolean
}

/** Receives access-log entries. */
export type RequestLogger = (entry: RequestLogEntry) => void

const MAX_LOGGED_TEXT = 200

/**
 * Remove anything that could grant access from text destined for logs: URLs
 * (presigned or signed action addresses), YunBox token secrets, `Basic` /
 * `Bearer` credentials and COS signature fields.
 */
export function redactLogText(text: string): string {
  return text
    .replace(/[a-z][a-z\d+.-]*:\/\/\S+/gi, '[url]')
    .replace(/ybx_[\w-]+/g, '[token]')
    .replace(/\b(Basic|Bearer)\s+\S+/gi, '$1 [redacted]')
    .replace(/(q-signature|q-ak|x-cos-security-token|signature)=[^&\s]+/gi, '$1=[redacted]')
    .slice(0, MAX_LOGGED_TEXT)
}

/** Request path for logging: drops the query string and redacts the rest. */
export function loggablePath(rawUrl: string | undefined): string {
  if (rawUrl === undefined)
    return ''
  const queryIndex = rawUrl.indexOf('?')
  return redactLogText(queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex))
}

/** Describe an error for logs without leaking secrets. */
export function describeErrorForLog(error: unknown): string {
  if (!(error instanceof Error))
    return 'non-error value thrown'
  const cause = error.cause instanceof Error ? ` (cause: ${redactLogText(`${error.cause.name}: ${error.cause.message}`)})` : ''
  return `${redactLogText(`${error.name}: ${error.message}`)}${cause}`
}
