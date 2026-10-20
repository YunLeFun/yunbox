<script setup lang="ts">
/**
 * A working copy of the macOS client's menu bar panel for push freeze
 * windows (FreezeMenuView.swift): the current repository's verdict with
 * today's timeline, the week ahead, machine-wide rules and every project.
 * The clock stands still on a Tuesday at 15:30 and nothing is fetched;
 * presets, the switch and the timer only change the sample state.
 */
import type { PopMenuItem } from './PopMenu.vue'
import { withBase } from 'vitepress'
import { computed, reactive, ref } from 'vue'
import PopMenu from './PopMenu.vue'
import SymbolIcon from './SymbolIcon.vue'

type Scope = 'local' | 'shared' | 'global'

/** One weekly stretch; `end <= start` crosses midnight and belongs to the day it starts. */
interface Part {
  days: number[]
  start: number
  end: number
}

interface Rule {
  /** `opening_hours` text, as `yunbox freeze list` prints it */
  text: string
  parts: Part[]
}

interface Project {
  name: string
  local: Rule | null
  shared: Rule | null
}

type Span = [number, number]

const DAY = 1440
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
const TODAY = 2
const NOW = 15 * 60 + 30
const SCOPE_LABELS: Record<Scope, string> = { local: '本仓库', shared: '团队', global: '全局' }

const PRESETS: { title: string, rule: Rule }[] = [
  { title: '工作时间', rule: { text: 'Mo-Fr 09:00-18:00', parts: [{ days: [1, 2, 3, 4, 5], start: 9 * 60, end: 18 * 60 }] } },
  { title: '周末', rule: { text: 'Sa,Su', parts: [{ days: [6, 0], start: 0, end: DAY }] } },
  { title: '夜间', rule: { text: '22:00-08:00', parts: [{ days: [0, 1, 2, 3, 4, 5, 6], start: 22 * 60, end: 8 * 60 }] } },
]

const PAUSES: { title: string, until: (now: number) => number | null }[] = [
  { title: '关闭 30 分钟', until: now => now + 30 },
  { title: '关闭 1 小时', until: now => now + 60 },
  { title: '关闭 2 小时', until: now => now + 120 },
  { title: '关闭到今天结束', until: () => DAY },
  { title: '一直关闭，直到重新开启', until: () => null },
]

const projects = reactive<Project[]>([
  { name: 'game', local: PRESETS[0].rule, shared: { text: 'Fr 18:00-24:00', parts: [{ days: [5], start: 18 * 60, end: DAY }] } },
  { name: 'art-library', local: null, shared: PRESETS[1].rule },
  { name: 'life', local: null, shared: null },
])
const globalRule = ref<Rule | null>(null)
/** `yunbox freeze off --global`: minutes after today's midnight, or `null` until switched back on. */
const pause = ref<{ until: number | null } | null>(null)
const current = ref('game')
const expanded = ref<string | null>('game')

function clock(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function dayLabel(offset: number): string {
  return offset === 0 ? '今天' : offset === 1 ? '明天' : WEEKDAYS[(TODAY + offset) % 7]
}

/** Frozen stretches of one rule on the day `offset` days from today, including last night's carry-over. */
function ruleSpans(rule: Rule, offset: number): Span[] {
  const weekday = (TODAY + offset) % 7
  const previous = (weekday + 6) % 7
  return rule.parts.flatMap((part): Span[] => {
    if (part.end > part.start)
      return part.days.includes(weekday) ? [[part.start, part.end]] : []
    return [
      ...(part.days.includes(previous) ? [[0, part.end] as Span] : []),
      ...(part.days.includes(weekday) ? [[part.start, DAY] as Span] : []),
    ]
  })
}

function merge(spans: Span[]): Span[] {
  const merged: Span[] = []
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1)
    if (last && start <= last[1])
      last[1] = Math.max(last[1], end)
    else
      merged.push([start, end])
  }
  return merged
}

function windowsOf(project: Project): { rule: Rule, scope: Scope }[] {
  return [
    project.local && { rule: project.local, scope: 'local' as const },
    project.shared && { rule: project.shared, scope: 'shared' as const },
    globalRule.value && { rule: globalRule.value, scope: 'global' as const },
  ].filter(window => window !== null)
}

function statusOf(project: Project) {
  const windows = windowsOf(project)
  const week = Array.from({ length: 7 }, (_, offset) => merge(windows.flatMap(window => ruleSpans(window.rule, offset))))
  const hit = windows.find(window => ruleSpans(window.rule, 0).some(([start, end]) => start <= NOW && NOW < end))
  // Walk adjacent stretches forward, like the CLI's `until`, at most 7 days.
  let opens: number | null = null
  if (hit) {
    let at = NOW
    for (;;) {
      const offset = Math.floor(at / DAY)
      const span = offset < 7 && week[offset].find(([start, end]) => start <= at % DAY && at % DAY < end)
      if (!span) {
        opens = offset < 7 ? at : null
        break
      }
      at = offset * DAY + span[1]
    }
  }
  const next = week.flatMap((spans, offset) => spans.map(([start]) => ({ offset, start })))
    .find(({ offset, start }) => offset > 0 || start > NOW)
  return {
    windows,
    week,
    hit,
    frozen: Boolean(hit) && !pause.value,
    paused: Boolean(hit) && Boolean(pause.value),
    opensLabel: opens === null
      ? '接下来 7 天都不能推送'
      : `${opens < DAY ? '' : `${dayLabel(Math.floor(opens / DAY))} `}${clock(opens % DAY)} 后可以推送`,
    nextLabel: next ? `${dayLabel(next.offset)} ${clock(next.start)} 开始禁推` : null,
  }
}

const pauseLabel = computed(() => {
  const until = pause.value?.until
  if (until === null || until === undefined)
    return '直到重新开启'
  return `至 ${until < DAY ? '今天' : '明天'} ${clock(until % DAY)} 自动恢复`
})

const statuses = computed(() => Object.fromEntries(projects.map(project => [project.name, statusOf(project)])))
const now = computed(() => statuses.value[current.value])

const card = computed(() => {
  const status = now.value
  const name = current.value
  if (status.frozen) {
    return { tone: 'red', icon: 'hand.raised' as const, title: '禁推中', subtitle: `${name} · ${status.opensLabel}`, detail: `${status.hit!.rule.text}（${SCOPE_LABELS[status.hit!.scope]}）` }
  }
  if (status.paused)
    return { tone: 'orange', icon: 'pause' as const, title: '现在可以推送（禁推已关闭）', subtitle: `${name} · 本应禁推：${status.hit!.rule.text}`, detail: null }
  const rest = status.nextLabel ?? (status.windows.length ? '未来 7 天没有禁推' : '没有设置禁推时段')
  return { tone: pause.value ? 'orange' : 'green', icon: pause.value ? 'pause' as const : 'arrow.up' as const, title: '现在可以推送', subtitle: `${name} · ${rest}`, detail: null }
})

const hasWeek = computed(() => now.value.week.some(spans => spans.length > 0))

function projectLine(project: Project) {
  const status = statuses.value[project.name]
  const rules = [project.local, project.shared].filter(rule => rule !== null).map(rule => rule.text)
  if (status.frozen)
    return { tone: 'red', icon: 'hand.raised' as const, subtitle: `禁推中 · ${status.opensLabel}` }
  if (pause.value)
    return { tone: 'orange', icon: 'pause' as const, subtitle: `已关闭（全局）· ${pauseLabel.value}` }
  if (rules.length === 0)
    return { tone: 'gray', icon: 'folder' as const, subtitle: globalRule.value ? '只有全局规则' : '未设置规则' }
  return { tone: 'blue', icon: 'folder' as const, subtitle: rules.join('；') }
}

function presetItems(rule: Rule | null, scope: Scope): PopMenuItem[] {
  return [
    ...PRESETS.map(preset => ({ key: preset.rule.text, label: preset.title, detail: preset.rule.text, checked: rule?.text === preset.rule.text })),
    { key: '', label: `清除${SCOPE_LABELS[scope]}规则`, disabled: rule === null, separated: true },
  ]
}

/** Checking a preset replaces the scope's rules; unchecking it, or「清除」, clears them. */
function pick(rule: Rule | null, key: string): Rule | null {
  if (key === '' || rule?.text === key)
    return null
  return PRESETS.find(preset => preset.rule.text === key)!.rule
}

const pauseItems = computed<PopMenuItem[]>(() => [
  ...PAUSES.map(option => ({ key: option.title, label: option.title })),
  ...(pause.value ? [{ key: 'resume', label: '恢复', separated: true }] : []),
])

/** A duration from the timer menu, or「恢复」. */
function choosePause(key: string) {
  const option = PAUSES.find(option => option.title === key)
  pause.value = option ? { until: option.until(NOW) } : null
}

function toggleAll() {
  pause.value = pause.value ? null : { until: null }
}

function percent(minutes: number): string {
  return `${minutes / DAY * 100}%`
}

function spansLabel(spans: Span[], offset: number): string {
  const day = offset === 0 ? '今天' : dayLabel(offset)
  return spans.length ? `${day}禁推 ${spans.map(([start, end]) => `${clock(start)} 到 ${clock(end)}`).join('、')}` : `${day}没有禁推`
}

function hours(spans: Span[]): string {
  const minutes = spans.reduce((sum, [start, end]) => sum + end - start, 0)
  if (minutes === 0)
    return '—'
  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${(minutes / 60).toFixed(1)} 小时`
}
</script>

<template>
  <figure class="desk" role="group" aria-label="macOS 菜单栏面板示意：推送时段">
    <div class="menubar">
      <span
        class="mark" role="img"
        :aria-label="now.frozen ? '菜单栏的云匣图标，右上角圆点表示当前仓库处于禁推时段' : '菜单栏的云匣图标'"
      >
        <svg viewBox="0 0 64 54" aria-hidden="true">
          <mask id="yb-mark-badge">
            <rect width="64" height="54" fill="#fff" />
            <circle v-if="now.frozen" cx="55" cy="9" r="12" fill="#000" />
          </mask>
          <g fill="currentColor" mask="url(#yb-mark-badge)">
            <path d="M8 13H56V21H8Z" />
            <path fill-rule="evenodd" d="M11 25H53V53H11ZM22.6 33.6 28.6 44H16.6ZM41.6 33.4A5.6 5.6 0 1 0 41.6 44.6 5.6 5.6 0 1 0 41.6 33.4Z" />
          </g>
          <circle v-if="now.frozen" cx="55" cy="9" r="8" fill="currentColor" />
        </svg>
      </span>
      <span class="menubar-clock">10月20日 周二 15:30</span>
    </div>

    <div class="panel">
      <header class="head">
        <strong>推送时段</strong>
        <PopMenu label="定时关闭本机所有仓库的禁推时段" heading="关闭本机所有仓库的禁推时段" :items="pauseItems" @select="choosePause">
          <SymbolIcon name="timer" />
        </PopMenu>
        <button
          type="button" class="switch" role="switch" :aria-checked="!pause" aria-label="禁推时段（本机所有仓库）"
          :title="pause ? '恢复本机所有仓库的禁推时段' : '关闭本机所有仓库的禁推时段（规则保留）'"
          @click="toggleAll"
        >
          <span />
        </button>
      </header>

      <section class="card" aria-live="polite">
        <div class="card-top">
          <span class="dot" :class="`tone-${card.tone}`" aria-hidden="true"><SymbolIcon :name="card.icon" /></span>
          <p>
            <strong>{{ card.title }}</strong>
            <small>{{ card.subtitle }}<template v-if="card.detail"><br>{{ card.detail }}</template></small>
          </p>
        </div>
        <div v-if="pause" class="paused">
          <SymbolIcon name="pause" class="paused-icon" />
          <span>已关闭（全局）· {{ pauseLabel }}</span>
          <button type="button" class="small-button" @click="pause = null">
            恢复
          </button>
        </div>
        <div class="today" :class="{ dimmed: pause }">
          <div class="timeline timeline-today" role="img" :aria-label="`${spansLabel(now.week[0], 0)}，现在 15:30`">
            <i v-for="[start, end] in now.week[0]" :key="start" :style="{ left: percent(start), width: percent(end - start) }" />
            <b :style="{ left: percent(NOW) }" />
          </div>
          <p class="hours" aria-hidden="true">
            <span v-for="hour in [0, 6, 12, 18, 24]" :key="hour">{{ hour }}</span>
          </p>
        </div>
      </section>

      <template v-if="hasWeek">
        <hr>
        <div class="section-title">
          未来 7 天
        </div>
        <ul class="week">
          <li v-for="(spans, offset) in now.week" :key="offset">
            <span class="week-day" :class="{ 'week-today': offset === 0 }">{{ offset === 0 ? '今天' : dayLabel(offset) }}</span>
            <span class="timeline" role="img" :aria-label="spansLabel(spans, offset)">
              <i v-for="[start, end] in spans" :key="start" :style="{ left: percent(start), width: percent(end - start) }" />
              <b v-if="offset === 0" :style="{ left: percent(NOW) }" />
            </span>
            <span class="week-hours">{{ hours(spans) }}</span>
          </li>
        </ul>
      </template>

      <hr>
      <div class="section-title">
        全局规则<small>本机所有仓库</small>
        <PopMenu class="section-menu" label="全局预设" heading="全局预设" :items="presetItems(globalRule, 'global')" @select="key => globalRule = pick(globalRule, key)">
          <SymbolIcon name="plus.circle" />
        </PopMenu>
      </div>
      <div class="row">
        <span class="dot dot-small" :class="globalRule ? 'tone-blue' : 'tone-gray'" aria-hidden="true"><SymbolIcon name="globe" /></span>
        <p>
          <template v-if="globalRule">
            <span class="mono">{{ globalRule.text }}</span>
            <small>全局</small>
          </template>
          <template v-else>
            <span>没有全局规则</span>
            <small>在右上角「＋」选择预设，对本机所有仓库生效</small>
          </template>
        </p>
      </div>

      <hr>
      <div class="section-title">
        项目<small>每个项目单独设置</small>
      </div>
      <div v-for="project in projects" :key="project.name" class="project">
        <button
          type="button" class="row row-button" :aria-expanded="expanded === project.name"
          :aria-controls="`fp-${project.name}`" @click="expanded = expanded === project.name ? null : project.name"
        >
          <span class="dot dot-small" :class="`tone-${projectLine(project).tone}`" aria-hidden="true"><SymbolIcon :name="projectLine(project).icon" /></span>
          <span class="row-text">
            <span>{{ project.name }}<i v-if="project.name === current" class="current">当前</i></span>
            <small>{{ projectLine(project).subtitle }}</small>
          </span>
          <SymbolIcon name="chevron.right" class="chevron" />
        </button>
        <div v-if="expanded === project.name" :id="`fp-${project.name}`" class="details">
          <div v-for="scope in (['local', 'shared'] as const)" :key="scope" class="detail">
            <span class="detail-scope">{{ SCOPE_LABELS[scope] }}</span>
            <span class="mono" :class="{ unset: !project[scope] }">{{ project[scope]?.text ?? '未设置' }}</span>
            <PopMenu :label="`${project.name} 的${SCOPE_LABELS[scope]}预设`" :heading="`${SCOPE_LABELS[scope]}预设`" :items="presetItems(project[scope], scope)" @select="key => project[scope] = pick(project[scope], key)">
              <SymbolIcon name="plus.circle" />
            </PopMenu>
          </div>
          <div v-if="project.name !== current" class="detail-actions">
            <button type="button" class="small-button" @click="current = project.name">
              设为当前
            </button>
          </div>
        </div>
      </div>
      <p class="menu-item inert">
        <SymbolIcon name="plus" />添加项目…
      </p>

      <hr>
      <p class="menu-item inert">
        <SymbolIcon name="slider.horizontal.3" />编辑禁推时段…
      </p>
      <p class="menu-item inert">
        <SymbolIcon name="macwindow" />打开云匣
      </p>
      <a class="menu-item" :href="withBase('/guide/freeze')">
        <SymbolIcon name="questionmark.circle" />使用说明
      </a>
      <p class="menu-item inert">
        <SymbolIcon name="power" />退出云匣
      </p>
    </div>
  </figure>
</template>

<style scoped>
.desk {
  --fp-panel: rgb(240 240 244 / 0.86);
  --fp-menu: rgb(246 246 248 / 0.94);
  --fp-red: #ff3b30;
  --fp-orange: #ff9500;
  --fp-green: #34c759;
  --fp-blue: var(--yb-accent);
  --fp-gray: #8e8e93;

  position: relative;
  width: 100%;
  max-width: 420px;
  margin: 0 auto;
  padding-bottom: 28px;
  border-radius: 14px;
  background:
    radial-gradient(ellipse 80% 50% at 85% 0%, rgb(85 170 255 / 0.45), transparent 70%),
    radial-gradient(ellipse 70% 60% at 0% 100%, rgb(37 99 235 / 0.3), transparent 70%),
    linear-gradient(170deg, #dbe8fb, #eef3fb 55%, #d6e2f6);
  box-shadow: var(--yb-shadow-window);
  color: var(--yb-label);
  font-size: 13px;
  line-height: 1.4;
  text-align: left;
}

.dark .desk {
  --fp-panel: rgb(36 36 40 / 0.86);
  --fp-menu: rgb(44 44 48 / 0.96);
  --fp-red: #ff453a;
  --fp-orange: #ff9f0a;
  --fp-green: #30d158;
  --fp-gray: #636366;

  background:
    radial-gradient(ellipse 80% 50% at 85% 0%, rgb(76 141 255 / 0.32), transparent 70%),
    radial-gradient(ellipse 70% 60% at 0% 100%, rgb(37 99 235 / 0.22), transparent 70%),
    linear-gradient(170deg, #121a2c, #0c1020 55%, #101828);
}

p {
  margin: 0;
}

i {
  font-style: normal;
}

/* Menu bar */
.menubar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
  height: 28px;
  padding: 0 14px;
  border-radius: 14px 14px 0 0;
  background: rgb(255 255 255 / 0.5);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  font-size: 12.5px;
  font-weight: 500;
}

.dark .menubar {
  background: rgb(0 0 0 / 0.35);
}

.mark {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 7px;
  border-radius: 5px;
  background: rgb(0 0 0 / 0.1);
}

.dark .mark {
  background: rgb(255 255 255 / 0.18);
}

.mark svg {
  width: 19px;
  height: 16px;
}

.menubar-clock {
  white-space: nowrap;
}

/* Panel */
.panel {
  width: 340px;
  margin: 6px 12px 0 auto;
  padding: 6px;
  border-radius: 12px;
  background: var(--fp-panel);
  box-shadow: 0 0 0 0.5px rgb(0 0 0 / 0.14), 0 16px 40px -12px rgb(0 0 0 / 0.35);
  backdrop-filter: blur(30px) saturate(160%);
  -webkit-backdrop-filter: blur(30px) saturate(160%);
}

.dark .panel {
  box-shadow: 0 0 0 0.5px rgb(255 255 255 / 0.16), 0 16px 40px -12px rgb(0 0 0 / 0.7);
}

.panel hr {
  margin: 5px 8px;
  border: 0;
  border-top: 0.5px solid var(--yb-separator);
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 6px;
  color: var(--yb-label-2);
  font-size: 13px;
}

.head strong {
  margin-right: auto;
  color: var(--yb-label);
  font-weight: 600;
}

.switch {
  position: relative;
  flex: none;
  width: 30px;
  height: 17px;
  border-radius: 999px;
  background: var(--yb-fill-strong);
  box-shadow: inset 0 0 0 0.5px var(--yb-separator);
  transition: background-color 160ms;
}

.switch[aria-checked='true'] {
  background: var(--yb-accent);
}

.switch span {
  position: absolute;
  top: 1.5px;
  left: 1.5px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.3);
  transition: transform 160ms;
}

.switch[aria-checked='true'] span {
  transform: translateX(13px);
}

.switch:focus-visible,
.row-button:focus-visible,
.small-button:focus-visible,
.menu-item:focus-visible {
  outline: 2px solid var(--yb-accent);
  outline-offset: 1px;
}

/* Current repository */
.card {
  display: grid;
  gap: 8px;
  margin: 0 2px;
  padding: 10px;
  border-radius: 8px;
  background: var(--yb-fill-strong);
}

.card-top,
.row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.card-top p,
.row p,
.row-text {
  display: grid;
  flex: 1;
  min-width: 0;
}

.card-top strong {
  font-size: 13px;
  font-weight: 600;
}

small {
  color: var(--yb-label-2);
  font-size: 11px;
}

.dot {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: linear-gradient(color-mix(in srgb, var(--tone) 82%, #fff), var(--tone));
  color: #fff;
  font-size: 14px;
}

.dot :deep(.symbol) {
  stroke-width: 2.6;
}

.dot-small {
  width: 26px;
  height: 26px;
  font-size: 12px;
}

.tone-red {
  --tone: var(--fp-red);
}

.tone-orange {
  --tone: var(--fp-orange);
}

.tone-green {
  --tone: var(--fp-green);
}

.tone-blue {
  --tone: var(--fp-blue);
}

.tone-gray {
  --tone: var(--fp-gray);
}

.paused {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.paused span {
  flex: 1;
}

.paused-icon {
  padding: 2px;
  border-radius: 50%;
  background: var(--fp-orange);
  color: #fff;
  font-size: 13px;
  stroke-width: 3;
}

.small-button {
  padding: 1px 9px;
  border-radius: 5px;
  background: var(--yb-window);
  box-shadow: 0 0 0 0.5px var(--yb-separator), 0 1px 1.5px rgb(0 0 0 / 0.1);
  color: var(--yb-label);
  font-size: 11.5px;
}

.today {
  transition: opacity 160ms;
}

.dimmed {
  opacity: 0.45;
}

.timeline {
  position: relative;
  display: block;
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--yb-fill-strong);
}

.timeline-today {
  height: 8px;
  margin: 3px 0;
}

.timeline i {
  position: absolute;
  top: 0;
  bottom: 0;
  min-width: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--fp-red) 78%, transparent);
  transition: left 200ms, width 200ms;
}

.timeline b {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: var(--yb-label);
}

.hours {
  display: flex;
  justify-content: space-between;
  color: var(--yb-label-3);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}

/* Sections */
.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  color: var(--yb-label-2);
  font-size: 12px;
  font-weight: 600;
}

.section-title small {
  color: var(--yb-label-3);
  font-weight: 400;
}

.section-menu {
  margin-left: auto;
  color: var(--yb-label-2);
  font-size: 14px;
}

.week {
  display: grid;
  gap: 5px;
  margin: 0;
  padding: 0 8px 4px;
  list-style: none;
}

.week li {
  display: flex;
  align-items: center;
  gap: 8px;
}

.week-day {
  flex: none;
  width: 28px;
  font-size: 11px;
}

.week-today {
  font-weight: 600;
}

.week-hours {
  flex: none;
  width: 48px;
  color: var(--yb-label-2);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.row {
  padding: 4px 8px;
}

.row-button {
  width: 100%;
  border-radius: 6px;
  color: inherit;
  text-align: left;
}

.row-button:hover {
  background: var(--yb-fill-strong);
}

.row-text > span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.current {
  margin-left: 5px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--yb-fill-strong);
  color: var(--yb-label-2);
  font-size: 9.5px;
  font-weight: 500;
  vertical-align: 1px;
}

.chevron {
  color: var(--yb-label-3);
  font-size: 11px;
  stroke-width: 2.4;
  transition: transform 160ms;
}

.row-button[aria-expanded='true'] .chevron {
  transform: rotate(90deg);
}

.details {
  display: grid;
  gap: 4px;
  padding: 2px 8px 6px 44px;
}

.detail {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}

.detail-scope {
  flex: none;
  width: 40px;
  color: var(--yb-label-2);
}

.detail .mono {
  flex: 1;
  min-width: 0;
}

.detail :deep(.pop) {
  color: var(--yb-label-2);
  font-size: 14px;
}

.mono {
  font-family: var(--yb-font-mono);
  font-size: 11.5px;
}

.unset {
  color: var(--yb-label-3);
}

.detail-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 2px;
}

/* Plain menu items */
.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  border-radius: 6px;
  color: var(--yb-label);
  text-decoration: none;
}

.menu-item :deep(.symbol) {
  width: 16px;
  color: var(--yb-label-2);
}

a.menu-item:hover {
  background: var(--yb-accent);
  color: #fff;
}

a.menu-item:hover :deep(.symbol) {
  color: #fff;
}

.inert {
  color: var(--yb-label);
}

@media (max-width: 640px) {
  .desk {
    max-width: none;
    margin: 0;
    padding-bottom: 14px;
  }

  .menubar-clock {
    font-size: 12px;
  }

  .panel {
    width: auto;
    margin: 6px 8px 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .switch,
  .switch span,
  .timeline i,
  .chevron,
  .today {
    transition: none;
  }
}
</style>
