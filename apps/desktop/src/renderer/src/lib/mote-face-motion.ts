import type { MoteExpression } from '../components/MoteFace'

type Identity = { node: HTMLElement; expression: MoteExpression; visible: boolean; inView: boolean; near: boolean }
const ambient = new Set<MoteExpression>(['identity', 'sleep', 'idle', 'thinking', 'tool', 'starting'])
let owner: ReturnType<typeof createMotionOwner> | undefined

/** One event-driven native rig owner for the currently visible identities. No React frame clock. */
function createMotionOwner() {
  const identities = new Map<Element, Identity>(), faces = new Set<Identity>()
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  let pointing = false, frame: number | null = null, point: { x: number; y: number } | null = null
  const reset = (identity: Identity) => {
    if (!identity.near) return
    identity.near = false; identity.node.dataset.moteGaze = 'far'
    for (const name of ['--mote-gaze-x', '--mote-gaze-y', '--mote-head-turn', '--mote-brow-lift', '--mote-mouth-shift']) identity.node.style.removeProperty(name)
  }
  const clear = () => { point = null; if (frame !== null) cancelAnimationFrame(frame); frame = null; for (const identity of faces) reset(identity) }
  const paint = () => {
    frame = null
    if (!point) return
    // The set contains only native-visible faces. Hidden instances are never laid out on pointer input.
    for (const identity of faces) {
      const svg = identity.node.querySelector('.mote-face'), rect = svg?.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) { reset(identity); continue }
      const dx = point.x - (rect.left + rect.width / 2), dy = point.y - (rect.top + rect.height / 2)
      const reach = Math.max(110, rect.width * 1.65), distance = Math.hypot(dx, dy)
      if (distance >= reach) { reset(identity); continue }
      const strength = Math.min(1, (reach - distance) / (reach * .3))
      const x = Math.max(-1, Math.min(1, dx / Math.max(28, rect.width * .55))) * strength
      const y = Math.max(-1, Math.min(1, dy / Math.max(28, rect.height * .55))) * strength
      identity.near = true; identity.node.dataset.moteGaze = 'near'
      identity.node.style.setProperty('--mote-gaze-x', `${(x * 2.5).toFixed(3)}px`)
      identity.node.style.setProperty('--mote-gaze-y', `${(y * 1.7).toFixed(3)}px`)
      identity.node.style.setProperty('--mote-head-turn', `${(x * 3).toFixed(3)}deg`)
      identity.node.style.setProperty('--mote-brow-lift', `${(-Math.abs(x) * .7).toFixed(3)}px`)
      identity.node.style.setProperty('--mote-mouth-shift', `${(x * .5).toFixed(3)}px`)
    }
  }
  const pointer = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return
    point = { x: event.clientX, y: event.clientY }
    if (frame === null) frame = requestAnimationFrame(paint)
  }
  const syncPointer = () => {
    const next = faces.size > 0
    if (next === pointing) return
    pointing = next
    if (next) { document.addEventListener('pointermove', pointer, { passive: true }); document.addEventListener('pointerleave', clear); window.addEventListener('blur', clear) }
    else { document.removeEventListener('pointermove', pointer); document.removeEventListener('pointerleave', clear); window.removeEventListener('blur', clear); clear() }
  }
  const sync = (identity: Identity) => {
    const enabled = identity.visible && identity.inView && !document.hidden && !reduced.matches
    identity.node.dataset.moteVisible = enabled ? 'on' : 'off'
    identity.node.dataset.moteMotion = enabled && ambient.has(identity.expression) ? 'on' : 'off'
    if (enabled && identity.node.querySelector('.mote-face')) faces.add(identity)
    else { reset(identity); faces.delete(identity) }
  }
  const syncAll = () => { for (const identity of identities.values()) sync(identity); syncPointer() }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const identity = identities.get(entry.target)
      if (identity) { identity.inView = entry.isIntersecting && entry.intersectionRatio > 0; sync(identity) }
    }
    syncPointer()
  })
  reduced.addEventListener('change', syncAll); document.addEventListener('visibilitychange', syncAll)
  return {
    register(node: HTMLElement, expression: MoteExpression, visible: boolean) {
      const identity: Identity = { node, expression, visible, inView: false, near: false }
      identities.set(node, identity); node.dataset.moteMotion = 'off'; node.dataset.moteGaze = 'far'
      if (visible) observer.observe(node)
      return {
        update(expression: MoteExpression, visible: boolean) {
          identity.expression = expression
          if (identity.visible !== visible) {
            identity.visible = visible; identity.inView = false
            if (visible) observer.observe(node); else observer.unobserve(node)
          }
          sync(identity); syncPointer()
        },
        dispose() {
          reset(identity); faces.delete(identity); identities.delete(node); observer.unobserve(node); syncPointer()
          if (identities.size === 0) {
            observer.disconnect(); reduced.removeEventListener('change', syncAll); document.removeEventListener('visibilitychange', syncAll); owner = undefined
          }
        }
      }
    }
  }
}

export function observeMoteMotion(node: HTMLElement, expression: MoteExpression, visible: boolean): ReturnType<ReturnType<typeof createMotionOwner>['register']> {
  owner ??= createMotionOwner()
  return owner.register(node, expression, visible)
}
