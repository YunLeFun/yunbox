<script setup lang="ts">
/**
 * A working copy of the macOS client's window: the push check with the
 * same budgets, filters and wording, and the COS sheet behind the status
 * capsule. The sample push has a PNG that slipped into Git instead of LFS.
 */
import { computed, ref } from 'vue'
import { demoOid, formatBytes } from '../demo-assets'
import MacWindow from './MacWindow.vue'
import SymbolIcon from './SymbolIcon.vue'

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
const lfsRows = ROWS.filter(row => row.storage === 'LFS')
const lfsBytes = lfsRows.reduce((sum, row) => sum + row.bytes, 0)

const budgets = [
  { title: 'Git pack', icon: 'arrow.up.doc' as const, value: GIT_PACK, limit: LIMITS.git, footnote: '压缩后的预计上传量' },
  { title: 'LFS 候选', icon: 'shippingbox' as const, value: lfsBytes, limit: LIMITS.lfs, footnote: `${lfsRows.length} 个素材对象` },
]

const DOCTOR = [
  { title: 'git', detail: '2.47.1' },
  { title: 'git-lfs', detail: '3.6.1' },
  { title: 'Git 仓库', detail: '/Users/alice/game' },
  { title: 'LFS 过滤器', detail: '已启用' },
  { title: '传输代理', detail: 'git-lfs 通过 git-yunbox 直连 COS' },
  { title: 'COS 密钥', detail: '来自 macOS 钥匙串（yunbox）' },
  { title: 'COS 权限', detail: '可以写入和读取' },
]

const kind = ref<'全部' | 'Git' | 'LFS'>('全部')
const onlyExceeded = ref(false)
const query = ref('')
const selected = ref(ROWS[3].path)
const sheetOpen = ref(false)

const visible = computed(() => ROWS.filter(row =>
  (kind.value === '全部' || row.storage === kind.value)
  && (!onlyExceeded.value || row.bytes > LIMITS.file)
  && (query.value === '' || row.path.toLowerCase().includes(query.value.toLowerCase()) || demoOid(row.path).startsWith(query.value.toLowerCase())),
))
const detail = computed(() => ROWS.find(row => row.path === selected.value))

function ratio(value: number, limit: number): string {
  return `${Math.min(value / limit, 1) * 100}%`
}
</script>

<template>
  <MacWindow label="macOS 客户端示意：推送检查" title="推送检查">
    <template #sidebar>
      <p class="side-head">
        最近的仓库
      </p>
      <p class="repo repo-active">
        <SymbolIcon name="folder" class="repo-icon" />
        <span class="repo-text">game<small>team</small></span>
        <kbd>⌘1</kbd>
      </p>
      <p class="repo">
        <SymbolIcon name="folder" class="repo-icon" />
        <span class="repo-text">life<small>YunYouJun</small></span>
        <kbd>⌘2</kbd>
      </p>
      <p class="repo">
        <SymbolIcon name="folder" class="repo-icon" />
        <span class="repo-text">art-library<small>team</small></span>
        <kbd>⌘3</kbd>
      </p>
      <p class="side-foot">
        <SymbolIcon name="shippingbox" /> YunBox
        <SymbolIcon name="gearshape" class="side-gear" />
      </p>
    </template>

    <template #toolbar>
      <SymbolIcon name="folder.badge.plus" />
      <SymbolIcon name="doc.on.doc" />
      <SymbolIcon name="arrow.clockwise" />
    </template>

    <header class="repo-head">
      <div>
        <p class="repo-title">
          game
        </p>
        <p class="repo-path">
          /Users/alice/game
        </p>
      </div>
      <button class="capsule" type="button" @click="sheetOpen = true">
        <SymbolIcon name="icloud" />
        直连 COS · 正常
      </button>
      <span class="checked">检查于 14:21</span>
    </header>

    <section class="report">
      <div class="report-head">
        <span class="status">
          <SymbolIcon name="exclamationmark.circle.fill" />
          超过预算
        </span>
        <span class="muted">单文件预算 {{ formatBytes(LIMITS.file) }}</span>
        <span class="bordered">预算设置</span>
      </div>

      <div class="budgets">
        <div v-for="budget in budgets" :key="budget.title" class="budget">
          <p class="budget-title">
            <SymbolIcon :name="budget.icon" />
            {{ budget.title }}
            <SymbolIcon v-if="budget.value > budget.limit" name="exclamationmark.circle.fill" class="budget-over" />
          </p>
          <p class="budget-value">
            {{ formatBytes(budget.value) }}
          </p>
          <div class="meter" :class="{ 'meter-over': budget.value > budget.limit }" aria-hidden="true">
            <span :style="{ width: ratio(budget.value, budget.limit) }" />
          </div>
          <p class="budget-foot">
            <span>{{ budget.footnote }}</span>
            <span>预算 {{ formatBytes(budget.limit) }}</span>
          </p>
        </div>
      </div>
      <p class="caption">
        LFS 尚未查询远端，实际上传量未知；远端已有对象可能跳过。
      </p>

      <div class="controls">
        <span class="control-label">文件类型</span>
        <div class="segmented" role="radiogroup" aria-label="文件类型">
          <button
            v-for="option in (['全部', 'Git', 'LFS'] as const)" :key="option" type="button" role="radio"
            :aria-checked="kind === option" @click="kind = option"
          >
            {{ option }}
          </button>
        </div>
        <label class="check"><input v-model="onlyExceeded" type="checkbox"> 仅超限</label>
        <label class="search">
          <SymbolIcon name="magnifyingglass" />
          <input v-model="query" type="search" placeholder="搜索路径或对象 ID" aria-label="搜索路径或对象 ID">
        </label>
      </div>

      <p class="table-title">
        <strong>文件明细</strong>
        <span>{{ visible.length }} / {{ ROWS.length }} 个对象 · 按大小降序</span>
      </p>
      <div class="table" role="table" aria-label="文件明细">
        <div class="tr th" role="row">
          <span role="columnheader">文件</span>
          <span role="columnheader">类型</span>
          <span role="columnheader">原始大小</span>
          <span role="columnheader">预算</span>
        </div>
        <button
          v-for="row in visible" :key="row.path" type="button" role="row" class="tr"
          :class="{ 'tr-active': row.path === selected }" @click="selected = row.path"
        >
          <span role="cell" class="cell-file">
            <SymbolIcon :name="row.storage === 'LFS' ? 'shippingbox' : 'doc'" />
            <span>{{ row.path }}</span>
          </span>
          <span role="cell" class="cell-dim">{{ row.storage }}</span>
          <span role="cell" class="cell-num">{{ formatBytes(row.bytes) }}</span>
          <span role="cell" :class="row.bytes > LIMITS.file ? 'cell-over' : 'cell-dim'">{{ row.bytes > LIMITS.file ? '超限' : '—' }}</span>
        </button>
        <p v-if="visible.length === 0" class="empty">
          没有符合条件的文件，换个筛选条件试试。
        </p>
      </div>

      <div v-if="detail" class="detail">
        <p class="detail-head">
          {{ detail.storage }} · {{ detail.bytes.toLocaleString('zh-CN') }} 字节
        </p>
        <p class="mono">
          {{ demoOid(detail.path).slice(0, 40) }}…
        </p>
        <p v-if="detail.storage === 'Git' && detail.path.endsWith('.png')" class="hint">
          <SymbolIcon name="info.circle" />
          这张图片进了 Git 而不是 LFS，Git pack 因此超出预算。检查 .gitattributes 有没有跟踪 *.png。
        </p>
        <p v-else-if="detail.bytes > LIMITS.file" class="hint">
          <SymbolIcon name="info.circle" />
          超过单文件预算 {{ formatBytes(LIMITS.file) }}，预算可以在设置里按仓库调整。
        </p>
      </div>
    </section>

    <template #overlay>
      <div v-if="sheetOpen" class="sheet-backdrop" @click.self="sheetOpen = false">
        <div class="sheet" role="dialog" aria-label="COS 直连">
          <div class="sheet-head">
            <strong>COS 直连</strong>
            <span class="bordered">重新检查</span>
          </div>
          <p class="location">
            <SymbolIcon name="icloud" />
            team-assets-1250000000（ap-shanghai）/yunbox/team/game/
          </p>
          <ul class="steps">
            <li v-for="step in DOCTOR" :key="step.title">
              <SymbolIcon name="checkmark.circle.fill" class="step-ok" />
              <span><strong>{{ step.title }}</strong><small>{{ step.detail }}</small></span>
            </li>
          </ul>
          <div class="sheet-foot">
            <span>密钥只保存在这台电脑上（钥匙串），仓库里只记录 bucket、地域和前缀。</span>
            <button type="button" class="bordered" @click="sheetOpen = false">
              完成
            </button>
          </div>
        </div>
      </div>
    </template>
  </MacWindow>
</template>

<style scoped>
/* Sidebar */
.side-head {
  margin: 0 8px 6px;
  color: var(--yb-label-3);
  font-size: 11px;
  font-weight: 600;
}

.repo {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 2px;
  padding: 5px 8px;
  border-radius: 6px;
}

.repo-active {
  background: var(--yb-fill-strong);
}

.repo-icon {
  color: var(--yb-accent);
  font-size: 15px;
}

.repo-text {
  display: grid;
  flex: 1;
  min-width: 0;
  line-height: 1.25;
}

.repo-text small {
  color: var(--yb-label-3);
  font-size: 10.5px;
}

kbd {
  color: var(--yb-label-3);
  font-family: inherit;
  font-size: 11px;
}

.side-foot {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: auto 8px 0;
  padding-top: 24px;
  color: var(--yb-label-2);
  font-weight: 600;
}

.side-gear {
  margin-left: auto;
}

/* Repository header */
.repo-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 22px 14px;
  border-bottom: 0.5px solid var(--yb-separator);
}

.repo-head > div {
  flex: 1;
  min-width: 0;
}

.repo-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
}

.repo-path {
  margin: 2px 0 0;
  color: var(--yb-label-2);
  font-size: 11px;
}

.capsule {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 999px;
  background: var(--yb-fill-strong);
  color: var(--yb-label);
  font-size: 12px;
  font-weight: 500;
  transition: background-color 120ms;
}

.capsule:hover {
  background: var(--yb-accent-soft);
}

.capsule :deep(.symbol) {
  color: var(--yb-green);
}

.checked {
  color: var(--yb-label-3);
  font-size: 11px;
}

/* Report */
.report {
  display: grid;
  gap: 12px;
  padding: 16px 22px 20px;
}

.report-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-right: auto;
  color: var(--yb-orange-text);
  font-weight: 600;
}

.status :deep(.symbol),
.budget-over {
  color: var(--yb-orange);
}

.muted {
  color: var(--yb-label-2);
  font-size: 12px;
}

.bordered {
  padding: 2px 10px;
  border-radius: 5px;
  background: var(--yb-window);
  box-shadow: 0 0 0 0.5px var(--yb-separator), 0 1px 1.5px rgb(0 0 0 / 0.08);
  color: var(--yb-label);
  font-size: 12px;
}

.budgets {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.budget {
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--yb-fill);
  border: 0.5px solid var(--yb-separator);
}

.budget p {
  margin: 0;
}

.budget-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--yb-label-2);
}

.budget-over {
  margin-left: auto;
}

.budget-value {
  margin: 8px 0 12px !important;
  font-size: 24px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.meter {
  height: 5px;
  border-radius: 3px;
  background: var(--yb-fill-strong);
  overflow: hidden;
}

.meter span {
  display: block;
  height: 100%;
  background: var(--yb-label-3);
}

.meter-over span {
  background: var(--yb-orange);
}

.budget-foot {
  display: flex;
  justify-content: space-between;
  margin-top: 10px !important;
  color: var(--yb-label-2);
  font-size: 11px;
}

.caption {
  margin: 0;
  color: var(--yb-label-2);
  font-size: 11px;
}

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.control-label {
  color: var(--yb-label);
}

.segmented {
  display: inline-flex;
  padding: 1px;
  border-radius: 6px;
  background: var(--yb-fill-strong);
}

.segmented button {
  padding: 2px 13px;
  border-radius: 5px;
  color: var(--yb-label);
  font-size: 12.5px;
}

.segmented button[aria-checked='true'] {
  background: var(--yb-window);
  box-shadow: 0 0 0 0.5px var(--yb-separator), 0 1px 2px rgb(0 0 0 / 0.12);
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.search {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 1 220px;
  margin-left: auto;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--yb-fill);
  box-shadow: inset 0 0 0 0.5px var(--yb-separator);
  color: var(--yb-label-3);
}

.search input {
  flex: 1;
  min-width: 0;
  color: var(--yb-label);
  font-size: 12.5px;
}

.segmented button:focus-visible,
.tr:focus-visible,
.capsule:focus-visible,
.check input:focus-visible,
.sheet button:focus-visible,
.search:focus-within {
  outline: 2px solid var(--yb-accent);
  outline-offset: 1px;
}

.table-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 4px 0 -4px;
}

.table-title span {
  color: var(--yb-label-2);
  font-size: 11px;
}

.table {
  border-radius: 6px;
  border: 0.5px solid var(--yb-separator);
  overflow: hidden;
  min-height: 190px;
}

.tr {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 54px 88px 52px;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 4px 12px;
  text-align: left;
  color: var(--yb-label);
  font-size: 12.5px;
}

.tr:nth-child(odd):not(.th) {
  background: var(--yb-fill);
}

.th {
  padding: 5px 12px;
  border-bottom: 0.5px solid var(--yb-separator);
  color: var(--yb-label-2);
  font-size: 11.5px;
}

.tr-active,
.tr-active:nth-child(odd) {
  background: var(--yb-accent) !important;
  color: #fff;
}

.tr-active .cell-dim,
.tr-active .cell-over {
  color: rgb(255 255 255 / 0.85);
}

.cell-file {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.cell-file span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cell-file :deep(.symbol) {
  color: var(--yb-label-3);
}

.tr-active .cell-file :deep(.symbol) {
  color: #fff;
}

.cell-dim {
  color: var(--yb-label-2);
}

.cell-num {
  font-variant-numeric: tabular-nums;
}

.cell-over {
  color: var(--yb-orange-text);
  font-weight: 600;
}

.empty {
  margin: 0;
  padding: 18px 12px;
  color: var(--yb-label-2);
}

.detail {
  display: grid;
  gap: 4px;
  min-height: 74px;
}

.detail p {
  margin: 0;
}

.detail-head {
  font-weight: 600;
}

.mono {
  color: var(--yb-label-2);
  font-family: var(--yb-font-mono);
  font-size: 11.5px;
  word-break: break-all;
}

.hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 4px !important;
  color: var(--yb-label-2);
  font-size: 12px;
}

.hint :deep(.symbol) {
  margin-top: 2px;
}

/* COS sheet */
.sheet-backdrop {
  position: absolute;
  z-index: 2;
  inset: 0;
  display: grid;
  place-items: start center;
  padding-top: 46px;
  background: rgb(0 0 0 / 0.18);
  animation: fade 160ms ease-out;
}

.sheet {
  width: min(92%, 520px);
  padding: 18px 20px 14px;
  border-radius: 12px;
  background: var(--yb-window);
  box-shadow: var(--yb-shadow-window);
  animation: drop 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 15px;
}

.location {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 4px;
  color: var(--yb-label-2);
  font-size: 12px;
}

.steps {
  margin: 0;
  padding: 0;
  list-style: none;
}

.steps li {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 0;
}

.steps span {
  display: grid;
}

.steps small {
  color: var(--yb-label-2);
  font-size: 11.5px;
}

.step-ok {
  margin-top: 1px;
  color: var(--yb-green);
  font-size: 15px;
}

.sheet-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
  padding-top: 12px;
  border-top: 0.5px solid var(--yb-separator);
  color: var(--yb-label-2);
  font-size: 11.5px;
}

.sheet-foot .bordered {
  margin-left: auto;
  flex: none;
}

@keyframes fade {
  from {
    opacity: 0;
  }
}

@keyframes drop {
  from {
    transform: translateY(-12px);
    opacity: 0;
  }
}

@media (max-width: 760px) {
  .repo-head {
    flex-wrap: wrap;
    padding: 14px 16px 12px;
  }

  .checked {
    display: none;
  }

  .report {
    padding: 14px 16px 18px;
  }

  .budgets {
    grid-template-columns: 1fr;
  }

  .search {
    flex-basis: 100%;
    margin-left: 0;
  }

  .tr {
    grid-template-columns: minmax(0, 1fr) 76px 40px;
  }

  .tr > :nth-child(2) {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sheet,
  .sheet-backdrop {
    animation: none;
  }
}
</style>
