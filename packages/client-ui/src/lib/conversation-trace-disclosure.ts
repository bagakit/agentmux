import { useCallback, useMemo, useRef, useState } from 'react'

const EMPTY_TRACES: ReadonlySet<string> = new Set()

/** Ephemeral disclosure for one loaded reading surface; never owns record content. */
export function useConversationTraceDisclosure(source: string) {
  const owner = useMemo(() => ({ registrations: new Map<object, readonly string[]>() }), [source])
  const current = useRef(owner)
  current.current = owner
  const [state, setState] = useState({ owner, expanded: EMPTY_TRACES })
  const expandedTraces = state.owner === owner ? state.expanded : EMPTY_TRACES
  const register = useCallback((token: object, ids: readonly string[] | null) => {
    if (ids?.length) owner.registrations.set(token, ids)
    else owner.registrations.delete(token)
    if (current.current !== owner) return
    setState(previous => {
      if (previous.owner !== owner || previous.expanded.size === 0) return previous
      const retained = new Set([...owner.registrations.values()].flat())
      const expanded = new Set([...previous.expanded].filter(id => retained.has(id)))
      return expanded.size === previous.expanded.size ? previous : { owner, expanded }
    })
  }, [owner])
  const onToggleTrace = useCallback((id: string, open: boolean) => {
    if (current.current !== owner || ![...owner.registrations.values()].some(ids => ids.includes(id))) return
    setState(previous => {
      const expanded = new Set(previous.owner === owner ? previous.expanded : EMPTY_TRACES)
      if (open) expanded.add(id)
      else expanded.delete(id)
      return { owner, expanded }
    })
  }, [owner])
  const collapse = useCallback(() => {
    if (current.current === owner) setState({ owner, expanded: EMPTY_TRACES })
  }, [owner])
  return useMemo(() => ({ expandedTraces, onToggleTrace, register, collapse }), [expandedTraces, onToggleTrace, register, collapse])
}

export type ConversationTraceDisclosure = ReturnType<typeof useConversationTraceDisclosure>
