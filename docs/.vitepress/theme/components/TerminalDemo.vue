<script setup lang="ts">
/**
 * Replays the three everyday YunBox sessions in a terminal. Output lines are
 * the CLI's own wording (`✓ title：detail`), with sample bucket names.
 */
import type { SiteLang } from '../i18n'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useCopy, useSiteLang } from '../i18n'
import MacWindow from './MacWindow.vue'

interface Line {
  /** `cmd` is typed after a prompt; `out` appears at once */
  type: 'cmd' | 'out' | 'note'
  text: string
  /** Colour for status symbols */
  tone?: 'pass' | 'warn' | 'dim'
}

interface Session {
  id: string
  label: string
  who: string
  lines: Line[]
}

// The CLI prints Chinese only for now; the English page shows its output
// translated and says so under the terminal.
const SESSIONS: Record<SiteLang, Session[]> = {
  zh: [
    {
      id: 'admin',
      label: '管理员接入仓库',
      who: '第一次给仓库接上 COS，只做一次',
      lines: [
        { type: 'cmd', text: 'tccli auth login' },
        { type: 'note', text: '# 浏览器登录腾讯云，用管理员身份' },
        { type: 'cmd', text: 'git yunbox init' },
        { type: 'out', text: '✓ COS 密钥：来自 tccli 登录，只保存在本机，不会写进仓库', tone: 'pass' },
        { type: 'out', text: '账号下的 bucket：' },
        { type: 'out', text: '   1) team-assets-1250000000（ap-shanghai）' },
        { type: 'out', text: '选择 bucket 编号，或输入 n 新建私有 bucket：1' },
        { type: 'out', text: 'bucket 里的目录前缀 [yunbox/team/game]：' },
        { type: 'out', text: '✓ COS 权限：可以在 team-assets-1250000000（ap-shanghai）/yunbox/team/game/ 写入和读取', tone: 'pass' },
        { type: 'out', text: '✓ 传输代理：本仓库的 git-lfs 改用 git-yunbox lfs-agent 直连 COS（写在 .git/config，只对这份 clone 生效）', tone: 'pass' },
        { type: 'cmd', text: 'git add .gitattributes .yunbox/config && git commit -m "chore: 用 YunBox 把 LFS 素材直传到 COS"' },
        { type: 'cmd', text: 'yunbox subaccount create yunbox-alice --show-key' },
        { type: 'note', text: '# 给协作者开一个只能读写这个前缀的子账号，密钥只显示这一次' },
      ],
    },
    {
      id: 'member',
      label: '协作者加入',
      who: '新同事拿到子账号密钥后',
      lines: [
        { type: 'cmd', text: 'npm install -g yunbox' },
        { type: 'cmd', text: 'yunbox login' },
        { type: 'note', text: '# 输入管理员给你的 SecretId 和 SecretKey，SecretKey 输入时不显示' },
        { type: 'out', text: '✓ 密钥有效：这个子账号不能列出 bucket，这是受限子账号的正常情况', tone: 'pass' },
        { type: 'out', text: '✓ 已保存：macOS 钥匙串（yunbox）', tone: 'pass' },
        { type: 'cmd', text: 'git yunbox clone git@github.com:team/game.git' },
        { type: 'note', text: '# 拉取代码历史，接上传输代理，再下载素材' },
        { type: 'out', text: '完成：cd game' },
      ],
    },
    {
      id: 'doctor',
      label: '出问题时体检',
      who: '推不上去、拉不下来，先跑这一条',
      lines: [
        { type: 'cmd', text: 'yunbox doctor' },
        { type: 'out', text: '✓ git：2.47.1', tone: 'pass' },
        { type: 'out', text: '✓ git-lfs：3.6.1', tone: 'pass' },
        { type: 'out', text: '✓ Git 仓库：/Users/alice/game', tone: 'pass' },
        { type: 'out', text: '✓ LFS 过滤器：已启用', tone: 'pass' },
        { type: 'out', text: '✓ COS 位置：team-assets-1250000000（ap-shanghai）/yunbox/team/game/（来自 .yunbox/config）', tone: 'pass' },
        { type: 'out', text: '✓ 传输代理：git-lfs 通过 git-yunbox 直连 COS', tone: 'pass' },
        { type: 'out', text: '✓ COS 密钥：来自 macOS 钥匙串（yunbox）', tone: 'pass' },
        { type: 'out', text: '✓ COS 权限：可以写入和读取', tone: 'pass' },
        { type: 'out', text: '' },
        { type: 'out', text: '全部检查通过，可以推送和拉取素材。' },
      ],
    },
  ],
  en: [
    {
      id: 'admin',
      label: 'Admin sets up a repository',
      who: 'Connecting a repository to Cloudflare R2, done once',
      lines: [
        { type: 'note', text: '# In the Cloudflare dashboard: a bucket for this project, and an API token for it with Object Read & Write' },
        { type: 'cmd', text: 'yunbox login --provider s3' },
        { type: 'note', text: '# Paste the token\'s Access Key ID and Secret Access Key; the secret is hidden as you type' },
        { type: 'out', text: '✓ Saved: macOS Keychain (yunbox / s3)', tone: 'pass' },
        { type: 'cmd', text: 'git yunbox init --preset r2 --account-id 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d --bucket team-game-assets' },
        { type: 'out', text: '✓ S3 key: from macOS Keychain (yunbox / s3), kept on this machine only, never written to the repository', tone: 'pass' },
        { type: 'out', text: '! R2 permission scope: an R2 API token can be limited to buckets, not to prefixes', tone: 'warn' },
        { type: 'out', text: '✓ S3 permissions: can write and read team-game-assets (1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.r2.cloudflarestorage.com)/yunbox/team/game/', tone: 'pass' },
        { type: 'out', text: '✓ Transfer agent: git-lfs in this repository now goes straight to S3 through git-yunbox lfs-agent (set in .git/config, for this clone only)', tone: 'pass' },
        { type: 'cmd', text: 'git add .gitattributes .yunbox/config && git commit -m "chore: store LFS assets in S3 with YunBox"' },
        { type: 'note', text: '# Give each collaborator an R2 token of their own for this bucket' },
      ],
    },
    {
      id: 'member',
      label: 'Collaborator joins',
      who: 'A new teammate with their own R2 token',
      lines: [
        { type: 'cmd', text: 'npm install -g yunbox' },
        { type: 'cmd', text: 'yunbox login --provider s3' },
        { type: 'note', text: '# Enter the Access Key ID and Secret Access Key of your token; the secret is hidden as you type' },
        { type: 'out', text: '✓ Saved: macOS Keychain (yunbox / s3)', tone: 'pass' },
        { type: 'cmd', text: 'git yunbox clone git@github.com:team/game.git' },
        { type: 'note', text: '# Clones the history, hooks up the transfer agent, then downloads the assets' },
        { type: 'out', text: 'Done: cd game' },
      ],
    },
    {
      id: 'doctor',
      label: 'Check-up when stuck',
      who: 'Push or pull failing? Run this first',
      lines: [
        { type: 'cmd', text: 'yunbox doctor' },
        { type: 'out', text: '✓ git: 2.47.1', tone: 'pass' },
        { type: 'out', text: '✓ git-lfs: 3.6.1', tone: 'pass' },
        { type: 'out', text: '✓ Git repository: /Users/alice/game', tone: 'pass' },
        { type: 'out', text: '✓ LFS filter: enabled', tone: 'pass' },
        { type: 'out', text: '✓ S3 location: team-game-assets (1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.r2.cloudflarestorage.com)/yunbox/team/game/ (from .yunbox/config)', tone: 'pass' },
        { type: 'out', text: '✓ Transfer agent: git-lfs goes straight to S3 through git-yunbox', tone: 'pass' },
        { type: 'out', text: '✓ S3 key: from macOS Keychain (yunbox / s3)', tone: 'pass' },
        { type: 'out', text: '✓ S3 permissions: can write and read', tone: 'pass' },
        { type: 'out', text: '' },
        { type: 'out', text: 'All checks passed. You can push and pull assets.' },
      ],
    },
  ],
}

const t = useCopy({
  zh: { tabs: '命令行示例', window: '终端', note: '' },
  en: { tabs: 'Command-line examples', window: 'Terminal', note: 'The command line prints its messages in Chinese for now; they are shown in English here.' },
})
const lang = useSiteLang()
const sessions = computed(() => SESSIONS[lang.value])

const active = ref(SESSIONS.zh[0].id)
const activeSession = computed(() => sessions.value.find(entry => entry.id === active.value)!)
const shown = ref<Line[]>([])
const typing = ref('')
const root = ref<HTMLElement>()
let run = 0
let observer: IntersectionObserver | undefined

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function replay(id: string): Promise<void> {
  const token = ++run
  active.value = id
  shown.value = []
  typing.value = ''
  const session = sessions.value.find(entry => entry.id === id)!
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    shown.value = session.lines
    return
  }
  for (const line of session.lines) {
    if (line.type === 'cmd') {
      for (let i = 1; i <= line.text.length; i++) {
        if (token !== run)
          return
        typing.value = line.text.slice(0, i)
        await wait(line.text.length > 40 ? 12 : 28)
      }
      await wait(220)
      typing.value = ''
    }
    if (token !== run)
      return
    shown.value = [...shown.value, line]
    await wait(line.type === 'cmd' ? 260 : 90)
  }
}

onMounted(() => {
  observer = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting)) {
      observer?.disconnect()
      replay(active.value)
    }
  }, { threshold: 0.4 })
  observer.observe(root.value!)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  run++
})
</script>

<template>
  <div ref="root" class="term-wrap">
    <div class="segmented" role="tablist" :aria-label="t.tabs">
      <button
        v-for="session in sessions"
        :id="`term-tab-${session.id}`"
        :key="session.id"
        role="tab"
        type="button"
        :aria-selected="active === session.id"
        aria-controls="term-panel"
        @click="replay(session.id)"
      >
        {{ session.label }}
      </button>
    </div>
    <p class="who">
      {{ activeSession.who }}
    </p>
    <MacWindow :label="t.window" title="zsh — game">
      <div id="term-panel" role="tabpanel" :aria-labelledby="`term-tab-${active}`">
        <pre class="term-body"><template v-for="(line, index) in shown" :key="index"><span v-if="line.type === 'cmd'" class="line"><span class="prompt">~/game % </span>{{ line.text }}</span><span v-else class="line" :class="[line.type, line.tone]">{{ line.text }}</span>
</template><span v-if="typing" class="line"><span class="prompt">~/game % </span>{{ typing }}<span class="caret" /></span></pre>
      </div>
    </MacWindow>
    <p v-if="t.note" class="term-note">
      {{ t.note }}
    </p>
  </div>
</template>

<style scoped>
.term-wrap {
  display: grid;
  justify-items: center;
  gap: 14px;
}

.term-wrap > :deep(.mac-window) {
  width: 100%;
}

.segmented {
  display: inline-flex;
  padding: 2px;
  border-radius: 9px;
  background: var(--yb-fill-strong);
  max-width: 100%;
  overflow-x: auto;
}

.segmented button {
  flex: none;
  padding: 6px 18px;
  border-radius: 7px;
  color: var(--yb-label);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
}

.segmented button[aria-selected='true'] {
  background: var(--yb-window);
  box-shadow: 0 0 0 0.5px var(--yb-separator), 0 1px 3px rgb(0 0 0 / 0.12);
}

.segmented button:focus-visible {
  outline: 2px solid var(--yb-accent);
  outline-offset: 1px;
}

.who {
  margin: 0 0 6px;
  color: var(--yb-label-2);
  font-size: 14px;
}

.term-note {
  margin: 10px 0 0;
  color: var(--yb-label-3);
  font-size: 13px;
  text-align: center;
}

.term-body {
  margin: 0;
  padding: 14px 18px 20px;
  min-height: 340px;
  background: var(--yb-term-bg);
  color: var(--yb-term-text);
  font-family: var(--yb-font-mono);
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.prompt {
  color: var(--yb-term-prompt);
  user-select: none;
}

.note,
.dim {
  color: var(--yb-term-dim);
}

.pass {
  color: var(--yb-term-green);
}

.warn {
  color: var(--yb-orange-text);
}

.caret {
  display: inline-block;
  width: 0.55em;
  height: 1.1em;
  vertical-align: text-bottom;
  background: var(--yb-term-text);
  opacity: 0.6;
  animation: blink 1s steps(2) infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

@media (max-width: 760px) {
  .segmented button {
    padding: 6px 12px;
    font-size: 13px;
  }

  .term-body {
    font-size: 11.5px;
    min-height: 300px;
  }
}
</style>
