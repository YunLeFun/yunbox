<script setup lang="ts">
/**
 * The homepage hero: the YunBox mark as a real box. Assets drop in through
 * the lifted lid and fill it (visible through the triangle and circle
 * windows), while Git only gains a few lines of pointer text per file.
 * Plays once on load; the replay button runs it again.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { DEMO_ASSETS, formatBytes, pointerFor } from '../demo-assets'

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
const pointer = computed(() => stored.value === 0 ? undefined : pointerFor(DEMO_ASSETS[stored.value - 1]))

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
    const start = 400 + index * STEP_MS
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
  later(400 + DEMO_ASSETS.length * STEP_MS, () => {
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
    <svg class="box" viewBox="-6 -34 76 92" role="img" aria-hidden="true">
      <defs>
        <clipPath id="yb-body-clip">
          <path d="M11 25H53V53H11Z" />
        </clipPath>
      </defs>
      <!-- What shows through the windows: empty paper, rising sky as the box fills -->
      <rect x="11" y="25" width="42" height="28" class="box-inside" />
      <g clip-path="url(#yb-body-clip)">
        <rect
          x="11" width="42" height="28" class="box-fill"
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
        <rect x="17" y="-30" width="30" height="10" rx="2" />
        <text x="32" y="-23.6" text-anchor="middle">{{ chip.name }}</text>
      </g>
      <path class="box-body" fill-rule="evenodd" d="M11 25H53V53H11ZM22.6 33.6 28.6 44H16.6ZM41.6 33.4A5.6 5.6 0 1 0 41.6 44.6 5.6 5.6 0 1 0 41.6 33.4Z" />
      <path class="box-lid" :class="{ 'box-lid-open': lidOpen }" d="M8 13H56V21H8Z" />
    </svg>

    <figcaption class="ledger">
      <div class="ledger-row">
        <span class="ledger-label">存进你的 COS</span>
        <strong class="ledger-value">{{ formatBytes(storedBytes) }}</strong>
        <span class="ledger-note">{{ stored }} 个素材</span>
      </div>
      <div class="ledger-row">
        <span class="ledger-label">Git 仓库增加</span>
        <strong class="ledger-value">{{ formatBytes(pointerBytes) }}</strong>
        <span class="ledger-note">每个素材一个指针文件</span>
      </div>
      <pre class="pointer" :class="{ 'pointer-empty': !pointer }"><code>{{ pointer ?? '# 素材的指针会出现在这里' }}</code></pre>
      <button class="replay" type="button" :disabled="playing" @click="play">
        {{ playing ? '正在装匣…' : '再装一次' }}
      </button>
    </figcaption>
  </figure>
</template>

<style scoped>
.stage {
  display: grid;
  gap: 20px;
  margin: 0;
}

.box {
  width: min(100%, 420px);
  justify-self: center;
  overflow: visible;
}

.box-inside {
  fill: var(--yb-paper);
}

.box-fill {
  fill: var(--yb-sky);
  transition: transform 520ms cubic-bezier(0.3, 0.7, 0.2, 1);
}

.box-body,
.box-lid {
  fill: var(--yb-blue);
}

.box-lid {
  transform-box: fill-box;
  transform-origin: 0% 100%;
  transition: transform 260ms cubic-bezier(0.3, 0.7, 0.2, 1);
}

.box-lid-open {
  transform: translate(-2px, -9px) rotate(-14deg);
}

.chip rect {
  fill: var(--yb-sheet);
  stroke: var(--yb-ink);
  stroke-width: 0.5;
}

.chip text {
  fill: var(--yb-ink);
  font-family: var(--yb-font-mono);
  font-size: 3.1px;
}

/* The file fades as it lands, so it does not show through the windows. */
.chip {
  transition:
    transform var(--drop) cubic-bezier(0.55, 0, 0.9, 0.4),
    opacity 140ms linear calc(var(--drop) - 140ms);
}

.chip-falling {
  transform: translateY(64px);
  opacity: 0;
}

.ledger {
  display: grid;
  gap: 10px;
}

.ledger-row {
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: baseline;
  gap: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--yb-line);
}

.ledger-label {
  color: var(--yb-ink-soft);
  font-size: 14px;
  white-space: nowrap;
}

.ledger-value {
  color: var(--yb-ink);
  font-size: 22px;
  font-variant-numeric: tabular-nums;
  min-width: 5.5em;
}

.ledger-note {
  color: var(--yb-ink-soft);
  font-size: 13px;
  text-align: right;
}

.pointer {
  margin: 4px 0 0;
  padding: 12px 14px;
  border-radius: var(--yb-radius-sm);
  background: var(--yb-sheet);
  border: 1px solid var(--yb-line);
  color: var(--yb-ink);
  font-family: var(--yb-font-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  min-height: 5.8em;
}

.pointer-empty {
  color: var(--yb-ink-soft);
}

.replay {
  justify-self: start;
  padding: 4px 0;
  color: var(--yb-blue);
  font-size: 14px;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.replay:disabled {
  color: var(--yb-ink-soft);
  text-decoration: none;
  cursor: default;
}

.replay:focus-visible {
  outline: 2px solid var(--yb-blue);
  outline-offset: 2px;
}

@media (max-width: 640px) {
  .box {
    width: min(72%, 260px);
  }

  .ledger-note {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .box-fill,
  .box-lid,
  .chip {
    transition: none;
  }
}
</style>
