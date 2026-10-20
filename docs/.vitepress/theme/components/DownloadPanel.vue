<script setup lang="ts">
/**
 * Download choices: the macOS client from the newest GitHub release and the
 * cross-platform CLI from npm. The visitor's own platform is listed first.
 */
import { withBase } from 'vitepress'
import { computed, onMounted, ref } from 'vue'
import { formatBytes } from '../demo-assets'
import { useCopy, useLocalePath } from '../i18n'
import { CLI_VERSION, MACOS_DOWNLOAD_URL, REPOSITORY, useLatestRelease } from '../release'
import CopyCommand from './CopyCommand.vue'
import SymbolIcon from './SymbolIcon.vue'

const t = useCopy({
  zh: {
    macTitle: '云匣 for macOS',
    macLead: '选择仓库就能看推送体积、超限文件和 COS 直连状态，也能在窗口里保存密钥、一键接入 bucket。',
    download: '下载 YunBox-macOS.zip',
    universal: 'Apple 芯片和 Intel 通用',
    separator: '，',
    pending: '带安装包的版本还没有发布。现在可以从源码构建，安装到「应用程序」：',
    macNeeds: ['macOS 14 或更新', '本机 Node.js 22.18+，客户端用它运行内置的检查组件', 'git-lfs 3.2+（', '）'],
    firstOpen: '第一次打开被 macOS 拦下？',
    firstOpenBody: '安装包还没有经过 Apple 公证。解压后把 YunBox 拖进「应用程序」，第一次打开如果提示无法验证开发者，到「系统设置 → 隐私与安全性」点「仍要打开」；也可以在终端运行：',
    cliTitle: '命令行',
    forYour: (platform: string) => `适用于你的 ${platform}`,
    cliLead: ['macOS、Linux、Windows 都能用。安装后同时得到 ', ' 和 ', '，', ' 和 ', ' 完全一样。'],
    cliMeta: (version: string) => `最新 v${version}，由 GitHub Actions 发布并附带 provenance`,
    cliNeeds: ['Git 2.30+ 和 git-lfs 3.2+', 'Windows 上使用 Git for Windows 自带的 git-lfs'],
    quickStart: '快速开始',
    releases: '全部版本',
    npm: 'npm 页面',
  },
  en: {
    macTitle: 'YunBox for macOS',
    macLead: 'Pick a repository to see its push size, files over budget and COS connection status. You can also save your key and connect a bucket right from the window.',
    download: 'Download YunBox-macOS.zip',
    universal: 'Universal (Apple silicon and Intel)',
    separator: ' · ',
    pending: 'No release with the app has been published yet. For now, build it from source and install it into Applications:',
    macNeeds: ['macOS 14 or later', 'Node.js 22.18+ on your Mac; the app uses it to run its built-in checks', 'git-lfs 3.2+ (', ')'],
    firstOpen: 'Blocked by macOS on first launch?',
    firstOpenBody: 'The app is not notarized by Apple yet. Unzip it and drag YunBox into Applications. If the first launch says the developer cannot be verified, go to System Settings → Privacy & Security and click Open Anyway, or run this in Terminal:',
    cliTitle: 'Command line',
    forYour: (platform: string) => `For your ${platform}`,
    cliLead: ['Works on macOS, Linux and Windows. Installing it gives you both ', ' and ', '; ', ' and ', ' are the same thing.'],
    cliMeta: (version: string) => `Latest v${version}, published by GitHub Actions with provenance`,
    cliNeeds: ['Git 2.30+ and git-lfs 3.2+', 'On Windows, the git-lfs bundled with Git for Windows'],
    quickStart: 'Quick Start',
    releases: 'All releases',
    npm: 'npm package',
  },
})
const localePath = useLocalePath()
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
  t.value.universal,
].filter(Boolean).join(t.value.separator))
const cliFirst = computed(() => platform.value === 'windows' || platform.value === 'linux')
const platformName = computed(() => ({ windows: 'Windows', linux: 'Linux', mac: 'macOS', other: '' })[platform.value])
</script>

<template>
  <div class="downloads" :class="{ 'cli-first': cliFirst }">
    <section class="option option-mac" aria-labelledby="dl-mac">
      <img class="app-icon" :src="withBase('/yunbox-app-icon.svg')" alt="" width="88" height="88">
      <h3 id="dl-mac">
        {{ t.macTitle }}
      </h3>
      <p class="lead">
        {{ t.macLead }}
      </p>
      <template v-if="macReady">
        <a class="primary" :href="macUrl">
          <SymbolIcon name="arrow.down.circle" />
          {{ t.download }}
        </a>
        <p class="meta">
          {{ macMeta }}
        </p>
      </template>
      <template v-else>
        <p class="pending">
          {{ t.pending }}
        </p>
        <CopyCommand command="./script/build_and_run.sh --install" />
      </template>
      <ul class="needs">
        <li>{{ t.macNeeds[0] }}</li>
        <li>{{ t.macNeeds[1] }}</li>
        <li>{{ t.macNeeds[2] }}<code>brew install git-lfs</code>{{ t.macNeeds[3] }}</li>
      </ul>
      <details class="first-open">
        <summary>{{ t.firstOpen }}</summary>
        <p>
          {{ t.firstOpenBody }}
        </p>
        <CopyCommand command="xattr -dr com.apple.quarantine /Applications/YunBox.app" />
      </details>
    </section>

    <section class="option" aria-labelledby="dl-cli">
      <span class="cli-icon"><SymbolIcon name="terminal" /></span>
      <h3 id="dl-cli">
        {{ t.cliTitle }}
        <span v-if="cliFirst" class="here">{{ t.forYour(platformName) }}</span>
      </h3>
      <p class="lead">
        {{ t.cliLead[0] }}<code>yunbox</code>{{ t.cliLead[1] }}<code>git-yunbox</code>{{ t.cliLead[2] }}<code>git yunbox init</code>{{ t.cliLead[3] }}<code>yunbox init</code>{{ t.cliLead[4] }}
      </p>
      <CopyCommand command="npm install -g yunbox" />
      <p class="meta">
        {{ t.cliMeta(CLI_VERSION) }}
      </p>
      <ul class="needs">
        <li>Node.js 22.18+</li>
        <li>{{ t.cliNeeds[0] }}</li>
        <li>{{ t.cliNeeds[1] }}</li>
      </ul>
      <p class="links">
        <a :href="localePath('/guide/')">{{ t.quickStart }}</a>
        <a :href="`${REPOSITORY}/releases`">{{ t.releases }}</a>
        <a href="https://www.npmjs.com/package/yunbox">{{ t.npm }}</a>
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
  align-items: center;
  gap: 14px;
  min-width: 0;
  padding: 36px 32px 28px;
  border-radius: 22px;
  background: var(--yb-window);
  box-shadow: 0 0 0 0.5px var(--yb-separator), 0 2px 8px -2px rgb(0 0 0 / 0.08);
  text-align: center;
}

.app-icon {
  width: 88px;
  height: 88px;
  border-radius: 22.37%;
  box-shadow: var(--yb-shadow-icon);
}

.cli-icon {
  display: grid;
  place-items: center;
  width: 88px;
  height: 88px;
  border-radius: 22.37%;
  background: linear-gradient(#3a3a3c, #1c1c1e);
  box-shadow: 0 12px 32px -10px rgb(0 0 0 / 0.5);
  color: #fff;
  font-size: 46px;
}

.option h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0 0;
  color: var(--yb-label);
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.here {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--yb-accent-soft);
  color: var(--yb-accent);
  font-size: 12px;
  font-weight: 500;
}

.lead,
.pending {
  max-width: 30em;
  margin: 0;
  color: var(--yb-label-2);
  font-size: 15px;
  line-height: 1.7;
}

.option code,
.first-open code {
  padding: 0;
  background: none;
  color: var(--yb-label);
  font-family: var(--yb-font-mono);
  font-size: 0.9em;
}

.option > :deep(.copy) {
  width: 100%;
  text-align: left;
}

.primary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  padding: 11px 24px;
  border-radius: 999px;
  background: var(--yb-accent);
  color: #fff;
  font-size: 16px;
  font-weight: 500;
  text-decoration: none;
  transition: background-color 120ms;
}

.primary:hover {
  background: var(--yb-accent-hover);
}

.primary:focus-visible,
.links a:focus-visible,
.first-open summary:focus-visible {
  outline: 2px solid var(--yb-accent);
  outline-offset: 3px;
}

.meta {
  margin: -4px 0 0;
  color: var(--yb-label-3);
  font-size: 13px;
}

.needs {
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
  color: var(--yb-label-2);
  font-size: 13.5px;
  line-height: 1.9;
}

.first-open {
  width: 100%;
  margin-top: auto;
  padding-top: 14px;
  border-top: 0.5px solid var(--yb-separator);
  color: var(--yb-label-2);
  font-size: 13.5px;
  line-height: 1.7;
  text-align: left;
}

.first-open summary {
  cursor: pointer;
  color: var(--yb-accent);
  text-align: center;
}

.first-open p {
  margin: 10px 0;
}

.links {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 22px;
  width: 100%;
  margin: auto 0 0;
  padding-top: 14px;
  border-top: 0.5px solid var(--yb-separator);
}

.links a {
  color: var(--yb-accent);
  font-size: 14px;
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
    padding: 28px 20px 22px;
  }
}
</style>
