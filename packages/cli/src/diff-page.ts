import type { CliContext } from './context.ts'
import type { InspectionChange } from './inspect.ts'
import { inspectGit } from './inspect-git.ts'

/** Larger versions are left to Quick Look's own viewer of each version. */
const DIFF_MAX_BYTES = 1024 * 1024
/** Lines rendered on a diff page; the rest is summarized. */
const DIFF_MAX_LINES = 5000

const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --muted: #8e8e93; --line: rgba(0,0,0,.08);
  --add: rgba(31,157,85,.16); --del: rgba(229,72,77,.16); --hunk: rgba(10,132,255,.08); --hunk-fg: #0a7cff; }
@media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --muted: #98989d; --line: rgba(255,255,255,.1);
  --add: rgba(61,214,140,.18); --del: rgba(255,99,105,.18); --hunk: rgba(82,169,255,.12); --hunk-fg: #52a9ff; } }
body { margin: 0; color: var(--fg); font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
header { display: flex; gap: 10px; align-items: baseline; padding: 10px 12px; border-bottom: 1px solid var(--line);
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
header strong { font-size: 13px; overflow-wrap: anywhere; }
header .add { color: #1f9d55; } header .del { color: #e5484d; }
table { width: 100%; border-collapse: collapse; }
td { padding: 0 8px; vertical-align: top; }
td.n { width: 1%; min-width: 2.5em; text-align: right; color: var(--muted); user-select: none; }
td.code { white-space: pre-wrap; overflow-wrap: anywhere; }
tr.add td { background: var(--add); } tr.del td { background: var(--del); }
tr.hunk td { background: var(--hunk); color: var(--hunk-fg); padding: 2px 8px; }
tr.note td, p.more { color: var(--muted); }
p.more { padding: 8px 12px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
`

/** Escape text for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
}

/**
 * Unified diff of a modified Git file between its versions before and after the push, from
 * the first hunk on. `undefined` for other changes, LFS or large files, binary content, or
 * when either object is not available locally. An optional signal stops a preview
 * query when its confirmation dialog closes.
 */
export async function textDiff(context: CliContext, change: InspectionChange, signal?: AbortSignal): Promise<string | undefined> {
  const blob = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
  if (change.status !== 'modified' || change.storage !== 'git' || !blob.test(change.beforeOid ?? '') || !blob.test(change.afterOid ?? '')
    || change.beforeBytes === null || change.afterBytes === null || Math.max(change.beforeBytes, change.afterBytes) > DIFF_MAX_BYTES) {
    return undefined
  }
  try {
    const output = await inspectGit(context, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', change.beforeOid!, change.afterOid!], '', undefined, signal)
    const text = output.output.toString('utf8')
    // Binary content has no hunks, only a "Binary files … differ" line.
    const start = text.search(/^@@/m)
    return start < 0 ? undefined : text.slice(start)
  }
  catch {
    return undefined
  }
}

/**
 * A self-contained page for a unified diff: line numbers of both versions, removed and added
 * lines coloured, following the system appearance. No scripts and nothing to load.
 * `title` is shown as is (escaped), so callers make control characters visible first.
 */
export function renderDiffHtml(title: string, diff: string): string {
  const lines = diff.replace(/\n$/, '').split('\n')
  const added = lines.filter(line => line.startsWith('+')).length
  const removed = lines.filter(line => line.startsWith('-')).length
  const rows: string[] = []
  let before = 0
  let after = 0
  const row = (kind: string, left: number | '', right: number | '', line: string): string =>
    `<tr${kind ? ` class="${kind}"` : ''}><td class="n">${left}</td><td class="n">${right}</td><td class="code">${escapeHtml(line) || ' '}</td></tr>`
  for (const line of lines.slice(0, DIFF_MAX_LINES)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line)
    if (hunk) {
      before = Number(hunk[1])
      after = Number(hunk[2])
      rows.push(`<tr class="hunk"><td colspan="3">${escapeHtml(line)}</td></tr>`)
    }
    else if (line.startsWith('-')) {
      rows.push(row('del', before++, '', line))
    }
    else if (line.startsWith('+')) {
      rows.push(row('add', '', after++, line))
    }
    else if (line.startsWith('\\')) {
      rows.push(`<tr class="note"><td colspan="3">${escapeHtml(line)}</td></tr>`)
    }
    else {
      rows.push(row('', before++, after++, line))
    }
  }
  const more = lines.length > DIFF_MAX_LINES ? `<p class="more">差异共 ${lines.length} 行，只显示前 ${DIFF_MAX_LINES} 行；可切换到推送前后的版本查看全文。</p>` : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>
<header><strong>${escapeHtml(title)}</strong><span class="add">+${added}</span><span class="del">−${removed}</span></header>
<table>${rows.join('')}</table>${more}
</body></html>
`
}
