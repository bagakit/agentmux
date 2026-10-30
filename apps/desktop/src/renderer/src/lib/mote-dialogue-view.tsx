import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useMoteDialogue } from '@agentmux/client-ui/use-mote-dialogue'
import type { MoteWorkfaceScope } from './mote-workface'
import { moteConnectionTarget } from './mote-connection-default'
import { useAppStore } from '../store'
import { api } from './api'
export type MoteDialogueView = ReturnType<typeof useMoteDialogue> & { target: ReturnType<typeof moteConnectionTarget>; active: boolean }
const Context = createContext<MoteDialogueView | null>(null)
export const useMoteDialogueView = () => useContext(Context)
/** Header, reading and input share one original main-role observation in this workface. */
export function MoteDialogueViewProvider({ scope, active, children }: { scope: MoteWorkfaceScope | null; active: boolean; children: ReactNode }) {
  const outer = useContext(Context)
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const target = useMemo(() => scope ? moteConnectionTarget(scope, bindings) : null, [scope, bindings])
  const reuse = Boolean(outer && (!scope || JSON.stringify(outer.target) === JSON.stringify(target) && (outer.active || !active)))
  const source = scope?.topic.quickMode
  const revision = source?.status === 'saved' ? source.version : source?.status === 'unconfirmed' ? source.message : undefined
  const own = useMoteDialogue(api.moteDialogue.read, target ?? undefined, active && !reuse, revision)
  const value = useMemo(() => ({ ...own, target, active }), [own.key, own.read, own.page, own.issue, own.unavailable, own.loading, own.refresh, own.older, target, active])
  return <Context.Provider value={reuse ? outer : value}>{children}</Context.Provider>
}
