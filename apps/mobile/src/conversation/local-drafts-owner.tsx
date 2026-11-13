import { createContext, useContext, useState, type ReactNode } from 'react'
import { createLocalDrafts } from './local-drafts'

export type MobileLocalDrafts = ReturnType<typeof createLocalDrafts>
const Owner = createContext<MobileLocalDrafts | null>(null)

/**
 * One device draft and answer owner per page. The conversation and the Focus ticket answer the same
 * request through the same retained attempt, so neither can show a request as open while the other
 * holds its in-flight or unknown answer.
 */
export function MobileLocalDraftsOwner({ children }: { children: ReactNode }) {
  const [local] = useState(createLocalDrafts)
  return <Owner.Provider value={local}>{children}</Owner.Provider>
}

/** The page owner; a surface mounted on its own keeps a private one. */
export function useMobileLocalDrafts(): MobileLocalDrafts {
  const shared = useContext(Owner)
  const [own] = useState(() => shared ? null : createLocalDrafts())
  return shared ?? own!
}
