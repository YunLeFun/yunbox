import { describe, expect, it } from 'vitest'
import { checkBuildVersions } from './check_macos_build.mjs'

const expected = { sdk: '27.0', minimum: '26.0' }
const info = { LSMinimumSystemVersion: '26.0', DTSDKName: 'macosx27.0' }
const arm = `YunBox (architecture arm64):
Load command 10
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 26.0
      sdk 27.0
   ntools 1
     tool 3
  version 1230.1
Load command 11
      cmd LC_SOURCE_VERSION
  version 0.0
`
const intel = arm.replace('arm64', 'x86_64')

describe('macOS build metadata', () => {
  it('accepts matching thin and universal executables', () => {
    expect(checkBuildVersions(arm, info, expected)).toBe(1)
    expect(checkBuildVersions(arm + intel, info, expected)).toBe(2)
    expect(checkBuildVersions(arm.replace('minos 26.0', 'minos 26.0.0'), info, expected)).toBe(1)
  })

  it('rejects an SDK stamped as the deployment target in either architecture', () => {
    expect(() => checkBuildVersions(arm.replace('sdk 27.0', 'sdk 26.0'), info, expected)).toThrow('expected SDK 27.0')
    expect(() => checkBuildVersions(arm + intel.replace('sdk 27.0', 'sdk 14.0'), info, expected)).toThrow('Slice 2')
  })

  it('rejects unsupported or missing binary metadata', () => {
    expect(() => checkBuildVersions('', info, expected)).toThrow('No LC_BUILD_VERSION')
    expect(() => checkBuildVersions(arm.replace('minos 26.0', 'minos 14.0'), info, expected)).toThrow('expected minimum macOS 26.0')
    expect(() => checkBuildVersions(arm.replace('platform 1', 'platform 2'), info, expected)).toThrow('expected macOS')
    expect(() => checkBuildVersions(arm.replace('sdk 27.0', ''), info, expected)).toThrow('expected SDK 27.0')
  })

  it('rejects bundle metadata that disagrees with the executable', () => {
    expect(() => checkBuildVersions(arm, { ...info, LSMinimumSystemVersion: '14.0' }, expected)).toThrow('Info.plist must require macOS 26.0')
    expect(() => checkBuildVersions(arm, { ...info, DTSDKName: 'macosx14.0' }, expected)).toThrow('Info.plist must record macosx27.0')
    expect(() => checkBuildVersions(arm, {}, expected)).toThrow('Info.plist must require macOS 26.0')
  })
})
