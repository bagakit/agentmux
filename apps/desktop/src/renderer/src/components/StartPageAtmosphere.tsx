import { useEffect, useRef, type RefObject } from 'react'

/** Optional local decoration. Pointer input schedules one frame; still pages do no work. */
export function StartPageAtmosphere({ host, visible }: { host: RefObject<HTMLDivElement | null>; visible: boolean }) {
  const plane = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const surface = host.current, layer = plane.current
    if (!surface || !layer || !visible) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0, x = 0, y = 0
    function reset() {
      cancelAnimationFrame(frame); frame = 0
      layer!.style.transform = 'translate3d(0px, 0px, 0px)'
    }
    function paint() {
      frame = 0
      // Read this visible workface once, then write only its isolated decoration layer.
      const rect = surface!.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const dx = Math.max(-1, Math.min(1, (x - rect.left) / rect.width * 2 - 1))
      const dy = Math.max(-1, Math.min(1, (y - rect.top) / rect.height * 2 - 1))
      layer!.style.transform = `translate3d(${(dx * 28).toFixed(2)}px, ${(dy * 20).toFixed(2)}px, 0px)`
    }
    function move(event: PointerEvent) {
      if (event.pointerType === 'touch') return
      x = event.clientX; y = event.clientY
      if (!frame) frame = requestAnimationFrame(paint)
    }
    function detach() {
      surface!.removeEventListener('pointermove', move)
      surface!.removeEventListener('pointerleave', reset)
      surface!.removeEventListener('pointercancel', reset)
      layer!.style.transition = 'none'
      reset()
    }
    function observe() {
      detach()
      if (reduced.matches || document.hidden) return
      layer!.style.transition = ''
      surface!.addEventListener('pointermove', move, { passive: true })
      surface!.addEventListener('pointerleave', reset)
      surface!.addEventListener('pointercancel', reset)
    }
    observe()
    reduced.addEventListener('change', observe)
    document.addEventListener('visibilitychange', observe)
    return () => { detach(); reduced.removeEventListener('change', observe); document.removeEventListener('visibilitychange', observe) }
  }, [host, visible])
  return <div className="browser-start-atmosphere" data-start-atmosphere aria-hidden="true">
    <div ref={plane} className="browser-start-atmosphere__plane">
      <div className="browser-start-atmosphere__light" />
      <svg className="browser-start-atmosphere__lines" viewBox="0 0 1200 600" preserveAspectRatio="xMidYMid slice" fill="none">
        <path d="M-160 425C170 25 555 85 1360 260M-160 465C170 65 555 125 1360 300M-160 505C170 105 555 165 1360 340" />
        <path d="M-80 150C260 415 810 490 1300 30M-80 176C260 441 810 516 1300 56" />
        <g><circle cx="186" cy="215" r="3" /><circle cx="913" cy="283" r="4" /><circle cx="1035" cy="177" r="2" /><circle cx="389" cy="342" r="2" /><circle cx="697" cy="153" r="2" /></g>
      </svg>
    </div>
  </div>
}
