import type { PushInspection } from './inspect.ts'
import { describe, expect, it } from 'vitest'
import { describeRemote, describeSource, remoteWebUrl, renderConfirmationHtml } from './confirm.ts'

function report(path: string): PushInspection {
  const file = { oid: 'a'.repeat(40), bytes: 2048, paths: [path], exceedsFileLimit: true }
  return {
    schemaVersion: 1,
    status: 'exceeded',
    limits: { gitBytes: 1024, lfsBytes: 1024, fileBytes: 1024 },
    warnings: ['<warning>'],
    changes: [{ path, status: 'added', storage: 'git', beforeBytes: null, afterBytes: 2048, versions: 1, pushBytes: 2048, exceedsFileLimit: true }],
    git: { packBytes: 4096, packComplete: true, packCapBytes: 10 * 1024 * 1024, exceedsLimit: true, blobBytes: 2048, blobCount: 1, pointerBytes: 0, files: [file] },
    lfs: { candidateBytes: 0, candidateCount: 0, remoteChecked: false, uploadBytes: null, exceedsLimit: false, files: [] },
  }
}

describe('describeRemote', () => {
  it('names URL and scp-style remotes without credentials', () => {
    expect(describeRemote('https://user:secret@github.com/YunLeFun/yunbox.git?x=1')).toBe('github.com/YunLeFun/yunbox')
    expect(describeRemote('git@github.com:YunLeFun/yunbox.git')).toBe('github.com/YunLeFun/yunbox')
    expect(describeRemote('ssh://git@example.com:2222/team/repo/')).toBe('example.com:2222/team/repo')
  })

  it('keeps remote names and local paths as they are', () => {
    expect(describeRemote('origin')).toBe('origin')
    expect(describeRemote('C:\\repos\\remote.git')).toBe('C:\\repos\\remote.git')
    expect(describeRemote(undefined)).toBeUndefined()
  })
})

describe('remoteWebUrl', () => {
  it('guesses the forge page of URL and scp-style remotes', () => {
    expect(remoteWebUrl('https://user:secret@github.com/YunLeFun/yunbox.git?x=1')).toBe('https://github.com/YunLeFun/yunbox')
    expect(remoteWebUrl('git@github.com:YunLeFun/yunbox.git')).toBe('https://github.com/YunLeFun/yunbox')
    expect(remoteWebUrl('ssh://git@example.com:2222/team/repo/')).toBe('https://example.com/team/repo')
    expect(remoteWebUrl('http://localhost:8080/a b/repo.git')).toBe('http://localhost:8080/a%20b/repo')
  })

  it('has none for remote names and local paths', () => {
    expect(remoteWebUrl('origin')).toBeUndefined()
    expect(remoteWebUrl('/srv/git/repo.git')).toBeUndefined()
    expect(remoteWebUrl('file:///srv/git/repo.git')).toBeUndefined()
  })
})

describe('describeSource', () => {
  const zero = '0'.repeat(40)
  const oid = 'a'.repeat(40)

  it('names the repository and the pushed refs', () => {
    const updates = [
      `refs/heads/main ${oid} refs/heads/main ${zero}`,
      `refs/heads/feature ${oid} refs/heads/release ${oid}`,
      `refs/tags/v1 ${oid} refs/tags/v1 ${zero}`,
      `(delete) ${zero} refs/heads/old ${oid}`,
    ].join('\n')
    expect(describeSource('/work/game', { updates })).toBe('本地仓库 game（main、feature → release、标签 v1）')
  })

  it('falls back to the inspected branch', () => {
    expect(describeSource('/work/game', { branch: 'main' })).toBe('本地仓库 game（main）')
    expect(describeSource('/work/game')).toBe('本地仓库 game')
  })
})

describe('renderConfirmationHtml', () => {
  it('escapes file names and warnings and loads nothing external', () => {
    const html = renderConfirmationHtml(report('art/<img src=x onerror=alert(1)>\x1B.png'))
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('\x1B')
    expect(html).toContain('&#60;img src=x onerror=alert(1)&#62;\\x1b.png')
    expect(html).toContain('&#60;warning&#62;')
    expect(html).toContain('default-src \'none\'')
  })

  it('shows the budgets, the change status and the size change', () => {
    const html = renderConfirmationHtml(report('docs/guide.md'))
    expect(html).toContain('4.00 KiB<span> / 1.00 KiB')
    expect(html).toContain('400%')
    expect(html).toContain('<span class="dir">docs/</span><span class="name">guide.md</span>')
    expect(html).toContain('新增')
    expect(html).toContain('无 → 2.00 KiB')
  })

  it('keeps the budgets and column titles out of the scrolling list', () => {
    const html = renderConfirmationHtml(report('docs/guide.md'))
    const list = html.indexOf('<div class="list">')
    expect(list).toBeGreaterThan(html.indexOf('<thead>'))
    expect(list).toBeGreaterThan(html.indexOf('class="meters"'))
    expect(html.slice(list)).toContain('docs/</span>')
  })
})
