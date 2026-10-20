import type { MarkdownRenderer } from 'vitepress'
import { posix } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'

const REPOSITORY = 'https://github.com/YunLeFun/yunbox'

// Planning notes stay next to the user docs (AGENTS.md links to them) but are
// not part of the site; links to them go to GitHub instead.
const INTERNAL_PAGES = ['plan.md', 'goal.md', 'goal-g2.md']

/**
 * Rewrite relative links that leave the site (the repository README, the
 * macOS client, workflows, internal planning notes) into GitHub URLs, so the
 * same Markdown reads correctly on GitHub and on the site.
 */
function repositoryLinks(md: MarkdownRenderer): void {
  const render = md.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options))
  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index]
    const href = token.attrGet('href')
    if (href !== null && !/^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(href)) {
      const [path, hash] = href.split('#')
      const target = posix.normalize(posix.join('docs', posix.dirname(env.relativePath ?? ''), path))
      const outside = !target.startsWith('docs/') || INTERNAL_PAGES.includes(target.slice('docs/'.length))
      if (outside)
        token.attrSet('href', `${REPOSITORY}/blob/main/${target}${hash === undefined ? '' : `#${hash}`}`)
    }
    return render(tokens, index, options, env, self)
  }
}

export default defineConfig({
  lang: 'zh-CN',
  title: '云匣 YunBox',
  titleTemplate: ':title · 云匣 YunBox',
  description: '兼容 Git LFS 的素材托管：代码交给 Git，素材直传你自己的腾讯云 COS，中间没有服务端。',
  // GitHub Pages serves project sites under /<repo>/; the workflow passes it in.
  base: process.env.SITE_BASE || '/',
  cleanUrls: true,
  lastUpdated: true,
  srcExclude: INTERNAL_PAGES,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${process.env.SITE_BASE || '/'}yunbox-app-icon.svg` }],
    ['meta', { name: 'theme-color', content: '#2563eb' }],
  ],
  markdown: {
    config: repositoryLinks,
  },
  vite: {
    // Serve the pinned brand files (assets/brand) as-is instead of keeping copies.
    publicDir: fileURLToPath(new URL('../../assets/brand', import.meta.url)),
  },
  themeConfig: {
    logo: '/yunbox-mark.svg',
    siteTitle: '云匣',
    nav: [
      { text: '指南', link: '/guide/', activeMatch: '/guide/' },
      { text: '推送检查', link: '/inspect' },
      { text: '下载', link: '/#download' },
      { text: '更新记录', link: `${REPOSITORY}/releases` },
    ],
    sidebar: [
      {
        text: '开始使用',
        items: [
          { text: '快速开始', link: '/guide/' },
          { text: '协作者加入', link: '/guide/collaborators' },
          { text: 'macOS 客户端', link: '/guide/macos' },
          { text: '禁推时段', link: '/guide/freeze' },
          { text: '用 AI 编程助手接入', link: '/guide/ai' },
        ],
      },
      {
        text: '参考',
        items: [
          { text: '推送体积检查', link: '/inspect' },
          { text: '服务端模式部署', link: '/deploy' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: REPOSITORY },
      { icon: 'npm', link: 'https://www.npmjs.com/package/yunbox' },
    ],
    editLink: {
      pattern: `${REPOSITORY}/edit/main/docs/:path`,
      text: '在 GitHub 上编辑此页',
    },
    outline: { label: '本页内容', level: [2, 3] },
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '最后更新' },
    darkModeSwitchLabel: '外观',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    footer: {
      message: 'MIT 许可证发布',
      copyright: '© 2026 云乐坊 YunLeFun',
    },
  },
})
