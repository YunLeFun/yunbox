<script setup lang="ts">
/** The landing page: hero, how a push travels, setup, push check, keys, downloads. */
import { withBase } from 'vitepress'
import ConfirmDialogMock from './ConfirmDialogMock.vue'
import CopyCommand from './CopyCommand.vue'
import DownloadPanel from './DownloadPanel.vue'
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
          <h2>密钥不离开你的电脑</h2>
          <p>仓库里只记录素材放在哪个 bucket、哪个前缀。访问 COS 的密钥每人一把，存在各自电脑的钥匙串里。</p>
        </header>
        <KeyBoundary />
      </div>
    </section>

    <section id="download" class="section section-alt">
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
.confirm-lead code {
  padding: 0;
  background: none;
  color: var(--yb-label);
  font-family: var(--yb-font-mono);
  font-size: 0.86em;
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
.section-foot a:focus-visible {
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

@media (max-width: 960px) {
  .hero-grid {
    grid-template-columns: 1fr;
    gap: 48px;
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

  .confirm-lead {
    margin-top: 40px;
    font-size: 15px;
    text-align: left;
  }
}
</style>
