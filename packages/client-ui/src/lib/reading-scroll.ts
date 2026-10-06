type ReadingScrollKind = 'restore' | 'navigation'
const scrolls = new WeakMap<HTMLElement, { top: number; kind: ReadingScrollKind }>()

/** Record a completed UI scroll on its exact viewport, without taking control of scrolling. */
export function markProgrammaticReadingScroll(viewport: HTMLElement, kind: ReadingScrollKind = 'restore'): void {
  scrolls.set(viewport, { top: viewport.scrollTop, kind })
}

export function consumeProgrammaticReadingScroll(viewport: HTMLElement): ReadingScrollKind | null {
  const scroll = scrolls.get(viewport)
  scrolls.delete(viewport)
  return scroll?.top === viewport.scrollTop ? scroll.kind : null
}
