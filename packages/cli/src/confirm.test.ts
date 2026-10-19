import type { InspectionChange, PushInspection } from './inspect.ts'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { describeRemote, describeSource, previewVersions, remoteWebUrl, renderConfirmationHtml } from './confirm.ts'

function change(path: string, overrides: Partial<InspectionChange> = {}): InspectionChange {
  return { path, status: 'added', storage: 'git', beforeBytes: null, afterBytes: 2048, beforeOid: null, afterOid: 'a'.repeat(40), versions: 1, pushBytes: 2048, exceedsFileLimit: true, ...overrides }
}

function report(path: string, changes = [change(path)]): PushInspection {
  const file = { oid: 'a'.repeat(40), bytes: 2048, paths: [path], exceedsFileLimit: true }
  return {
    schemaVersion: 1,
    status: 'exceeded',
    limits: { gitBytes: 1024, lfsBytes: 1024, fileBytes: 1024 },
    warnings: ['<warning>'],
    changes,
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

  it('links rows with a pushed version to their preview, and only those', () => {
    const html = renderConfirmationHtml(report('art/logo.png', [
      change('art/logo.png', { status: 'modified', beforeOid: 'b'.repeat(64), afterOid: 'c'.repeat(64), storage: 'lfs' }),
      change('art/old.png', { status: 'deleted', afterBytes: null, afterOid: null }),
      change('art/<b>.png'),
    ]))
    expect(html).toContain('<tr class="over preview"><td><i class="badge modified">修改</i></td><td><a class="path" href="yunbox-preview:0" target="_blank" title="art/logo.png">')
    expect(html).toContain('<div class="path" title="art/old.png">')
    expect(html).toContain('href="yunbox-preview:2" target="_blank" title="art/&#60;b&#62;.png"><span class="dir">art/</span><span class="name">&#60;b&#62;.png</span>')
    expect(html).toContain('点击文件预览')
    // Still no script and nothing to load: the click goes to the dialog's UI delegate.
    expect(html).not.toContain('<script')
    expect(html).toContain('content="default-src \'none\'; style-src \'unsafe-inline\'"')
    expect(renderConfirmationHtml(report('a.bin', [change('a.bin', { status: 'deleted', afterOid: null })]))).not.toContain('点击文件预览')
  })
})

describe('previewVersions', () => {
  it('shows a modification before and after, and the pushed version otherwise', () => {
    const before = 'b'.repeat(64)
    const after = 'c'.repeat(40)
    expect(previewVersions(change('art/logo.png', { status: 'modified', beforeOid: before, afterOid: after }))).toEqual([
      { oid: before, name: 'logo（推送前）.png' },
      { oid: after, name: 'logo（推送后）.png' },
    ])
    expect(previewVersions(change('art/logo.png', { status: 'modified', beforeOid: null, afterOid: after }))).toEqual([{ oid: after, name: 'logo（推送后）.png' }])
    expect(previewVersions(change('README', { afterOid: after }))).toEqual([{ oid: after, name: 'README' }])
    expect(previewVersions(change('gone.png', { status: 'deleted', afterOid: null }))).toEqual([])
    expect(previewVersions(change('scratch.png', { status: 'transient', afterOid: null }))).toEqual([])
  })

  it('never passes on a malformed oid or an unsafe file name', () => {
    expect(previewVersions(change('a.png', { afterOid: '../../etc/passwd' }))).toEqual([])
    expect(previewVersions(change('dir/..', { afterOid: 'a'.repeat(40) }))[0]!.name).toBe('file..')
    expect(previewVersions(change('x/\x1B[31m.png', { afterOid: 'a'.repeat(40) }))[0]!.name).toBe('\\x1b[31m.png')
    const long = previewVersions(change(`${'素'.repeat(200)}.png`, { status: 'modified', beforeOid: 'a'.repeat(40) }))
    for (const { name } of long) {
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255)
      expect(name.endsWith('.png')).toBe(true)
    }
  })
})
