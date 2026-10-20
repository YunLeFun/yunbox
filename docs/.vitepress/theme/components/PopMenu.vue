<script setup lang="ts">
/**
 * A small pull-down menu in the style of an NSMenu: a borderless trigger and
 * a list of plain or checkable items. Arrow keys, Home/End and Escape work
 * as they do in menus; clicking outside closes it.
 *
 * @example
 * ```vue
 * <PopMenu label="全局预设" :items="items" @select="apply">
 *   <SymbolIcon name="plus.circle" />
 * </PopMenu>
 * ```
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

defineProps<{
  /** Accessible name of the trigger button */
  label: string
  items: PopMenuItem[]
  /** Optional heading inside the menu */
  heading?: string
}>()

const emit = defineEmits<{
  select: [key: string]
}>()

const open = ref(false)
const root = ref<HTMLElement>()
const trigger = ref<HTMLButtonElement>()
const list = ref<HTMLElement>()

function enabledItems(): HTMLButtonElement[] {
  return [...(list.value?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])]
}

async function show(focus: 'first' | 'last' = 'first') {
  open.value = true
  await nextTick()
  const items = enabledItems()
  items[focus === 'first' ? 0 : items.length - 1]?.focus()
}

function close(refocus = true) {
  open.value = false
  if (refocus)
    trigger.value?.focus()
}

function choose(item: PopMenuItem) {
  if (item.disabled)
    return
  emit('select', item.key)
  close()
}

function onTriggerKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    show(event.key === 'ArrowDown' ? 'first' : 'last')
  }
}

function onMenuKey(event: KeyboardEvent) {
  const items = enabledItems()
  const index = items.indexOf(document.activeElement as HTMLButtonElement)
  const move = (to: number) => {
    event.preventDefault()
    items[(to + items.length) % items.length]?.focus()
  }
  if (event.key === 'ArrowDown') {
    move(index + 1)
  }
  else if (event.key === 'ArrowUp') {
    move(index - 1)
  }
  else if (event.key === 'Home') {
    move(0)
  }
  else if (event.key === 'End') {
    move(items.length - 1)
  }
  else if (event.key === 'Escape') {
    event.preventDefault()
    close()
  }
  else if (event.key === 'Tab') {
    close(false)
  }
}

function onPointerDown(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node))
    close(false)
}

watch(open, (value) => {
  if (value)
    document.addEventListener('pointerdown', onPointerDown)
  else
    document.removeEventListener('pointerdown', onPointerDown)
})

onBeforeUnmount(() => document.removeEventListener('pointerdown', onPointerDown))
</script>

<script lang="ts">
/** One row of the menu. */
export interface PopMenuItem {
  /** Value emitted with `select` */
  key: string
  label: string
  /** Secondary text after the label, e.g. the rule a preset writes */
  detail?: string
  /** `true` / `false` makes the row a checkbox item; leave out for a plain item */
  checked?: boolean
  disabled?: boolean
  /** Draw a separator above this row */
  separated?: boolean
}
</script>

<template>
  <span ref="root" class="pop">
    <button
      ref="trigger" type="button" class="pop-trigger" :aria-label="label" aria-haspopup="menu" :aria-expanded="open"
      @click="open ? close() : show()" @keydown="onTriggerKey"
    >
      <slot />
    </button>
    <div v-if="open" ref="list" class="pop-menu" role="menu" :aria-label="heading ?? label" @keydown="onMenuKey">
      <p v-if="heading" class="pop-heading" role="presentation">
        {{ heading }}
      </p>
      <template v-for="item in items" :key="item.key">
        <hr v-if="item.separated" role="separator">
        <button
          type="button" class="pop-item" tabindex="-1"
          :role="item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'"
          :aria-checked="item.checked === undefined ? undefined : item.checked"
          :aria-disabled="item.disabled || undefined"
          @click="choose(item)"
        >
          <span class="pop-check" aria-hidden="true">{{ item.checked ? '✓' : '' }}</span>
          <span>{{ item.label }}</span>
          <span v-if="item.detail" class="pop-detail">{{ item.detail }}</span>
        </button>
      </template>
    </div>
  </span>
</template>

<style scoped>
.pop {
  position: relative;
  display: inline-flex;
}

.pop-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px;
  border-radius: 5px;
  color: inherit;
}

.pop-trigger:hover,
.pop-trigger[aria-expanded='true'] {
  background: var(--yb-fill-strong);
}

.pop-trigger:focus-visible,
.pop-item:focus-visible {
  outline: 2px solid var(--yb-accent);
  outline-offset: 1px;
}

.pop-menu {
  position: absolute;
  z-index: 5;
  top: calc(100% + 4px);
  right: -4px;
  min-width: 230px;
  padding: 5px;
  border-radius: 9px;
  background: var(--fp-menu, var(--yb-window));
  box-shadow: var(--yb-shadow-window);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  color: var(--yb-label);
  font-size: 13px;
  text-align: left;
  animation: pop 120ms ease-out;
}

.pop-heading {
  margin: 2px 8px 4px;
  color: var(--yb-label-2);
  font-size: 11px;
  font-weight: 600;
}

.pop-menu hr {
  margin: 5px 8px;
  border: 0;
  border-top: 0.5px solid var(--yb-separator);
}

.pop-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 3px 10px 3px 4px;
  border-radius: 5px;
  color: inherit;
  text-align: left;
  white-space: nowrap;
}

.pop-item:hover:not([aria-disabled='true']),
.pop-item:focus-visible {
  background: var(--yb-accent);
  color: #fff;
}

.pop-item[aria-disabled='true'] {
  color: var(--yb-label-3);
  cursor: default;
}

.pop-check {
  flex: none;
  width: 14px;
  text-align: center;
}

.pop-detail {
  margin-left: auto;
  padding-left: 14px;
  color: var(--yb-label-2);
  font-family: var(--yb-font-mono);
  font-size: 11px;
}

.pop-item:hover:not([aria-disabled='true']) .pop-detail,
.pop-item:focus-visible .pop-detail {
  color: rgb(255 255 255 / 0.8);
}

@keyframes pop {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .pop-menu {
    animation: none;
  }
}
</style>
