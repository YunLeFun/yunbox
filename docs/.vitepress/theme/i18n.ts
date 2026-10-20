import type { ComputedRef } from 'vue'
import { useData, withBase } from 'vitepress'
import { computed } from 'vue'

/** The site's languages: Simplified Chinese at the root, English under `/en/`. */
export type SiteLang = 'zh' | 'en'

/**
 * The language of the page being shown.
 *
 * @returns `en` on English pages, otherwise `zh`
 */
export function useSiteLang(): ComputedRef<SiteLang> {
  const { lang } = useData()
  return computed(() => lang.value.startsWith('en') ? 'en' : 'zh')
}

/**
 * Pick a component's copy for the page's language.
 *
 * @param copy - The same strings in both languages
 * @returns The strings for the current page
 *
 * @example
 * ```ts
 * const t = useCopy({ zh: { copy: '复制' }, en: { copy: 'Copy' } })
 * ```
 */
export function useCopy<T>(copy: Record<SiteLang, T>): ComputedRef<T> {
  const lang = useSiteLang()
  return computed(() => copy[lang.value])
}

/**
 * Link to a page of the site in the current page's language.
 *
 * @returns A function from a root-relative path (`/guide/`) to a full link (`/en/guide/` on English pages)
 */
export function useLocalePath(): ComputedRef<(path: string) => string> {
  const lang = useSiteLang()
  return computed(() => (path: string) => withBase(lang.value === 'en' ? `/en${path}` : path))
}
