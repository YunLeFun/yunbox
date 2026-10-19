<script setup lang="ts">
/** The landing page: hero, how a push travels, setup, push check, keys, downloads. */
import { withBase } from 'vitepress'
import CopyCommand from './CopyCommand.vue'
import DownloadPanel from './DownloadPanel.vue'
import HeroBox from './HeroBox.vue'
import InspectorMock from './InspectorMock.vue'
import KeyBoundary from './KeyBoundary.vue'
import PushFlow from './PushFlow.vue'
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
            <a class="btn btn-primary" href="#download">下载 macOS 客户端</a>
            <a class="btn btn-ghost" :href="withBase('/guide/')">快速开始</a>
          </div>
          <div class="hero-install">
            <CopyCommand command="npm install -g yunbox" />
            <p>命令行支持 macOS、Linux 和 Windows</p>
          </div>
        </div>
        <HeroBox />
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <header class="section-head">
          <h2>一次推送，分两条路走</h2>
          <p>代码和几行指针照旧去代码托管平台；素材由本机的传输代理签名后，直接上传到你的 bucket。没有要部署、要续费、要盯着的服务端。</p>
        </header>
        <PushFlow />
      </div>
    </section>

    <section class="section section-sheet">
      <div class="wrap">
        <header class="section-head">
          <h2>接入只要几条命令</h2>
          <p>管理员给仓库接一次 COS，再给每位协作者开一个子账号。协作者登录后 clone，素材自动下载。哪里不对，先跑 <code>yunbox doctor</code>，每一项都附修复命令。</p>
        </header>
        <TerminalDemo />
      </div>
    </section>

    <section class="section">
      <div class="wrap inspector-grid">
        <header class="section-head inspector-copy">
          <h2>推送之前，先看看有多大</h2>
          <p>macOS 客户端和 <code>yunbox inspect --push</code> 用同一套检查：分别统计 Git pack 和 LFS 候选量，按大小列出每个文件，超出预算的标出来。漏进 Git 的大图、意外提交的视频，在推送前就能发现。</p>
          <p>右边这个窗口可以操作：切换类型、只看超限、搜索路径，点一行看详情。</p>
          <p>
            <a class="text-link" :href="withBase('/inspect')">推送检查的统计口径</a>
          </p>
        </header>
        <InspectorMock />
      </div>
    </section>

    <section class="section section-sheet">
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
  color: var(--yb-ink);
}

.wrap {
  max-width: 1152px;
  margin: 0 auto;
  padding: 0 24px;
}

.hero {
  padding: 56px 0 72px;
  background-image: radial-gradient(var(--yb-line) 1px, transparent 1px);
  background-size: 22px 22px;
  border-bottom: 1.5px solid var(--yb-ink);
}

.hero-grid {
  display: grid;
  grid-template-columns: 1.1fr 1fr;
  align-items: center;
  gap: 56px;
}

.hero-title {
  display: grid;
  margin: 0;
  color: var(--yb-ink);
  font-size: clamp(34px, 5.6vw, 72px);
  font-weight: 900;
  line-height: 1.08;
  letter-spacing: -0.02em;
}

.hero-title span {
  white-space: nowrap;
}

.hero-title span:last-child {
  padding-left: 1em;
}

.hero-lead {
  max-width: 34em;
  margin: 28px 0 0;
  color: var(--yb-ink-soft);
  font-size: 18px;
  line-height: 1.8;
}

.hero-lead code,
.section-head code {
  font-family: var(--yb-font-mono);
  font-size: 0.88em;
  color: var(--yb-ink);
  background: none;
  padding: 0;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 32px;
}

.btn {
  padding: 12px 24px;
  border-radius: 999px;
  font-weight: 700;
  font-size: 16px;
  text-decoration: none;
  transition: background-color 150ms;
}

.btn-primary {
  background: var(--yb-action);
  color: #fff;
}

.btn-primary:hover {
  background: var(--yb-action-hover);
}

.btn-ghost {
  border: 1.5px solid var(--yb-ink);
  color: var(--yb-ink);
}

.btn-ghost:hover {
  background: var(--yb-sheet);
}

.btn:focus-visible,
.text-link:focus-visible {
  outline: 2px solid var(--yb-ink);
  outline-offset: 3px;
}

.hero-install {
  max-width: 360px;
  margin-top: 28px;
}

.hero-install p {
  margin: 8px 0 0;
  color: var(--yb-ink-soft);
  font-size: 13px;
}

.section {
  padding: 88px 0;
}

.section-sheet {
  background: var(--yb-sheet);
  border-block: 1px solid var(--yb-line);
}

.section-sheet :deep(.tab[aria-selected='true']) {
  background: var(--yb-paper);
}

.section-head {
  max-width: 40em;
  margin-bottom: 40px;
}

.section-head h2 {
  margin: 0;
  padding: 0;
  border: 0;
  color: var(--yb-ink);
  font-size: clamp(28px, 3.6vw, 40px);
  font-weight: 800;
  line-height: 1.25;
  letter-spacing: -0.01em;
}

.section-head p {
  margin: 16px 0 0;
  color: var(--yb-ink-soft);
  font-size: 16px;
  line-height: 1.8;
}

.inspector-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.75fr) 1.6fr;
  align-items: start;
  gap: 48px;
}

.inspector-copy {
  margin-bottom: 0;
  position: sticky;
  top: calc(var(--vp-nav-height) + 32px);
}

.text-link {
  color: var(--yb-blue);
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 3px;
}

@media (max-width: 960px) {
  .hero-grid,
  .inspector-grid {
    grid-template-columns: 1fr;
    gap: 40px;
  }

  .inspector-copy {
    position: static;
  }
}

@media (max-width: 640px) {
  .wrap {
    padding: 0 16px;
  }

  .hero {
    padding: 32px 0 48px;
  }

  .hero-title span:last-child {
    padding-left: 0;
  }

  .hero-lead {
    font-size: 16px;
  }

  .section {
    padding: 56px 0;
  }
}
</style>
