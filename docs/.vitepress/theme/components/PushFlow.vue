<script setup lang="ts">
/**
 * One `git push`, drawn as two lanes: commits and pointers go to the code
 * host, assets go from the transfer agent straight to the team's COS bucket.
 * The empty slot between them is where a server would usually sit.
 */
import { computed, ref } from 'vue'
import { DEMO_ASSETS, demoOid, formatBytes, pointerFor } from '../demo-assets'

const PREFIX = 'yunbox/team/game'
const pushed = DEMO_ASSETS.slice(0, 3)

const state = ref<'idle' | 'moving' | 'done'>('idle')
const pointerBytes = computed(() => pushed.reduce((sum, asset) => sum + pointerFor(asset).length, 0))
const assetBytes = computed(() => pushed.reduce((sum, asset) => sum + asset.bytes, 0))
const keys = computed(() => pushed.map((asset) => {
  const oid = demoOid(asset.name)
  return `${PREFIX}/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid.slice(0, 12)}…`
}))

function push(): void {
  if (state.value === 'moving')
    return
  state.value = 'idle'
  requestAnimationFrame(() => {
    state.value = 'moving'
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    setTimeout(() => (state.value = 'done'), reduced ? 0 : 1600)
  })
}
</script>

<template>
  <div class="flow" :class="`flow-${state}`">
    <div class="machine">
      <p class="machine-title">
        你的电脑
      </p>
      <ol class="machine-steps">
        <li><code>git push</code></li>
        <li><code>git-lfs</code> 找出 {{ pushed.length }} 个素材</li>
        <li><code>git-yunbox lfs-agent</code> 用本机密钥签名</li>
      </ol>
      <button class="push" type="button" :disabled="state === 'moving'" @click="push">
        {{ state === 'done' ? '再推送一次' : '推送一次' }}
      </button>
    </div>

    <div class="lane lane-code">
      <div class="track">
        <span class="parcel parcel-small" />
        <span class="track-label">提交和指针，{{ formatBytes(pointerBytes) }}</span>
      </div>
      <div class="dest">
        <p class="dest-title">
          代码托管
        </p>
        <p class="dest-sub">
          GitHub、GitLab、工蜂……照旧
        </p>
        <p class="dest-result">
          收到 1 个提交，{{ pushed.length }} 个指针文件
        </p>
      </div>
    </div>

    <div class="lane lane-assets">
      <div class="track">
        <span class="parcel parcel-big" />
        <span class="track-label">素材本体，{{ formatBytes(assetBytes) }}</span>
        <span class="no-server">这里没有服务端</span>
      </div>
      <div class="dest dest-cos">
        <p class="dest-title">
          你的 COS bucket
        </p>
        <p class="dest-sub">
          私有读写，按内容寻址
        </p>
        <ul class="dest-result keys">
          <li v-for="key in keys" :key="key">
            <code>{{ key }}</code>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.flow {
  display: grid;
  grid-template-columns: minmax(220px, 280px) 1fr;
  grid-template-rows: auto auto;
  gap: 18px 0;
}

.machine {
  grid-row: 1 / span 2;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 20px;
  border: 1.5px solid var(--yb-ink);
  border-radius: var(--yb-radius-lg);
  background: var(--yb-sheet);
}

.machine-title,
.dest-title {
  margin: 0;
  color: var(--yb-ink);
  font-weight: 700;
  font-size: 16px;
}

.machine-steps {
  margin: 0;
  padding-left: 1.3em;
  color: var(--yb-ink-soft);
  font-size: 14px;
  line-height: 1.6;
}

.machine-steps li + li {
  margin-top: 6px;
}

.machine-steps code,
.keys code {
  font-family: var(--yb-font-mono);
  font-size: 12.5px;
  color: var(--yb-ink);
  background: none;
  padding: 0;
}

.push {
  margin-top: auto;
  align-self: flex-start;
  padding: 8px 18px;
  border-radius: 999px;
  background: var(--yb-action);
  color: #fff;
  font-weight: 600;
  font-size: 14px;
}

.push:disabled {
  opacity: 0.6;
}

.push:focus-visible {
  outline: 2px solid var(--yb-ink);
  outline-offset: 3px;
}

.lane {
  min-width: 0;
  display: grid;
  grid-template-columns: 1fr minmax(200px, 260px);
  align-items: center;
}

.track {
  position: relative;
  height: 64px;
}

.track::before {
  content: '';
  position: absolute;
  inset: 50% 0 auto;
  border-top: 2px solid var(--yb-line);
}

.lane-assets .track::before {
  border-top-color: var(--yb-blue);
}

.track-label {
  position: absolute;
  top: 4px;
  left: 18px;
  color: var(--yb-ink-soft);
  font-size: 13px;
}

.no-server {
  position: absolute;
  left: 50%;
  bottom: -2px;
  translate: -50% 0;
  padding: 2px 10px;
  border: 1.5px dashed var(--yb-ink-soft);
  border-radius: var(--yb-radius-sm);
  background: var(--yb-paper);
  color: var(--yb-ink-soft);
  font-size: 12px;
  white-space: nowrap;
}

.parcel {
  position: absolute;
  top: 50%;
  left: 0;
  translate: 0 -50%;
  opacity: 0;
  background: var(--yb-blue);
}

.parcel-small {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--yb-ink-soft);
}

.parcel-big {
  width: 30px;
  height: 22px;
  border-radius: 4px;
  box-shadow: 0 0 0 4px var(--vp-c-brand-soft);
}

.flow-moving .parcel {
  animation: travel 1.5s cubic-bezier(0.45, 0, 0.25, 1) forwards;
}

.flow-moving .parcel-big {
  animation-delay: 0.1s;
}

@keyframes travel {
  0% {
    left: 0;
    opacity: 1;
  }
  92% {
    opacity: 1;
  }
  100% {
    left: calc(100% - 30px);
    opacity: 0;
  }
}

.dest {
  min-width: 0;
  padding: 14px 16px;
  border: 1.5px solid var(--yb-line);
  border-radius: var(--yb-radius-lg);
  background: var(--yb-sheet);
  transition: border-color 200ms;
}

.dest-cos {
  border-color: var(--yb-blue);
}

.dest-sub {
  margin: 2px 0 0;
  color: var(--yb-ink-soft);
  font-size: 13px;
}

.dest-result {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
  color: var(--yb-ink);
  font-size: 13px;
  visibility: hidden;
}

.flow-done .dest-result {
  visibility: visible;
}

.keys li {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Phones: the machine on top, the two lanes side by side below it. */
@media (max-width: 760px) {
  .flow {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0 12px;
  }

  .machine {
    grid-row: auto;
    grid-column: 1 / -1;
  }

  .lane {
    grid-template-columns: 1fr;
    align-items: stretch;
  }

  .track {
    height: 128px;
  }

  .track::before {
    inset: 0 auto 0 20px;
    border-top: 0;
    border-left: 2px solid var(--yb-line);
  }

  .lane-assets .track::before {
    border-left-color: var(--yb-blue);
  }

  .track-label {
    top: 18px;
    left: 34px;
    right: 0;
  }

  .no-server {
    left: 34px;
    right: auto;
    bottom: 18px;
    translate: none;
    white-space: normal;
  }

  .parcel {
    left: 21px;
    top: 0;
    translate: -50% 0;
  }

  .dest {
    padding: 12px;
  }

  .keys li {
    font-size: 11px;
  }

  @keyframes travel {
    0% {
      top: 0;
      opacity: 1;
    }
    92% {
      opacity: 1;
    }
    100% {
      top: calc(100% - 22px);
      opacity: 0;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .flow-moving .parcel {
    animation: none;
  }
}
</style>
