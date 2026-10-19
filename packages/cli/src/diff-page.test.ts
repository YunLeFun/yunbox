import { describe, expect, it } from 'vitest'
import { renderDiffHtml } from './diff-page.ts'

describe('renderDiffHtml', () => {
  it('numbers both versions and colours removed and added lines', () => {
    const html = renderDiffHtml('docs/guide.md', '@@ -1,3 +1,4 @@ intro\n # Guide\n-old\n+new\n+more\n keep\n\\ No newline at end of file\n')
    expect(html).toContain('<strong>docs/guide.md</strong><span class="add">+2</span><span class="del">−1</span>')
    expect(html).toContain('<tr class="hunk"><td colspan="3">@@ -1,3 +1,4 @@ intro</td></tr>')
    expect(html).toContain('<tr><td class="n">1</td><td class="n">1</td><td class="code"> # Guide</td></tr>')
    expect(html).toContain('<tr class="del"><td class="n">2</td><td class="n"></td><td class="code">-old</td></tr>')
    expect(html).toContain('<tr class="add"><td class="n"></td><td class="n">2</td><td class="code">+new</td></tr>')
    expect(html).toContain('<tr class="add"><td class="n"></td><td class="n">3</td><td class="code">+more</td></tr>')
    expect(html).toContain('<tr><td class="n">3</td><td class="n">4</td><td class="code"> keep</td></tr>')
    expect(html).toContain('<tr class="note"><td colspan="3">\\ No newline at end of file</td></tr>')
  })

  it('escapes file content and the title and loads nothing', () => {
    const html = renderDiffHtml('<b>x</b>.html', '@@ -1 +1 @@\n-<script>alert(1)</script>\n+<img src=x onerror="alert(2)">\n')
    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img')
    expect(html).toContain('-&#60;script&#62;alert(1)&#60;/script&#62;')
    expect(html).toContain('+&#60;img src=x onerror=&#34;alert(2)&#34;&#62;')
    expect(html).toContain('<title>&#60;b&#62;x&#60;/b&#62;.html</title>')
    expect(html).toContain('content="default-src \'none\'; style-src \'unsafe-inline\'"')
    expect(html.match(/<script/g)).toBeNull()
  })

  it('caps very long diffs', () => {
    const diff = `@@ -1,6000 +1,6000 @@\n${Array.from({ length: 6000 }, (_, i) => ` line ${i}`).join('\n')}\n`
    const html = renderDiffHtml('big.txt', diff)
    expect(html).toContain('差异共 6001 行，只显示前 5000 行')
    expect(html).not.toContain('line 5500')
  })
})
