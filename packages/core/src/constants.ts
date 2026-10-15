/** Git LFS JSON media type used by batch and verify endpoints. */
export const LFS_JSON_MEDIA_TYPE = 'application/vnd.git-lfs+json'

/** Maximum accepted object size: 2 GiB. */
export const MAX_OBJECT_SIZE = 2 * 1024 * 1024 * 1024

/** Default lifetime for a signed local transfer URL, in seconds. */
export const DEFAULT_ACTION_TTL_SECONDS = 5 * 60
