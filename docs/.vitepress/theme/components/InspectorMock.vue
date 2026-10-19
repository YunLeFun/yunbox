<script setup lang="ts">
/**
 * A working model of the macOS client's push check: the same budgets,
 * filters and wording as the real window, on a sample push where a PNG
 * slipped into Git instead of LFS.
 */
import { computed, ref } from 'vue'
import { demoOid, formatBytes } from '../demo-assets'

interface Row {
  path: string
  storage: 'Git' | 'LFS'
  bytes: number
}

const KIB = 1024
const MIB = 1024 * KIB
const LIMITS = { git: 900 * KIB, lfs: 100 * MIB, file: 10 * MIB }

const ROWS: Row[] = ([
  { path: 'Assets/Terrain/terrain_albedo.png', storage: 'LFS', bytes: 48 * MIB },
  { path: 'Assets/Audio/theme_loop.wav', storage: 'LFS', bytes: 21.6 * MIB },
  { path: 'Assets/Characters/boss_idle.fbx', storage: 'LFS', bytes: 4.6 * MIB },
  { path: 'Assets/UI/ui_atlas.png', storage: 'Git', bytes: 1.1 * MIB },
  { path: 'Assets/Scenes/Level01.unity', storage: 'Git', bytes: 212 * KIB },
  { path: 'Assets/Scripts/PlayerController.cs', storage: 'Git', bytes: 18 * KIB },
] satisfies Row[]).map(row => ({ ...row, bytes: Math.round(row.bytes) }))

// Git pack is compressed; this sample estimate stays a little under the raw blob sizes.
const GIT_PACK = Math.round(1.24 * MIB)
const lfsBytes = ROWS.filter(row => row.storage === 'LFS').reduce((sum, row) => sum + row.bytes, 0)
const lfsCount = ROWS.filter(row => row.storage === 'LFS').length

const kind = ref<'全部' | 'Git' | 'LFS'>('全部')
const onlyExceeded = ref(false)
const query = ref('')
const selected = ref(ROWS[3].path)

const visible = computed(() => ROWS.filter(row =>
  (kind.value === '全部' || row.storage === kind.value)
  && (!onlyExceeded.value || row.bytes > LIMITS.file)
  && (query.value === '' || row.path.toLowerCase().includes(query.value.toLowerCase()) || demoOid(row.path).startsWith(query.value.toLowerCase())),
))
const detail = computed(() => ROWS.find(row => row.path === selected.value))

const budgets = [
  { title: 'Git pack', value: GIT_PACK, limit: LIMITS.git, footnote: '压缩后的预计上传量' },
  { title: 'LFS 候选', value: lfsBytes, limit: LIMITS.lfs, footnote: `${lfsCount} 个素材对象` },
]

function ratio(value: number, limit: number): string {
  return `${Math.min(value / limit, 1) * 100}%`
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
</script>

<template>
  <div class="window" role="group" aria-label="macOS 客户端推送检查示意">
    <div class="titlebar">
      <span class="lights" aria-hidden="true"><i /><i /><i /></span>
      <span class="title">game</span>
      <span class="cos-pill">直连 COS · 正常</span>
    </div>
    <div class="body">
      <aside class="recents" aria-label="最近的仓库">
        <p class="recents-head">
          最近的仓库
        </p>
        <p class="recent recent-active">
          game <kbd>⌘1</kbd>
        </p>
        <p class="recent">
          life <kbd>⌘2</kbd>
        </p>
        <p class="recent">
          art-library <kbd>⌘3</kbd>
        </p>
      </aside>

      <section class="report">
        <div class="report-head">
          <span class="status">超过预算</span>
          <span class="muted">单文件预算 {{ formatBytes(LIMITS.file) }}</span>
        </div>

        <div class="budgets">
          <div v-for="budget in budgets" :key="budget.title" class="budget" :class="{ over: budget.value > budget.limit }">
            <p class="budget-title">
              {{ budget.title }}
            </p>
            <p class="budget-value">
              {{ formatBytes(budget.value) }}
            </p>
            <div class="meter" aria-hidden="true">
              <span :style="{ width: ratio(budget.value, budget.limit) }" />
            </div>
            <p class="muted small">
              预算 {{ formatBytes(budget.limit) }}，{{ budget.footnote }}
            </p>
          </div>
        </div>

        <div class="controls">
          <div class="segmented" role="radiogroup" aria-label="文件类型">
            <button
              v-for="option in (['全部', 'Git', 'LFS'] as const)" :key="option" type="button" role="radio"
              :aria-checked="kind === option" @click="kind = option"
            >
              {{ option }}
            </button>
          </div>
          <label class="check"><input v-model="onlyExceeded" type="checkbox"> 仅超限</label>
          <input v-model="query" class="search" type="search" placeholder="搜索路径或对象 ID" aria-label="搜索路径或对象 ID">
        </div>

        <div class="split">
          <ul class="rows" aria-label="文件明细，按大小降序">
            <li v-for="row in visible" :key="row.path">
              <button
                type="button" class="row" :class="{ 'row-active': row.path === selected, 'row-over': row.bytes > LIMITS.file }"
                @click="selected = row.path"
              >
                <span class="tag" :class="`tag-${row.storage}`">{{ row.storage }}</span>
                <span class="row-name">{{ fileName(row.path) }}</span>
                <span class="row-size">{{ formatBytes(row.bytes) }}</span>
              </button>
            </li>
            <li v-if="visible.length === 0" class="empty">
              没有符合条件的文件，换个筛选条件试试。
            </li>
          </ul>
          <div v-if="detail" class="detail">
            <p class="detail-kind">
              {{ detail.storage }} · {{ detail.bytes.toLocaleString('zh-CN') }} 字节
            </p>
            <p class="muted small">
              对象 ID
            </p>
            <p class="mono">
              {{ demoOid(detail.path).slice(0, 24) }}…
            </p>
            <p class="muted small">
              路径
            </p>
            <p class="mono">
              {{ detail.path }}
            </p>
            <p v-if="detail.storage === 'Git' && detail.path.endsWith('.png')" class="hint">
              这张图片进了 Git 而不是 LFS，所以 Git pack 超了预算。检查 .gitattributes 是否跟踪 *.png。
            </p>
            <p v-else-if="detail.bytes > LIMITS.file" class="hint">
              超过单文件预算 {{ formatBytes(LIMITS.file) }}。预算可以在设置里按仓库调整。
            </p>
          </div>
        </div>
        <p class="muted small">
          LFS 尚未查询远端，实际上传量未知；远端已有对象可能跳过。
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.window {
  border: 1px solid var(--yb-line);
  border-radius: 12px;
  background: var(--yb-sheet);
  box-shadow: 0 24px 60px -30px rgb(15 30 61 / 0.45);
  overflow: hidden;
  font-size: 13px;
  color: var(--yb-ink);
}

.titlebar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--yb-line);
  background: var(--yb-paper);
}

.lights {
  display: flex;
  gap: 7px;
}

.lights i {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #ff5f57;
}

.lights i:nth-child(2) {
  background: #febc2e;
}

.lights i:nth-child(3) {
  background: #28c840;
}

.title {
  font-weight: 600;
}

.cos-pill {
  margin-left: auto;
  padding: 2px 10px;
  border-radius: 999px;
  background: rgb(21 128 61 / 0.12);
  color: var(--yb-green);
  font-size: 12px;
}

.body {
  display: grid;
  grid-template-columns: 150px 1fr;
}

.recents {
  padding: 14px 10px;
  border-right: 1px solid var(--yb-line);
  background: var(--yb-paper);
}

.recents-head {
  margin: 0 6px 8px;
  color: var(--yb-ink-soft);
  font-size: 11.5px;
}

.recent {
  display: flex;
  justify-content: space-between;
  margin: 0;
  padding: 5px 8px;
  border-radius: 6px;
}

.recent-active {
  background: var(--yb-action);
  color: #fff;
}

kbd {
  font-family: inherit;
  font-size: 11px;
  opacity: 0.6;
}

.report {
  display: grid;
  gap: 14px;
  padding: 18px 20px;
  min-width: 0;
}

.report-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}

.status {
  color: var(--yb-amber);
  font-weight: 700;
  font-size: 15px;
}

.status::before {
  content: '!';
  display: inline-grid;
  place-items: center;
  width: 17px;
  height: 17px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--yb-amber);
  color: var(--yb-sheet);
  font-size: 12px;
}

.budgets {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.budget {
  padding: 12px 14px;
  border: 1px solid var(--yb-line);
  border-radius: 10px;
}

.budget.over {
  border-color: var(--yb-amber);
  background: var(--yb-amber-wash);
}

.budget-title,
.budget-value {
  margin: 0;
}

.budget-title {
  color: var(--yb-ink-soft);
}

.budget-value {
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.meter {
  height: 5px;
  margin: 8px 0 6px;
  border-radius: 3px;
  background: var(--yb-line);
  overflow: hidden;
}

.meter span {
  display: block;
  height: 100%;
  background: var(--yb-blue);
}

.over .meter span {
  background: var(--yb-amber);
}

.muted {
  color: var(--yb-ink-soft);
  margin: 0;
}

.small {
  font-size: 12px;
}

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.segmented {
  display: inline-flex;
  padding: 2px;
  border-radius: 7px;
  background: var(--yb-paper);
  border: 1px solid var(--yb-line);
}

.segmented button {
  padding: 3px 14px;
  border-radius: 5px;
  color: var(--yb-ink);
}

.segmented button[aria-checked='true'] {
  background: var(--yb-sheet);
  box-shadow: 0 1px 2px rgb(15 30 61 / 0.18);
  font-weight: 600;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.search {
  flex: 1 1 160px;
  max-width: 240px;
  margin-left: auto;
  padding: 4px 10px;
  border: 1px solid var(--yb-line);
  border-radius: 6px;
  background: var(--yb-sheet);
  color: var(--yb-ink);
}

.segmented button:focus-visible,
.row:focus-visible,
.search:focus-visible,
.check input:focus-visible {
  outline: 2px solid var(--yb-blue);
  outline-offset: 1px;
}

.split {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 14px;
  min-height: 236px;
}

.rows {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--yb-line);
  border-radius: 8px;
  overflow: hidden;
}

.row {
  display: grid;
  grid-template-columns: 38px 1fr auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  text-align: left;
  color: var(--yb-ink);
  border-bottom: 1px solid var(--yb-line);
}

.rows li:last-child .row {
  border-bottom: 0;
}

.row-active {
  background: var(--vp-c-brand-soft);
}

.row-over .row-size {
  color: var(--yb-amber);
  font-weight: 600;
}

.row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-size {
  font-variant-numeric: tabular-nums;
}

.tag {
  justify-self: start;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
}

.tag-Git {
  background: var(--yb-paper);
  color: var(--yb-ink-soft);
  border: 1px solid var(--yb-line);
}

.tag-LFS {
  background: var(--yb-action);
  color: #fff;
}

.empty {
  padding: 18px 12px;
  color: var(--yb-ink-soft);
}

.detail {
  display: grid;
  align-content: start;
  gap: 4px;
  min-width: 0;
}

.detail p {
  margin: 0;
}

.detail-kind {
  font-weight: 700;
  margin-bottom: 8px !important;
}

.mono {
  font-family: var(--yb-font-mono);
  font-size: 12px;
  word-break: break-all;
  margin-bottom: 6px !important;
}

.hint {
  margin-top: 8px !important;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--yb-amber-wash);
  color: var(--yb-ink);
  line-height: 1.5;
}

@media (max-width: 760px) {
  .body {
    grid-template-columns: 1fr;
  }

  .recents {
    display: none;
  }

  .split,
  .budgets {
    grid-template-columns: 1fr;
  }

  .search {
    max-width: none;
    margin-left: 0;
  }
}
</style>
