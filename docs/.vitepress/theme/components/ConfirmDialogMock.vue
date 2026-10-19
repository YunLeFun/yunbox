<script setup lang="ts">
/**
 * A still of the alert `yunbox inspect --push --confirm` shows on macOS when a
 * push is over budget: the native caution alert with the report page from
 * packages/cli/src/confirm.ts embedded. Nothing here is clickable; the sample
 * push adds an intro video that is larger than the single-file budget.
 */

type Status = 'added' | 'modified' | 'deleted'

interface Change {
  path: string
  status: Status
  lfs: boolean
  before: number | null
  after: number | null
  push: number
  versions?: number
}

const KIB = 1024
const MIB = 1024 * KIB
const GIB = 1024 * MIB
const LIMITS = { git: 50 * MIB, lfs: GIB, file: 200 * MIB }

const LABELS: Record<Status, string> = { added: '新增', modified: '修改', deleted: '删除' }

const CHANGES = ([
  { path: 'Assets/Video/opening.mp4', status: 'added', lfs: true, before: null, after: 412 * MIB, push: 412 * MIB },
  { path: 'Assets/Characters/boss_idle.fbx', status: 'modified', lfs: true, before: 168 * MIB, after: 178 * MIB, push: 346 * MIB, versions: 2 },
  { path: 'Assets/Terrain/terrain_albedo.png', status: 'modified', lfs: true, before: 48 * MIB, after: 52.5 * MIB, push: 52.5 * MIB },
  { path: 'Assets/UI/ui_atlas.png', status: 'added', lfs: false, before: null, after: 3.12 * MIB, push: 3.12 * MIB },
  { path: 'Assets/Scenes/Level01.unity', status: 'modified', lfs: false, before: 212 * KIB, after: 236 * KIB, push: 236 * KIB },
  { path: 'Assets/Audio/old_theme.wav', status: 'deleted', lfs: true, before: 31.2 * MIB, after: null, push: 0 },
] satisfies Change[]).map(change => ({
  ...change,
  dir: change.path.slice(0, change.path.lastIndexOf('/') + 1),
  name: change.path.slice(change.path.lastIndexOf('/') + 1),
  over: Math.max(change.before ?? 0, change.after ?? 0) > LIMITS.file,
}))

const GIT_PACK = Math.round(2.84 * MIB)
const lfsChanges = CHANGES.filter(change => change.lfs && change.push > 0)
const lfsBytes = lfsChanges.reduce((sum, change) => sum + change.push, 0)
const largest = Math.max(...CHANGES.map(change => change.after ?? 0))
const largestPush = Math.max(...CHANGES.map(change => change.push))

const meters = [
  { label: 'Git pack', value: GIT_PACK, limit: LIMITS.git, note: '压缩后预计上传' },
  { label: 'LFS 候选', value: lfsBytes, limit: LIMITS.lfs, note: `${lfsChanges.length} 个素材，远端已有的会跳过` },
  { label: '最大单文件', value: largest, limit: LIMITS.file, note: '原始大小' },
].map(meter => ({ ...meter, over: meter.value > meter.limit, ratio: meter.value / meter.limit }))

const counts = (['added', 'modified', 'deleted'] as const)
  .map(status => ({ status, count: CHANGES.filter(change => change.status === status).length }))

const reason = `${CHANGES.filter(change => change.over).length} 个文件版本超过单文件限额 ${compact(LIMITS.file)}`

const LINKS = ['在 Finder 中显示', '在 Cursor 中打开', '在 YunBox 中查看完整信息', '打开远端仓库']

/** Same rounding as the CLI's `compactBytes`, so the numbers read like the real dialog. */
function compact(bytes: number): string {
  if (bytes < KIB)
    return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB']
  let value = bytes / KIB
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`
}

function sizeChange(change: Change): string {
  const text = `${change.before === null ? '无' : compact(change.before)} → ${change.after === null ? '无' : compact(change.after)}`
  if (change.before === null || change.after === null)
    return text
  const delta = change.after - change.before
  return `${text}（${delta > 0 ? '+' : '−'}${compact(Math.abs(delta))}）`
}

function percent(ratio: number): string {
  return `${Math.min(ratio, 1) * 100}%`
}
</script>

<template>
  <figure class="alert" role="group" aria-label="macOS 推送确认对话框示意">
    <svg class="caution" viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="yb-caution" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffd84d" />
          <stop offset="1" stop-color="#f7b500" />
        </linearGradient>
      </defs>
      <path d="M27.6 8.6a5 5 0 0 1 8.8 0l23 41.4a5 5 0 0 1-4.4 7.4H9a5 5 0 0 1-4.4-7.4Z" fill="url(#yb-caution)" stroke="rgb(0 0 0 / 0.14)" stroke-width="0.8" />
      <path d="M32 22v17" stroke="#1d1d1f" stroke-width="5" stroke-linecap="round" />
      <circle cx="32" cy="47.5" r="3" fill="#1d1d1f" />
    </svg>

    <div class="body">
      <p class="title">
        推送到 github.com/owner/game-assets 超过限额
      </p>
      <p class="info">
        本地仓库 game-assets（main）<br>{{ reason }}
      </p>

      <div class="report">
        <div class="meters">
          <div v-for="meter in meters" :key="meter.label" class="meter" :class="{ over: meter.over }">
            <p class="meter-label">
              {{ meter.label }}<b v-if="meter.over">超限</b>
            </p>
            <p class="meter-value">
              {{ compact(meter.value) }}<span> / {{ compact(meter.limit) }}</span>
            </p>
            <div class="track">
              <span :style="{ width: percent(meter.ratio) }" />
            </div>
            <p class="meter-note">
              <span>{{ meter.note }}</span><span>{{ Math.round(meter.ratio * 100) }}%</span>
            </p>
          </div>
        </div>

        <p class="caption">
          <strong>变更文件</strong>
          <span>
            {{ CHANGES.length }} 个文件
            <template v-for="item in counts" :key="item.status">
              · <i class="badge" :class="item.status">{{ LABELS[item.status] }}</i> {{ item.count }}
            </template>
          </span>
          <span class="sort">按本次上传大小排序</span>
        </p>

        <div class="table" role="table" aria-label="变更文件">
          <div class="tr th" role="row">
            <span role="columnheader">状态</span>
            <span role="columnheader">文件</span>
            <span role="columnheader" class="num col-diff">大小变化</span>
            <span role="columnheader" class="num">本次上传</span>
          </div>
          <div v-for="change in CHANGES" :key="change.path" class="tr" :class="{ over: change.over }" role="row">
            <span role="cell"><i class="badge" :class="change.status">{{ LABELS[change.status] }}</i></span>
            <span role="cell" class="path">
              <span class="dir">{{ change.dir }}</span>
              <span class="name">{{ change.name }}</span>
              <i v-if="change.lfs" class="tag">LFS</i>
              <i v-if="change.versions" class="tag">{{ change.versions }} 个版本</i>
              <i v-if="change.over" class="tag tag-over">超限</i>
            </span>
            <span role="cell" class="num diff col-diff">{{ sizeChange(change) }}</span>
            <span role="cell" class="num push">
              <b>{{ compact(change.push) }}</b>
              <span class="bar"><span :style="{ width: `${Math.max(2, change.push / largestPush * 100)}%` }" /></span>
            </span>
          </div>
        </div>
        <p class="note">
          「本次上传」是文件原始大小，Git 会压缩和增量传输；同一文件的每个历史版本分别统计。
        </p>
      </div>

      <div class="links">
        <span v-for="link in LINKS" :key="link" class="button button-small">{{ link }}</span>
      </div>

      <div class="actions">
        <span class="button button-destructive">继续推送</span>
        <span class="button button-default">取消</span>
      </div>
    </div>
  </figure>
</template>

<style scoped>
/* Colours of the report page in confirm.ts, mapped onto the site's tokens where they match. */
.alert {
  --fg: var(--yb-label);
  --muted: var(--yb-label-2);
  --line: rgb(0 0 0 / 0.08);
  --card: rgb(0 0 0 / 0.04);
  --track: rgb(0 0 0 / 0.08);
  --bar: #0a84ff;
  --over: #e5484d;
  --added: #1f9d55;
  --modified: #0a7cff;
  --deleted: #d93f3f;
  --button: #fff;

  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  gap: 18px;
  max-width: 860px;
  margin: 0 auto;
  padding: 20px 20px 18px;
  border-radius: 12px;
  background: var(--yb-window);
  box-shadow: var(--yb-shadow-window);
  color: var(--fg);
  font-size: 12px;
  line-height: 1.45;
  text-align: left;
}

.dark .alert {
  --line: rgb(255 255 255 / 0.1);
  --card: rgb(255 255 255 / 0.06);
  --track: rgb(255 255 255 / 0.12);
  --over: #ff6369;
  --added: #3dd68c;
  --modified: #52a9ff;
  --deleted: #ff6b6b;
  --button: rgb(255 255 255 / 0.16);
}

.alert p {
  margin: 0;
}

.caution {
  width: 64px;
  height: 64px;
}

.body {
  display: grid;
  gap: 10px;
  min-width: 0;
}

.title {
  font-size: 13px;
  font-weight: 700;
  overflow-wrap: anywhere;
}

.info {
  margin-top: -6px !important;
  font-size: 11px;
}

.report {
  margin-top: 4px;
  min-width: 0;
}

.meters {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.meter {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--card);
}

.meter-label,
.meter-note {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--muted);
}

.meter-label b {
  color: var(--over);
  font-weight: 600;
}

.meter-value {
  margin: 1px 0 5px !important;
  font-size: 17px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.meter-value span {
  color: var(--muted);
  font-size: 12px;
  font-weight: 400;
}

.over .meter-value {
  color: var(--over);
}

.track {
  height: 5px;
  border-radius: 3px;
  background: var(--track);
  overflow: hidden;
}

.track span {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--bar);
}

.meter.over .track span {
  background: var(--over);
}

.meter-note {
  margin-top: 4px !important;
  font-size: 11px;
}

.caption {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  margin: 14px 2px 6px !important;
  color: var(--muted);
}

.caption strong {
  color: var(--fg);
  font-size: 13px;
}

.sort {
  margin-left: auto;
}

i {
  font-style: normal;
}

.badge {
  display: inline-block;
  padding: 0 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--c) 14%, transparent);
  color: var(--c);
  font-size: 11px;
  font-weight: 600;
}

.badge.added {
  --c: var(--added);
}

.badge.modified {
  --c: var(--modified);
}

.badge.deleted {
  --c: var(--deleted);
}

.tr {
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr) 210px 120px;
  align-items: center;
  gap: 0 8px;
  padding: 5px 6px;
  border-bottom: 1px solid var(--line);
}

.th {
  padding: 4px 6px;
  color: var(--muted);
  font-size: 11px;
  font-weight: 500;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.path {
  display: flex;
  align-items: center;
  min-width: 0;
  white-space: nowrap;
}

.dir {
  flex: 0 1 auto;
  min-width: 2em;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--muted);
}

.name {
  flex: 0 0 auto;
  max-width: 75%;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
}

.tag {
  flex: none;
  margin-left: 6px;
  padding: 0 5px;
  border: 1px solid var(--line);
  border-radius: 4px;
  color: var(--muted);
  font-size: 10px;
}

.tag-over {
  border-color: var(--over);
  color: var(--over);
}

.diff {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--muted);
  font-size: 11px;
}

.push b {
  font-weight: 600;
}

.bar {
  display: block;
  height: 3px;
  margin-top: 3px;
  border-radius: 2px;
  background: var(--track);
}

.bar span {
  display: block;
  height: 100%;
  margin-left: auto;
  border-radius: 2px;
  background: var(--bar);
  opacity: 0.7;
}

.tr.over .bar span {
  background: var(--over);
  opacity: 1;
}

.note {
  margin: 10px 2px 0 !important;
  color: var(--muted);
  font-size: 11px;
}

/* NSButton look: small link buttons, then the alert's own buttons. */
.links,
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.actions {
  justify-content: flex-end;
  gap: 12px;
  margin-top: 8px;
}

.button {
  padding: 3px 14px;
  border-radius: 6px;
  background: var(--button);
  box-shadow: 0 0 0 0.5px rgb(0 0 0 / 0.14), 0 1px 1.5px rgb(0 0 0 / 0.1);
  color: var(--fg);
  font-size: 13px;
  white-space: nowrap;
}

.button-small {
  padding: 1px 8px;
  border-radius: 5px;
  font-size: 11px;
}

.button-default {
  min-width: 76px;
  background: linear-gradient(#3b95ff, #0a7cff);
  color: #fff;
  text-align: center;
}

.button-destructive {
  min-width: 76px;
  color: #e5484d;
  text-align: center;
}

.dark .button-destructive {
  color: #ff6369;
}

@media (max-width: 760px) {
  .alert {
    grid-template-columns: 1fr;
    gap: 12px;
    padding: 16px 14px 14px;
  }

  .caution {
    width: 48px;
    height: 48px;
  }

  .meters {
    grid-template-columns: 1fr;
  }

  .sort {
    margin-left: 0;
  }

  .tr {
    grid-template-columns: 40px minmax(0, 1fr) 76px;
    padding: 5px 2px;
  }

  .col-diff {
    display: none;
  }

  .path {
    flex-wrap: wrap;
    row-gap: 2px;
  }

  .actions .button {
    flex: 1;
  }
}
</style>
