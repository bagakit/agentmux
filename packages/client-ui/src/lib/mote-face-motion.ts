import type { MoteExpression } from '../components/MoteFace.js'

type Identity = { node: HTMLElement; expression: MoteExpression; visible: boolean; inView: boolean; near: boolean; nextAt: number; endsAt: number; lastGesture: string }
const ambient = new Set<MoteExpression>(['identity', 'sleep', 'idle', 'thinking', 'tool', 'starting', 'waiting', 'unknown'])
const gestures: Partial<Record<MoteExpression, readonly string[]>> = {
  identity: ['blink', 'double-blink', 'glance-left', 'glance-right', 'curious', 'smile'],
  idle: ['blink', 'double-blink', 'glance-left', 'glance-right', 'curious', 'smile'],
  sleep: ['doze'], thinking: ['ponder', 'double-blink'], tool: ['focus', 'nod'],
  starting: ['wake'], waiting: ['blink', 'attentive'], unknown: ['blink']
}
let owner: ReturnType<typeof createMotionOwner> | undefined

/** One event-driven native rig owner for the currently visible identities. No React frame clock. */
function createMotionOwner() {
  const identities = new Map<Element, Identity>(), rigs = new Set<Identity>(), spontaneous = new Set<Identity>()
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  let pointing = false, frame: number | null = null, point: { x: number; y: number } | null = null
  let timer: ReturnType<typeof setTimeout> | undefined, deadline = 0
  const resting = () => Date.now() + 4000 + Math.random() * 6000
  const clearGesture = (identity: Identity) => {
    delete identity.node.dataset.moteGesture
    identity.endsAt = 0
  }
  // One sparse wake-up for visible native rigs. CSS paints every intermediate frame.
  const schedule = () => {
    const next = Math.min(...Array.from(spontaneous, identity => identity.endsAt || identity.nextAt))
    if (timer !== undefined && next === deadline) return
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined; deadline = next
    if (!Number.isFinite(next)) return
    timer = setTimeout(() => {
      timer = undefined
      const now = Date.now()
      for (const identity of spontaneous) {
        if (identity.endsAt && identity.endsAt <= now) { clearGesture(identity); identity.nextAt = resting() }
        else if (!identity.endsAt && identity.nextAt <= now) {
          const choices = gestures[identity.expression]!.filter(value => value !== identity.lastGesture)
          const available = choices.length ? choices : gestures[identity.expression]!
          if (!identity.near) {
            const gesture = available[Math.floor(Math.random() * available.length)]!
            identity.lastGesture = gesture; identity.node.dataset.moteGesture = gesture; identity.endsAt = now + 1600
          } else identity.nextAt = resting()
        }
      }
      schedule()
    }, Math.max(1, next - Date.now()))
  }
  const reset = (identity: Identity) => {
    if (!identity.near) return
    identity.near = false; identity.node.dataset.moteGaze = 'far'
    for (const name of ['--mote-gaze-x', '--mote-gaze-y', '--mote-head-turn', '--mote-brow-lift', '--mote-mouth-shift']) identity.node.style.removeProperty(name)
  }
  const clear = () => { point = null; if (frame !== null) cancelAnimationFrame(frame); frame = null; for (const identity of rigs) reset(identity) }
  const paint = () => {
    frame = null
    if (!point) return
    // The set contains only native-visible avatar rigs. Hidden instances are never laid out on pointer input.
    const measured = Array.from(rigs, identity => ({ identity,
      rect: identity.node.querySelector('.mote-face, .mote-image-follow')?.getBoundingClientRect() }))
    // Read every active rig before any style/dataset write can invalidate the next rig's layout.
    for (const { identity, rect } of measured) {
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
    const next = rigs.size > 0
    if (next === pointing) return
    pointing = next
    if (next) { document.addEventListener('pointermove', pointer, { passive: true }); document.addEventListener('pointerleave', clear); window.addEventListener('blur', clear) }
    else { document.removeEventListener('pointermove', pointer); document.removeEventListener('pointerleave', clear); window.removeEventListener('blur', clear); clear() }
  }
  const sync = (identity: Identity) => {
    const enabled = identity.visible && identity.inView && !document.hidden && !reduced.matches
    identity.node.dataset.moteVisible = enabled ? 'on' : 'off'
    const animated = enabled && ambient.has(identity.expression)
    identity.node.dataset.moteMotion = animated ? 'on' : 'off'
    if (animated) {
      if (!spontaneous.has(identity)) { identity.nextAt = Date.now() + 1800 + Math.random() * 2700; spontaneous.add(identity) }
    } else { spontaneous.delete(identity); clearGesture(identity) }
    if (enabled && identity.node.querySelector('.mote-face, .mote-image-follow')) rigs.add(identity)
    else { reset(identity); rigs.delete(identity) }
  }
  const syncAll = () => { for (const identity of identities.values()) sync(identity); syncPointer(); schedule() }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const identity = identities.get(entry.target)
      if (identity) { identity.inView = entry.isIntersecting && entry.intersectionRatio > 0; sync(identity) }
    }
    syncPointer(); schedule()
  })
  reduced.addEventListener('change', syncAll); document.addEventListener('visibilitychange', syncAll)
  return {
    register(node: HTMLElement, expression: MoteExpression, visible: boolean) {
      const identity: Identity = { node, expression, visible, inView: false, near: false, nextAt: 0, endsAt: 0, lastGesture: '' }
      identities.set(node, identity); node.dataset.moteMotion = 'off'; node.dataset.moteGaze = 'far'
      if (visible) observer.observe(node)
      return {
        update(expression: MoteExpression, visible: boolean) {
          if (identity.expression !== expression) { spontaneous.delete(identity); clearGesture(identity); identity.lastGesture = '' }
          identity.expression = expression
          if (identity.visible !== visible) {
            identity.visible = visible; identity.inView = false
            if (visible) observer.observe(node); else observer.unobserve(node)
          }
          sync(identity); syncPointer(); schedule()
        },
        dispose() {
          reset(identity); clearGesture(identity); spontaneous.delete(identity); rigs.delete(identity); identities.delete(node); observer.unobserve(node); syncPointer(); schedule()
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
