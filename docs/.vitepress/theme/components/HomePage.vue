<script setup lang="ts">
/** The landing page: hero, how a push travels, setup, push check, freeze windows and AI, keys, downloads. */
import { useCopy, useLocalePath } from '../i18n'
import ConfirmDialogMock from './ConfirmDialogMock.vue'
import CopyCommand from './CopyCommand.vue'
import DownloadPanel from './DownloadPanel.vue'
import FreezePanelMock from './FreezePanelMock.vue'
import HeroBox from './HeroBox.vue'
import InspectorMock from './InspectorMock.vue'
import KeyBoundary from './KeyBoundary.vue'
import PushFlow from './PushFlow.vue'
import SymbolIcon from './SymbolIcon.vue'
import TerminalDemo from './TerminalDemo.vue'

const localePath = useLocalePath()

// Paragraphs with inline code are trusted HTML written here, never user input.
const t = useCopy({
  zh: {
    title: ['代码交给 Git，', '素材交给云匣。'],
    lead: '云匣 YunBox 兼容 Git LFS。PSD、模型、音频和视频直接存进你自己的腾讯云 COS，也支持 Cloudflare R2、AWS S3、MinIO 等任何 S3 兼容存储，团队照常 <code>git push</code>、<code>git clone</code>，中间不经过任何服务端。',
    downloadMac: '下载 macOS 客户端',
    quickStart: '快速开始',
    platforms: '命令行支持 macOS、Linux 和 Windows',
    scope: '<strong>腾讯云 COS 深度集成。</strong>一条命令给协作者开好只能读写本仓库目录的子账号，最小权限策略自动生成，bucket 可以在命令行或客户端里直接选择、新建。用 Cloudflare R2（下载不收流量费）、AWS S3、MinIO 等 S3 兼容存储也行，bucket 和密钥在各自的控制台里创建。',
    flowTitle: '一次推送，分两条路走',
    flow: '代码和几行指针照旧去代码托管平台；素材由本机的传输代理签名后，直接上传到你的 bucket。没有要部署、要续费、要盯着的服务端。',
    setupTitle: '接入只要几条命令',
    setup: '管理员给仓库接一次 COS（或 R2 等 S3 兼容存储），再给每位协作者一把自己的密钥。协作者登录后 clone，素材自动下载。哪里不对，先跑 <code>yunbox doctor</code>，每一项都附修复命令。',
    checkTitle: '推送之前，先看看有多大',
    check: 'macOS 客户端和 <code>yunbox inspect --push</code> 用同一套检查：分别统计 Git pack 和 LFS 候选量，按大小列出每个文件，超出预算的标出来。下面的窗口可以直接操作。',
    confirm: '用 <code>yunbox hook install --confirm</code> 装上推送钩子后，超出预算的 <code>git push</code> 不会被直接拦下，而是弹出下面的对话框：推到哪个远端、哪些文件超限、每个文件多大，看完再决定取消还是继续。',
    checkLinks: [
      { text: '推送检查的统计口径', path: '/inspect' },
      { text: '超限时如何确认', path: '/inspect#超限确认' },
      { text: 'macOS 客户端的全部功能', path: '/guide/macos' },
    ],
    freezeTitle: '到点不让推送',
    freeze: '用 <code>opening_hours</code> 写法设定禁推时段，例如 <code>Mo-Fr 09:00-18:00; We off</code>。本仓库、团队、全局三层规则同时生效，命中时推送在上传前被中断；紧急修复时 <code>yunbox freeze off --for 1h</code> 快速关闭，规则保留，到点自动恢复。',
    menuTitle: '菜单栏里随时看到',
    menu: '当前仓库处在禁推时段时，菜单栏的云匣图标右上角会多一个圆点。点开面板：现在能不能推、今天和未来 7 天的禁推分布、每个项目的规则。勾选预设就能设置，右上角的开关和定时按钮可以一次关闭所有仓库。这里的演示面板可以直接操作：勾选预设、拨动开关试试。',
    commands: '命令行示例',
    aiTitle: '交给 AI 接入',
    ai: '客户端的 COS 面板里有「复制给 AI 的接入说明」，粘贴给 Claude Code、Codex 或 Cursor 即可。云匣的命令都不需要交互、都有 JSON 输出，编程助手可以自己检查、接入、设时段；只有保存存储密钥这一步留给你自己。',
    freezeLinks: [
      { text: '禁推时段的写法和场景', path: '/guide/freeze' },
      { text: '用 AI 编程助手接入', path: '/guide/ai' },
    ],
    keysTitle: '密钥不离开你的电脑',
    keys: '仓库里只记录素材放在哪个 bucket、哪个前缀。访问存储的密钥每人一把，存在各自电脑的钥匙串里。',
    downloadTitle: '下载云匣',
    download: '图形界面适合日常查看和接入；命令行负责传输，每位协作者都需要安装。两者可以同时使用。',
  },
  en: {
    title: ['Code goes to Git.', 'Assets go to YunBox.'],
    lead: 'YunBox works with Git LFS. PSDs, models, audio and video go straight into your own bucket on any S3-compatible storage, such as Cloudflare R2, AWS S3 or MinIO, or on Tencent Cloud COS, while your team keeps using <code>git push</code> and <code>git clone</code> as usual. No server sits in between.',
    downloadMac: 'Download for macOS',
    quickStart: 'Quick Start',
    platforms: 'The command line runs on macOS, Linux and Windows',
    scope: '<strong>Bring your own S3 bucket.</strong> Cloudflare R2 charges no egress fees, so pulling assets again and again costs nothing in download traffic. AWS S3, MinIO and any other S3-compatible service work the same way. Tencent Cloud COS is supported natively too, down to one-command sub-accounts limited to a single repository. The macOS app and these docs are in English; command-line messages are still in Chinese.',
    flowTitle: 'One push, two paths',
    flow: 'Code and a few lines of pointers go to your Git host as always. Assets are signed by a transfer agent on your machine and uploaded straight to your bucket. There is no server to deploy, pay for or babysit.',
    setupTitle: 'Set up with a few commands',
    setup: 'An admin connects the repository to R2 or any S3-compatible bucket (or to COS) once and gives each collaborator a key of their own. Collaborators sign in and clone; assets download on their own. If anything is off, run <code>yunbox doctor</code>: every failed check comes with the command that fixes it.',
    checkTitle: 'See how big a push is before you push',
    check: 'The macOS app and <code>yunbox inspect --push</code> run the same check: Git pack and LFS candidates are counted separately, every file is listed by size, and anything over budget is flagged. Try the window below; it works.',
    confirm: 'Install the hook with <code>yunbox hook install --confirm</code> and an over-budget <code>git push</code> is not simply refused. You get the dialog below instead: which remote, which files are over, how big each one is. Then you decide whether to cancel or push anyway. (The real dialog is in Chinese for now.)',
    checkLinks: [
      { text: 'What the push check counts', path: '/inspect' },
      { text: 'Confirming over-budget pushes', path: '/inspect#confirming-over-budget-pushes' },
      { text: 'Everything the macOS app does', path: '/guide/macos' },
    ],
    freezeTitle: 'No pushing after hours',
    freeze: 'Set push freeze windows in <code>opening_hours</code> syntax, such as <code>Mo-Fr 09:00-18:00; We off</code>. Rules for this repository, the team and every repository on your machine all apply at once, and a push that falls inside a window stops before anything uploads. For an urgent fix, <code>yunbox freeze off --for 1h</code> switches it off; the rules stay and come back on by themselves.',
    menuTitle: 'Always visible in the menu bar',
    menu: 'When the current repository is in a push freeze, the YunBox icon in the menu bar gets a dot. Open the panel to see whether you can push now, today\'s and the next 7 days\' freeze windows, and each project\'s rules. Tick a preset to set one; the switch and timer at the top switch off every repository at once. The demo panel here works too: tick a preset or flip the switch.',
    commands: 'Command-line examples',
    aiTitle: 'Let AI set it up',
    ai: 'The app\'s COS panel has Copy Setup Prompt for AI: paste it into Claude Code, Codex or Cursor. Every YunBox command runs without prompts and has JSON output, so a coding assistant can check, connect and set freeze windows by itself. Saving your storage key is the one step left to you.',
    freezeLinks: [
      { text: 'Freeze window syntax and examples', path: '/guide/freeze' },
      { text: 'Set up with an AI coding assistant', path: '/guide/ai' },
    ],
    keysTitle: 'Your keys never leave your computer',
    keys: 'The repository only records which bucket and prefix the assets live in. Everyone has their own storage key, kept in their own computer\'s keychain.',
    downloadTitle: 'Download YunBox',
    download: 'The app is for everyday checks and setup; the command line does the transfers, so every collaborator needs it. Use both side by side.',
  },
})
</script>

<template>
  <div class="yb-home">
    <section class="hero">
      <div class="wrap hero-grid">
        <div class="hero-copy">
          <h1 class="hero-title">
            <span v-for="line in t.title" :key="line">{{ line }}</span>
          </h1>
          <p class="hero-lead" v-html="t.lead" />
          <div class="hero-actions">
            <a class="btn btn-primary" href="#download">
              <SymbolIcon name="arrow.down.circle" />
              {{ t.downloadMac }}
            </a>
            <a class="btn btn-secondary" :href="localePath('/guide/')">{{ t.quickStart }}</a>
          </div>
          <div class="hero-install">
            <CopyCommand command="npm install -g yunbox" />
            <p>{{ t.platforms }}</p>
          </div>
          <p v-if="t.scope" class="hero-scope" v-html="t.scope" />
        </div>
        <HeroBox />
      </div>
    </section>

    <section class="section section-alt">
      <div class="wrap">
        <header class="section-head">
          <h2>{{ t.flowTitle }}</h2>
          <p>{{ t.flow }}</p>
        </header>
        <PushFlow />
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <header class="section-head">
          <h2>{{ t.setupTitle }}</h2>
          <p v-html="t.setup" />
        </header>
        <div class="narrow">
          <TerminalDemo />
        </div>
      </div>
    </section>

    <section class="section section-alt">
      <div class="wrap">
        <header class="section-head">
          <h2>{{ t.checkTitle }}</h2>
          <p v-html="t.check" />
        </header>
        <InspectorMock />
        <p class="confirm-lead" v-html="t.confirm" />
        <ConfirmDialogMock />
        <p class="section-foot">
          <a v-for="link in t.checkLinks" :key="link.path" :href="localePath(link.path)">{{ link.text }}</a>
        </p>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <header class="section-head">
          <h2>{{ t.freezeTitle }}</h2>
          <p v-html="t.freeze" />
        </header>
        <div class="freeze-grid">
          <div class="freeze-copy">
            <h3>{{ t.menuTitle }}</h3>
            <p>{{ t.menu }}</p>
            <pre class="freeze-commands" :aria-label="t.commands"><code><span>yunbox freeze set "Mo-Fr 09:00-18:00"</span>
<span>yunbox freeze off --until 18:00</span>
<span>yunbox freeze check --json</span></code></pre>

            <h3>{{ t.aiTitle }}</h3>
            <p>{{ t.ai }}</p>
            <p class="freeze-links">
              <a v-for="link in t.freezeLinks" :key="link.path" :href="localePath(link.path)">{{ link.text }}</a>
            </p>
          </div>
          <FreezePanelMock />
        </div>
      </div>
    </section>

    <section class="section section-alt">
      <div class="wrap">
        <header class="section-head">
          <h2>{{ t.keysTitle }}</h2>
          <p>{{ t.keys }}</p>
        </header>
        <KeyBoundary />
      </div>
    </section>

    <section id="download" class="section">
      <div class="wrap">
        <header class="section-head">
          <h2>{{ t.downloadTitle }}</h2>
          <p>{{ t.download }}</p>
        </header>
        <DownloadPanel />
      </div>
    </section>
  </div>
</template>

<style scoped>
.yb-home {
  color: var(--yb-label);
}

.wrap {
  max-width: 1080px;
  margin: 0 auto;
  padding: 0 24px;
}

.narrow {
  max-width: 880px;
  margin: 0 auto;
}

.hero {
  padding: 72px 0 88px;
  background:
    radial-gradient(ellipse 60% 70% at 78% 30%, rgb(85 170 255 / 0.14), transparent 70%),
    var(--yb-bg);
}

.hero-grid {
  display: grid;
  grid-template-columns: 1.05fr 1fr;
  align-items: center;
  gap: 56px;
}

.hero-title {
  display: grid;
  margin: 0;
  color: var(--yb-label);
  font-size: clamp(36px, 5.4vw, 64px);
  font-weight: 700;
  line-height: 1.12;
  letter-spacing: -0.025em;
}

.hero-title span {
  white-space: nowrap;
}

.hero-lead {
  max-width: 32em;
  margin: 24px 0 0;
  color: var(--yb-label-2);
  font-size: 19px;
  line-height: 1.7;
}

.hero-lead :deep(code),
.section-head :deep(code),
.confirm-lead :deep(code),
.freeze-copy p code {
  padding: 0;
  background: none;
  color: var(--yb-label);
  font-family: var(--yb-font-mono);
  font-size: 0.86em;
  white-space: nowrap;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 32px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 11px 22px;
  border-radius: 999px;
  font-size: 16px;
  font-weight: 500;
  text-decoration: none;
  transition: background-color 120ms, color 120ms;
}

.btn-primary {
  background: var(--yb-accent);
  color: #fff;
}

.btn-primary:hover {
  background: var(--yb-accent-hover);
}

.btn-secondary {
  background: var(--yb-fill-strong);
  color: var(--yb-label);
}

.btn-secondary:hover {
  background: var(--yb-accent-soft);
  color: var(--yb-accent);
}

.btn:focus-visible,
.section-foot a:focus-visible,
.freeze-links a:focus-visible {
  outline: 2px solid var(--yb-accent);
  outline-offset: 3px;
}

.hero-install {
  max-width: 340px;
  margin-top: 28px;
}

.hero-install p {
  margin: 8px 0 0 2px;
  color: var(--yb-label-3);
  font-size: 13px;
}

.hero-scope {
  max-width: 34em;
  margin: 24px 0 0;
  padding: 12px 16px;
  border-radius: var(--yb-radius-card);
  background: var(--yb-fill-strong);
  color: var(--yb-label-2);
  font-size: 14px;
  line-height: 1.6;
}

.hero-scope :deep(strong) {
  color: var(--yb-label);
}

.section {
  padding: 96px 0;
  background: var(--yb-bg);
}

.section-alt {
  background: var(--yb-bg-alt);
}

.section-head {
  max-width: 44em;
  margin: 0 auto 48px;
  text-align: center;
}

.section-head h2 {
  margin: 0;
  padding: 0;
  border: 0;
  color: var(--yb-label);
  font-size: clamp(28px, 3.6vw, 40px);
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.02em;
}

.section-head p {
  margin: 16px 0 0;
  color: var(--yb-label-2);
  font-size: 17px;
  line-height: 1.75;
}

.confirm-lead {
  max-width: 44em;
  margin: 64px auto 28px;
  color: var(--yb-label-2);
  font-size: 17px;
  line-height: 1.75;
  text-align: center;
}

.section-foot {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 28px;
  margin: 32px 0 0;
}

.section-foot a {
  color: var(--yb-accent);
  font-size: 15px;
  text-decoration: none;
}

.section-foot a:hover {
  text-decoration: underline;
}

.freeze-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 420px);
  align-items: start;
  gap: 56px;
}

.freeze-copy h3 {
  margin: 0;
  color: var(--yb-label);
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.freeze-copy h3:not(:first-child) {
  margin-top: 40px;
}

.freeze-copy p {
  margin: 12px 0 0;
  color: var(--yb-label-2);
  font-size: 16px;
  line-height: 1.75;
}

.freeze-commands {
  margin: 20px 0 0;
  padding: 14px 16px;
  border-radius: var(--yb-radius-card);
  background: var(--yb-code-bg);
  box-shadow: inset 0 0 0 0.5px var(--yb-separator);
  overflow-x: auto;
  font-family: var(--yb-font-mono);
  font-size: 13px;
  line-height: 1.8;
}

.freeze-commands span::before {
  content: '$ ';
  color: var(--yb-term-prompt);
  user-select: none;
}

.freeze-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 28px;
  margin-top: 20px !important;
}

.freeze-links a {
  color: var(--yb-accent);
  font-size: 15px;
  text-decoration: none;
}

.freeze-links a:hover {
  text-decoration: underline;
}

@media (max-width: 960px) {
  .hero-grid {
    grid-template-columns: 1fr;
    gap: 48px;
  }

  .freeze-grid {
    grid-template-columns: 1fr;
    gap: 40px;
  }
}

@media (max-width: 640px) {
  .wrap {
    padding: 0 16px;
  }

  .hero {
    padding: 36px 0 56px;
  }

  .hero-lead {
    font-size: 16px;
  }

  .section {
    padding: 64px 0;
  }

  .section-head {
    margin-bottom: 32px;
    text-align: left;
  }

  .section-head p {
    font-size: 15px;
  }

  .freeze-copy p {
    font-size: 15px;
  }

  .confirm-lead {
    margin-top: 40px;
    font-size: 15px;
    text-align: left;
  }
}
</style>
