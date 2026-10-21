import type { CliContext } from './context.ts'
import type { InspectionChange, PushInspection } from './inspect.ts'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { escapeHtml, renderDiffHtml, textDiff } from './diff-page.ts'
import { inspectGit } from './inspect-git.ts'
import { CHANGE_LABELS, compactBytes, describeSizeChange, exceededReasons } from './inspect.ts'

/** Rows rendered in the dialog; the terminal report and JSON carry the rest. */
const DIALOG_ROWS = 300

/** Shared column widths for the fixed header table and the scrolling body table. */
const COLUMNS = '<colgroup><col class="c-status"><col><col class="c-diff"><col class="c-push"></colgroup>'

/** Look of the report page; follows the system light/dark appearance. */
const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #6e6e73; --line: rgba(0,0,0,.08); --card: rgba(0,0,0,.04); --track: rgba(0,0,0,.08);
  --accent: #0a84ff; --over: #e5484d; --added: #1f9d55; --modified: #0a7cff; --deleted: #d93f3f; --transient: #8e4ec6; }
@media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #98989d; --line: rgba(255,255,255,.1); --card: rgba(255,255,255,.06); --track: rgba(255,255,255,.12);
  --over: #ff6369; --added: #3dd68c; --modified: #52a9ff; --deleted: #ff6b6b; --transient: #bf7af0; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
body { font: 12px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; color: var(--fg); padding: 2px 2px 0; -webkit-user-select: text;
  display: flex; flex-direction: column; }
/* Budgets, summary, column titles and notes stay put; only the file list scrolls. Both tables
   reserve the same scrollbar gutter so their columns line up. */
.columns, .list { scrollbar-gutter: stable; }
.meters, .caption, .columns, .notes { flex: none; }
.columns { overflow-y: hidden; }
.list { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 8px; }
.meters { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.meter { background: var(--card); border-radius: 8px; padding: 8px 10px; }
.meter .label { color: var(--muted); display: flex; justify-content: space-between; }
.meter .label b { color: var(--over); font-weight: 600; }
.meter .value { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; margin: 1px 0 5px; }
.meter .value span { font-size: 12px; font-weight: 400; color: var(--muted); }
.meter.over .value { color: var(--over); }
.track { height: 5px; border-radius: 3px; background: var(--track); overflow: hidden; }
.track div { height: 100%; border-radius: 3px; background: var(--accent); }
.meter.over .track div { background: var(--over); }
.meter .note { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 11px; margin-top: 4px; }
.caption { display: flex; align-items: baseline; gap: 8px; margin: 14px 2px 6px; color: var(--muted); }
.caption strong { color: var(--fg); font-size: 13px; }
.caption .spacer { flex: 1; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; }
th { text-align: left; font-weight: 500; color: var(--muted); font-size: 11px; padding: 4px 6px; border-bottom: 1px solid var(--line); }
.c-status { width: 46px; } .c-diff { width: 210px; } .c-push { width: 120px; }
td { padding: 5px 6px; border-bottom: 1px solid var(--line); vertical-align: middle; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.path { display: flex; align-items: center; white-space: nowrap; min-width: 0; }
.path .dir { color: var(--muted); overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 2em; }
.path .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; flex: 0 0 auto; max-width: 75%; }
.path .tag { flex: none; }
.diff { color: var(--muted); font-size: 11px; }
.push span { font-weight: 600; }
.bar { height: 3px; margin-top: 3px; border-radius: 2px; background: var(--track); }
.bar div { height: 100%; margin-left: auto; border-radius: 2px; background: var(--accent); opacity: .7; }
tr.over .bar div { background: var(--over); opacity: 1; }
i { font-style: normal; }
.badge { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 11px; font-weight: 600; color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent); }
.badge.added { --c: var(--added); } .badge.modified { --c: var(--modified); } .badge.deleted { --c: var(--deleted); } .badge.transient { --c: var(--transient); }
.tag { margin-left: 6px; padding: 0 5px; border-radius: 4px; font-size: 10px; color: var(--muted); border: 1px solid var(--line); }
.tag.over { color: var(--over); border-color: var(--over); }
.empty { text-align: center; color: var(--muted); padding: 18px; }
/* A previewable row is one link stretched over the whole row; clicking it opens Quick Look.
   WebKit ignores position: relative on table rows, but a transform makes the row contain the link. */
tr.preview { transform: translate(0); }
tr.preview:hover td { background: var(--card); }
a.path { color: inherit; text-decoration: none; cursor: default; }
a.path::after { content: ""; position: absolute; inset: 0; }
a.path:focus-visible { outline: none; }
tr.preview:has(a.path:focus-visible) td { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.notes { margin: 8px 2px 0; padding-left: 16px; color: var(--muted); font-size: 11px; }
`

/**
 * JXA run through `osascript`: a native alert with the HTML report embedded, so it needs
 * no app bundle. argv: title, reasons, web view height, optional snapshot path (debug aid:
 * capture the window to a PNG, then cancel), JSON `{ root, web, preview }` for the link
 * buttons and row previews. stdin: the HTML. Prints `continue` or `cancel`. The link
 * buttons open Finder, an editor, the remote's web page or the YunBox client without
 * closing the alert.
 *
 * Previews need no script in the page: a previewable row is a `target="_blank"` link to
 * `yunbox-preview:<row>`, which WebKit hands to the UI delegate as a new-window request.
 * The delegate opens no window; it copies the row's versions (`preview.items[row]`) from
 * the LFS store or `git cat-file` into `preview.dir` and shows them in Quick Look, along
 * with a diff page already written there for text files. The directory is removed when
 * the alert closes.
 */
const DIALOG_SCRIPT = `
ObjC.import('Cocoa')
ObjC.import('WebKit')
ObjC.import('CoreGraphics')
function run(argv) {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
  const html = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)
  const app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
  const alert = $.NSAlert.alloc.init
  alert.alertStyle = $.NSAlertStyleWarning
  alert.icon = $.NSImage.imageNamed('NSCaution')
  alert.messageText = argv[0]
  alert.informativeText = argv[1]
  alert.addButtonWithTitle('取消')
  alert.addButtonWithTitle('继续推送').hasDestructiveAction = true
  const height = Number(argv[2])
  const web = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 0, 760, height), $.WKWebViewConfiguration.alloc.init)
  web.setValueForKey(false, 'drawsBackground')
  web.loadHTMLStringBaseURL(html, $.nil)
  const links = JSON.parse(argv[4] || '{}')
  const preview = links.preview
  let previewer
  if (preview) {
    ObjC.import('Quartz')
    const files = $.NSFileManager.defaultManager
    let items = []
    ObjC.registerSubclass({ name: 'YunBoxPreviewItems', protocols: ['QLPreviewPanelDataSource'], methods: {
      'numberOfPreviewItemsInPreviewPanel:': { types: ['long', ['id']], implementation: () => items.length },
      'previewPanel:previewItemAtIndex:': { types: ['id', ['id', 'long']], implementation: (panel, index) => items[index] },
    } })
    const source = $.YunBoxPreviewItems.alloc.init
    // The pushed version, not the worktree file: they can differ.
    const extract = (version, folder) => {
      const path = folder.stringByAppendingPathComponent(version.name)
      if (files.fileExistsAtPath(path))
        return path
      // Pages written before the dialog opened (a text diff) have no object to extract.
      if (!version.oid)
        return undefined
      if (preview.lfs) {
        const stored = $(preview.lfs).stringByAppendingPathComponent([version.oid.slice(0, 2), version.oid.slice(2, 4), version.oid].join('/'))
        if (files.fileExistsAtPath(stored))
          return files.copyItemAtPathToPathError(stored, path, null) ? path : undefined
      }
      if (!files.createFileAtPathContentsAttributes(path, $.NSData.data, $.nil))
        return undefined
      const output = $.NSFileHandle.fileHandleForWritingAtPath(path)
      const task = $.NSTask.alloc.init
      task.executableURL = $.NSURL.fileURLWithPath('/usr/bin/env')
      task.arguments = $(['git', 'cat-file', 'blob', version.oid])
      task.standardOutput = output
      task.standardError = $.NSFileHandle.fileHandleWithNullDevice
      let done = task.launchAndReturnError(null)
      if (done) {
        task.waitUntilExit
        done = task.terminationStatus === 0
      }
      output.closeFile
      if (done)
        return path
      files.removeItemAtPathError(path, null)
    }
    ObjC.registerSubclass({ name: 'YunBoxPreview', methods: {
      'webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:': { types: ['id', ['id', 'id', 'id', 'id']], implementation: (view, configuration, action) => {
        const row = /^yunbox-preview:(\\d+)$/.exec(ObjC.unwrap(action.request.URL.absoluteString))?.[1]
        const versions = row === undefined ? undefined : preview.items[Number(row)]
        if (versions) {
          const folder = $(preview.dir).stringByAppendingPathComponent(row)
          files.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(folder, true, $.nil, null)
          items = versions.map(version => extract(version, folder)).filter(Boolean).map(path => $.NSURL.fileURLWithPath(path))
          if (items.length) {
            const panel = $.QLPreviewPanel.sharedPreviewPanel
            panel.dataSource = source
            panel.reloadData
            // Start on the last item: the diff of a text file, else the pushed version; the left arrow steps back.
            panel.currentPreviewItemIndex = items.length - 1
            // The alert is modal; without this the panel would not take the arrow keys or Esc.
            panel.worksWhenModal = true
            panel.makeKeyAndOrderFront($.nil)
          }
          else {
            $.NSBeep()
          }
        }
        // Never a new window: the click only previews.
        return $.nil
      } },
    } })
    previewer = $.YunBoxPreview.alloc.init
    web.UIDelegate = previewer
  }
  const workspace = $.NSWorkspace.sharedWorkspace
  const installed = id => { const url = workspace.URLForApplicationWithBundleIdentifier(id); return url.isNil() ? undefined : url }
  const openWith = (url, application) => workspace.openURLsWithApplicationAtURLConfigurationCompletionHandler($([url]), application, $.NSWorkspaceOpenConfiguration.configuration, $.nil)
  const actions = []
  if (links.root) {
    const folder = $.NSURL.fileURLWithPath(links.root)
    actions.push(['在 Finder 中显示', () => workspace.activateFileViewerSelectingURLs($([folder]))])
    const editor = ['com.todesktop.230313mzl4w4u92', 'com.microsoft.VSCode', 'dev.zed.Zed', 'com.sublimetext.4'].map(installed).find(Boolean)
    if (editor)
      actions.push([\`在 \${ObjC.unwrap(editor.URLByDeletingPathExtension.lastPathComponent)} 中打开\`, () => openWith(folder, editor)])
    const client = installed('fun.yunle.yunbox.desktop')
    if (client)
      actions.push(['在 YunBox 中查看完整信息', () => openWith(folder, client)])
  }
  if (links.web)
    actions.push(['打开远端仓库', () => workspace.openURL($.NSURL.URLWithString(links.web))])
  if (actions.length) {
    ObjC.registerSubclass({ name: 'YunBoxLinks', methods: { 'perform:': { types: ['void', ['id']], implementation: function (sender) { actions[sender.tag][1]() } } } })
    const target = $.YunBoxLinks.alloc.init
    const row = $.NSStackView.alloc.initWithFrame($.NSMakeRect(0, height + 8, 760, 24))
    row.spacing = 6
    row.alignment = $.NSLayoutAttributeCenterY
    actions.forEach(([label], index) => {
      const button = $.NSButton.buttonWithTitleTargetAction(label, target, 'perform:')
      button.controlSize = $.NSControlSizeSmall
      button.font = $.NSFont.systemFontOfSize($.NSFont.smallSystemFontSize)
      button.tag = index
      row.addArrangedSubview(button)
    })
    row.addArrangedSubview($.NSView.alloc.init)
    const box = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, 760, height + 36))
    box.addSubview(web)
    box.addSubview(row)
    alert.accessoryView = box
  }
  else {
    alert.accessoryView = web
  }
  if (argv[3]) {
    ObjC.registerSubclass({ name: 'YunBoxSnapshot', methods: { 'capture:': { types: ['void', ['id']], implementation: function () {
      const image = $.CGWindowListCreateImage($.CGRectNull, $.kCGWindowListOptionIncludingWindow, alert.window.windowNumber, $.kCGWindowImageBoundsIgnoreFraming)
      $.NSBitmapImageRep.alloc.initWithCGImage(image).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).writeToFileAtomically(argv[3], true)
      app.abortModal
    } } } })
    const timer = $.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(1.5, $.YunBoxSnapshot.alloc.init, 'capture:', $.nil, false)
    $.NSRunLoop.currentRunLoop.addTimerForMode(timer, $.NSModalPanelRunLoopMode)
  }
  app.activateIgnoringOtherApps(true)
  const answer = alert.runModal
  if (preview) {
    if ($.QLPreviewPanel.sharedPreviewPanelExists)
      $.QLPreviewPanel.sharedPreviewPanel.orderOut($.nil)
    $.NSFileManager.defaultManager.removeItemAtPathError(preview.dir, null)
  }
  return answer === $.NSAlertSecondButtonReturn ? 'continue' : 'cancel'
}
`

/** One version of a changed file that the dialog can show in Quick Look. */
export interface PreviewVersion {
  /** `afterOid` or `beforeOid` of the change: an LFS payload or a Git blob. */
  oid: string
  /** File name Quick Look shows as the title; never contains `/`. */
  name: string
}

/**
 * Versions to preview for a change: before and after for a modification (before first, so
 * the arrow keys step through time), only the pushed version otherwise, nothing when the
 * path is gone at the pushed tip.
 */
export function previewVersions(change: InspectionChange): PreviewVersion[] {
  const valid = (oid: string | null): oid is string => oid !== null && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)
  if (!valid(change.afterOid))
    return []
  const name = visible(change.path.slice(change.path.lastIndexOf('/') + 1))
  if (change.status !== 'modified')
    return [{ oid: change.afterOid, name: fileName(name) }]
  return [
    ...(valid(change.beforeOid) ? [{ oid: change.beforeOid, name: fileName(name, '推送前') }] : []),
    { oid: change.afterOid, name: fileName(name, '推送后') },
  ]
}

/** `name（tag）.ext`, kept under the 255-byte file name limit. */
function fileName(name: string, tag?: string): string {
  const extension = /\.[^.\s]{1,16}$/.exec(name)?.[0] ?? ''
  let stem = [...name.slice(0, name.length - extension.length)]
  while (Buffer.byteLength(stem.join('')) > 180)
    stem = stem.slice(0, -1)
  const result = `${stem.join('')}${tag ? `（${tag}）` : ''}${extension}`
  return result === '' || result === '.' || result === '..' ? `file${result}` : result
}

/** A Quick Look item of a row: a version to extract, or a page already in the row's folder. */
type PreviewItem = PreviewVersion | { name: string }

/** Text files diffed before the dialog opens, at most; later rows keep their two versions. */
const DIFF_PAGES = 100

/**
 * Write a diff page for each modified text file among the listed rows into `dir/<row>/`
 * and add it after the row's versions, so Quick Look opens on the diff.
 */
async function addDiffPages(context: CliContext, dir: string, shown: InspectionChange[], items: PreviewItem[][]): Promise<void> {
  const rows = shown.map((change, index) => ({ change, index })).filter(({ change }) => change.status === 'modified' && change.storage === 'git').slice(0, DIFF_PAGES)
  for (let offset = 0; offset < rows.length; offset += 8) {
    await Promise.all(rows.slice(offset, offset + 8).map(async ({ change, index }) => {
      const diff = await textDiff(context, change)
      if (diff === undefined)
        return
      const name = fileName(`${visible(change.path.slice(change.path.lastIndexOf('/') + 1))}.html`, '差异')
      await mkdir(join(dir, String(index)), { recursive: true })
      await writeFile(join(dir, String(index), name), renderDiffHtml(visible(change.path), diff))
      items[index]!.push({ name })
    }))
  }
}

/** Both ends of a push, as the confirmation names and links them. */
interface PushEnds {
  /** Repository root, for Finder, the editor and the YunBox client. */
  root: string
  /** `本地仓库 name（branch）`. */
  source: string
  /** Credential-free remote name, e.g. `github.com/owner/repo`. */
  target?: string
  /** The remote's probable web page. */
  web?: string
}

/** How the push confirmation is asked, from `YUNBOX_CONFIRM_UI`. */
type ConfirmUi = 'auto' | 'dialog' | 'terminal' | 'none'

/**
 * Credential-free parts of a URL or scp-style remote; undefined for remote names and
 * local paths. `web` is the forge page guessed from it (`https://host/owner/repo`).
 */
function parseRemote(remote: string): { name: string, web?: string } | undefined {
  let host: string
  let path: string
  let web: string | undefined
  try {
    const url = new URL(remote)
    if (url.protocol === 'file:' || !url.host)
      return undefined
    host = url.host
    path = url.pathname
    // HTTP remotes keep their port; SSH ports are not where the forge serves pages.
    web = url.protocol === 'http:' || url.protocol === 'https:' ? `${url.protocol}//${url.host}` : url.protocol === 'ssh:' || url.protocol === 'git:' ? `https://${url.hostname}` : undefined
  }
  catch {
    // `user@host:path`; a one-letter "host" is a Windows drive.
    const scp = /^(?:[^@/]+@)?([^:/\\]{2,}):(?!\/\/)(.+)$/.exec(remote)
    if (!scp)
      return undefined
    host = scp[1]!
    // URL paths arrive percent-encoded; encode scp paths to match.
    path = encodeURI(scp[2]!)
    web = `https://${host}`
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
  let name = `${host}/${path}`
  try {
    name = decodeURI(name)
  }
  catch {}
  // The name reaches the terminal prompt: never let it carry escape sequences.
  return { name: visible(name), web: web && path ? `${web}/${path}` : undefined }
}

/**
 * A short, credential-free name for a remote: `github.com/owner/repo` for URLs and
 * scp-style addresses, the value itself for remote names and local paths.
 */
export function describeRemote(remote: string | undefined): string | undefined {
  return remote ? parseRemote(remote)?.name ?? remote : undefined
}

/** The web page a remote probably has (`https://github.com/owner/repo`), if it is a URL. */
export function remoteWebUrl(remote: string | undefined): string | undefined {
  return remote ? parseRemote(remote)?.web : undefined
}

/**
 * Which local repository and refs a push comes from, e.g. `本地仓库 yunbox（main）`.
 * `updates` are pre-push lines; without them `branch` names what is inspected.
 */
export function describeSource(root: string, options: { updates?: string, branch?: string } = {}): string {
  const short = (ref: string): string => ref.startsWith('refs/heads/') ? ref.slice(11) : ref.startsWith('refs/tags/') ? `标签 ${ref.slice(10)}` : ref
  const refs = options.updates === undefined
    ? options.branch ? [options.branch] : []
    : options.updates.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(fields => fields.length === 4 && !/^0+$/.test(fields[1]!)).map(([local, , remote]) => short(local!) === short(remote!) ? short(local!) : `${short(local!)} → ${short(remote!)}`)
  const unique = [...new Set(refs)]
  const listed = unique.length > 3 ? `${unique.slice(0, 3).join('、')} 等 ${unique.length} 个引用` : unique.join('、')
  return `本地仓库 ${basename(root)}${listed ? `（${visible(listed)}）` : ''}`
}

/** Self-contained report page for the confirmation dialog: no scripts, no network. */
export function renderConfirmationHtml(report: PushInspection): string {
  const { changes, shown } = listedChanges(report)
  const hidden = changes.slice(DIALOG_ROWS)
  const largest = Math.max(1, ...shown.map(change => change.pushBytes))
  // LFS objects already in COS are not uploaded, so they do not count towards the per-file budget.
  const largestFile = Math.max(0, ...[...report.git.files, ...report.lfs.files].filter(file => !file.onRemote).map(file => file.bytes))
  const counts = (['added', 'modified', 'deleted', 'transient'] as const)
    .map(status => [status, changes.filter(change => change.status === status).length] as const)
    .filter(([, count]) => count > 0)
  const meters = [
    meter('Git pack', report.git.packComplete ? report.git.packBytes : report.git.packCapBytes, report.limits.gitBytes, report.git.exceedsLimit, report.git.packComplete ? '压缩后预计上传' : '估算已截断，实际更大', !report.git.packComplete),
    report.lfs.uploadBytes === null
      ? meter('LFS 候选', report.lfs.candidateBytes, report.limits.lfsBytes, report.lfs.exceedsLimit, `${report.lfs.candidateCount} 个素材，远端已有的会跳过`)
      : meter('LFS 上传', report.lfs.uploadBytes, report.limits.lfsBytes, report.lfs.exceedsLimit, `${report.lfs.files.filter(file => !file.onRemote).length} 个素材，${report.lfs.files.filter(file => file.onRemote).length} 个已在 COS`),
    meter('最大单文件', largestFile, report.limits.fileBytes, [...report.git.files, ...report.lfs.files].some(file => file.exceedsFileLimit), '原始大小'),
  ]
  const rows = shown.map((change, index) => row(change, largest, previewVersions(change).length ? index : undefined)).join('')
  const previewable = shown.some(change => previewVersions(change).length)
  const unpathed = [...report.git.files, ...report.lfs.files].filter(file => file.paths.length === 0)
  const notes = [
    ...report.warnings,
    ...(hidden.length ? [`另有 ${hidden.length} 个文件（合计 ${compactBytes(hidden.reduce((sum, change) => sum + change.pushBytes, 0))}）未列出，完整明细见 yunbox inspect --push --json`] : []),
    ...(unpathed.length ? [`${unpathed.length} 个对象无法确定路径，未列在表中`] : []),
    '「本次上传」是文件原始大小，Git 会压缩和增量传输；同一文件的每个历史版本分别统计。',
  ]
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>${STYLE}</style></head><body>
<section class="meters">${meters.join('')}</section>
<div class="caption"><strong>变更文件</strong><span>${changes.length} 个文件${counts.map(([status, count]) => ` · <i class="badge ${status}">${CHANGE_LABELS[status]}</i> ${count}`).join('')}</span><span class="spacer"></span><span>${previewable ? '点击文件预览 · ' : ''}按本次上传大小排序</span></div>
<div class="columns"><table>${COLUMNS}<thead><tr><th>状态</th><th>文件</th><th class="num">大小变化</th><th class="num">本次上传</th></tr></thead></table></div>
<div class="list"><table>${COLUMNS}<tbody>${rows || '<tr><td colspan="4" class="empty">没有新的文件内容</td></tr>'}</tbody></table></div>
<ul class="notes">${notes.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul>
</body></html>
`
}

/**
 * Ask whether to push despite an exceeded budget: a native dialog on macOS, else the
 * controlling terminal. Blocks (returns false) when nobody can be asked.
 */
export async function confirmPush(context: CliContext, report: PushInspection, options: { remote?: string, updates?: string, head?: string } = {}): Promise<boolean> {
  return await askPush(context, report, options) === 'continue'
}

/**
 * Like {@link confirmPush}, but tells a “cancel” answer apart from nobody being
 * asked (`undefined`, after explaining why on stderr).
 */
export async function askPush(context: CliContext, report: PushInspection, options: { remote?: string, updates?: string, head?: string } = {}): Promise<'continue' | 'cancel' | undefined> {
  const ui = confirmUi(context.env)
  const push = await describePush(context, options)
  const { source, target } = push
  const answered = (answer: boolean): 'continue' | 'cancel' => answer ? 'continue' : 'cancel'
  if (ui === 'dialog' || (ui === 'auto' && process.platform === 'darwin' && !context.env.SSH_CONNECTION)) {
    const answer = await askDialog(context, report, push)
    if (answer !== undefined)
      return answered(answer)
  }
  if (ui !== 'none') {
    const answer = await askTerminal(`\n${source}${target ? ` 推送到 ${target}` : ''}：超过限额，仍要继续推送吗？[y/N] `)
    if (answer !== undefined)
      return answered(answer)
  }
  context.stderr.write('无法请求确认：没有可用的对话框或交互式终端。可提高限额（yunbox inspect --help）后重试。\n')
  return undefined
}

/**
 * Name both ends of the push. `context.cwd` is the repository root. Without `--remote`
 * (a manual check), the target is the current branch's upstream remote, if any.
 */
async function describePush(context: CliContext, options: { remote?: string, updates?: string, head?: string }): Promise<PushEnds> {
  const git = async (args: string[]): Promise<string | undefined> => {
    try {
      return (await inspectGit(context, args)).output.toString('utf8').trim() || undefined
    }
    catch {
      return undefined
    }
  }
  const branch = options.updates === undefined ? options.head ?? await git(['symbolic-ref', '--short', '-q', 'HEAD']) : undefined
  let remote = options.remote
  if (remote === undefined && options.updates === undefined && options.head === undefined && branch) {
    const name = await git(['config', '--get', `branch.${branch}.remote`])
    remote = name && name !== '.' ? name : undefined
  }
  // A remote name (`origin`) is shown as its URL so the dialog says where it really goes.
  if (remote !== undefined && !parseRemote(remote) && /^[\w.-]+$/.test(remote))
    remote = await git(['remote', 'get-url', '--', remote]) ?? remote
  return { root: context.cwd, source: describeSource(context.cwd, { updates: options.updates, branch }), target: describeRemote(remote), web: remoteWebUrl(remote) }
}

function confirmUi(env: NodeJS.ProcessEnv): ConfirmUi {
  const value = env.YUNBOX_CONFIRM_UI
  return value === 'dialog' || value === 'terminal' || value === 'none' ? value : 'auto'
}

/** Changes with uploaded content, and the ones the dialog lists. */
function listedChanges(report: PushInspection): { changes: InspectionChange[], shown: InspectionChange[] } {
  const changes = report.changes.filter(change => change.versions > 0)
  return { changes, shown: changes.slice(0, DIALOG_ROWS) }
}

async function askDialog(context: CliContext, report: PushInspection, push: PushEnds): Promise<boolean | undefined> {
  const { shown } = listedChanges(report)
  const height = Math.min(560, Math.max(300, 210 + shown.length * 29))
  const title = push.target ? `推送到 ${push.target} 超过限额` : '推送超过限额'
  const info = [push.source, ...exceededReasons(report)].join('\n')
  const items: PreviewItem[][] = shown.map(previewVersions)
  // Private (0700) and removed when the dialog closes; the dialog removes it too.
  const dir = items.some(versions => versions.length) ? await mkdtemp(join(tmpdir(), 'yunbox-preview-')) : undefined
  try {
    if (dir)
      await addDiffPages(context, dir, shown, items)
    const preview = dir && { dir, lfs: await lfsObjects(context), items }
    const links = JSON.stringify({ root: push.root, web: push.web, preview })
    const args = ['-l', 'JavaScript', '-e', DIALOG_SCRIPT, title, info, String(height), context.env.YUNBOX_CONFIRM_SNAPSHOT ?? '', links]
    // Previews read objects with `git cat-file`: never prompt or fetch for a missing one.
    return await runDialog(args, { ...context.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' }, context.cwd, renderConfirmationHtml(report))
  }
  finally {
    if (dir)
      await rm(dir, { recursive: true, force: true })
  }
}

/** The local LFS object store, `<common git dir>/lfs/objects`. */
async function lfsObjects(context: CliContext): Promise<string | undefined> {
  try {
    const common = (await inspectGit(context, ['rev-parse', '--git-common-dir'])).output.toString('utf8').replace(/\r?\n$/, '')
    return common ? resolve(context.cwd, common, 'lfs', 'objects') : undefined
  }
  catch {
    return undefined
  }
}

function runDialog(args: string[], env: NodeJS.ProcessEnv, cwd: string, html: string): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const child = spawn('osascript', args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stdin.on('error', () => {})
    child.on('error', () => resolve(undefined))
    child.on('close', (code) => {
      const answer = Buffer.concat(chunks).toString('utf8').trim()
      // Anything but a clear answer (no window server, scripting disabled) falls back to the terminal.
      resolve(code === 0 && (answer === 'continue' || answer === 'cancel') ? answer === 'continue' : undefined)
    })
    child.stdin.end(html)
  })
}

/** Ask on the controlling terminal: hook stdin carries ref updates, not the user's keyboard. */
async function askTerminal(question: string): Promise<boolean | undefined> {
  if (process.platform === 'win32')
    return undefined
  let tty
  try {
    tty = await open('/dev/tty', 'r+')
  }
  catch {
    return undefined
  }
  try {
    await tty.write(question)
    const buffer = Buffer.alloc(256)
    let answer = ''
    while (!answer.includes('\n')) {
      const { bytesRead } = await tty.read(buffer, 0, buffer.length, null)
      if (!bytesRead)
        break
      answer += buffer.subarray(0, bytesRead).toString('utf8')
    }
    return /^\s*y(?:es)?\s*$/i.test(answer.split('\n')[0]!)
  }
  catch {
    return undefined
  }
  finally {
    await tty.close()
  }
}

function meter(label: string, value: number, limit: number, exceeded: boolean, note: string, lowerBound = false): string {
  const ratio = limit > 0 ? value / limit : value > 0 ? Infinity : 0
  const percent = Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : '—'
  return `<div class="meter${exceeded ? ' over' : ''}"><div class="label">${escapeHtml(label)}${exceeded ? '<b>超限</b>' : ''}</div>`
    + `<div class="value">${lowerBound ? '&gt; ' : ''}${compactBytes(value)}<span> / ${compactBytes(limit)}</span></div>`
    + `<div class="track"><div style="width:${Math.min(100, ratio * 100).toFixed(1)}%"></div></div>`
    + `<div class="note"><span>${escapeHtml(note)}</span><span>${percent}</span></div></div>`
}

/** One table row; `preview` is the row index the preview link names, if it has versions to show. */
function row(change: InspectionChange, largest: number, preview?: number): string {
  const slash = change.path.lastIndexOf('/')
  const directory = slash < 0 ? '' : change.path.slice(0, slash + 1)
  const name = change.path.slice(slash + 1)
  const tags = [
    change.storage === 'lfs' ? '<i class="tag">LFS</i>' : '',
    change.versions > 1 ? `<i class="tag">${change.versions} 个版本</i>` : '',
    change.exceedsFileLimit ? '<i class="tag over">超限</i>' : '',
  ].join('')
  const hint = change.status === 'transient' ? ' title="在本次推送的提交中新增后又删除，内容仍会上传"' : change.status === 'deleted' && change.pushBytes ? ' title="已删除，但中间的历史版本仍会上传"' : ''
  const classes = [change.exceedsFileLimit ? 'over' : '', preview === undefined ? '' : 'preview'].filter(Boolean).join(' ')
  const path = `<span class="dir">${escapeHtml(visible(directory))}</span><span class="name">${escapeHtml(visible(name))}</span>${tags}`
  const title = escapeHtml(visible(change.path))
  const cell = preview === undefined
    ? `<div class="path" title="${title}">${path}</div>`
    : `<a class="path" href="yunbox-preview:${preview}" target="_blank" title="${title}">${path}</a>`
  return `<tr${classes ? ` class="${classes}"` : ''}><td><i class="badge ${change.status}"${hint}>${CHANGE_LABELS[change.status]}</i></td>`
    + `<td>${cell}</td>`
    + `<td class="num diff">${escapeHtml(describeSizeChange(change))}</td>`
    + `<td class="num push"><span>${compactBytes(change.pushBytes)}</span><div class="bar"><div style="width:${Math.max(2, change.pushBytes / largest * 100).toFixed(1)}%"></div></div></td></tr>`
}

/** Show control characters in file names instead of letting them disappear. */
function visible(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001F\u007F]/g, character => `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`)
}
