import type { ReaderBook, BookTocItem } from './types'
import { BookResources } from './resources'

export interface ParsedBook {
  metadata?: Record<string, unknown>
  toc?: { label?: string; href: string; subitems?: ParsedBook['toc'] }[]
  sections: { id?: string | number; size?: number; load(): string | Promise<string>; unload?(): void; resolveHref?(href: string): string }[]
  rendition?: { layout?: string }
  dir?: string
  resolveHref?(href: string): { index?: number; anchor?: unknown; fragment?: string; selector?: string } | null | undefined | Promise<{ index?: number; anchor?: unknown; fragment?: string; selector?: string } | null | undefined>
  destroy?(): void
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ') || undefined
  if (value && typeof value === 'object') return text((value as { name?: unknown }).name) ?? text(Object.values(value)[0])
  return undefined
}

export function readerBook(parsed: ParsedBook, name: string, resources: BookResources, controller: AbortController, close?: () => void): ReaderBook {
  let destroyed = false
  const toc = (items: ParsedBook['toc']): BookTocItem[] => (items ?? []).map(item => ({ label: item.label || item.href, href: item.href,
    ...(item.subitems?.length ? { children: toc(item.subitems) } : {}) }))
  const sections = parsed.sections.map((section, index) => {
    let loaded: Promise<string> | null = null, generation = 0
    let previous: Promise<unknown> = Promise.resolve()
    return {
      id: String(section.id ?? index), size: section.size ?? 0,
      load(): Promise<string> {
        if (destroyed) return Promise.reject(new DOMException('The book was closed', 'AbortError'))
        if (loaded) return loaded
        const current = generation
        loaded = previous.then(() => section.load()).then(url => {
          if (!resources.has(url)) throw Object.assign(new Error('This book section could not be loaded'), { code: 'BOOK_SECTION_UNAVAILABLE' })
          if (destroyed || current !== generation) {
            section.unload?.()
            throw new DOMException('The section was released', 'AbortError')
          }
          return url
        }).catch(error => { section.unload?.(); if (current === generation) loaded = null; throw error })
        previous = loaded.catch(() => {}) // Release an older operation before reopening this same section.
        return loaded
      },
      unload(): void {
        generation++
        loaded = null
        section.unload?.()
      }
    }
  })
  const author = text(parsed.metadata?.author), language = text(parsed.metadata?.language)
  return {
    metadata: { title: text(parsed.metadata?.title) ?? name, ...(author ? { author } : {}), ...(language ? { language } : {}) },
    toc: toc(parsed.toc), sections, layout: parsed.rendition?.layout === 'pre-paginated' ? 'pre-paginated' : 'reflowable',
    direction: parsed.dir === 'rtl' ? 'rtl' : 'ltr',
    async resolveHref(href, fromSection) {
      if (destroyed) return null
      const target = fromSection === undefined ? href : parsed.sections[fromSection]?.resolveHref?.(href) ?? href
      const location = await parsed.resolveHref?.(target)
      if (!location || !Number.isInteger(location.index) || location.index! < 0 || location.index! >= sections.length) return null
      const fragment = location.fragment ?? (target.includes('#') ? target.slice(target.indexOf('#') + 1) : undefined)
      return { index: location.index!, ...(fragment ? { fragment } : {}), ...(location.selector ? { selector: location.selector } : {}) }
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      controller.abort(new DOMException('The book was closed', 'AbortError'))
      for (const section of sections) section.unload()
      parsed.destroy?.()
      resources.destroy()
      close?.()
    }
  }
}
