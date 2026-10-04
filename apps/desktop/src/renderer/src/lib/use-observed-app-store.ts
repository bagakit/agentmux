import { useCallback, useLayoutEffect, useRef } from 'react'
import { useAppStore } from '../store'
import { rendererPerformance } from './renderer-performance'

type ConsumerKind = 'composer' | 'sessionPane'
type State = ReturnType<typeof useAppStore.getState>
/** Same store subscription and selector semantics; observes checks, not React render attempts. */
export function useObservedAppStore<T>(kind: ConsumerKind, visible: boolean, selector: (state: State) => T): T {
  const visibility = useRef(visible)
  visibility.current = visible
  const previous = useRef<T>(undefined as T)
  const initialized = useRef(false)
  const observed = useCallback((state: State) => {
    const value = selector(state)
    const changed = initialized.current && !Object.is(previous.current, value)
    previous.current = value
    initialized.current = true
    rendererPerformance.check(kind, visibility.current, changed)
    return value
  }, [kind, selector])
  return useAppStore(observed)
}
/** One per component, after a successful commit; aborted renders are not commits. */
export function useObservedConsumerCommit(kind: ConsumerKind, visible: boolean): void {
  useLayoutEffect(() => { rendererPerformance.commit(kind, visible) })
}
