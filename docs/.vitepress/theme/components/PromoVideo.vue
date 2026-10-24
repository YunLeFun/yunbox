<script setup lang="ts">
import { nextTick, shallowRef, useTemplateRef } from 'vue'
import cover from '../assets/videos/yunbox-checkin-cover.png'
import { useCopy } from '../i18n'

const bvid = 'BV1hZHN6sEL6'
const videoUrl = `https://www.bilibili.com/video/${bvid}/`
// The iframe only exists after the visitor chooses to play the first part.
const playerUrl = `https://player.bilibili.com/player.html?bvid=${bvid}&p=1&autoplay=1&muted=0&danmaku=0`
const playing = shallowRef(false)
const player = useTemplateRef<HTMLIFrameElement>('player')
const poster = useTemplateRef<HTMLButtonElement>('poster')

const t = useCopy({
  zh: {
    meta: 'P1 · 机场版 · 45 秒',
    title: '代码登机，素材托运',
    description: '用一座机场，看懂代码与大素材为什么要分开走。还有举重版和功能演示，三种方式认识云匣。',
    play: '播放 P1',
    playLabel: '播放 P1：代码登机，素材托运',
    playerTitle: '云匣宣传片 P1：代码登机，素材托运',
    allParts: '去 B 站看完整三版',
    close: '关闭视频',
  },
  en: {
    meta: 'P1 · Airport edition · 45 sec · Chinese',
    title: 'Code on board. Assets checked in.',
    description: 'An airport story about why code and large assets take different paths. Watch the weightlifting story and feature demo for two more ways to meet YunBox.',
    play: 'Play P1',
    playLabel: 'Play P1: Code on board, assets checked in',
    playerTitle: 'YunBox P1: Code on board, assets checked in',
    allParts: 'Watch all three on Bilibili',
    close: 'Close video',
  },
})

async function play() {
  playing.value = true
  await nextTick()
  player.value?.focus()
}

async function close() {
  playing.value = false
  await nextTick()
  poster.value?.focus()
}
</script>

<template>
  <section id="video" class="promo-video" aria-labelledby="promo-video-title">
    <div class="video-layout">
      <div class="video-frame">
        <iframe
          v-if="playing"
          ref="player"
          class="player"
          :src="playerUrl"
          :title="t.playerTitle"
          allow="autoplay; fullscreen; picture-in-picture"
          allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"
          tabindex="0"
        />
        <button
          v-else
          ref="poster"
          class="poster"
          type="button"
          :aria-label="t.playLabel"
          @click="play"
        >
          <img :src="cover" alt="" width="1920" height="1080" loading="lazy" decoding="async">
          <span class="play-label" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="m8 5 11 7-11 7Z" /></svg>
            {{ t.play }}
          </span>
        </button>
      </div>
      <div class="video-copy">
        <p class="video-meta">
          {{ t.meta }}
        </p>
        <h2 id="promo-video-title" class="video-title">
          {{ t.title }}
        </h2>
        <p class="video-description">
          {{ t.description }}
        </p>
        <div class="video-actions">
          <a class="all-parts" :href="videoUrl" target="_blank" rel="noopener noreferrer">
            {{ t.allParts }} <span aria-hidden="true">↗</span>
          </a>
          <button v-if="playing" class="close-video" type="button" @click="close">
            {{ t.close }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.promo-video {
  padding: 0 24px 88px;
  background: var(--yb-bg);
  scroll-margin-top: 96px;
}

.video-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr);
  align-items: center;
  gap: 40px;
  max-width: 1032px;
  margin: 0 auto;
}

.video-frame {
  aspect-ratio: 16 / 9;
  border-radius: var(--yb-radius-card);
  background: var(--yb-fill-strong);
  box-shadow: 0 0 0 1px var(--yb-separator), 0 12px 32px -16px rgb(0 0 0 / 0.2);
}

.poster,
.player {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  border-radius: inherit;
}

.poster {
  position: relative;
  padding: 0;
  overflow: hidden;
  cursor: pointer;
}

.poster img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.play-label {
  position: absolute;
  right: 16px;
  bottom: 16px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 999px;
  background: #1d1d1f;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  transition: background-color 120ms;
}

.poster:hover .play-label {
  background: #2563eb;
}

.video-meta {
  margin: 0 0 12px;
  color: var(--yb-label-2);
  font-size: 13px;
  font-weight: 500;
}

.video-title {
  margin: 0;
  color: var(--yb-label);
  font-size: clamp(24px, 2.6vw, 32px);
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: -0.02em;
  text-wrap: balance;
}

.video-description {
  margin: 16px 0 24px;
  color: var(--yb-label-2);
  font-size: 16px;
  line-height: 1.75;
}

.video-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  font-size: 15px;
}

.all-parts {
  color: var(--yb-accent);
  text-decoration: none;
}

.close-video {
  color: var(--yb-label-2);
  cursor: pointer;
}

.all-parts:hover,
.close-video:hover {
  text-decoration: underline;
}

.poster:focus-visible,
.player:focus-visible,
.all-parts:focus-visible,
.close-video:focus-visible {
  outline: 2px solid var(--yb-accent);
  outline-offset: 4px;
}

@media (max-width: 760px) {
  .video-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
  }
}

@media (max-width: 640px) {
  .promo-video {
    padding: 0 16px 64px;
  }

  .video-description {
    font-size: 15px;
  }

  .play-label {
    right: 12px;
    bottom: 12px;
    padding: 8px 12px;
  }
}
</style>
