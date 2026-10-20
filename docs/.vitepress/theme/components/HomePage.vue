<script setup lang="ts">
/** The landing page: hero, how a push travels, setup, push check, freeze windows and AI, keys, downloads. */
import { withBase } from 'vitepress'
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
</script>

<template>
  <div class="yb-home">
    <section class="hero">
      <div class="wrap hero-grid">
        <div class="hero-copy">
          <h1 class="hero-title">
            <span>代码交给 Git，</span>
            <span>素材交给云匣。</span>
          </h1>
          <p class="hero-lead">
            云匣 YunBox 兼容 Git LFS。PSD、模型、音频和视频直接存进你自己的腾讯云 COS，团队照常
            <code>git push</code>、<code>git clone</code>，中间不经过任何服务端。
          </p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="#download">
              <SymbolIcon name="arrow.down.circle" />
              下载 macOS 客户端
            </a>
            <a class="btn btn-secondary" :href="withBase('/guide/')">快速开始</a>
          </div>
          <div class="hero-install">
            <CopyCommand command="npm install -g yunbox" />
            <p>命令行支持 macOS、Linux 和 Windows</p>
          </div>
        </div>
        <HeroBox />
      </div>
    </section>

    <section class="section section-alt">
      <div class="wrap">
        <header class="section-head">
          <h2>一次推送，分两条路走</h2>
          <p>代码和几行指针照旧去代码托管平台；素材由本机的传输代理签名后，直接上传到你的 bucket。没有要部署、要续费、要盯着的服务端。</p>
        </header>
        <PushFlow />
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <header class="section-head">
          <h2>接入只要几条命令</h2>
          <p>管理员给仓库接一次 COS，再给每位协作者开一个子账号。协作者登录后 clone，素材自动下载。哪里不对，先跑 <code>yunbox doctor</code>，每一项都附修复命令。</p>
        </header>
        <div class="narrow">
          <TerminalDemo />
        </div>
      </div>
    </section>

    <section class="section section-alt">
      <div class="wrap">
        <header class="section-head">
          <h2>推送之前，先看看有多大</h2>
          <p>
            macOS 客户端和 <code>yunbox inspect --push</code> 用同一套检查：分别统计 Git pack 和 LFS 候选量，按大小列出每个文件，超出预算的标出来。下面的窗口可以直接操作。
          </p>
        </header>
        <InspectorMock />
        <p class="confirm-lead">
          用 <code>yunbox hook install --confirm</code> 装上推送钩子后，超出预算的 <code>git push</code> 不会被直接拦下，而是弹出下面的对话框：推到哪个远端、哪些文件超限、每个文件多大，看完再决定取消还是继续。
        </p>
        <ConfirmDialogMock />
        <p class="section-foot">
          <a :href="withBase('/inspect')">推送检查的统计口径</a>
          <a :href="withBase('/inspect#超限确认')">超限时如何确认</a>
          <a :href="withBase('/guide/macos')">macOS 客户端的全部功能</a>
        </p>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <header class="section-head">
          <h2>到点不让推送</h2>
          <p>
            用 <code>opening_hours</code> 写法设定禁推时段，例如 <code>Mo-Fr 09:00-18:00; We off</code>。本仓库、团队、全局三层规则同时生效，命中时推送在上传前被中断；紧急修复时 <code>yunbox freeze off --for 1h</code> 快速关闭，规则保留，到点自动恢复。
          </p>
        </header>
        <div class="freeze-grid">
          <div class="freeze-copy">
            <h3>菜单栏里随时看到</h3>
            <p>当前仓库处在禁推时段时，菜单栏的云匣图标右上角会多一个圆点。点开面板：现在能不能推、今天和未来 7 天的禁推分布、每个项目的规则。勾选预设就能设置，右上角的开关和定时按钮可以一次关闭所有仓库。这里的演示面板可以直接操作：勾选预设、拨动开关试试。</p>
            <pre class="freeze-commands" aria-label="命令行示例"><code><span>yunbox freeze set "Mo-Fr 09:00-18:00"</span>
<span>yunbox freeze off --until 18:00</span>
<span>yunbox freeze check --json</span></code></pre>

            <h3>交给 AI 接入</h3>
            <p>客户端的 COS 面板里有「复制给 AI 的接入说明」，粘贴给 Claude Code、Codex 或 Cursor 即可。云匣的命令都不需要交互、都有 JSON 输出，编程助手可以自己检查、接入、设时段；只有保存腾讯云密钥这一步留给你自己。</p>
            <p class="freeze-links">
              <a :href="withBase('/guide/freeze')">禁推时段的写法和场景</a>
              <a :href="withBase('/guide/ai')">用 AI 编程助手接入</a>
            </p>
          </div>
          <FreezePanelMock />
        </div>
      </div>
    </section>

    <section class="section section-alt">
      <div class="wrap">
        <header class="section-head">
          <h2>密钥不离开你的电脑</h2>
          <p>仓库里只记录素材放在哪个 bucket、哪个前缀。访问 COS 的密钥每人一把，存在各自电脑的钥匙串里。</p>
        </header>
        <KeyBoundary />
      </div>
    </section>

    <section id="download" class="section">
      <div class="wrap">
        <header class="section-head">
          <h2>下载云匣</h2>
          <p>图形界面适合日常查看和接入；命令行负责传输，每位协作者都需要安装。两者可以同时使用。</p>
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

.hero-lead code,
.section-head code,
.confirm-lead code,
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
