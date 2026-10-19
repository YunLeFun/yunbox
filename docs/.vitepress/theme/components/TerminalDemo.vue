<script setup lang="ts">
/**
 * Replays the three everyday YunBox sessions in a terminal. Output lines are
 * the CLI's own wording (`✓ title：detail`), with sample bucket names.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'

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

const SESSIONS: Session[] = [
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
]

const active = ref(SESSIONS[0].id)
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
  const session = SESSIONS.find(entry => entry.id === id)!
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
    <div class="tabs" role="tablist" aria-label="命令行示例">
      <button
        v-for="session in SESSIONS"
        :id="`term-tab-${session.id}`"
        :key="session.id"
        class="tab"
        role="tab"
        type="button"
        :aria-selected="active === session.id"
        aria-controls="term-panel"
        @click="replay(session.id)"
      >
        <span class="tab-label">{{ session.label }}</span>
        <span class="tab-who">{{ session.who }}</span>
      </button>
    </div>
    <div id="term-panel" class="term" role="tabpanel" :aria-labelledby="`term-tab-${active}`">
      <div class="term-bar" aria-hidden="true">
        <i /><i /><i />
      </div>
      <pre class="term-body"><template v-for="(line, index) in shown" :key="index"><span v-if="line.type === 'cmd'" class="line"><span class="prompt">$ </span>{{ line.text }}</span><span v-else class="line" :class="[line.type, line.tone]">{{ line.text }}</span>
</template><span v-if="typing" class="line"><span class="prompt">$ </span>{{ typing }}<span class="caret" /></span></pre>
    </div>
  </div>
</template>

<style scoped>
.term-wrap {
  display: grid;
  grid-template-columns: minmax(200px, 260px) 1fr;
  gap: 20px;
}

.tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tab {
  display: grid;
  gap: 2px;
  padding: 12px 14px;
  border-left: 3px solid transparent;
  text-align: left;
  border-radius: 0 var(--yb-radius-sm) var(--yb-radius-sm) 0;
}

.tab[aria-selected='true'] {
  border-left-color: var(--yb-blue);
  background: var(--yb-sheet);
}

.tab:focus-visible {
  outline: 2px solid var(--yb-blue);
  outline-offset: 2px;
}

.tab-label {
  color: var(--yb-ink);
  font-weight: 600;
  font-size: 15px;
}

.tab-who {
  color: var(--yb-ink-soft);
  font-size: 13px;
}

.term {
  min-width: 0;
  border-radius: var(--yb-radius-lg);
  background: var(--yb-term-bg);
  overflow: hidden;
}

.term-bar {
  display: flex;
  gap: 6px;
  padding: 12px 14px 0;
}

.term-bar i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #34466e;
}

.term-body {
  margin: 0;
  padding: 14px 18px 20px;
  min-height: 330px;
  color: var(--yb-term-ink);
  font-family: var(--yb-font-mono);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.prompt {
  color: var(--yb-sky);
  user-select: none;
}

.note,
.dim {
  color: var(--yb-term-dim);
}

.pass {
  color: #9be7b4;
}

.warn {
  color: #f5c46b;
}

.caret {
  display: inline-block;
  width: 0.55em;
  height: 1.1em;
  vertical-align: text-bottom;
  background: var(--yb-term-ink);
  animation: blink 1s steps(2) infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

@media (max-width: 760px) {
  .term-wrap {
    grid-template-columns: 1fr;
  }

  .tabs {
    flex-direction: row;
    overflow-x: auto;
  }

  .tab {
    flex: 1 0 auto;
    border-left: 0;
    border-bottom: 3px solid transparent;
    border-radius: var(--yb-radius-sm) var(--yb-radius-sm) 0 0;
  }

  .tab[aria-selected='true'] {
    border-bottom-color: var(--yb-blue);
  }

  .tab-who {
    display: none;
  }

  .term-body {
    font-size: 12px;
    min-height: 300px;
  }
}
</style>
