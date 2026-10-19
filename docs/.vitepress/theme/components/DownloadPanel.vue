<script setup lang="ts">
/**
 * Download choices: the macOS client from the newest GitHub release and the
 * cross-platform CLI from npm. The visitor's own platform is listed first.
 */
import { withBase } from 'vitepress'
import { computed, onMounted, ref } from 'vue'
import { formatBytes } from '../demo-assets'
import { CLI_VERSION, MACOS_DOWNLOAD_URL, REPOSITORY, useLatestRelease } from '../release'
import CopyCommand from './CopyCommand.vue'

const release = useLatestRelease()
const platform = ref<'mac' | 'windows' | 'linux' | 'other'>('other')

onMounted(() => {
  const agent = navigator.userAgent
  // Phones and tablets report Linux or Mac OS X too, but cannot run either download.
  if (/Android|iPhone|iPad|Mobile/.test(agent))
    platform.value = 'other'
  else
    platform.value = /Mac OS X|Macintosh/.test(agent) ? 'mac' : /Windows/.test(agent) ? 'windows' : /Linux|X11/.test(agent) ? 'linux' : 'other'
})

// Without a release that carries the zip, the button would lead to a 404.
// When GitHub could not be asked at all, offer the link and let it resolve.
const macReady = computed(() => release.value.state === 'unknown' || release.value.macosUrl !== undefined)
const macUrl = computed(() => release.value.macosUrl ?? MACOS_DOWNLOAD_URL)
const macMeta = computed(() => [
  release.value.tag ?? `v${CLI_VERSION}`,
  release.value.macosBytes === undefined ? undefined : formatBytes(release.value.macosBytes),
  'Apple 芯片和 Intel 通用',
].filter(Boolean).join('，'))
const cliFirst = computed(() => platform.value === 'windows' || platform.value === 'linux')
const platformName = computed(() => ({ windows: 'Windows', linux: 'Linux', mac: 'macOS', other: '' })[platform.value])
</script>

<template>
  <div class="downloads" :class="{ 'cli-first': cliFirst }">
    <section class="option option-mac" aria-labelledby="dl-mac">
      <img class="option-icon" :src="withBase('/yunbox-app-icon.svg')" alt="" width="56" height="56">
      <h3 id="dl-mac">
        macOS 客户端
      </h3>
      <p class="option-lead">
        选择仓库就能看推送体积、超限文件和 COS 直连状态，也能在窗口里保存密钥、一键接入 bucket。
      </p>
      <template v-if="macReady">
        <a class="primary" :href="macUrl">下载 YunBox-macOS.zip</a>
        <p class="meta">
          {{ macMeta }}
        </p>
      </template>
      <template v-else>
        <p class="pending">
          带 macOS 安装包的版本还没有发布。现在可以从源码构建并安装到「应用程序」：
        </p>
        <CopyCommand command="./script/build_and_run.sh --install" />
      </template>
      <ul class="needs">
        <li>macOS 14 或更新</li>
        <li>本机安装 Node.js 22.18+，客户端用它运行内置的检查组件</li>
        <li>git-lfs 3.2+（<code>brew install git-lfs</code>）</li>
      </ul>
      <details class="first-open">
        <summary>第一次打开被 macOS 拦下？</summary>
        <p>
          目前的安装包还没有经过 Apple 公证。解压后把 YunBox 拖进「应用程序」，第一次打开时如果提示无法验证开发者，到「系统设置 → 隐私与安全性」点「仍要打开」；也可以在终端运行：
        </p>
        <CopyCommand command="xattr -dr com.apple.quarantine /Applications/YunBox.app" />
      </details>
    </section>

    <section class="option" aria-labelledby="dl-cli">
      <h3 id="dl-cli">
        命令行<span v-if="cliFirst" class="here">适用于你的 {{ platformName }}</span>
      </h3>
      <p class="option-lead">
        macOS、Linux、Windows 都能用。安装后同时得到 <code>yunbox</code> 和 <code>git-yunbox</code>，<code>git yunbox init</code> 和 <code>yunbox init</code> 完全一样。
      </p>
      <CopyCommand command="npm install -g yunbox" />
      <p class="meta">
        最新 v{{ CLI_VERSION }}，由 GitHub Actions 发布并附带 provenance
      </p>
      <ul class="needs">
        <li>Node.js 22.18+</li>
        <li>Git 2.30+ 和 git-lfs 3.2+</li>
        <li>Windows 上使用 Git for Windows 自带的 git-lfs</li>
      </ul>
      <p class="links">
        <a href="./guide/">快速开始</a>
        <a :href="`${REPOSITORY}/releases`">全部版本</a>
        <a href="https://www.npmjs.com/package/yunbox">npm 页面</a>
      </p>
    </section>
  </div>
</template>

<style scoped>
.downloads {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px;
}

.cli-first .option-mac {
  order: 2;
}

.option {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 28px;
  border: 1.5px solid var(--yb-line);
  border-radius: var(--yb-radius-lg);
  background: var(--yb-sheet);
  min-width: 0;
}

.option-mac {
  border-color: var(--yb-blue);
}

.option-icon {
  width: 56px;
  height: 56px;
  border-radius: 13px;
}

.option h3 {
  margin: 0;
  color: var(--yb-ink);
  font-size: 22px;
  font-weight: 700;
}

.here {
  margin-left: 10px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--vp-c-brand-soft);
  color: var(--yb-blue);
  font-size: 12px;
  font-weight: 600;
  vertical-align: middle;
}

.option-lead,
.pending {
  margin: 0;
  color: var(--yb-ink-soft);
  font-size: 15px;
  line-height: 1.7;
}

.option code,
.first-open code {
  font-family: var(--yb-font-mono);
  font-size: 0.9em;
  color: var(--yb-ink);
}

.primary {
  align-self: flex-start;
  margin-top: 4px;
  padding: 11px 22px;
  border-radius: 999px;
  background: var(--yb-action);
  color: #fff;
  font-weight: 700;
  text-decoration: none;
}

.primary:hover {
  background: var(--yb-action-hover);
}

.primary:focus-visible,
.links a:focus-visible,
.first-open summary:focus-visible {
  outline: 2px solid var(--yb-ink);
  outline-offset: 3px;
}

.meta {
  margin: -4px 0 0;
  color: var(--yb-ink-soft);
  font-size: 13px;
}

.needs {
  margin: 4px 0 0;
  padding-left: 1.2em;
  color: var(--yb-ink);
  font-size: 14px;
  line-height: 1.8;
}

.first-open {
  margin-top: auto;
  padding-top: 12px;
  border-top: 1px solid var(--yb-line);
  color: var(--yb-ink-soft);
  font-size: 14px;
  line-height: 1.7;
}

.first-open summary {
  cursor: pointer;
  color: var(--yb-ink);
  font-weight: 600;
}

.first-open p {
  margin: 8px 0;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin: auto 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--yb-line);
}

.links a {
  color: var(--yb-blue);
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
}

.links a:hover {
  text-decoration: underline;
}

@media (max-width: 860px) {
  .downloads {
    grid-template-columns: 1fr;
  }

  .option {
    padding: 22px;
  }
}
</style>
