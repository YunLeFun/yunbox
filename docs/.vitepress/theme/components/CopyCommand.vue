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
import SymbolIcon from './SymbolIcon.vue'

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
      <SymbolIcon :name="copied ? 'checkmark.circle.fill' : 'doc.on.doc'" />
      {{ copied ? '已复制' : '复制' }}
    </button>
  </div>
</template>

<style scoped>
.copy {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 5px 5px 5px 14px;
  border-radius: 10px;
  background: var(--yb-code-bg);
  box-shadow: inset 0 0 0 0.5px var(--yb-separator);
}

.copy-text {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  padding: 0;
  background: none;
  color: var(--yb-label);
  font-family: var(--yb-font-mono);
  font-size: 13px;
  white-space: nowrap;
}

.prompt {
  color: var(--yb-label-3);
}

.copy-button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  padding: 4px 10px;
  border-radius: 7px;
  background: var(--yb-window);
  box-shadow: 0 0 0 0.5px var(--yb-separator), 0 1px 1.5px rgb(0 0 0 / 0.08);
  color: var(--yb-label);
  font-size: 12px;
}

.copy-button:hover {
  color: var(--yb-accent);
}

.copy-button:focus-visible {
  outline: 2px solid var(--yb-accent);
  outline-offset: 1px;
}
</style>
