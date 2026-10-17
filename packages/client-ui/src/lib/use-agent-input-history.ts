import { readHistoryQuery } from './history-query-read.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSessionHistoryReadInput, AgentSessionHistoryReadPage, AgentSessionUserMessage } from '@agentmux/core'

export type InputHistoryRead = (input: Omit<AgentSessionHistoryReadInput, 'hostId' | 'agentSessionId'>,
  signal: AbortSignal) => Promise<AgentSessionHistoryReadPage>
export type InputHistorySource = 'captured' | 'native'
type SourcePage = { source: InputHistorySource; messages: readonly AgentSessionUserMessage[]; cursor: string | null;
  complete: boolean; examined: number; loading: boolean; error: string | null; retry?: { cursor?: string; retain?: boolean } }
const sources: readonly InputHistorySource[] = ['captured', 'native']
const EMPTY_MESSAGES: readonly AgentSessionUserMessage[] = Object.freeze([])
const empty = (source: InputHistorySource): SourcePage => ({ source, messages: [], cursor: null, complete: false, examined: 0, loading: false, error: null })

/** One visible reader's temporary query window. No transcript, delivery or draft state is owned here. */
export function useAgentInputHistory({ scope, enabled, read, initialMessages = EMPTY_MESSAGES }: {
  scope: string; enabled: boolean; read: InputHistoryRead; initialMessages?: readonly AgentSessionUserMessage[]
}) {
  const [draftQuery, setDraftQuery] = useState('')
  const [state, setState] = useState<{ scope: string; read: InputHistoryRead; query: string; pages: readonly SourcePage[] }>(
    () => ({ scope, read, query: '', pages: sources.map(empty) }))
  const stateRef = useRef(state); stateRef.current = state
  const current = useRef({ scope, enabled, read, generation: 0 })
  const controllers = useRef(new Map<InputHistorySource, AbortController>())
  current.current.scope = scope; current.current.enabled = enabled; current.current.read = read

  const load = useCallback(async (source: InputHistorySource, query: string, cursor?: string, retain = false) => {
    controllers.current.get(source)?.abort()
    const controller = new AbortController(); controllers.current.set(source, controller)
    const generation = current.current.generation
    const matches = () => !controller.signal.aborted && current.current.enabled && current.current.scope === scope &&
      current.current.read === read && current.current.generation === generation
    setState(value => ({ ...value, pages: value.pages.map(page => page.source === source ? { ...page, loading: true, error: null } : page) }))
    try {
      const input: Omit<AgentSessionHistoryReadInput, 'hostId' | 'agentSessionId'> = { source, kind: 'user-message', query,
        limit: 30, scanLimit: 200, maxBytes: 128 * 1024, ...(cursor ? { cursor } : {}) }
      const page = await readHistoryQuery(input, read, controller.signal, matches)
      if (!matches()) return
      if (!page.userMessages || !page.scan || page.source !== source) throw new Error('Input history returned no matching typed query result.')
      setState(value => {
        if (value.scope !== scope || value.read !== read || value.query !== query) return value
        return { ...value, pages: value.pages.map(old => {
          if (old.source !== source) return old
          // A refresh rechecks the head, retaining the reader's earlier observations.
          // Paging resumes from the new snapshot; retained records do not claim scan coverage.
          const messages = [...new Map([...(cursor || retain ? old.messages : []), ...page.userMessages!]
            .map(message => [message.id, message])).values()]
          return { source, messages, cursor: page.nextCursor, complete: page.scan!.complete,
            examined: (cursor ? old.examined : 0) + page.scan!.examined, loading: false, error: null }
        }) }
      })
    } catch (error) {
      if (matches()) setState(value => ({ ...value, pages: value.pages.map(page => page.source === source
        ? { ...page, loading: false, error: error instanceof Error ? error.message : String(error), retry: { ...(cursor ? { cursor } : {}), ...(retain ? { retain } : {}) } } : page) }))
    } finally { if (controllers.current.get(source) === controller) controllers.current.delete(source) }
  }, [scope, read])

  const search = useCallback((query = draftQuery) => {
    current.current.generation++
    for (const controller of controllers.current.values()) controller.abort()
    controllers.current.clear()
    setState(value => value.scope === scope && value.read === read && value.query === query
      ? { ...value, pages: value.pages.map(page => ({ ...page, loading: false, error: null })) }
      : { scope, read, query, pages: sources.map(empty) })
    if (current.current.enabled) for (const source of sources) void load(source, query)
  }, [scope, read, load, draftQuery])
  const refresh = useCallback(() => {
    const original = stateRef.current
    if (!current.current.enabled || original.scope !== scope || original.read !== read) return
    current.current.generation++
    for (const controller of controllers.current.values()) controller.abort()
    controllers.current.clear()
    for (const source of sources) void load(source, original.query, undefined, true)
  }, [scope, read, load])
  useEffect(() => {
    current.current.generation++
    if (enabled) {
      const previous = stateRef.current
      const same = previous.scope === scope && previous.read === read
      const query = same ? previous.query : ''
      if (!same) { setDraftQuery(''); setState({ scope, read, query, pages: sources.map(empty) }) }
      for (const source of sources) void load(source, query, undefined, same)
    } else setState(value => value.scope === scope && value.read === read
      ? { ...value, pages: value.pages.map(page => ({ ...page, loading: false })) }
      : { scope, read, query: '', pages: sources.map(empty) })
    return () => {
      current.current.generation++
      for (const controller of controllers.current.values()) controller.abort()
      controllers.current.clear()
    }
  }, [scope, read, enabled, load])
  const valid = state.scope === scope && state.read === read
  const pages = valid ? state.pages : sources.map(empty)
  const messages = useMemo(() => {
    const seen = new Set<string>()
    const messages = pages.flatMap(page => page.messages).filter(message => {
      if (seen.has(message.id)) return false
      seen.add(message.id); return true
    })
    // The unfiltered current view also retains original live observations. Search pages
    // stay bound to their query snapshots; neither path settles delivery records.
    if (valid && state.query === '') {
      const indices = new Map(messages.map((message, index) => [message.id, index]))
      for (const message of initialMessages) {
        const index = indices.get(message.id)
        if (index !== undefined) messages[index] = message
        else { indices.set(message.id, messages.length); messages.push(message) }
      }
    }
    messages.sort((a, b) => a.recordedAt === undefined ? b.recordedAt === undefined ? 0 : 1
      : b.recordedAt === undefined ? -1 : b.recordedAt - a.recordedAt)
    return messages
  }, [pages, valid, state.query, initialMessages])
  const loadMore = (source: InputHistorySource) => {
    const page = pages.find(page => page.source === source)
    if (!page || page.loading || (!page.error && !page.cursor)) return
    void load(source, valid ? state.query : '', page.error ? page.retry?.cursor : page.cursor ?? undefined, page.error ? page.retry?.retain : false)
  }
  return { scope, draftQuery, setDraftQuery, query: valid ? state.query : '', search, refresh, messages, pages, loadMore,
    loading: pages.some(page => page.loading) || enabled && pages.some(page => !page.complete && page.cursor === null && page.examined === 0 && page.error === null),
    complete: pages.every(page => page.complete && !page.error),
    examined: pages.reduce((total, page) => total + page.examined, 0) }
}
