import { useEffect, useId, useRef, type RefObject } from 'react'

/** Two prepainted light surfaces. Pointer input schedules one frame; still pages do no work. */
export function StartPageAtmosphere({ host, visible }: { host: RefObject<HTMLDivElement | null>; visible: boolean }) {
  const plane = useRef<HTMLDivElement>(null), sheen = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    const surface = host.current, layer = plane.current, highlight = sheen.current
    if (!surface || !layer || !highlight || !visible) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0, x = 0, y = 0
    function reset() {
      cancelAnimationFrame(frame); frame = 0
      layer!.style.transform = 'translate3d(0px, 0px, 0px)'
      highlight!.style.transform = 'translate3d(0px, 0px, 0px)'
      highlight!.style.opacity = '0.62'
    }
    function paint() {
      frame = 0
      // Geometry belongs to this workface. Neither inherited CSS variables nor React carry frame data.
      const rect = surface!.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const dx = Math.max(-1, Math.min(1, (x - rect.left) / rect.width * 2 - 1))
      const dy = Math.max(-1, Math.min(1, (y - rect.top) / rect.height * 2 - 1))
      layer!.style.transform = `translate3d(${(dx * 10).toFixed(2)}px, ${(dy * 6).toFixed(2)}px, 0px)`
      highlight!.style.transform = `translate3d(${(-dx * 14).toFixed(2)}px, ${(-dy * 8).toFixed(2)}px, 0px)`
      highlight!.style.opacity = (0.62 + Math.abs(dx) * 0.2).toFixed(3)
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
      highlight!.style.transition = 'none'
      reset()
    }
    function observe() {
      detach()
      if (reduced.matches || document.hidden) return
      layer!.style.transition = ''
      highlight!.style.transition = ''
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
    <div className="browser-start-atmosphere__haze" />
    <div ref={plane} className="browser-start-atmosphere__plane">
      <svg viewBox="0 0 1200 520" preserveAspectRatio="none" fill="none">
        <defs>
          <linearGradient id={`${id}-fold`} x1="20" y1="480" x2="325" y2="80" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--green-2)" stopOpacity="0" />
            <stop offset=".34" stopColor="var(--green-2)" stopOpacity=".04" />
            <stop offset=".68" stopColor="var(--green-2)" stopOpacity=".18" />
            <stop offset=".88" stopColor="var(--green)" stopOpacity=".4" />
            <stop offset="1" stopColor="var(--green)" stopOpacity=".02" />
          </linearGradient>
          <linearGradient id={`${id}-face`} x1="198" y1="240" x2="290" y2="255" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--green)" stopOpacity="0" />
            <stop offset=".35" stopColor="var(--green-2)" stopOpacity=".08" />
            <stop offset=".72" stopColor="var(--green)" stopOpacity=".48" />
            <stop offset="1" stopColor="var(--green-2)" stopOpacity=".03" />
          </linearGradient>
          <linearGradient id={`${id}-rim`} x1="315" y1="62" x2="120" y2="438" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--green)" stopOpacity="0" />
            <stop offset=".3" stopColor="var(--green)" stopOpacity=".65" />
            <stop offset="1" stopColor="var(--green)" stopOpacity="0" />
          </linearGradient>
          <g id={`${id}-wing`}>
            <path d="M-60 500C75 315 200 174 342 52C289 140 268 214 282 265C300 332 370 369 454 408C263 385 108 461-60 500Z" fill={`url(#${id}-fold)`} />
            <path d="M342 52C304 134 266 184 252 232L198 292C229 182 281 117 342 52Z" fill={`url(#${id}-face)`} />
            <path d="M198 292L252 232C260 296 293 333 349 366L125 438Z" fill={`url(#${id}-fold)`} opacity=".7" />
            <path d="M125 438L198 292L109 356L-60 500Z" fill={`url(#${id}-face)`} opacity=".3" />
            <path d="M342 52C286 144 226 218 198 292L125 438" stroke={`url(#${id}-rim)`} strokeWidth="1.2" />
            <path d="M198 292L252 232C260 296 293 333 349 366" stroke={`url(#${id}-rim)`} strokeWidth=".6" opacity=".45" />
          </g>
        </defs>
        <use href={`#${id}-wing`} />
        <use href={`#${id}-wing`} transform="translate(1200 0) scale(-1 1)" opacity=".7" />
      </svg>
    </div>
    <div ref={sheen} className="browser-start-atmosphere__sheen">
      <svg viewBox="0 0 1200 520" preserveAspectRatio="none" fill="none">
        <defs>
          <linearGradient id={`${id}-glint`} x1="250" y1="64" x2="52" y2="440" gradientUnits="userSpaceOnUse">
            <stop stopColor="var(--green)" stopOpacity="0" />
            <stop offset=".32" stopColor="var(--green)" stopOpacity=".38" />
            <stop offset=".6" stopColor="var(--green-2)" stopOpacity=".08" />
            <stop offset="1" stopColor="var(--green-2)" stopOpacity="0" />
          </linearGradient>
          <g id={`${id}-light`}>
            <path d="M252 100C215 175 173 239 149 306L49 440C120 268 193 161 252 100Z" fill={`url(#${id}-glint)`} />
            <path d="M252 100C215 175 173 239 149 306L49 440" stroke={`url(#${id}-glint)`} strokeWidth="1" />
            <path d="M296 238L406 360L486 435L351 367Z" fill={`url(#${id}-glint)`} opacity=".5" />
          </g>
        </defs>
        <use href={`#${id}-light`} />
        <use href={`#${id}-light`} transform="translate(1200 0) scale(-1 1)" />
      </svg>
    </div>
  </div>
}
