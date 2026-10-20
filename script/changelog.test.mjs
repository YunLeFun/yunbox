import { describe, expect, it } from 'vitest'
import { check, embedInAppcast, format, LANGUAGES, load, notes, parse, release } from './changelog.mjs'

const zh = `# 更新日志

简介。

## 未发布

### 新增

- 新功能

## 0.1.0 - 2026-10-19

### 新增

- 第一个版本
`

const en = `# Changelog

Intro.

## Unreleased

### Added

- A new feature

## 0.1.0 - 2026-10-19

### Added

- First release
`

function both() {
  return { 'zh-Hans': parse(zh, '未发布'), 'en': parse(en, 'Unreleased') }
}

describe('changelog', () => {
  it('keeps the repository changelogs in step', () => {
    const changelogs = load()
    expect(() => check(changelogs)).not.toThrow()
    for (const language of Object.keys(LANGUAGES))
      expect(changelogs[language].releases.length).toBeGreaterThan(0)
  })

  it('parses and formats without changing the text', () => {
    expect(format(parse(zh, '未发布'), '未发布')).toBe(zh)
    expect(format(parse(en, 'Unreleased'), 'Unreleased')).toBe(en)
  })

  it('rejects malformed changelogs', () => {
    expect(() => parse(zh.replace('## 未发布', '## 0.2.0'), '未发布')).toThrow('the first section must be')
    expect(() => parse(zh.replace('## 0.1.0 - 2026-10-19', '## 0.1.0'), '未发布')).toThrow('is not "## <version>')
    expect(() => parse(zh.replace('### 新增\n\n- 第一个版本\n', ''), '未发布')).toThrow('0.1.0 has no notes')
  })

  it('requires every language to list the same releases', () => {
    const changelogs = both()
    changelogs.en = parse(en.replace('0.1.0 - 2026-10-19', '0.1.0 - 2026-10-20'), 'Unreleased')
    expect(() => check(changelogs)).toThrow('docs/en/changelog.md lists 0.1.0 - 2026-10-20')
  })

  it('turns the pending notes into a release', () => {
    const released = release(both(), '0.2.0', '2026-10-21')
    expect(format(released['zh-Hans'], '未发布')).toContain('## 未发布\n\n## 0.2.0 - 2026-10-21\n\n### 新增\n\n- 新功能\n\n## 0.1.0')
    expect(notes(released, '0.2.0', 'en')).toBe('### Added\n\n- A new feature')
    expect(() => release(released, '0.3.0', '2026-10-22')).toThrow('before releasing')
    expect(() => release(both(), '0.1.0', '2026-10-22')).toThrow('already in the changelog')
  })

  it('needs pending notes in every language', () => {
    const changelogs = both()
    changelogs.en = parse(en.replace('### Added\n\n- A new feature\n\n', ''), 'Unreleased')
    expect(() => check(changelogs)).not.toThrow()
    expect(() => check(changelogs, { unreleased: true })).toThrow('docs/en/changelog.md: write the changes under "## Unreleased"')
    expect(() => notes(changelogs, 'unreleased', 'en')).toThrow('has no notes for unreleased')
  })

  it('embeds the notes of every language in the appcast and drops the old signature', () => {
    const appcast = `<?xml version="1.0" standalone="yes"?><rss version="2.0">
    <channel>
        <item>
            <title>0.2.0</title>
            <sparkle:version>0.2.0</sparkle:version>
            <enclosure url="https://example.com/YunBox-macOS.zip" length="1" type="application/octet-stream" sparkle:edSignature="sig"></enclosure>
        </item>
    </channel>
</rss><!-- sparkle-signatures:
edSignature: abc
length: 10
-->`
    const result = embedInAppcast(appcast, { 'zh-Hans': '- 新功能', 'en': '- A new feature' })
    expect(result).not.toContain('sparkle-signatures')
    expect(result).toContain(`<description xml:lang="zh-Hans" sparkle:format="markdown"><![CDATA[- 新功能\n]]></description>
            <description xml:lang="en" sparkle:format="markdown"><![CDATA[- A new feature\n]]></description>
            <enclosure`)
    expect(embedInAppcast(result, { en: '- Again' }).match(/<description/g)).toHaveLength(1)
    expect(() => embedInAppcast(appcast, { en: 'a ]]> b' })).toThrow('cannot go into CDATA')
  })
})
