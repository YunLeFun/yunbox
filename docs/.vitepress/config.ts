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
    socialLinks: [
      { icon: 'github', link: REPOSITORY },
      { icon: 'npm', link: 'https://www.npmjs.com/package/yunbox' },
    ],
  },
  // Chinese stays at the root so existing links keep working; English pages
  // mirror the same paths under /en/.
  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      title: '云匣 YunBox',
      titleTemplate: ':title · 云匣 YunBox',
      description: '兼容 Git LFS 的素材托管：代码交给 Git，素材直传你自己的腾讯云 COS，中间没有服务端。',
      themeConfig: {
        siteTitle: '云匣',
        nav: [
          { text: '指南', link: '/guide/', activeMatch: '/guide/' },
          { text: '推送检查', link: '/inspect' },
          { text: '下载', link: '/#download' },
          { text: '更新日志', link: '/changelog' },
        ],
        sidebar: [
          {
            text: '开始使用',
            items: [
              { text: '快速开始', link: '/guide/' },
              { text: '协作者加入', link: '/guide/collaborators' },
              { text: '从 GitHub LFS 迁移', link: '/guide/migrate' },
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
              { text: '更新日志', link: '/changelog' },
            ],
          },
        ],
        editLink: {
          pattern: `${REPOSITORY}/edit/main/docs/:path`,
          text: '在 GitHub 上编辑此页',
        },
        outline: { label: '本页内容', level: [2, 3] },
        docFooter: { prev: '上一页', next: '下一页' },
        lastUpdated: { text: '最后更新' },
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换到浅色模式',
        darkModeSwitchTitle: '切换到深色模式',
        sidebarMenuLabel: '目录',
        returnToTopLabel: '回到顶部',
        langMenuLabel: '切换语言',
        skipToContentLabel: '跳到正文',
        notFound: {
          title: '页面不存在',
          quote: '这个地址没有内容，可能是链接写错了，或者页面已经移动。',
          linkLabel: '回到首页',
          linkText: '回到首页',
        },
        footer: {
          message: 'MIT 许可证发布',
          copyright: '© 2026 云乐坊 YunLeFun',
        },
      },
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      title: 'YunBox',
      titleTemplate: ':title · YunBox',
      description: 'Git LFS–compatible asset hosting: code stays in Git, assets go straight to your own Tencent Cloud COS bucket, with no server in between.',
      themeConfig: {
        siteTitle: 'YunBox',
        nav: [
          { text: 'Guide', link: '/en/guide/', activeMatch: '/en/guide/' },
          { text: 'Push Check', link: '/en/inspect' },
          { text: 'Download', link: '/en/#download' },
          { text: 'Changelog', link: '/en/changelog' },
        ],
        sidebar: [
          {
            text: 'Getting Started',
            items: [
              { text: 'Quick Start', link: '/en/guide/' },
              { text: 'Joining as a Collaborator', link: '/en/guide/collaborators' },
              { text: 'Migrating from GitHub LFS', link: '/en/guide/migrate' },
              { text: 'macOS App', link: '/en/guide/macos' },
              { text: 'Push Freeze', link: '/en/guide/freeze' },
              { text: 'Set Up with an AI Assistant', link: '/en/guide/ai' },
            ],
          },
          {
            text: 'Reference',
            items: [
              { text: 'Push Size Check', link: '/en/inspect' },
              { text: 'Server Mode', link: '/en/deploy' },
              { text: 'Changelog', link: '/en/changelog' },
            ],
          },
        ],
        editLink: {
          pattern: `${REPOSITORY}/edit/main/docs/:path`,
          text: 'Edit this page on GitHub',
        },
        outline: { label: 'On this page', level: [2, 3] },
        lastUpdated: { text: 'Last updated' },
        footer: {
          message: 'Released under the MIT License',
          copyright: '© 2026 YunLeFun',
        },
      },
    },
  },
})
