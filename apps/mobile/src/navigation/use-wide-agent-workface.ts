import { useSyncExternalStore } from 'react'

// The App occupies the viewport before its compact reading-width cap. This is layout
// only; the native viewport owner continues to own keyboard height and position.
const query = '(min-width: 760px)'
let media: MediaQueryList | undefined
const viewport = () => typeof window.matchMedia === 'function' ? media ??= window.matchMedia(query) : undefined
const subscribe = (changed: () => void) => {
  const source = viewport()
  source?.addEventListener('change', changed)
  return () => source?.removeEventListener('change', changed)
}
export function useWideAgentWorkface() {
  return useSyncExternalStore(subscribe, () => viewport()?.matches ?? false, () => false)
}
