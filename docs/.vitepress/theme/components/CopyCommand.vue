<script setup lang="ts">
/**
 * A one-line shell command with a copy button.
 *
 * @example
 * ```vue
 * <CopyCommand command="npm install -g yunbox" />
 * ```
 */
import { ref } from 'vue'

const props = defineProps<{
  /** The command, without a prompt */
  command: string
}>()

const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.command)
    copied.value = true
    clearTimeout(timer)
    timer = setTimeout(() => (copied.value = false), 1600)
  }
  catch {
    // Clipboard access can be denied; the command stays selectable.
  }
}
</script>

<template>
  <div class="copy">
    <code class="copy-text"><span class="prompt" aria-hidden="true">$ </span>{{ command }}</code>
    <button type="button" class="copy-button" :aria-label="`复制命令 ${command}`" @click="copy">
      {{ copied ? '已复制' : '复制' }}
    </button>
  </div>
</template>

<style scoped>
.copy {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 6px 6px 14px;
  border-radius: var(--yb-radius-sm);
  background: var(--yb-term-bg);
  min-width: 0;
}

.copy-text {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  color: var(--yb-term-ink);
  background: none;
  font-family: var(--yb-font-mono);
  font-size: 13px;
  padding: 0;
}

.prompt {
  color: var(--yb-sky);
}

.copy-button {
  flex: none;
  padding: 4px 12px;
  border-radius: 4px;
  background: rgb(255 255 255 / 0.1);
  color: var(--yb-term-ink);
  font-size: 12px;
}

.copy-button:hover {
  background: rgb(255 255 255 / 0.18);
}

.copy-button:focus-visible {
  outline: 2px solid var(--yb-sky);
  outline-offset: 1px;
}
</style>
