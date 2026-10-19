import type { Ref } from 'vue'
import type { ReleaseSnapshot } from './release.data'
import { onMounted, ref } from 'vue'
import cli from '../../../packages/cli/package.json'
import { fetchLatestRelease, MACOS_ASSET } from './release-api'
import { data as built } from './release.data'

/** The GitHub repository that hosts the code and the releases. */
export const REPOSITORY = 'https://github.com/YunLeFun/yunbox'

/** Always points at the newest release, so the site follows releases without a rebuild. */
export const MACOS_DOWNLOAD_URL = `${REPOSITORY}/releases/latest/download/${MACOS_ASSET}`

/** The CLI version in this checkout. */
export const CLI_VERSION: string = cli.version

/**
 * The newest release: what GitHub said at build time, refreshed in the
 * browser when GitHub answers (it rate-limits anonymous visitors, so a
 * failed refresh keeps the build-time answer).
 *
 * @returns A reactive release snapshot
 */
export function useLatestRelease(): Ref<ReleaseSnapshot> {
  const release = ref<ReleaseSnapshot>(built)
  onMounted(async () => {
    const fresh = await fetchLatestRelease()
    if (fresh.state !== 'unknown')
      release.value = fresh
  })
  return release
}
