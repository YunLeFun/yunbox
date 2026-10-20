import { describe, expect, it } from 'vitest'
import { compareVersions, parseVersion } from './git.ts'
import { mergeGitAttributes, selectCategories } from './gitattributes.ts'
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
})

describe('versions', () => {
  it('parses and compares Git and git-lfs versions', () => {
    expect(parseVersion('git version 2.45.1.windows.1')).toBe('2.45.1')
    expect(compareVersions('3.2.0', '3.2.0')).toBe(0)
    expect(compareVersions('3.10.0', '3.2.0')).toBeGreaterThan(0)
    expect(compareVersions('2.29.9', '2.30.0')).toBeLessThan(0)
  })
})
