import { useCallback, useContext, useLayoutEffect, useSyncExternalStore, type ContextType, type ReactNode } from 'react'
import { MoteWorkfaceContext } from './mote-workface'
import { MoteDialogueViewContext, type MoteDialogueView } from './mote-dialogue-view'

type Presentation = { workface: ContextType<typeof MoteWorkfaceContext>; dialogue: MoteDialogueView | null }
// The floating shell owns these live React values. Retained Views keep their
// original React owner when their DOM moves, so transfer the shell's context too.
// This registry neither reads nor stores independent role/lifecycle facts.
const values = new Map<string, Presentation>()
const listeners = new Map<string, Set<() => void>>()
const changed = (key: string) => { for (const listener of listeners.get(key) ?? []) listener() }
export const motePresentationContextKey = (topicId: string, entry: number | undefined) => JSON.stringify([topicId, entry])

export function usePublishMotePresentation(key: string | undefined, workface: Presentation['workface'], dialogue: Presentation['dialogue']) {
  useLayoutEffect(() => {
    if (!key) return
    const value = { workface, dialogue }
    values.set(key, value); changed(key)
    return () => { if (values.get(key) === value) { values.delete(key); changed(key) } }
  }, [key, workface, dialogue])
}

/** A missing exact shell shadows the background context rather than borrowing it.
 * Providers stay mounted across placement changes, preserving the original DOM. */
export function MotePresentationContext({ contextKey, isolated, children }: { contextKey: string | undefined; isolated: boolean; children: ReactNode }) {
  const parentWorkface = useContext(MoteWorkfaceContext), parentDialogue = useContext(MoteDialogueViewContext)
  const subscribe = useCallback((listener: () => void) => {
    if (!contextKey) return () => {}
    let group = listeners.get(contextKey)
    if (!group) { group = new Set(); listeners.set(contextKey, group) }
    group.add(listener)
    return () => { group.delete(listener); if (!group.size) listeners.delete(contextKey) }
  }, [contextKey])
  const snapshot = useCallback(() => contextKey ? values.get(contextKey) ?? null : null, [contextKey])
  const value = useSyncExternalStore(subscribe, snapshot, snapshot)
  const own = Boolean(contextKey || isolated)
  return <MoteWorkfaceContext.Provider value={own ? value?.workface ?? null : parentWorkface}>
    <MoteDialogueViewContext.Provider value={own ? value?.dialogue ?? null : parentDialogue}>{children}</MoteDialogueViewContext.Provider>
  </MoteWorkfaceContext.Provider>
}
