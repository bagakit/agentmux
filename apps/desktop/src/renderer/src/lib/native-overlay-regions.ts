import type { NativeBrowserPointer, NativeOverlayRegion } from '../../../shared/native-overlay'
import { NATIVE_OVERLAY_LIMIT, NATIVE_OVERLAY_PIXEL_LIMIT } from '../../../shared/native-overlay'
import { rendererCssBoundsToWindowDip } from './browser-bounds-sync'

const OPEN_FLOAT = '[data-state="open"], [role="tooltip"], [role="dialog"], [role="menu"], [role="listbox"]'

/** Portal scopes exclude the entire terminal/editor tree. IDs belong to actual mounted float elements. */
export function observeNativeOverlayRegions(
  body: HTMLElement,
  zoomFactor: () => number,
  publish: (regions: NativeOverlayRegion[], warning?: string) => void
): { dispose(): void; dismissAtPoint(point: NativeBrowserPointer): void } {
  const ids = new WeakMap<Element, string>()
  let nextId = 0
  let disposed = false
  let frame = 0
  let watched: Element[] = []
  const topLayers = new Set<Element>()
  const topLayerSources = new WeakMap<Element, Element>()
  const win = body.ownerDocument.defaultView!
  const resize = new ResizeObserver(() => schedule())
  const portals = (): Element[] => Array.from(body.children).filter(node => node.id !== 'root')
  const collect = (): void => {
    frame = 0
    if (disposed) return
    const nodes: Element[] = []
    for (const portal of portals()) {
      if (portal.matches(OPEN_FLOAT)) nodes.push(portal)
      nodes.push(...portal.querySelectorAll(OPEN_FLOAT))
    }
    for (const node of topLayers) if (node.isConnected) nodes.push(node)
    // A menu's checked item also has data-state=open. Capture its mounted Content once.
    const unique = [...new Set(nodes)]
    const candidates = unique.filter(node => {
      const rect = node.getBoundingClientRect()
      const style = win.getComputedStyle(node)
      // A transparent full-window wrapper is not a float's painted surface. Its children are.
      return !(rect.width >= win.innerWidth && rect.height >= win.innerHeight &&
        style.backgroundColor === 'rgba(0, 0, 0, 0)' && unique.some(child => child !== node && node.contains(child)))
    })
    const floats = candidates.filter(node => !candidates.some(parent => parent !== node && parent.contains(node)))
    const regions: NativeOverlayRegion[] = []
    const activeFloats: Element[] = []
    let pixels = 0
    let warning: string | undefined
    for (const node of floats) {
      const style = win.getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden' || node.getAttribute('data-state') === 'closed') continue
      const rect = node.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      activeFloats.push(node)
      const bounds = rendererCssBoundsToWindowDip(rect, zoomFactor())
      const emptyScrim = node.children.length === 0 && (node.textContent ?? '').trim() === '' && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
      // Chrome capture is composited against the Renderer. Only an opaque content box with
      // uniform native-clippable corners may be projected; never invent alpha by colour removal.
      const alpha = style.backgroundColor.startsWith('rgba(') ? Number.parseFloat(style.backgroundColor.split(',').at(-1)!) : 1
      const solid = /^rgba?\(/.test(style.backgroundColor) && alpha === 1 && Number(style.opacity || '1') === 1 &&
        (!style.clipPath || style.clipPath === 'none') && (!style.maskImage || style.maskImage === 'none') &&
        [style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].every(radius => radius === style.borderTopLeftRadius)
      if (!emptyScrim && !solid) {
        warning = 'Floating content has transparency or an unsupported clip. The Browser remains available; close the floating panel. Its transparency has not been replaced with an opaque window background.'
        continue
      }
      if (!emptyScrim && rect.width >= win.innerWidth && rect.height >= win.innerHeight) {
        warning = 'Full-window floating content cannot be projected as a bitmap. The Browser remains available; close the floating panel.'
        continue
      }
      const cost = emptyScrim ? 0 : Math.ceil(bounds.width) * Math.ceil(bounds.height)
      if (regions.length >= NATIVE_OVERLAY_LIMIT || pixels + cost > NATIVE_OVERLAY_PIXEL_LIMIT) {
        warning = 'Floating content exceeds the native chrome budget. The Browser remains available; close an unused floating panel.'
        continue
      }
      pixels += cost
      let id = ids.get(node)
      if (!id) { id = `chrome-${++nextId}`; ids.set(node, id) }
      regions.push({ id, bounds, radius: (Number.parseFloat(style.borderTopLeftRadius) || 0) * zoomFactor(), ...(emptyScrim ? { scrim: style.backgroundColor } : {}) })
    }
    if (watched.length !== activeFloats.length || watched.some((node, index) => node !== activeFloats[index])) {
      resize.disconnect()
      for (const node of activeFloats) resize.observe(node)
      watched = activeFloats
    }
    publish(regions, warning)
  }
  const schedule = (): void => {
    if (!disposed && !frame) frame = win.requestAnimationFrame(collect)
  }
  const observer = new MutationObserver(records => {
    if (records.some(record => record.target === body && record.type === 'childList')) bind()
    schedule()
  })
  const bind = (): void => {
    observer.disconnect()
    observer.observe(body, { childList: true })
    for (const portal of portals()) observer.observe(portal, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['data-state', 'style', 'class', 'aria-expanded', 'aria-disabled']
    })
    // HTML popovers live in the native DOM top layer, often inside #root. Observe only the opened
    // target named by the toggle event, never terminal/editor content or a whole-document scan.
    for (const node of topLayers) if (node.isConnected) observer.observe(node, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['data-state', 'style', 'class', 'aria-expanded', 'aria-disabled']
    })
  }
  const onToggle = (event: Event): void => {
    const target = event.target
    if (!(target instanceof Element) || !target.hasAttribute('popover')) return
    if ((event as ToggleEvent).newState === 'open') {
      topLayers.add(target)
      // ToggleEvent.source is the actual HTML popover invoker/implicit anchor; never scan #root.
      const source = (event as ToggleEvent & { source?: Element | null }).source
      if (source instanceof Element) topLayerSources.set(target, source)
      else topLayerSources.delete(target)
    } else {
      topLayers.delete(target)
      topLayerSources.delete(target)
    }
    bind()
    schedule()
  }
  const onScroll = (event: Event): void => {
    if (watched.length === 0) return
    const target = event.target
    if (target === event.currentTarget || target === body.ownerDocument) { schedule(); return }
    if (!(target instanceof Element)) return
    if (watched.some(node => node.contains(target) || target.contains(node) || target.contains(topLayerSources.get(node) ?? null))) schedule()
  }
  bind()
  collect()
  win.addEventListener('resize', schedule)
  win.addEventListener('scroll', onScroll, true)
  body.addEventListener('toggle', onToggle, true)
  body.ownerDocument.fonts?.addEventListener('loadingdone', schedule)
  return { dismissAtPoint(point) {
    if (disposed || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return
    const target = body.ownerDocument.elementFromPoint(point.x, point.y)
    // A moved/closed page cannot turn a stale point into a click on another piece of Chrome.
    if (!target?.closest('[data-native-browser-stage]')) return
    target.dispatchEvent(new win.PointerEvent('pointerdown', {
      bubbles: true, composed: true, clientX: point.x, clientY: point.y,
      button: point.button, pointerType: 'mouse', isPrimary: true
    }))
    for (const node of topLayers) {
      if (!(node instanceof win.HTMLElement) || (node.popover !== 'auto' && node.popover !== 'hint') || !node.matches(':popover-open')) continue
      const rect = node.getBoundingClientRect()
      if (point.x < rect.left || point.x >= rect.right || point.y < rect.top || point.y >= rect.bottom) node.hidePopover()
    }
  }, dispose() {
    disposed = true
    win.cancelAnimationFrame(frame)
    observer.disconnect()
    resize.disconnect()
    win.removeEventListener('resize', schedule)
    win.removeEventListener('scroll', onScroll, true)
    body.removeEventListener('toggle', onToggle, true)
    body.ownerDocument.fonts?.removeEventListener('loadingdone', schedule)
    publish([])
  } }
}
