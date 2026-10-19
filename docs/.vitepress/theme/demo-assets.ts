/** A sample asset used by the homepage demos. */
export interface DemoAsset {
  /** File name as it appears in the repository */
  name: string
  /** Size in bytes */
  bytes: number
  /** Asset category shown next to the name */
  kind: string
}

/** Typical game-project assets, sized like the real thing. */
export const DEMO_ASSETS: DemoAsset[] = [
  { name: 'hero_concept.psd', bytes: 412_316_860, kind: '设计源文件' },
  { name: 'boss_idle.fbx', bytes: 186_646_528, kind: '模型' },
  { name: 'terrain_albedo.png', bytes: 50_331_648, kind: '贴图' },
  { name: 'theme_loop.wav', bytes: 61_865_984, kind: '音频' },
  { name: 'opening.mp4', bytes: 1_288_490_188, kind: '视频' },
]

const UNITS = ['B', 'KiB', 'MiB', 'GiB']

/**
 * Format a byte count the way the macOS client does: 1024-based units with
 * at most two decimals and no trailing zeros.
 *
 * @param bytes - Byte count
 * @returns A short label such as `531.48 KiB` or `10 MiB`
 */
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${Number(value.toFixed(2))} ${UNITS[unit]}`
}

/**
 * A stable, made-up SHA-256 for a demo file, so the pointer and object key
 * shown on the page look like the real ones without hashing anything.
 *
 * @param seed - Any string, usually the file name
 * @returns 64 lowercase hex characters
 */
export function demoOid(seed: string): string {
  let hash = 2166136261
  let out = ''
  while (out.length < 64) {
    for (const char of `${seed}:${out.length}`)
      hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
    out += hash.toString(16).padStart(8, '0')
  }
  return out.slice(0, 64)
}

/**
 * The Git LFS pointer file that Git stores in place of the asset.
 *
 * @param asset - The asset being replaced
 * @returns The three pointer lines, newline-terminated like git-lfs writes them
 */
export function pointerFor(asset: DemoAsset): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${demoOid(asset.name)}\nsize ${asset.bytes}\n`
}
