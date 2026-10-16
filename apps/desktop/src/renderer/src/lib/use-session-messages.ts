import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentMuxMessageMetadata, AgentMuxMessageDirection } from '@agentmux/core'
import { api } from './api'

type Window = { scope: string; pages: number; items: readonly AgentMuxMessageMetadata[]; nextCursor: number | null;
  loading: boolean; error: string | null; observationError: string | null }
const empty = (scope: string): Window => ({ scope, pages: 1, items: [], nextCursor: null, loading: false, error: null,
  observationError: 'Message update observation is unconfirmed. Explicitly refresh the original Host.' })

/** One visible participant's requested pages. No Agent consumption or editor state is owned here. */
export function useSessionMessages({ hostId, agentSessionId, direction, enabled }: {
  hostId: string; agentSessionId: string; direction: AgentMuxMessageDirection; enabled: boolean
}) {
  const scope = JSON.stringify([hostId, agentSessionId, direction])
  const [state, setState] = useState<Window>(() => empty(scope))
  const stateRef = useRef(state); stateRef.current = state
  const current = useRef({ scope, enabled, generation: 0 }); Object.assign(current.current, { scope, enabled })
  const load = useCallback(async (earlier = false) => {
    if (!current.current.enabled || current.current.scope !== scope) return
    const previous = stateRef.current.scope === scope ? stateRef.current : empty(scope)
    const cursor = earlier ? previous.nextCursor : null
    if (earlier && cursor === null) return
    const generation = ++current.current.generation
    const matches = () => current.current.enabled && current.current.scope === scope && current.current.generation === generation
    setState(value => ({ ...(value.scope === scope ? value : empty(scope)), loading: true, error: null }))
    try {
      const received = new Map<string, AgentMuxMessageMetadata>()
      const originals = new Map(previous.items.map(item => [item.envelope.messageId, item]))
      let before = cursor, nextCursor: number | null = null, readPages = 0
      const requestedPages = earlier ? 1 : previous.pages
      // Refresh the explicitly requested window, keeping it contiguous even after a burst larger than one page.
      // Stage every page first: an incomplete refresh cannot replace a previously readable window.
      for (let index = 0; index < requestedPages; ++index) {
        const page = await api.sessions.listMessages({ hostId, agentSessionId }, { direction, limit: 25, ...(before === null ? {} : { beforeSequence: before }) })
        if (!matches()) return
        if (page.hostId !== hostId || page.participantSessionId !== agentSessionId || page.direction !== direction ||
            page.messages.some(item => item.envelope.sender.kind !== 'agent-session' || item.envelope.recipient.kind !== 'agent-session' ||
              (direction === 'incoming' ? item.envelope.recipientSessionId : item.envelope.senderSessionId) !== agentSessionId) ||
            before !== null && page.nextBeforeSequence !== null && page.nextBeforeSequence >= before) throw new Error('The original message page identity changed. The previous window is retained.')
        for (const item of page.messages) {
          const old = originals.get(item.envelope.messageId)
          if (old && (old.sequence !== item.sequence || JSON.stringify(old.envelope) !== JSON.stringify(item.envelope) ||
              old.bodyPreview !== item.bodyPreview || old.bodyBytes !== item.bodyBytes)) throw new Error('An original message changed immutable content. The previous window is retained.')
          received.set(item.envelope.messageId, item)
        }
        ++readPages
        nextCursor = page.nextBeforeSequence
        if (nextCursor === null) break
        before = nextCursor
      }
      const records = earlier ? new Map(previous.items.map(item => [item.envelope.messageId, item])) : new Map<string, AgentMuxMessageMetadata>()
      for (const [id, item] of received) records.set(id, item)
      setState(value => ({ ...(value.scope === scope ? value : empty(scope)), items: [...records.values()].sort((a,b) => b.sequence-a.sequence),
        pages: earlier ? previous.pages + readPages : readPages, nextCursor, loading: false, error: null }))
    } catch (error) {
      if (matches()) setState(value => ({ ...(value.scope === scope ? value : empty(scope)), loading: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }, [scope, hostId, agentSessionId, direction])
  useEffect(() => {
    if (!enabled) return
    let queued = false, active = true
    const release = api.sessions.onEvent(({ hostId: sourceHost, event }) => {
      if (!active || sourceHost !== hostId) return
      if (event.type === 'agent-message-observation') {
        setState(value => value.scope !== scope ? value : { ...value, observationError: event.state === 'available' ? null : event.message ?? 'Original message observation is unavailable. Explicitly refresh.' })
      } else if (event.type === 'agent-message-changed' &&
          (direction === 'incoming' ? event.recipientSessionId : event.senderSessionId) === agentSessionId && !queued) {
        queued = true
        queueMicrotask(() => { queued = false; if (active) void load() })
      }
    })
    void load()
    return () => { active = false; ++current.current.generation; release() }
  }, [scope, hostId, agentSessionId, direction, enabled, load])
  const refresh = useCallback(() => load(), [load])
  const loadEarlier = useCallback(() => load(true), [load])
  const visible = state.scope === scope ? state : empty(scope)
  return { ...visible, loading: enabled && visible.loading, refresh, loadEarlier }
}
