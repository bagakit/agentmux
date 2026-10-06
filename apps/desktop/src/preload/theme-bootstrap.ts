import type { ThemeBootstrap } from '../shared/theme-bootstrap'

/** A single document-start projection; the original Root runtime owns all later changes. */
export function projectInitialTheme(snapshot: ThemeBootstrap | null, host: Window = window): () => void {
  if (!snapshot || snapshot.status !== 'available') return () => {}
  let observer: MutationObserver | undefined
  const dispose = () => { observer?.disconnect(); observer = undefined; host.removeEventListener('pagehide', dispose) }
  const apply = () => {
    const root = host.document.documentElement
    if (!root) return false
    for (const [property, value] of Object.entries(snapshot.variables)) root.style.setProperty(property, value)
    root.style.backgroundColor = 'var(--bg)'
    root.style.color = 'var(--text)'
    root.style.colorScheme = snapshot.mode
    root.dataset.theme = snapshot.document.id
    root.dataset.appearance = snapshot.mode
    dispose()
    return true
  }
  if (!apply()) {
    observer = new (host as Window & typeof globalThis).MutationObserver(apply)
    observer.observe(host.document, { childList: true, subtree: true })
    host.addEventListener('pagehide', dispose, { once: true })
  }
  return dispose
}
