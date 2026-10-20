<script setup lang="ts">
/**
 * One `git push`, drawn as two lanes: commits and pointers go to the code
 * host, assets go from the transfer agent straight to the team's COS bucket.
 * The empty slot between them is where a server would usually sit.
 */
import { computed, ref } from 'vue'
import { DEMO_ASSETS, demoOid, formatBytes, pointerFor } from '../demo-assets'
import { useCopy } from '../i18n'
import SymbolIcon from './SymbolIcon.vue'

const t = useCopy({
  zh: {
    machine: '你的电脑',
    found: (count: number) => `找出 ${count} 个素材`,
    signs: '用本机密钥签名',
    push: '推送一次',
    again: '再推送一次',
    commits: (size: string) => `提交和指针，${size}`,
    codeHost: '代码托管',
    codeHostSub: 'GitHub、GitLab、工蜂，照旧使用',
    received: (count: number) => `收到 1 个提交，${count} 个指针文件`,
    assets: (size: string) => `素材本体，${size}`,
    noServer: '中间没有服务端',
    bucket: '你的 COS bucket',
    bucketSub: '私有读写，按内容寻址',
  },
  en: {
    machine: 'Your computer',
    found: (count: number) => `finds ${count} assets`,
    signs: 'signs with your local key',
    push: 'Push',
    again: 'Push Again',
    commits: (size: string) => `Commits and pointers, ${size}`,
    codeHost: 'Code host',
    codeHostSub: 'GitHub, GitLab or any Git host, as before',
    received: (count: number) => `Received 1 commit and ${count} pointer files`,
    assets: (size: string) => `The assets themselves, ${size}`,
    noServer: 'No server in between',
    bucket: 'Your COS bucket',
    bucketSub: 'Private, content-addressed',
  },
})

const PREFIX = 'yunbox/team/game'
const pushed = DEMO_ASSETS.slice(0, 3)

const state = ref<'idle' | 'moving' | 'done'>('idle')
const pointerBytes = computed(() => pushed.reduce((sum, asset) => sum + pointerFor(asset).length, 0))
const assetBytes = computed(() => pushed.reduce((sum, asset) => sum + asset.bytes, 0))
const keys = computed(() => pushed.map((asset) => {
  const oid = demoOid(asset.name)
  return `${PREFIX}/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid.slice(0, 10)}…`
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
    <div class="node machine">
      <p class="node-title">
        <span class="node-icon"><SymbolIcon name="laptopcomputer" /></span>
        {{ t.machine }}
      </p>
      <ol class="steps">
        <li><code>git push</code></li>
        <li><code>git-lfs</code> {{ t.found(pushed.length) }}</li>
        <li><code>git-yunbox lfs-agent</code> {{ t.signs }}</li>
      </ol>
      <button class="push" type="button" :disabled="state === 'moving'" @click="push">
        <SymbolIcon name="arrow.up.doc" />
        {{ state === 'done' ? t.again : t.push }}
      </button>
    </div>

    <div class="lane lane-code">
      <div class="track">
        <span class="parcel parcel-small" />
        <span class="track-label">{{ t.commits(formatBytes(pointerBytes)) }}</span>
      </div>
      <div class="node dest">
        <p class="node-title">
          <span class="node-icon node-icon-grey"><SymbolIcon name="arrow.triangle.branch" /></span>
          {{ t.codeHost }}
        </p>
        <p class="dest-sub">
          {{ t.codeHostSub }}
        </p>
        <p class="dest-result">
          <SymbolIcon name="checkmark.circle.fill" class="ok" />
          {{ t.received(pushed.length) }}
        </p>
      </div>
    </div>

    <div class="lane lane-assets">
      <div class="track">
        <span class="parcel parcel-big" />
        <span class="track-label">{{ t.assets(formatBytes(assetBytes)) }}</span>
        <span class="no-server">
          <SymbolIcon name="square.on.square.dashed" />
          {{ t.noServer }}
        </span>
      </div>
      <div class="node dest">
        <p class="node-title">
          <span class="node-icon"><SymbolIcon name="icloud" /></span>
          {{ t.bucket }}
        </p>
        <p class="dest-sub">
          {{ t.bucketSub }}
        </p>
        <ul class="dest-result keys">
          <li v-for="key in keys" :key="key">
            <SymbolIcon name="checkmark.circle.fill" class="ok" />
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
  grid-template-columns: minmax(240px, 290px) minmax(0, 1fr);
  grid-template-rows: auto auto;
  gap: 16px 0;
}

.node {
  padding: 18px 20px;
  border-radius: var(--yb-radius-panel);
  background: var(--yb-window);
  box-shadow: 0 0 0 0.5px var(--yb-separator), 0 2px 8px -2px rgb(0 0 0 / 0.08);
}

.machine {
  grid-row: 1 / span 2;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.node-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  color: var(--yb-label);
  font-weight: 600;
  font-size: 16px;
}

.node-icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: linear-gradient(#55aaff, #2563eb);
  color: #fff;
  font-size: 17px;
}

.node-icon-grey {
  background: linear-gradient(#8e8e93, #636366);
}

.steps {
  margin: 0;
  padding-left: 1.2em;
  color: var(--yb-label-2);
  font-size: 14px;
  line-height: 1.6;
}

.steps li + li {
  margin-top: 6px;
}

.steps code,
.keys code {
  padding: 0;
  background: none;
  color: var(--yb-label);
  font-family: var(--yb-font-mono);
  font-size: 12.5px;
}

.push {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: auto;
  align-self: flex-start;
  padding: 7px 16px;
  border-radius: 999px;
  background: var(--yb-accent);
  color: #fff;
  font-weight: 500;
  font-size: 14px;
  transition: background-color 120ms;
}

.push:hover:not(:disabled) {
  background: var(--yb-accent-hover);
}

.push:disabled {
  opacity: 0.55;
}

.push:focus-visible {
  outline: 2px solid var(--yb-accent);
  outline-offset: 3px;
}

.lane {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(220px, 300px);
  align-items: center;
}

.track {
  position: relative;
  height: 70px;
}

.track::before {
  content: '';
  position: absolute;
  inset: 50% 0 auto;
  border-top: 1.5px solid var(--yb-separator);
}

.lane-assets .track::before {
  border-top-color: var(--yb-accent);
}

.track-label {
  position: absolute;
  top: 6px;
  left: 20px;
  color: var(--yb-label-2);
  font-size: 13px;
}

.no-server {
  position: absolute;
  left: 50%;
  bottom: 0;
  translate: -50% 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--yb-bg-alt);
  box-shadow: 0 0 0 0.5px var(--yb-separator);
  color: var(--yb-label-2);
  font-size: 12px;
  white-space: nowrap;
}

.parcel {
  position: absolute;
  top: 50%;
  left: 0;
  translate: 0 -50%;
  opacity: 0;
}

.parcel-small {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--yb-label-3);
}

.parcel-big {
  width: 28px;
  height: 20px;
  border-radius: 5px;
  background: linear-gradient(#55aaff, #2563eb);
  box-shadow: 0 2px 8px rgb(37 99 235 / 0.4);
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
    left: calc(100% - 28px);
    opacity: 0;
  }
}

.dest {
  min-width: 0;
  padding: 16px 18px;
}

.dest-sub {
  margin: 6px 0 0 40px;
  color: var(--yb-label-2);
  font-size: 13px;
}

.dest-result {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 0 40px;
  padding: 0;
  list-style: none;
  color: var(--yb-label);
  font-size: 13px;
  visibility: hidden;
}

.keys {
  display: grid;
  gap: 4px;
}

.keys li {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.keys code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
}

.ok {
  color: var(--yb-green);
}

.flow-done .dest-result {
  visibility: visible;
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
    border-left: 1.5px solid var(--yb-separator);
  }

  .lane-assets .track::before {
    border-left-color: var(--yb-accent);
  }

  .track-label {
    top: 18px;
    left: 34px;
    right: 0;
  }

  .no-server {
    left: 34px;
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

  .node-title {
    font-size: 14px;
  }

  .dest-sub,
  .dest-result {
    margin-left: 0;
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
      top: calc(100% - 20px);
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
