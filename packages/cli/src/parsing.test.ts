import { describe, expect, it } from 'vitest'
import { compareVersions, parseVersion } from './git.ts'
import { ASSET_CATEGORIES, mergeGitAttributes, removeGitAttributes, selectCategories, yunBoxPatterns } from './gitattributes.ts'
import { isSecureServiceUrl, parseServiceUrl } from './service-url.ts'

describe('parseServiceUrl', () => {
  it('normalizes a repository URL and derives the credential host', () => {
    expect(parseServiceUrl('https://lfs.example.com/team/game-assets/')).toEqual({
      url: 'https://lfs.example.com/team/game-assets',
      origin: 'https://lfs.example.com',
      protocol: 'https',
      host: 'lfs.example.com',
      owner: 'team',
      repo: 'game-assets',
      loopback: false,
    })
    expect(parseServiceUrl('http://127.0.0.1:8080/demo/assets').host).toBe('127.0.0.1:8080')
  })

  it('allows plain HTTP only for this machine', () => {
    for (const url of ['http://127.0.0.1:8080/a/b', 'http://localhost/a/b', 'http://[::1]:9/a/b', 'https://lfs.example.com/a/b'])
      expect(isSecureServiceUrl(parseServiceUrl(url)), url).toBe(true)
    for (const url of ['http://lfs.example.com/a/b', 'http://10.0.0.5/a/b', 'http://localhost.example.com/a/b'])
      expect(isSecureServiceUrl(parseServiceUrl(url)), url).toBe(false)
  })

  it('rejects credentials, queries and paths that are not <owner>/<repo>', () => {
    for (const url of [
      'lfs.example.com/a/b',
      'ftp://lfs.example.com/a/b',
      'https://user:token@lfs.example.com/a/b',
      'https://token@lfs.example.com/a/b',
      'https://lfs.example.com/a/b?token=x',
      'https://lfs.example.com/a/b#x',
      'https://lfs.example.com/a',
      'https://lfs.example.com/a/b/c',
      'https://lfs.example.com/_yunbox/b',
      'https://lfs.example.com/a/%2e%2e',
    ])
      expect(() => parseServiceUrl(url), url).toThrow()
  })
})

describe('mergeGitAttributes', () => {
  it('creates a file from scratch and is a no-op the second time', () => {
    const categories = selectCategories(['audio'])
    const first = mergeGitAttributes('', categories)
    expect(first.content.startsWith('# YunBox：')).toBe(true)
    expect(first.content).toContain('*.wav  filter=lfs diff=lfs merge=lfs -text\n')
    expect(first.added.get('audio')).toHaveLength(9)
    const second = mergeGitAttributes(first.content, categories)
    expect(second.content).toBe(first.content)
    expect(second.added.size).toBe(0)
  })

  it('treats quoted patterns and any existing attributes as already handled', () => {
    const existing = '"*.wav" filter=lfs diff=lfs merge=lfs -text\n*.mp3 -filter\n*.ogg'
    const merged = mergeGitAttributes(existing, selectCategories(['audio']))
    expect(merged.content.startsWith(`${existing}\n\n`)).toBe(true)
    expect(merged.keptNonLfs).toEqual(['*.mp3', '*.ogg'])
    expect(merged.added.get('audio')).not.toContain('*.wav')
  })

  it('leaves out excluded patterns', () => {
    const merged = mergeGitAttributes('', selectCategories(['archive']), { exclude: new Set(['*.zip']) })
    expect(merged.added.get('archive')).toEqual(['*.7z', '*.rar'])
    expect(merged.content).not.toContain('*.zip')
    expect(mergeGitAttributes('', selectCategories(['archive']), { exclude: new Set(['*.zip', '*.7z', '*.rar']) }).content).toBe('')
  })

  it('rejects unknown categories', () => {
    expect(() => selectCategories(['texture', 'nope'])).toThrow('nope')
  })

  it('expands presets and mixes them with categories', () => {
    expect(selectCategories(['design']).map(category => category.id)).toEqual(['texture', 'source', 'font'])
    expect(selectCategories(['media,archive', 'texture']).map(category => category.id)).toEqual(['texture', 'audio', 'video', 'archive'])
    expect(selectCategories(['game']).map(category => category.id)).not.toContain('archive')
    expect(selectCategories(['all'])).toEqual(ASSET_CATEGORIES)
  })
})

describe('removeGitAttributes', () => {
  const lfs = 'filter=lfs diff=lfs merge=lfs -text'

  it('removes only the categories asked for and is the inverse of adding them', () => {
    const base = '# project\r\n*.txt text eol=crlf\r\n'
    const first = mergeGitAttributes(base, selectCategories(['texture', 'audio'])).content
    const both = mergeGitAttributes(first, selectCategories(['archive'])).content
    const removed = removeGitAttributes(both, selectCategories(['archive']))
    expect(removed.content).toBe(first)
    expect(removed.removed.get('archive')).toEqual(['*.zip', '*.7z', '*.rar'])
    const all = removeGitAttributes(first, selectCategories(['texture', 'audio']))
    expect(all.content).toBe(base)
    expect(removeGitAttributes(mergeGitAttributes('', selectCategories(['font'])).content, selectCategories(['font'])).content).toBe('')
    expect(removeGitAttributes(base, selectCategories(['texture']))).toEqual({ content: base, removed: new Map() })
  })

  it('keeps hand-written rules inside and right after the block', () => {
    const generated = mergeGitAttributes('', selectCategories(['archive', 'font'])).content
    // An edited line, a rule that git lfs track appended, and one out of alignment.
    const edited = generated
      .replace(`*.7z  ${lfs}\n`, `*.7z  ${lfs} lockable\n`)
      .concat(`*.zip ${lfs}\n*.c ${lfs}\n`)
    expect([...yunBoxPatterns(edited).keys()]).toEqual(['*.ttf', '*.otf', '*.zip', '*.rar'])
    const removed = removeGitAttributes(edited, selectCategories(['font', 'archive']))
    expect(removed.removed.get('archive')).toEqual(['*.zip', '*.rar'])
    expect(removed.content).toBe(`# YunBox：以下素材由 Git LFS 管理（git yunbox init 生成）\n# 压缩包\n*.7z  ${lfs} lockable\n*.zip ${lfs}\n*.c ${lfs}\n`)
    // Rules before the header are never YunBox's.
    expect(yunBoxPatterns(`# 压缩包\n*.zip ${lfs}\n`).size).toBe(0)
  })
})

describe('versions', () => {
  it('parses and compares Git and git-lfs versions', () => {
    expect(parseVersion('git version 2.45.1.windows.1')).toBe('2.45.1')
    expect(compareVersions('3.2.0', '3.2.0')).toBe(0)
    expect(compareVersions('3.10.0', '3.2.0')).toBeGreaterThan(0)
    expect(compareVersions('2.29.9', '2.30.0')).toBeLessThan(0)
  })
})
