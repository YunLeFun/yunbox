<script setup lang="ts">
/**
 * macOS window chrome: traffic lights, an optional title and toolbar, and
 * an optional translucent sidebar, so every demo on the page reads as part
 * of the same desktop.
 *
 * @example
 * ```vue
 * <MacWindow title="推送检查">
 *   <template #sidebar>…</template>
 *   …
 * </MacWindow>
 * ```
 */
defineProps<{
  /** Title shown in the title bar */
  title?: string
  /** Accessible name for the whole window */
  label: string
}>()
</script>

<template>
  <div class="mac-window" role="group" :aria-label="label">
    <aside v-if="$slots.sidebar" class="mac-sidebar">
      <div class="mac-lights" aria-hidden="true">
        <i /><i /><i />
      </div>
      <slot name="sidebar" />
    </aside>
    <div class="mac-main">
      <div class="mac-titlebar">
        <div v-if="!$slots.sidebar" class="mac-lights" aria-hidden="true">
          <i /><i /><i />
        </div>
        <span v-if="title" class="mac-title" :class="{ 'mac-title-center': !$slots.sidebar }">{{ title }}</span>
        <div class="mac-toolbar">
          <slot name="toolbar" />
        </div>
      </div>
      <div class="mac-content">
        <slot />
      </div>
    </div>
    <slot name="overlay" />
  </div>
</template>

<style scoped>
.mac-window {
  position: relative;
  display: flex;
  min-width: 0;
  border-radius: 12px;
  background: var(--yb-window);
  box-shadow: var(--yb-shadow-window);
  overflow: hidden;
  color: var(--yb-label);
  font-size: 13px;
  line-height: 1.4;
  text-align: left;
}

.mac-sidebar {
  display: flex;
  flex-direction: column;
  flex: none;
  width: 176px;
  padding: 14px 10px 12px;
  background: var(--yb-sidebar);
  border-right: 0.5px solid var(--yb-separator);
  backdrop-filter: blur(30px);
}

.mac-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.mac-titlebar {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 46px;
  padding: 0 14px;
  background: var(--yb-toolbar);
  border-bottom: 0.5px solid var(--yb-separator);
}

.mac-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--yb-label-2);
}

.mac-titlebar {
  position: relative;
}

/* Windows without a sidebar centre the title, like Terminal. */
.mac-title-center {
  position: absolute;
  left: 50%;
  translate: -50% 0;
}

.mac-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-left: auto;
  color: var(--yb-label-2);
  font-size: 16px;
}

.mac-lights {
  display: flex;
  gap: 8px;
  padding: 2px 2px 0;
}

.mac-sidebar .mac-lights {
  margin-bottom: 22px;
}

.mac-lights i {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #ff5f57;
  box-shadow: inset 0 0 0 0.5px rgb(0 0 0 / 0.12);
}

.mac-lights i:nth-child(2) {
  background: #febc2e;
}

.mac-lights i:nth-child(3) {
  background: #28c840;
}

.mac-content {
  flex: 1;
  min-width: 0;
}

@media (max-width: 760px) {
  .mac-sidebar {
    display: none;
  }

  .mac-main .mac-titlebar::before {
    content: '';
    width: 52px;
    height: 12px;
    background:
      radial-gradient(circle at 6px 6px, #ff5f57 6px, transparent 6.5px),
      radial-gradient(circle at 26px 6px, #febc2e 6px, transparent 6.5px),
      radial-gradient(circle at 46px 6px, #28c840 6px, transparent 6.5px);
  }
}
</style>
