<script setup lang="ts">
/**
 * Line icons standing in for the SF Symbols the macOS client uses, drawn on
 * a 24-unit grid with round caps so they sit next to system text.
 *
 * @example
 * ```vue
 * <SymbolIcon name="shippingbox" />
 * ```
 */
defineProps<{
  /** SF Symbol name the icon imitates */
  name: SymbolName
  /** Rendered size in pixels; defaults to 1em */
  size?: number
}>()
</script>

<script lang="ts">
/** The symbols this site draws. */
export type SymbolName
  = | 'doc' | 'shippingbox' | 'folder' | 'folder.badge.plus' | 'doc.on.doc' | 'arrow.clockwise'
    | 'gearshape' | 'checkmark.circle.fill' | 'exclamationmark.circle.fill' | 'xmark.circle.fill'
    | 'info.circle' | 'sidebar.left' | 'icloud' | 'laptopcomputer' | 'arrow.triangle.branch'
    | 'key' | 'lock' | 'terminal' | 'arrow.down.circle' | 'magnifyingglass' | 'checkmark.shield'
    | 'square.on.square.dashed' | 'arrow.up.doc'
</script>

<template>
  <svg
    class="symbol" :width="size ?? '1em'" :height="size ?? '1em'" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
  >
    <template v-if="name === 'doc'">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </template>
    <template v-else-if="name === 'arrow.up.doc'">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5M12 17v-6m-2.5 2.5L12 11l2.5 2.5" />
    </template>
    <template v-else-if="name === 'shippingbox'">
      <path d="M11 21.7a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7Z" />
      <path d="M12 22V12M3.3 7 12 12l8.7-5M7.5 4.3l9 5.2" />
    </template>
    <template v-else-if="name === 'folder'">
      <path d="M20 19a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />
    </template>
    <template v-else-if="name === 'folder.badge.plus'">
      <path d="M20 19a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z" />
      <path d="M12 10v6M9 13h6" />
    </template>
    <template v-else-if="name === 'doc.on.doc'">
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2" />
    </template>
    <template v-else-if="name === 'arrow.clockwise'">
      <path d="M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8" />
      <path d="M21 3v5h-5" />
    </template>
    <template v-else-if="name === 'gearshape'">
      <circle cx="12" cy="12" r="7.2" stroke-width="3.2" stroke-dasharray="2.6 2.05" stroke-linecap="butt" />
      <circle cx="12" cy="12" r="5.6" />
      <circle cx="12" cy="12" r="2.4" />
    </template>
    <template v-else-if="name === 'checkmark.circle.fill'">
      <circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" />
      <path d="m7.5 12.3 3 3 6-6.3" stroke="#fff" stroke-width="2.2" />
    </template>
    <template v-else-if="name === 'exclamationmark.circle.fill'">
      <circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" />
      <path d="M12 7v6.2" stroke="#fff" stroke-width="2.4" />
      <circle cx="12" cy="17" r="1.3" fill="#fff" stroke="none" />
    </template>
    <template v-else-if="name === 'xmark.circle.fill'">
      <circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" />
      <path d="m8.5 8.5 7 7m0-7-7 7" stroke="#fff" stroke-width="2.2" />
    </template>
    <template v-else-if="name === 'info.circle'">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 16.5V11" />
      <circle cx="12" cy="7.6" r="0.6" fill="currentColor" />
    </template>
    <template v-else-if="name === 'sidebar.left'">
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9.5 4v16M5.5 8h1.5M5.5 11h1.5" />
    </template>
    <template v-else-if="name === 'icloud'">
      <path d="M17.5 19H8a6 6 0 1 1 5.7-7.9h.3a4 4 0 0 1 3.6 2.3A3 3 0 0 1 17.5 19Z" transform="translate(0 -1)" />
    </template>
    <template v-else-if="name === 'laptopcomputer'">
      <rect x="4" y="4.5" width="16" height="11" rx="1.6" />
      <path d="M2 19h20" />
    </template>
    <template v-else-if="name === 'arrow.triangle.branch'">
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 8.5v7M18 10.5c0 4-4 4.5-9.8 6.3" />
    </template>
    <template v-else-if="name === 'key'">
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.7 12.3 9.3-9.3M16 7l3 3M13.5 9.5l2 2" />
    </template>
    <template v-else-if="name === 'lock'">
      <rect x="4.5" y="10.5" width="15" height="10.5" rx="2.2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </template>
    <template v-else-if="name === 'terminal'">
      <rect x="2.5" y="4" width="19" height="16" rx="3" />
      <path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5" />
    </template>
    <template v-else-if="name === 'arrow.down.circle'">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 7.5v8.5m-3.5-3.5L12 16l3.5-3.5" />
    </template>
    <template v-else-if="name === 'magnifyingglass'">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m20 20-4.8-4.8" />
    </template>
    <template v-else-if="name === 'checkmark.shield'">
      <path d="M12 21.5s7.5-3.2 7.5-9.5V5.5L12 2.5 4.5 5.5V12c0 6.3 7.5 9.5 7.5 9.5Z" />
      <path d="m8.8 12 2.3 2.3 4.2-4.6" />
    </template>
    <template v-else-if="name === 'square.on.square.dashed'">
      <rect x="3" y="3" width="13" height="13" rx="2.5" stroke-dasharray="2.5 2.5" />
      <rect x="8" y="8" width="13" height="13" rx="2.5" />
    </template>
  </svg>
</template>

<style scoped>
.symbol {
  display: inline-block;
  flex: none;
  vertical-align: -0.15em;
}
</style>
