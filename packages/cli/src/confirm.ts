import type { CliContext } from './context.ts'
import type { InspectionChange, PushInspection } from './inspect.ts'
import type { PushEnds } from './push-context.ts'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { escapeHtml, renderDiffHtml, textDiff } from './diff-page.ts'
import { readGitConfig } from './git.ts'
import { inspectGit } from './inspect-git.ts'
import { CHANGE_LABELS, compactBytes, describeSizeChange, exceededReasons } from './inspect.ts'
import { describePush } from './push-context.ts'
import { readTerminalLine } from './terminal-input.ts'
import { terminalFor } from './terminal.ts'

export { describeRemote, describeSource, remoteWebUrl } from './push-context.ts'

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
 * JXA run through `osascript`: a native panel with the HTML report embedded, so it needs
 * no app bundle. argv: title, reasons, web view height, optional snapshot path (debug aid:
 * capture the window to a PNG, then cancel), JSON `{ root, web, preview }` for the link
 * buttons and row previews. stdin: the HTML. Prints `continue` or `cancel`, then on the next line the note typed
 * under the report (may be empty). The link
 * buttons open Finder, an editor, the remote's web page or the YunBox client without
 * closing the panel.
 *
 * Previews need no script in the page: a previewable row is a `target="_blank"` link to
 * `yunbox-preview:<row>`, which WebKit hands to the UI delegate as a new-window request.
 * The delegate opens no window; it copies the row's versions (`preview.items[row]`) from
 * the LFS store or `git cat-file` into `preview.dir` and shows them in Quick Look, along
 * with a text diff requested from the CLI only for the selected row. The directory
 * is removed when the panel closes.
 */
const DIALOG_SCRIPT = `
ObjC.import('AppKit')
ObjC.import('WebKit')
function run(argv) {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
  const html = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)
  const app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
  const height = Number(argv[2])
  const links = JSON.parse(argv[4] || '{}')
  const preview = links.preview
  // The panel runs without a modal session: in one, AppKit drops every click on the Quick Look
  // panel (it never works when modal), so its close button did nothing. The buttons answer instead.
  // The index of the chosen button: 0 取消, 1 继续推送.
  let answer
  const finish = (value) => {
    answer = value
    app.stop($.nil)
    // stop takes effect after the next event; post one so run returns now.
    app.postEventAtStart($.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2($.NSEventTypeApplicationDefined, $.NSZeroPoint, 0, 0, 0, $.nil, 0, 0, 0), true)
  }
  let previewLoaded = false
  const dismissPreview = () => {
    if (previewLoaded && $.QLPreviewPanel.sharedPreviewPanelExists && $.QLPreviewPanel.sharedPreviewPanel.isVisible) {
      $.QLPreviewPanel.sharedPreviewPanel.orderOut($.nil)
      return true
    }
    return false
  }
  ObjC.registerSubclass({ name: 'YunBoxConfirmation', superclass: 'NSPanel', methods: {
    'cancelOperation:': { types: ['void', ['id']], implementation: () => { if (!dismissPreview()) finish(0) } }
  } })
  ObjC.registerSubclass({ name: 'YunBoxAnswer', protocols: ['NSWindowDelegate'], methods: {
    'windowWillClose:': { types: ['void', ['id']], implementation: () => finish(0) },
    'choose:': { types: ['void', ['id']], implementation: (sender) => {
    // A keyboard answer closes an open preview first; a mouse click still answers the push.
    // The button acts on key up, so check for either key event.
    const type = app.currentEvent.type
    const keyed = type === $.NSEventTypeKeyDown || type === $.NSEventTypeKeyUp
    if (keyed && dismissPreview()) {
      return
    }
    // JXA hands NSInteger back as a string.
    finish(Number(sender.tag))
  } } } })
  const chooser = $.YunBoxAnswer.alloc.init
  const buttons = ['取消', '继续推送'].map(title => $.NSButton.buttonWithTitleTargetAction(title, chooser, 'choose:'))
  for (let index = 0; index < buttons.length; index++) {
    const button = buttons[index]
    button.tag = index
    button.bezelStyle = $.NSBezelStyleRounded
    button.setFrame($.NSMakeRect(index === 0 ? 596 : 688, 16, index === 0 ? 80 : 96, 32))
  }
  buttons[0].keyEquivalent = '\\r'
  buttons[1].hasDestructiveAction = true
  // An optional note under the report, answered by either button: typing it is the only extra step.
  const note = $.NSTextField.alloc.initWithFrame($.NSMakeRect(0, 0, 760, 24))
  note.placeholderString = '原因（可选）：为什么取消或继续推送，会转告发起推送的人或 AI'
  note.bezelStyle = $.NSTextFieldRoundedBezel
  note.setAccessibilityLabel('推送原因')
  note.cell.usesSingleLineMode = true
  note.cell.scrollable = true
  const setupEditing = () => {
    // An accessory app has no menu bar; without an Edit menu, ⌘V / ⌘C / ⌘A do nothing in the field or the report.
    const menu = $.NSMenu.alloc.init
    const edit = $.NSMenu.alloc.initWithTitle('编辑')
    ;[['撤销', 'undo:', 'z'], ['重做', 'redo:', 'Z'], ['剪切', 'cut:', 'x'], ['拷贝', 'copy:', 'c'], ['粘贴', 'paste:', 'v'], ['全选', 'selectAll:', 'a']]
      .forEach(([title, action, key]) => edit.addItemWithTitleActionKeyEquivalent(title, action, key))
    menu.addItemWithTitleActionKeyEquivalent('编辑', $.nil, '').submenu = edit
    app.mainMenu = menu
  }
  const accessory = $.NSView.alloc.initWithFrame($.NSMakeRect(0, 0, 760, height + 32))
  accessory.addSubview(note)
  const loading = $.NSTextField.labelWithString('正在加载文件列表…')
  loading.textColor = $.NSColor.secondaryLabelColor
  loading.setFrame($.NSMakeRect(16, 32 + height / 2, 728, 24))
  accessory.addSubview(loading)
  let previewer
  let previewTimer
  let navigation
  const setupReport = () => {
    const web = $.WKWebView.alloc.initWithFrameConfiguration($.NSMakeRect(0, 32, 760, height), $.WKWebViewConfiguration.alloc.init)
    web.setValueForKey(false, 'drawsBackground')
    if (preview) {
      const files = $.NSFileManager.defaultManager
      let items = []
      let source
      const ensurePreview = () => {
        if (previewLoaded) return
        ObjC.import('Quartz')
        ObjC.registerSubclass({ name: 'YunBoxPreviewItems', protocols: ['QLPreviewPanelDataSource'], methods: {
          'numberOfPreviewItemsInPreviewPanel:': { types: ['long', ['id']], implementation: () => items.length },
          'previewPanel:previewItemAtIndex:': { types: ['id', ['id', 'long']], implementation: (panel, index) => items[index] },
        } })
        source = $.YunBoxPreviewItems.alloc.init
        previewLoaded = true
      }
      // The pushed version, not the worktree file: they can differ.
      const extract = (version, folder) => {
        const path = folder.stringByAppendingPathComponent(version.name)
        if (files.fileExistsAtPath(path))
          return path
        // A generated text diff has no object to extract.
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
      let waiting
      ObjC.registerSubclass({ name: 'YunBoxPreviewReady', methods: { 'check:': { types: ['void', ['id']], implementation: () => {
        if (!waiting)
          return
        const data = files.contentsAtPath(waiting.stringByAppendingPathComponent('diff.json'))
        if (data.isNil())
          return
        let result
        try { result = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding))) }
        catch (_) { return }
        previewTimer.invalidate
        if (result.name && $.QLPreviewPanel.sharedPreviewPanelExists) {
          const panel = $.QLPreviewPanel.sharedPreviewPanel
          const path = waiting.stringByAppendingPathComponent(result.name)
          if (panel.isVisible && files.fileExistsAtPath(path)) {
            const last = items.length - 1
            const selected = Number(panel.currentPreviewItemIndex)
            items.push($.NSURL.fileURLWithPath(path))
            panel.reloadData
            // Show the diff unless the user has already stepped back to the old version.
            panel.currentPreviewItemIndex = selected === last ? items.length - 1 : selected
          }
        }
        waiting = undefined
      } } } })
      const poller = $.YunBoxPreviewReady.alloc.init
      ObjC.registerSubclass({ name: 'YunBoxPreview', methods: {
        'webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:': { types: ['id', ['id', 'id', 'id', 'id']], implementation: (view, configuration, action) => {
          const row = /^yunbox-preview:(\\d+)$/.exec(ObjC.unwrap(action.request.URL.absoluteString))?.[1]
          const versions = row === undefined ? undefined : preview.items[Number(row)]
          if (versions) {
            ensurePreview()
            if (previewTimer)
              previewTimer.invalidate
            waiting = undefined
            const folder = $(preview.dir).stringByAppendingPathComponent(row)
            files.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(folder, true, $.nil, null)
            items = versions.map(version => extract(version, folder)).filter(Boolean).map(path => $.NSURL.fileURLWithPath(path))
            if (items.length) {
              const panel = $.QLPreviewPanel.sharedPreviewPanel
              panel.dataSource = source
              panel.reloadData
              // The pushed version is available immediately; a requested text diff follows.
              panel.currentPreviewItemIndex = items.length - 1
              panel.makeKeyAndOrderFront($.nil)
              if (preview.diffRows.includes(Number(row))) {
                waiting = folder
                previewTimer = $.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(0.05, poller, 'check:', $.nil, true)
                $.NSRunLoop.currentRunLoop.addTimerForMode(previewTimer, $.NSRunLoopCommonModes)
                $.NSFileHandle.fileHandleWithStandardOutput.writeData($('yunbox-preview:' + row + '\\n').dataUsingEncoding($.NSUTF8StringEncoding))
              }
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
    ObjC.registerSubclass({ name: 'YunBoxReportReady', protocols: ['WKNavigationDelegate'], methods: {
      'webView:didFinishNavigation:': { types: ['void', ['id', 'id']], implementation: () => loading.removeFromSuperview }
    } })
    navigation = $.YunBoxReportReady.alloc.init
    web.navigationDelegate = navigation
    accessory.addSubview(web)
    web.loadHTMLStringBaseURL(html, $.nil)
  }
  const hasLinks = Boolean(links.root || links.web)
  let linkTarget
  const setupLinks = () => {
    const workspace = $.NSWorkspace.sharedWorkspace
    const installed = id => { const url = workspace.URLForApplicationWithBundleIdentifier(id); return url.isNil() ? undefined : url }
    const openWith = (url, application) => workspace.openURLsWithApplicationAtURLConfigurationCompletionHandler($([url]), application, $.NSWorkspaceOpenConfiguration.configuration, $.nil)
    const actions = []
    if (links.root) {
      const folder = $.NSURL.fileURLWithPath(links.root)
      actions.push(['在 Finder 中显示', () => workspace.activateFileViewerSelectingURLs($([folder])), installed('com.apple.finder')])
      const editor = ['com.todesktop.230313mzl4w4u92', 'com.microsoft.VSCode', 'dev.zed.Zed', 'com.sublimetext.4'].map(installed).find(Boolean)
      if (editor)
        actions.push([\`在 \${ObjC.unwrap(editor.URLByDeletingPathExtension.lastPathComponent)} 中打开\`, () => openWith(folder, editor), editor])
      const client = installed('fun.yunle.yunbox.desktop')
      if (client)
        actions.push(['在 YunBox 中查看完整信息', () => openWith(folder, client), client])
    }
    if (links.web) {
      const page = $.NSURL.URLWithString(links.web)
      const browser = workspace.URLForApplicationToOpenURL(page)
      actions.push(['打开远端仓库', () => workspace.openURL(page), browser.isNil() ? undefined : browser])
    }
    if (actions.length) {
      ObjC.registerSubclass({ name: 'YunBoxLinks', methods: { 'perform:': { types: ['void', ['id']], implementation: function (sender) { actions[sender.tag][1]() } } } })
      linkTarget = $.YunBoxLinks.alloc.init
      const row = $.NSStackView.alloc.initWithFrame($.NSMakeRect(0, height + 40, 760, 24))
      row.spacing = 6
      row.alignment = $.NSLayoutAttributeCenterY
      actions.forEach(([label, , application], index) => {
        const button = $.NSButton.buttonWithTitleTargetAction(label, linkTarget, 'perform:')
        button.controlSize = $.NSControlSizeSmall
        button.font = $.NSFont.systemFontOfSize($.NSFont.smallSystemFontSize)
        button.tag = index
        // The icon of the app the button opens: Finder, the editor, YunBox, the default browser.
        if (application) {
          const icon = workspace.iconForFile(application.path)
          icon.size = $.NSMakeSize(14, 14)
          button.image = icon
          button.imagePosition = $.NSImageLeading
        }
        row.addArrangedSubview(button)
      })
      row.addArrangedSubview($.NSView.alloc.init)
      accessory.addSubview(row)
    }
  }
  // Fixed native frames avoid NSAlert's expensive first layout. Only the file list scrolls.
  const accessoryHeight = height + (hasLinks ? 68 : 32)
  const infoHeight = Math.max(32, Math.min(96, argv[1].split('\\n').length * 16))
  const contentHeight = accessoryHeight + 148 + infoHeight
  const window = $.YunBoxConfirmation.alloc.initWithContentRectStyleMaskBackingDefer(
    $.NSMakeRect(0, 0, 808, contentHeight), $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable, $.NSBackingStoreBuffered, false)
  window.title = 'YunBox'
  window.releasedWhenClosed = false
  window.hidesOnDeactivate = false
  window.delegate = chooser
  window.defaultButtonCell = buttons[0].cell
  const icon = $.NSImageView.alloc.initWithFrame($.NSMakeRect(24, contentHeight - 64, 40, 40))
  icon.image = $.NSImage.imageNamed('NSCaution')
  window.contentView.addSubview(icon)
  const title = $.NSTextField.wrappingLabelWithString(argv[0])
  title.font = $.NSFont.boldSystemFontOfSize(16)
  title.maximumNumberOfLines = 2
  title.setFrame($.NSMakeRect(76, contentHeight - 68, 708, 44))
  window.contentView.addSubview(title)
  const info = $.NSTextField.wrappingLabelWithString(argv[1])
  info.font = $.NSFont.systemFontOfSize(12)
  info.setFrame($.NSMakeRect(76, contentHeight - 76 - infoHeight, 708, infoHeight))
  window.contentView.addSubview(info)
  accessory.setFrame($.NSMakeRect(24, 68, 760, accessoryHeight))
  window.contentView.addSubview(accessory)
  buttons.forEach(button => window.contentView.addSubview(button))
  if (argv[3]) {
    ObjC.import('CoreGraphics')
    ObjC.registerSubclass({ name: 'YunBoxSnapshot', methods: { 'capture:': { types: ['void', ['id']], implementation: function () {
      const image = $.CGWindowListCreateImage($.CGRectNull, $.kCGWindowListOptionIncludingWindow, window.windowNumber, $.kCGWindowImageBoundsIgnoreFraming)
      $.NSBitmapImageRep.alloc.initWithCGImage(image).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).writeToFileAtomically(argv[3], true)
      finish(0)
    } } } })
    const timer = $.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(1.5, $.YunBoxSnapshot.alloc.init, 'capture:', $.nil, false)
    $.NSRunLoop.currentRunLoop.addTimerForMode(timer, $.NSDefaultRunLoopMode)
  }
  window.level = $.NSModalPanelWindowLevel
  window.center
  // Activating before launch finishes is often ignored.
  app.finishLaunching
  app.activateIgnoringOtherApps(true)
  window.makeKeyAndOrderFront($.nil)
  window.displayIfNeeded
  // Focus the note, so a reason can be typed straight away; Return still means 取消.
  window.makeFirstResponder(note)
  // Load the report, discover shortcut apps and set up editing after the first native frame.
  ObjC.registerSubclass({ name: 'YunBoxDeferredSetup', methods: { 'prepare:': { types: ['void', ['id']], implementation: () => {
    setupReport()
    setupEditing()
    setupLinks()
  } } } })
  const deferred = $.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(0.001, $.YunBoxDeferredSetup.alloc.init, 'prepare:', $.nil, false)
  $.NSRunLoop.currentRunLoop.addTimerForMode(deferred, $.NSDefaultRunLoopMode)
  app.run
  if (previewTimer)
    previewTimer.invalidate
  if (preview) {
    if (previewLoaded && $.QLPreviewPanel.sharedPreviewPanelExists)
      $.QLPreviewPanel.sharedPreviewPanel.orderOut($.nil)
    $.NSFileManager.defaultManager.removeItemAtPathError(preview.dir, null)
  }
  return [answer === 1 ? 'continue' : 'cancel', ObjC.unwrap(note.stringValue)].join('\\n')
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

/** Prepare a requested row, publishing its ready file after the HTML is complete. */
async function addDiffPage(context: CliContext, dir: string, change: InspectionChange, index: number, signal: AbortSignal): Promise<void> {
  const diff = await textDiff(context, change, signal)
  if (signal.aborted)
    return
  const folder = join(dir, String(index))
  await mkdir(folder, { recursive: true })
  const name = diff === undefined ? undefined : fileName(`${visible(change.path.slice(change.path.lastIndexOf('/') + 1))}.html`, '差异')
  if (name)
    await writeFile(join(folder, name), renderDiffHtml(visible(change.path), diff!))
  await writeFile(join(folder, 'diff.json'), JSON.stringify({ name }))
}

/** How the push confirmation is asked, from `YUNBOX_CONFIRM_UI`. */
export type ConfirmUi = 'auto' | 'dialog' | 'terminal' | 'none'

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
    meter('Git 增量上传', report.git.packComplete ? report.git.packBytes : report.git.packCapBytes, report.limits.gitBytes, report.git.exceedsLimit, report.git.packComplete ? '压缩 / 增量 pack 估算' : '估算已截断，实际更大', !report.git.packComplete),
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
    '「原始内容」为各历史版本压缩前的大小合计，不是网络上传量，也不是前后大小之差；Git 增量上传量见上方 pack 估算。',
  ]
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>${STYLE}</style></head><body>
<section class="meters">${meters.join('')}</section>
<div class="caption"><strong>变更文件</strong><span>${changes.length} 个文件${counts.map(([status, count]) => ` · <i class="badge ${status}">${CHANGE_LABELS[status]}</i> ${count}`).join('')}</span><span class="spacer"></span><span>${previewable ? '点击文件预览 · ' : ''}按原始内容大小排序</span></div>
<div class="columns"><table>${COLUMNS}<thead><tr><th>状态</th><th>文件</th><th class="num">大小变化</th><th class="num">原始内容</th></tr></thead></table></div>
<div class="list"><table>${COLUMNS}<tbody>${rows || '<tr><td colspan="4" class="empty">没有新的文件内容</td></tr>'}</tbody></table></div>
<ul class="notes">${notes.map(note => `<li>${escapeHtml(note)}</li>`).join('')}</ul>
</body></html>
`
}

/**
 * Ask whether to push: a native dialog on macOS, else the
 * controlling terminal. Blocks (returns false) when nobody can be asked.
 */
export async function confirmPush(context: CliContext, report: PushInspection, options: { remote?: string, updates?: string, head?: string, ui?: ConfirmUi } = {}): Promise<boolean> {
  return (await askPush(context, report, options))?.answer === 'continue'
}

/** An answer to the confirmation, with the reason given beside it, if any. */
export interface PushAnswer {
  answer: 'continue' | 'cancel'
  /** Why, as typed in the dialog or after `y` / `n`: one line, never empty. */
  note?: string
}

/** Longest note kept, in characters. */
const NOTE_LIMIT = 500

/**
 * A typed note made safe to print: control characters (terminal escapes) and bidi
 * overrides become spaces, then it is one line, cut to {@link NOTE_LIMIT} characters
 * without splitting one. `undefined` when blank.
 */
export function cleanNote(text: string): string | undefined {
  const note = text.replace(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (!note)
    return undefined
  const characters = Array.from(note)
  return characters.length > NOTE_LIMIT ? `${characters.slice(0, NOTE_LIMIT - 1).join('')}…` : note
}

/**
 * Read a terminal answer: `y` / `yes` continues, anything else cancels. A reason may
 * follow the answer (`n 先压缩图片`); a line that starts with neither is a reason to cancel.
 */
export function parseTerminalAnswer(line: string): PushAnswer {
  const match = /^\s*(y(?:es)?|no?)(?:\s(.*))?$/i.exec(line)
  const answer = match?.[1]?.[0]?.toLowerCase() === 'y' ? 'continue' : 'cancel'
  const note = cleanNote(match ? match[2] ?? '' : line)
  return note ? { answer, note } : { answer }
}

/**
 * Like {@link confirmPush}, but tells a “cancel” answer apart from nobody being
 * asked (`undefined`, after explaining why on stderr).
 */
export async function askPush(context: CliContext, report: PushInspection, options: { remote?: string, updates?: string, head?: string, ui?: ConfirmUi, push?: PushEnds } = {}): Promise<PushAnswer | undefined> {
  const ui = options.ui ?? confirmUi(context.env.YUNBOX_CONFIRM_UI ?? await readGitConfig(context, 'yunbox.confirmUI'))
  const push = options.push ?? await describePush(context, options)
  const { source, target } = push
  if (ui === 'dialog' || (ui === 'auto' && process.platform === 'darwin' && !context.env.SSH_CONNECTION)) {
    const answer = await askDialog(context, report, push)
    if (answer !== undefined)
      return answer
  }
  if (ui !== 'none') {
    const style = terminalFor(context, 'stderr')
    const prompt = report.status === 'exceeded' ? '? 超过限额，继续推送？[y/N]' : '? 未超限，确认推送？[y/N]'
    const answer = await readTerminalLine(`\n${source}${target ? ` 推送到 ${target}` : ''}\n${style.paint('warning', prompt)} 可附原因（如 n 先压缩图片）：`)
    if (answer !== undefined)
      return parseTerminalAnswer(answer)
  }
  const unavailable = ui === 'none'
    ? '无法请求确认：确认方式设为 none，推送已取消。\n需要交互确认时，检查 YUNBOX_CONFIRM_UI 和 git config yunbox.confirmUI 的设置。\n'
    : '无法请求确认：没有可用的对话框 / 控制终端。已取消推送。\n请在交互式终端重试（Windows 可用 PowerShell / Windows Terminal）。\n'
  context.stderr.write(terminalFor(context, 'stderr').paint('warning', unavailable))
  return undefined
}

function confirmUi(value: string | undefined): ConfirmUi {
  return value === 'dialog' || value === 'terminal' || value === 'none' ? value : 'auto'
}

/** Changes with uploaded content, and the ones the dialog lists. */
function listedChanges(report: PushInspection): { changes: InspectionChange[], shown: InspectionChange[] } {
  const changes = report.changes.filter(change => change.versions > 0)
  return { changes, shown: changes.slice(0, DIALOG_ROWS) }
}

async function askDialog(context: CliContext, report: PushInspection, push: PushEnds): Promise<PushAnswer | undefined> {
  const { shown } = listedChanges(report)
  const height = Math.min(560, Math.max(300, 210 + shown.length * 29))
  const title = report.status === 'exceeded'
    ? push.target ? `推送到 ${push.target} 超过限额` : '推送超过限额'
    : push.target ? `确认推送到 ${push.target}` : '确认推送'
  const info = [push.source, ...(report.status === 'exceeded' ? exceededReasons(report) : ['未超限；已启用每次推送确认'])].join('\n')
  const items = shown.map(previewVersions)
  // Private (0700) and removed when the dialog closes; the dialog removes it too.
  const dir = items.some(versions => versions.length) ? await mkdtemp(join(tmpdir(), 'yunbox-preview-')) : undefined
  const controller = new AbortController()
  const requested = new Set<number>()
  let preparing = Promise.resolve()
  try {
    const diffRows = shown.flatMap((change, index) => change.status === 'modified' && change.storage === 'git' && items[index]!.length === 2 ? [index] : [])
    const preview = dir && { dir, lfs: await lfsObjects(context), items, diffRows }
    const links = JSON.stringify({ root: push.root, web: push.web, preview })
    const args = ['-l', 'JavaScript', '-e', DIALOG_SCRIPT, title, info, String(height), context.env.YUNBOX_CONFIRM_SNAPSHOT ?? '', links]
    // Previews read objects with `git cat-file`: never prompt or fetch for a missing one.
    return await runDialog(args, { ...context.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' }, context.cwd, renderConfirmationHtml(report), (index) => {
      if (!dir || !diffRows.includes(index) || requested.has(index))
        return
      requested.add(index)
      // Serialize requests and cache repeated clicks; closing cancels in-flight Git.
      preparing = preparing.then(async () => {
        if (!controller.signal.aborted)
          await addDiffPage(context, dir, shown[index]!, index, controller.signal)
      }).catch(() => {})
    })
  }
  finally {
    controller.abort()
    await preparing
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

function runDialog(args: string[], env: NodeJS.ProcessEnv, cwd: string, html: string, preview: (index: number) => void): Promise<PushAnswer | undefined> {
  return new Promise((resolve) => {
    const child = spawn('osascript', args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let pending = Buffer.alloc(0)
    let answered = false
    child.stdout.on('data', (chunk: Buffer) => {
      if (answered) {
        chunks.push(chunk)
        return
      }
      pending = Buffer.concat([pending, chunk])
      while (true) {
        const end = pending.indexOf(10)
        if (end < 0)
          break
        const line = pending.subarray(0, end + 1)
        pending = pending.subarray(end + 1)
        const request = /^yunbox-preview:(\d+)\n$/.exec(line.toString('utf8'))
        if (request) {
          preview(Number(request[1]))
        }
        else {
          answered = true
          chunks.push(line, pending)
          pending = Buffer.alloc(0)
          break
        }
      }
    })
    child.stdin.on('error', () => {})
    child.on('error', () => resolve(undefined))
    child.on('close', (code) => {
      chunks.push(pending)
      resolve(code === 0 ? parseDialogOutput(Buffer.concat(chunks).toString('utf8')) : undefined)
    })
    child.stdin.end(html)
  })
}

/**
 * Read the dialog's output: `continue` or `cancel`, then the note. Anything else (no
 * window server, scripting disabled) is `undefined`, which falls back to the terminal.
 */
export function parseDialogOutput(output: string): PushAnswer | undefined {
  const [first, ...rest] = output.trimStart().split('\n')
  const answer = first?.trim()
  if (answer !== 'continue' && answer !== 'cancel')
    return undefined
  const note = cleanNote(rest.join(' '))
  return note ? { answer, note } : { answer }
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
