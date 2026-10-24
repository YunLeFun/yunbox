import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

function normalizedVersion(value) {
  return value.split('.').map(Number).concat([0, 0]).slice(0, 3).join('.')
}

/**
 * Verify every Mach-O slice and the bundle agree on the SDK and minimum system.
 * Reject missing metadata as well as an SDK accidentally stamped as the deployment target.
 * @param {string} loadCommands Output from `otool -l`, including all universal slices.
 * @param {Record<string, string>} info Parsed Info.plist.
 * @param {{ sdk: string, minimum: string }} expected The selected SDK and Package.swift minimum.
 * @returns {number} Number of validated architecture slices.
 */
export function checkBuildVersions(loadCommands, info, expected) {
  const commands = [...loadCommands.matchAll(/\bcmd LC_BUILD_VERSION\b([\s\S]*?)(?=\nLoad command|\n[^\n]*\(architecture|$)/g)]
  if (commands.length === 0)
    throw new Error('No LC_BUILD_VERSION found in the app executable')
  for (const [index, command] of commands.entries()) {
    const platform = command[1].match(/\bplatform\s+(\S+)/)?.[1]
    const minimum = command[1].match(/\bminos\s+([\d.]+)/)?.[1]
    const sdk = command[1].match(/\bsdk\s+([\d.]+)/)?.[1]
    if (!['1', 'MACOS', 'macos'].includes(platform))
      throw new Error(`Slice ${index + 1}: expected macOS, found ${platform ?? 'no platform'}`)
    if (!minimum || normalizedVersion(minimum) !== normalizedVersion(expected.minimum))
      throw new Error(`Slice ${index + 1}: expected minimum macOS ${expected.minimum}, found ${minimum ?? 'none'}`)
    if (!sdk || normalizedVersion(sdk) !== normalizedVersion(expected.sdk))
      throw new Error(`Slice ${index + 1}: expected SDK ${expected.sdk}, found ${sdk ?? 'none'}`)
  }
  if (!info.LSMinimumSystemVersion || normalizedVersion(info.LSMinimumSystemVersion) !== normalizedVersion(expected.minimum))
    throw new Error(`Info.plist must require macOS ${expected.minimum}`)
  if (info.DTSDKName !== `macosx${expected.sdk}`)
    throw new Error(`Info.plist must record macosx${expected.sdk}`)
  return commands.length
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [app, sdk, minimum] = process.argv.slice(2)
  if (!app || !sdk || !minimum)
    throw new Error('usage: node script/check_macos_build.mjs <app> <sdk-version> <minimum-macos>')
  const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', resolve(app, 'Contents/Info.plist')], { encoding: 'utf8' }))
  const loadCommands = execFileSync('xcrun', ['otool', '-l', resolve(app, 'Contents/MacOS/YunBox')], { encoding: 'utf8' })
  const count = checkBuildVersions(loadCommands, info, { sdk, minimum })
  process.stdout.write(`Verified ${count} Mach-O slice(s): SDK ${sdk}, minimum macOS ${minimum}; Info.plist matches.\n`)
}
