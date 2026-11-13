import { createContext } from 'react'

/** A surface whose content can move under a still pointer, such as a pan and zoom camera.
 * A pointer entry while the surface moves is content arriving under the pointer, not hover
 * intent. It is held and replayed once the surface rests, for targets the pointer still covers.
 * Motion has named sources. Each source is begun and ended by its own owner, so the late end
 * of one source cannot release another. Nothing re-renders on motion; only subscribers hear it. */
export type PointerRestGate = {
  readonly moving: () => boolean
  readonly subscribe: (listener: () => void) => () => void
  /** Run `enter` now, or at rest if `target` is still under the pointer then. Pass a
   * callback that reads current state, because it may run after later renders. */
  readonly enter: (target: Element, enter: () => void) => void
  readonly leave: (target: Element) => void
  readonly begin: (source: string) => void
  readonly end: (source: string) => void
}

export function createPointerRestGate(): PointerRestGate {
  const sources = new Set<string>(), held = new Map<Element, () => void>(), listeners = new Set<() => void>()
  const publish = () => { for (const listener of [...listeners]) listener() }
  return {
    moving: () => sources.size > 0,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    enter(target, enter) { if (sources.size) held.set(target, enter); else enter() },
    leave(target) { held.delete(target) },
    begin(source) { if (sources.has(source)) return; sources.add(source); if (sources.size === 1) publish() },
    end(source) {
      if (!sources.delete(source) || sources.size) return
      const rest = [...held]; held.clear()
      publish()
      for (const [target, enter] of rest) if (target.isConnected && target.matches(':hover')) enter()
    }
  }
}

/** A surface that never moves: every pointer entry is hover intent. */
export const PointerRestGateContext = createContext<PointerRestGate>(createPointerRestGate())
