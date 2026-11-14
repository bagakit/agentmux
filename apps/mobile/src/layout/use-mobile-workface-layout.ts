import { useSyncExternalStore } from 'react'
import { readMobileViewport, subscribeMobileViewport } from '../platform/native/device'
import { mobileWorkfaceLayout } from './workface-presentation'

const subscribe = (changed: () => void) => subscribeMobileViewport(window, changed)
const snapshot = () => mobileWorkfaceLayout(readMobileViewport(window))
const serverSnapshot = () => mobileWorkfaceLayout({ width: 0, height: 0 })
/** The App already binds the sole viewport producer; this hook only consumes it. */
export function useMobileWorkfaceLayout() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}
