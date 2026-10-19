<script setup lang="ts">
/**
 * The homepage hero: the app icon itself opens up. Assets drop in through
 * the lifted lid and fill it (visible through the triangle and circle
 * windows), while Git only gains a few lines of pointer text per file.
 * Plays once on load; the replay button runs it again.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { DEMO_ASSETS, formatBytes, pointerFor } from '../demo-assets'
import SymbolIcon from './SymbolIcon.vue'

// Timings of one asset: lid opens, file falls in, lid closes.
const LIFT_MS = 260
const DROP_MS = 620
const STEP_MS = 1500

const stored = ref(0)
const current = ref(-1)
const lidOpen = ref(false)
const falling = ref(false)
const playing = ref(false)
let timers: ReturnType<typeof setTimeout>[] = []

const storedAssets = computed(() => DEMO_ASSETS.slice(0, stored.value))
const storedBytes = computed(() => storedAssets.value.reduce((sum, asset) => sum + asset.bytes, 0))
const pointerBytes = computed(() => storedAssets.value.reduce((sum, asset) => sum + pointerFor(asset).length, 0))
const fill = computed(() => stored.value / DEMO_ASSETS.length)
const chip = computed(() => DEMO_ASSETS[Math.max(current.value, 0)])
const last = computed(() => stored.value === 0 ? undefined : DEMO_ASSETS[stored.value - 1])

function later(ms: number, run: () => void): void {
  timers.push(setTimeout(run, ms))
}

function clear(): void {
  timers.forEach(clearTimeout)
  timers = []
}

function play(): void {
  clear()
  stored.value = 0
  current.value = -1
  playing.value = true
  DEMO_ASSETS.forEach((_, index) => {
    const start = 500 + index * STEP_MS
    later(start, () => {
      current.value = index
      falling.value = false
      lidOpen.value = true
    })
    later(start + LIFT_MS, () => {
      falling.value = true
    })
    later(start + LIFT_MS + DROP_MS, () => {
      stored.value = index + 1
      lidOpen.value = false
    })
  })
  later(500 + DEMO_ASSETS.length * STEP_MS, () => {
    playing.value = false
    current.value = -1
  })
}

onMounted(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    stored.value = DEMO_ASSETS.length
  else
    play()
})
onBeforeUnmount(clear)
</script>

<template>
  <figure class="stage" aria-label="素材装进云匣，Git 里只留下指针">
    <svg class="icon" viewBox="-4 -30 72 98" role="img" aria-hidden="true">
      <defs>
        <linearGradient id="yb-hero-sky" x1="32" y1="0" x2="32" y2="64" gradientUnits="userSpaceOnUse">
          <stop stop-color="#55aaff" />
          <stop offset="1" stop-color="#2563eb" />
        </linearGradient>
        <clipPath id="yb-hero-body">
          <path d="M11 25H53V53H11Z" />
        </clipPath>
      </defs>
      <rect class="squircle" width="64" height="64" rx="14.3" fill="url(#yb-hero-sky)" />
      <!-- The rising contents, seen through the triangle and circle windows -->
      <g clip-path="url(#yb-hero-body)">
        <rect
          x="11" width="42" height="28" class="contents"
          :style="{ transform: `translateY(${53 - 28 * fill}px)` }"
        />
      </g>
      <g
        v-if="current >= 0"
        :key="current"
        class="chip"
        :class="{ 'chip-falling': falling }"
        :style="{ '--drop': `${DROP_MS}ms` }"
      >
        <rect x="16" y="-26" width="32" height="9" rx="4.5" />
        <text x="32" y="-20.1" text-anchor="middle">{{ chip.name }}</text>
      </g>
      <path class="mark" fill-rule="evenodd" d="M11 25H53V53H11ZM22.6 33.6 28.6 44H16.6ZM41.6 33.4A5.6 5.6 0 1 0 41.6 44.6 5.6 5.6 0 1 0 41.6 33.4Z" />
      <path class="mark lid" :class="{ 'lid-open': lidOpen }" d="M8 13H56V21H8Z" />
    </svg>

    <figcaption class="ledger">
      <dl class="rows">
        <div class="row">
          <dt><SymbolIcon name="icloud" /> 存进你的 COS</dt>
          <dd><strong>{{ formatBytes(storedBytes) }}</strong><span>{{ stored }} 个素材</span></dd>
        </div>
        <div class="row">
          <dt><SymbolIcon name="arrow.triangle.branch" /> Git 仓库增加</dt>
          <dd><strong>{{ formatBytes(pointerBytes) }}</strong><span>只有指针</span></dd>
        </div>
      </dl>
      <div class="pointer">
        <p class="pointer-name">
          <SymbolIcon name="doc" />
          {{ last ? last.name : '指针文件' }}
          <span>在 Git 里的样子</span>
        </p>
        <pre><code>{{ last ? pointerFor(last) : '素材装进来以后，这里显示它的指针。' }}</code></pre>
      </div>
      <button class="replay" type="button" :disabled="playing" @click="play">
        <SymbolIcon name="arrow.clockwise" />
        {{ playing ? '正在装匣…' : '再装一次' }}
      </button>
    </figcaption>
  </figure>
</template>

<style scoped>
.stage {
  display: grid;
  justify-items: center;
  gap: 28px;
  margin: 0;
}

.icon {
  width: min(100%, 300px);
  overflow: visible;
}

.squircle {
  filter: drop-shadow(0 6px 10px rgb(37 99 235 / 0.35));
}

.contents {
  fill: #c9e2ff;
  transition: transform 520ms cubic-bezier(0.3, 0.7, 0.2, 1);
}

.mark {
  fill: #ffffff;
}

.lid {
  transform-box: fill-box;
  transform-origin: 0% 100%;
  transition: transform 260ms cubic-bezier(0.3, 0.7, 0.2, 1);
}

.lid-open {
  transform: translate(-2px, -9px) rotate(-14deg);
}

.chip rect {
  fill: #ffffff;
  filter: drop-shadow(0 1px 1.5px rgb(15 40 110 / 0.3));
}

.chip text {
  fill: #1d4ed8;
  font-family: var(--yb-font-mono);
  font-size: 3.2px;
  font-weight: 600;
}

/* The file fades as it lands, so it does not show through the windows. */
.chip {
  transition:
    transform var(--drop) cubic-bezier(0.55, 0, 0.9, 0.4),
    opacity 140ms linear calc(var(--drop) - 140ms);
}

.chip-falling {
  transform: translateY(62px);
  opacity: 0;
}

.ledger {
  display: grid;
  gap: 12px;
  width: min(100%, 420px);
}

.rows {
  margin: 0;
  border-radius: var(--yb-radius-card);
  background: var(--yb-fill);
  border: 0.5px solid var(--yb-separator);
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 14px;
}

.row + .row {
  border-top: 0.5px solid var(--yb-separator);
}

.row dt {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--yb-label-2);
  font-size: 14px;
}

.row dd {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
}

.row strong {
  color: var(--yb-label);
  font-size: 17px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.row dd span {
  min-width: 4.5em;
  color: var(--yb-label-3);
  font-size: 12px;
  text-align: right;
}

.pointer {
  border-radius: var(--yb-radius-card);
  background: var(--yb-fill);
  border: 0.5px solid var(--yb-separator);
  overflow: hidden;
}

.pointer-name {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 9px 14px 0;
  color: var(--yb-label);
  font-size: 13px;
  font-weight: 600;
}

.pointer-name span {
  margin-left: auto;
  color: var(--yb-label-3);
  font-weight: 400;
  font-size: 12px;
}

.pointer pre {
  margin: 0;
  padding: 8px 14px 12px;
  min-height: 72px;
  color: var(--yb-label-2);
  font-family: var(--yb-font-mono);
  font-size: 11.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}

.replay {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  justify-self: center;
  padding: 4px 10px;
  border-radius: 999px;
  color: var(--yb-accent);
  font-size: 13px;
}

.replay:hover:not(:disabled) {
  background: var(--yb-accent-soft);
}

.replay:disabled {
  color: var(--yb-label-3);
  cursor: default;
}

.replay:focus-visible {
  outline: 2px solid var(--yb-accent);
  outline-offset: 2px;
}

@media (max-width: 640px) {
  .icon {
    width: min(64%, 220px);
  }

  .row dd span {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .contents,
  .lid,
  .chip {
    transition: none;
  }
}
</style>
