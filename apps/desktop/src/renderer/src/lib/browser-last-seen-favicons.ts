import { BROWSER_LAST_SEEN_FAVICON_BATCH } from '../../../shared/browser-page-memory'
import { api } from './api'
import { useAppStore } from '../store'
import { rememberBrowserFavicons } from './browser-state'
import { workbenchSurfaces, type WorkbenchTab } from './workbench-tabs'

/** Ask Main once per parked page and address for its last-seen icon; a live document's icon always wins. */
export function observeLastSeenBrowserFavicons(): () => void {
  const asked = new Set<string>()
  let disposed = false, scheduled = false
  const request = () => {
    scheduled = false
    if (disposed) return
    const wanted = parkedWithoutIcon(useAppStore.getState().tabs).filter(([id, url]) => !asked.has(`${id}\n${url}`))
    if (!wanted.length) return
    for (const [id, url] of wanted) asked.add(`${id}\n${url}`)
    const ids = [...new Set(wanted.map(([id]) => id))]
    for (let start = 0; start < ids.length; start += BROWSER_LAST_SEEN_FAVICON_BATCH) {
      void api.browser.getLastSeenFavicons(ids.slice(start, start + BROWSER_LAST_SEEN_FAVICON_BATCH)).then(found => {
        if (disposed) return
        useAppStore.setState(state => {
          const tabs = rememberBrowserFavicons(state.tabs, found)
          return tabs === state.tabs ? state : { tabs }
        })
      }, error => console.warn('Last-seen Browser icons could not be read. Pages keep the generic icon.', error))
    }
  }
  const schedule = () => {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(request)
  }
  schedule()
  const unsubscribe = useAppStore.subscribe((state, previous) => { if (state.tabs !== previous.tabs) schedule() })
  return () => { disposed = true; unsubscribe() }
}

function parkedWithoutIcon(tabs: Readonly<Record<string, WorkbenchTab>>): [string, string][] {
  const parked: [string, string][] = []
  for (const tab of Object.values(tabs)) {
    for (const surface of workbenchSurfaces(tab)) {
      if (surface.kind === 'browser' && !surface.faviconDataUrl && (surface.nativeOwnerDeferred || surface.nativeOwnerReleased) &&
        surface.url && surface.url !== 'about:blank') parked.push([surface.browserId, surface.url])
    }
  }
  return parked
}
