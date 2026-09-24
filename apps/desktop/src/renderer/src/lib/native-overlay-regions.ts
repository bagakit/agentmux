import type { NativeBrowserInput, NativeOverlayRegion } from '../../../shared/native-overlay'
import { NATIVE_OVERLAY_LIMIT, NATIVE_OVERLAY_PIXEL_LIMIT } from '../../../shared/native-overlay'
import { rendererCssBoundsToWindowDip } from './browser-bounds-sync'

const OPEN_FLOAT = '[data-state="open"], [role="tooltip"], [role="dialog"], [role="menu"], [role="listbox"]'

/** Portal scopes exclude the entire terminal/editor tree. IDs belong to actual mounted float elements. */
export function observeNativeOverlayRegions(
  body: HTMLElement,
  zoomFactor: () => number,
  publish: (regions: NativeOverlayRegion[], warning?: string) => void
): { dispose(): void; handleNativeInput(input: NativeBrowserInput): void } {
  const ids = new WeakMap<Element, string>()
  let nextId = 0
  let disposed = false
  let frame = 0
  let watched: Element[] = []
  let geometry: Element[] = []
  let hoveredStage: Element | undefined
  let hoveredFloat: Element | undefined
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
    const stages: Element[] = []
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
      const browserStages = Array.from(node.querySelectorAll('[data-native-browser-stage]')).flatMap(stage => {
        const browserId = stage.getAttribute('data-native-browser-stage'), box = stage.getBoundingClientRect()
        if (!browserId || box.width <= 0 || box.height <= 0) return []
        stages.push(stage)
        return [{ browserId, bounds: rendererCssBoundsToWindowDip(box, zoomFactor()) }]
      })
      regions.push({ id, bounds, radius: (Number.parseFloat(style.borderTopLeftRadius) || 0) * zoomFactor(),
        ...(emptyScrim ? { scrim: style.backgroundColor } : {}), ...(browserStages.length ? { browserStages } : {}) })
    }
    const observed = [...activeFloats, ...stages]
    if (geometry.length !== observed.length || geometry.some((node, index) => node !== observed[index])) {
      resize.disconnect()
      for (const node of observed) resize.observe(node)
      geometry = observed
    }
    watched = activeFloats
    if (hoveredFloat && !watched.includes(hoveredFloat)) { hoveredFloat = undefined; hoveredStage = undefined }
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
      attributeFilter: ['data-state', 'style', 'class', 'aria-expanded', 'aria-disabled', 'data-native-browser-stage']
    })
    // HTML popovers live in the native DOM top layer, often inside #root. Observe only the opened
    // target named by the toggle event, never terminal/editor content or a whole-document scan.
    for (const node of topLayers) if (node.isConnected) observer.observe(node, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['data-state', 'style', 'class', 'aria-expanded', 'aria-disabled', 'data-native-browser-stage']
    })
  }
  // The same mounted float can close and reopen between capture frames. Its original
  // DOM leave/close is authoritative even while its sibling native page still has input.
  const clearHover = (): void => { hoveredFloat = undefined; hoveredStage = undefined }
  const onPointerLeave = (event: Event): void => {
    if (event.target === hoveredFloat || event.target === hoveredStage) clearHover()
  }
  const onBeforeToggle = (event: Event): void => {
    if ((event as ToggleEvent).newState === 'closed' && event.target === hoveredFloat) clearHover()
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
      if (target === hoveredFloat) clearHover()
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
  body.addEventListener('beforetoggle', onBeforeToggle, true)
  body.addEventListener('pointerleave', onPointerLeave, true)
  body.ownerDocument.fonts?.addEventListener('loadingdone', schedule)
  return { handleNativeInput(input) {
    if (disposed) return
    const float = input.overlayId ? watched.find(node => ids.get(node) === input.overlayId && node.isConnected && (!node.hasAttribute('popover') || topLayers.has(node)) && node.getAttribute('data-state') !== 'closed' &&
      win.getComputedStyle(node).display !== 'none' && win.getComputedStyle(node).visibility !== 'hidden') : undefined
    const ownedStage = float ? Array.from(float.querySelectorAll('[data-native-browser-stage]')).find(stage =>
      stage.getAttribute('data-native-browser-stage') === input.browserId) : undefined
    if (input.overlayId && !ownedStage) return
    if (input.type === 'escape') {
      if (!float || !ownedStage) return
      const event = new win.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
      ownedStage.dispatchEvent(event)
      if (!event.defaultPrevented && float instanceof win.HTMLElement && (float.popover === 'auto' || float.popover === 'hint') && float.matches(':popover-open')) float.hidePopover()
      return
    }
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) return
    const hit = body.ownerDocument.elementFromPoint(input.x, input.y)
    const target = hit?.closest('[data-native-browser-stage]')
    const stage = ownedStage ?? target
    if (!stage || stage.getAttribute('data-native-browser-stage') !== input.browserId) return
    const pointer = (type: string, relatedTarget: EventTarget | null = null): PointerEvent => new win.PointerEvent(type, {
      bubbles: true, composed: true, clientX: input.x, clientY: input.y, relatedTarget,
      button: input.button, pointerType: 'mouse', isPrimary: true
    })
    const floatPointer = (node: Element, type: 'pointerenter' | 'pointerleave', relatedTarget: EventTarget | null): void => {
      node.dispatchEvent(new win.PointerEvent(type, { bubbles: false, clientX: input.x, clientY: input.y,
        relatedTarget, pointerType: 'mouse', isPrimary: true }))
    }
    if (input.type === 'pointerLeave') {
      if (hit && stage.contains(hit)) return
      stage.dispatchEvent(pointer('pointerout', hit))
      if (float && (!hit || !float.contains(hit))) { floatPointer(float, 'pointerleave', hit); if (hoveredFloat === float) hoveredFloat = undefined }
      if (hoveredStage === stage) hoveredStage = undefined
      return
    }
    // A moved/closed original stage cannot route input into a different Chrome control.
    if (target !== stage) return
    // Raw DOM panel owners listen to non-bubbling enter/leave. pointerover/out alone does
    // not make the UA synthesize those events for a notice from a sibling native page.
    if (hoveredFloat !== float) {
      if (hoveredFloat) floatPointer(hoveredFloat, 'pointerleave', stage)
      if (float) floatPointer(float, 'pointerenter', hoveredStage ?? null)
      hoveredFloat = float
    }
    if (hoveredStage !== stage) {
      const previous = hoveredStage
      previous?.dispatchEvent(pointer('pointerout', stage))
      stage.dispatchEvent(pointer('pointerover', previous ?? null))
      hoveredStage = stage
    }
    stage.dispatchEvent(pointer(input.type === 'pointerDown' ? 'pointerdown' : 'pointermove'))
    if (input.type !== 'pointerDown') return
    for (const node of topLayers) {
      if (!(node instanceof win.HTMLElement) || (node.popover !== 'auto' && node.popover !== 'hint') || !node.matches(':popover-open')) continue
      const rect = node.getBoundingClientRect()
      if (input.x < rect.left || input.x >= rect.right || input.y < rect.top || input.y >= rect.bottom) node.hidePopover()
    }
  }, dispose() {
    disposed = true
    hoveredStage = undefined
    hoveredFloat = undefined
    win.cancelAnimationFrame(frame)
    observer.disconnect()
    resize.disconnect()
    win.removeEventListener('resize', schedule)
    win.removeEventListener('scroll', onScroll, true)
    body.removeEventListener('toggle', onToggle, true)
    body.removeEventListener('beforetoggle', onBeforeToggle, true)
    body.removeEventListener('pointerleave', onPointerLeave, true)
    body.ownerDocument.fonts?.removeEventListener('loadingdone', schedule)
    publish([])
  } }
}
