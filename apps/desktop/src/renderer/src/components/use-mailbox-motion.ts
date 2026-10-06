import { useEffect, useLayoutEffect, useReducer, useRef, useState, type RefObject } from 'react'

type Motion = { animation: Animation; from: DOMRect; to: DOMRect }

/** Presentation only: the native popover and existing queue remain the interaction/fact owners. */
export function useMailboxMotion(panel: RefObject<HTMLDivElement | null>, dock: RefObject<HTMLElement | null>, open: boolean, visible: boolean, scope: string) {
  const [retaining, setRetaining] = useState(false)
  // Native close/open can coalesce to "open" while React's open boolean stays true.
  // Each real native open still commits the current reading DOM and presentation effect.
  const [revision, nativeOpened] = useReducer(value => value + 1, 0)
  const motion = useRef<Motion | null>(null)
  const origin = useRef<{ node: Element; rect: DOMRect; composer: DOMRect } | null>(null)
  const reduced = useRef(false)
  const opening = useRef<{ rect: DOMRect; opacity: number } | null>(null)
  function currentRect() {
    const active = motion.current
    if (!active) return panel.current!.getBoundingClientRect()
    const progress = active.animation.effect!.getComputedTiming().progress ?? 1
    const lerp = (a: number, b: number) => a + (b - a) * progress
    return new DOMRect(lerp(active.from.x, active.to.x), lerp(active.from.y, active.to.y),
      lerp(active.from.width, active.to.width), lerp(active.from.height, active.to.height))
  }
  function cancel() {
    const active = motion.current
    motion.current = null; active?.animation.cancel(); setRetaining(false)
  }
  function animate(from: DOMRect, to: DOMRect, exit: boolean, opacity = Number(getComputedStyle(panel.current!).opacity)) {
    cancel()
    const node = panel.current!
    const box = node.getBoundingClientRect()
    const style = getComputedStyle(node)
    const value = style.getPropertyValue('--dur-enter').trim()
    const duration = parseFloat(value) * (value.endsWith('ms') ? 1 : 1000)
    const frame = (rect: DOMRect) => ({
      transform: `translate(${rect.right - box.right}px, ${rect.top - box.top}px)`,
      clipPath: `inset(0px 0px ${Math.max(0, box.height - rect.height)}px ${Math.max(0, box.width - rect.width)}px round ${style.borderRadius})`
    })
    const animation = node.animate([{ ...frame(from), opacity }, { ...frame(to), opacity: exit ? 0 : 1 }], { duration, easing: style.getPropertyValue('--ease-enter').trim() })
    const active = { animation, from, to }; motion.current = active
    if (exit) setRetaining(true)
    void animation.finished.then(() => {
      if (motion.current !== active) return
      motion.current = null; setRetaining(false)
    }, () => { /* Reversal, layout change and disposal cancel only presentation. */ })
  }
  function captureSource(node?: Element | null) {
    const card = node ?? dock.current?.querySelector('.composer-pending__card[data-selected="true"], .composer-pending__notice') ?? dock.current?.querySelector('.composer-pending__card')
    const composer = panel.current?.closest('.composer')
    if (!card || !composer) { origin.current = null; return }
    const rect = card.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) origin.current = { node: card, rect, composer: composer.getBoundingClientRect() }
  }
  function beforeToggle(next: string) {
    const node = panel.current
    if (node && next === 'open') node.dataset.state = 'closed'
    if (!node || reduced.current || !visible) { cancel(); opening.current = null; return }
    if (next === 'open') {
      if (motion.current) {
        const from = currentRect(), opacity = Number(getComputedStyle(node).opacity)
        cancel(); opening.current = null
        // The exiting native popover still has its original full layout. Reverse its
        // current paint now, before the asynchronous/coalesced toggle event can leave a gap.
        animate(from, node.getBoundingClientRect(), false, opacity)
      } else {
        captureSource(origin.current?.node.isConnected ? origin.current.node : undefined)
        opening.current = origin.current ? { rect: origin.current.rect, opacity: 0 } : null
        cancel()
      }
      setRetaining(true)
    } else if (origin.current?.node.isConnected) {
      const composer = node.closest('.composer')!.getBoundingClientRect()
      const previous = origin.current
      const destination = new DOMRect(previous.rect.x + composer.right - previous.composer.right,
        previous.rect.y + composer.top - previous.composer.top, previous.rect.width, previous.rect.height)
      const from = currentRect()
      // The exiting native panel retains its full layout and original text; only its paint contracts.
      animate(from, destination, true)
    } else cancel()
  }
  useLayoutEffect(() => {
    const node = panel.current
    if (!open || !node?.matches(':popover-open') || !visible) return
    node.dataset.state = 'open'
    if (!opening.current || reduced.current) {
      const target = motion.current?.to
      if (target && (Math.abs(node.offsetWidth - target.width) > 1 || Math.abs(node.offsetHeight - target.height) > 1)) cancel()
      else setRetaining(false)
      return
    }
    const from = opening.current; opening.current = null
    animate(from.rect, panel.current!.getBoundingClientRect(), false, from.opacity)
  }, [open, visible, revision])
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => { reduced.current = media.matches; if (media.matches) cancel() }
    update(); media.addEventListener('change', update)
    return () => { media.removeEventListener('change', update); motion.current?.animation.cancel(); motion.current=null }
  }, [])
  useLayoutEffect(() => {
    if (!motion.current || !open && !retaining) return
    const composer = panel.current?.closest('.composer'), region = composer?.closest('[data-workbench-region-id]')
    if (!composer) return
    const initial = composer.getBoundingClientRect(), target = { width: panel.current!.offsetWidth, height: panel.current!.offsetHeight }
    const resize = new ResizeObserver(() => {
      const next = composer.getBoundingClientRect()
      const box = { width: panel.current!.offsetWidth, height: panel.current!.offsetHeight }
      if (next.width !== initial.width || next.height !== initial.height ||
          box.width !== target.width || box.height !== target.height || !origin.current?.node.isConnected) { origin.current = null; cancel() }
    })
    resize.observe(composer); resize.observe(panel.current!); if (region) resize.observe(region)
    return () => resize.disconnect()
  }, [open, retaining, revision])
  useLayoutEffect(() => {
    cancel(); opening.current = null; origin.current = null
    if (!visible && panel.current?.matches(':popover-open')) panel.current.hidePopover()
  }, [scope, visible])
  return { retaining, beforeToggle, captureSource, afterToggle(next: string) { if (next === 'open') nativeOpened() } }
}
