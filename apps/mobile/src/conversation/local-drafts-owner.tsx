import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createLocalDrafts } from './local-drafts'
import { getDeviceWorkface } from '../recovery/device-workface'

export type MobileLocalDrafts = ReturnType<typeof createLocalDrafts>
const Owner = createContext<MobileLocalDrafts | null>(null)

/**
 * One device draft and answer owner per page. The conversation and the Focus ticket answer the same
 * request through the same retained attempt, so neither can show a request as open while the other
 * holds its in-flight or unknown answer.
 */
export function MobileLocalDraftsOwner({ children }: { children: ReactNode }) {
  const device = getDeviceWorkface()
  const retained = useRef<MobileLocalDrafts | null>(null)
  const subscribe = useCallback((listener: () => void) => device.subscribeRecordReplacement(listener,
    () => retained.current?.unstoredDraftEdits() ?? []), [device])
  const replacementRevision = useSyncExternalStore(subscribe, device.recordReplacementRevision)
  const local = useMemo(createLocalDrafts, [replacementRevision])
  retained.current = local
  return <Owner.Provider value={local}>{children}</Owner.Provider>
}

/** The page owner; a surface mounted on its own keeps a private one. */
export function useMobileLocalDrafts(): MobileLocalDrafts {
  const shared = useContext(Owner)
  const [own] = useState(() => shared ? null : createLocalDrafts())
  return shared ?? own!
}
