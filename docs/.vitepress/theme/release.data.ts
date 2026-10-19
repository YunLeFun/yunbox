import process from 'node:process'
import { defineLoader } from 'vitepress'

/** The newest GitHub release as seen when the site was built. */
export interface ReleaseSnapshot {
  /** `none` when the repository has no release yet; `unknown` when GitHub could not be reached */
  state: 'ready' | 'none' | 'unknown'
  tag?: string
  url?: string
  macosUrl?: string
  macosBytes?: number
}

declare const data: ReleaseSnapshot
export { data }

export default defineLoader({
  async load(): Promise<ReleaseSnapshot> {
    const { fetchLatestRelease } = await import('./release-api')
    // In CI the workflow token avoids the anonymous rate limit.
    const token = process.env.GITHUB_TOKEN
    return fetchLatestRelease(token === undefined ? {} : { Authorization: `Bearer ${token}` })
  },
})
