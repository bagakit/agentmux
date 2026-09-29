import { useLayoutEffect, useRef } from 'react'

type Bounds = { x: number; y: number; width: number; height: number }
const transform = ({ x, y }: Bounds, scaleX = 1, scaleY = 1) => `translate3d(${x}px, ${y}px, 0) scale(${scaleX}, ${scaleY})`
const sameBounds = (a: Bounds | null, b: Bounds) => a !== null && (['x', 'y', 'width', 'height'] as const).every((key) => Math.abs(a[key] - b[key]) < 0.5)

/** A decorative selection surface. Native controls remain the selection and focus owner. */
export function LiquidSelectionSurface({ selected, active, targetAttribute }: {
  selected: string | null
  active: boolean
  targetAttribute: 'data-settings-target' | 'data-prompt-id'
}) {
  const surface = useRef<HTMLSpanElement>(null)
  const painted = useRef<Bounds | null>(null)

  useLayoutEffect(() => {
    const lens = surface.current
    const host = lens?.parentElement
    if (!lens || !host) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let animation: Animation | undefined
    let destination: Bounds | null = null
    let observing = false
    let pointing = false
    let observedTarget: HTMLElement | null = null

    const bounds = (node: Element): Bounds => {
      const rect = node.getBoundingClientRect()
      const container = host.getBoundingClientRect()
      return { x: rect.left - container.left + host.scrollLeft - host.clientLeft, y: rect.top - container.top + host.scrollTop - host.clientTop, width: rect.width, height: rect.height }
    }
    const remember = () => {
      // Only a live animation can differ from our stored geometry. After an
      // effect cleanup, cancellation exposes the old inline destination; do
      // not overwrite the intermediate rectangle that cleanup just captured.
      if (animation && !lens.hidden && lens.getClientRects().length) {
        const current = bounds(lens)
        if (current.width > 0 && current.height > 0) painted.current = current
      }
      animation?.cancel()
      animation = undefined
    }
    const clearGlint = () => {
      lens.style.removeProperty('--liquid-pointer-x')
      lens.style.removeProperty('--liquid-pointer-y')
    }
    const update = (flow = false) => {
      const paused = !active || document.hidden || reduced.matches
      lens.dataset.liquidPaused = String(paused)
      const target = selected === null ? null : host.querySelector<HTMLElement>(`[${targetAttribute}="${CSS.escape(selected)}"]`)
      if (observing && observedTarget !== target) {
        if (observedTarget) resize.unobserve(observedTarget)
        if (target) resize.observe(target)
        observedTarget = target
      }
      const next = target && bounds(target)
      const visible = active && !document.hidden && target?.getClientRects().length && next && next.width > 0 && next.height > 0
        && next.y + next.height > host.scrollTop && next.y < host.scrollTop + host.clientHeight
      if (!visible || !next) {
        remember()
        lens.dataset.liquidPaused = 'true'
        lens.hidden = true
        painted.current = destination = null
        clearGlint()
        return
      }
      if (!flow && sameBounds(destination, next) && !paused) return
      remember()
      const from = painted.current
      destination = next
      lens.hidden = false
      lens.style.width = `${next.width}px`
      lens.style.height = `${next.height}px`
      lens.style.transform = transform(next)
      if (flow && from && !paused && !sameBounds(from, next)) {
        const direction = Math.sign(next.y - from.y)
        animation = lens.animate([
          { transform: transform(from, from.width / next.width, from.height / next.height), offset: 0 },
          { transform: transform({ ...next, x: from.x + (next.x - from.x) * 0.35, y: from.y + (next.y - from.y) * 0.35 }, 0.93, 1.45), borderRadius: direction > 0 ? '18px 18px 26px 26px' : '26px 26px 18px 18px', offset: 0.34 },
          { transform: transform({ ...next, y: next.y + direction * 2 }, 1.03, 0.94), borderRadius: '11px', offset: 0.78 },
          { transform: transform(next), borderRadius: 'var(--radius)', offset: 1 }
        ], { duration: 420, easing: 'cubic-bezier(.22,.72,.2,1)' })
      }
      painted.current = next
      if (paused) clearGlint()
    }
    const onPointer = (event: PointerEvent) => {
      if (lens.hidden) return
      const rect = lens.getBoundingClientRect()
      const clamp = (n: number) => Math.max(0, Math.min(100, n))
      lens.style.setProperty('--liquid-pointer-x', `${clamp((event.clientX - rect.left) / rect.width * 100)}%`)
      lens.style.setProperty('--liquid-pointer-y', `${clamp((event.clientY - rect.top) / rect.height * 100)}%`)
    }
    const resize = new ResizeObserver(() => update())
    const mutation = new MutationObserver(() => {
      // A filter may remove the selected control without changing the selection fact.
      update()
    })
    const onScroll = () => update()
    const sync = () => {
      const visible = active && !document.hidden
      if (visible && !observing) {
        resize.observe(host)
        mutation.observe(host, { childList: true, subtree: true, characterData: true })
        host.addEventListener('scroll', onScroll, { passive: true })
        observing = true
      } else if (!visible && observing) {
        resize.disconnect()
        mutation.disconnect()
        host.removeEventListener('scroll', onScroll)
        observing = false
        observedTarget = null
      }
      const pointer = visible && !reduced.matches
      if (pointer && !pointing) {
        host.addEventListener('pointermove', onPointer, { passive: true })
        host.addEventListener('pointerleave', clearGlint)
      } else if (!pointer && pointing) {
        host.removeEventListener('pointermove', onPointer)
        host.removeEventListener('pointerleave', clearGlint)
      }
      pointing = pointer
      update()
    }
    update(true)
    sync()
    reduced.addEventListener('change', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      remember()
      resize.disconnect()
      mutation.disconnect()
      host.removeEventListener('scroll', onScroll)
      host.removeEventListener('pointermove', onPointer)
      host.removeEventListener('pointerleave', clearGlint)
      reduced.removeEventListener('change', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [selected, active, targetAttribute])

  return <span ref={surface} className="liquid-selection" data-liquid-selection={selected ?? ''} aria-hidden="true"><i data-liquid-glint /></span>
}
