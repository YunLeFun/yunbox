import type { ReleaseSnapshot } from './release.data'

/** Asset name the Release workflow uploads for the macOS client. */
export const MACOS_ASSET = 'YunBox-macOS.zip'

/**
 * Ask GitHub for the newest release. Never throws: a slow or unreachable
 * GitHub gives `state: 'unknown'`.
 *
 * @param headers - Extra request headers, such as an Authorization token
 * @returns What the newest release offers
 */
export async function fetchLatestRelease(headers: Record<string, string> = {}): Promise<ReleaseSnapshot> {
  try {
    const response = await fetch('https://api.github.com/repos/YunLeFun/yunbox/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', ...headers },
      signal: AbortSignal.timeout(6000),
    })
    if (response.status === 404)
      return { state: 'none' }
    if (!response.ok)
      return { state: 'unknown' }
    const body = await response.json() as { tag_name: string, html_url: string, assets: { name: string, size: number, browser_download_url: string }[] }
    const asset = body.assets.find(entry => entry.name === MACOS_ASSET)
    return { state: 'ready', tag: body.tag_name, url: body.html_url, macosUrl: asset?.browser_download_url, macosBytes: asset?.size }
  }
  catch {
    return { state: 'unknown' }
  }
}
