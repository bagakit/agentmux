import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSessionHistoryReadInput, AgentSessionHistoryReadPage, AgentSessionUserMessage } from '@agentmux/core'

export type InputHistoryRead = (input: Omit<AgentSessionHistoryReadInput, 'hostId' | 'agentSessionId'>,
  signal: AbortSignal) => Promise<AgentSessionHistoryReadPage>
export type InputHistorySource = 'captured' | 'native'
type SourcePage = { source: InputHistorySource; messages: readonly AgentSessionUserMessage[]; cursor: string | null;
  complete: boolean; examined: number; loading: boolean; error: string | null; retry?: { cursor?: string } }
const sources: readonly InputHistorySource[] = ['captured', 'native']
const empty = (source: InputHistorySource): SourcePage => ({ source, messages: [], cursor: null, complete: false, examined: 0, loading: false, error: null })

/** One visible reader's temporary query window. No transcript, delivery or draft state is owned here. */
export function useAgentInputHistory({ scope, enabled, read, initialMessages = [] }: {
  scope: string; enabled: boolean; read: InputHistoryRead; initialMessages?: readonly AgentSessionUserMessage[]
}) {
  const [draftQuery, setDraftQuery] = useState('')
  const [state, setState] = useState<{ scope: string; read: InputHistoryRead; query: string; pages: readonly SourcePage[] }>(
    () => ({ scope, read, query: '', pages: sources.map(empty) }))
  const stateRef = useRef(state); stateRef.current = state
  const current = useRef({ scope, enabled, read, generation: 0 })
  const controllers = useRef(new Map<InputHistorySource, AbortController>())
  current.current.scope = scope; current.current.enabled = enabled; current.current.read = read

  const load = useCallback(async (source: InputHistorySource, query: string, cursor?: string) => {
    controllers.current.get(source)?.abort()
    const controller = new AbortController(); controllers.current.set(source, controller)
    const generation = current.current.generation
    const matches = () => !controller.signal.aborted && current.current.enabled && current.current.scope === scope &&
      current.current.read === read && current.current.generation === generation
    setState(value => ({ ...value, pages: value.pages.map(page => page.source === source ? { ...page, loading: true, error: null } : page) }))
    try {
      const input: Omit<AgentSessionHistoryReadInput, 'hostId' | 'agentSessionId'> = { source, kind: 'user-message', query,
        limit: 30, scanLimit: 200, maxBytes: 128 * 1024, ...(cursor ? { cursor } : {}) }
      let page: AgentSessionHistoryReadPage
      try { page = await read(input, controller.signal) }
      catch (error) {
        // A read-only retry follows only the owner's exact required budget and original position.
        const failure = error as { code?: unknown; detail?: unknown }
        let budget: { requiredBytes?: number; maxBytes?: number; cursor?: string } = {}
        if (failure?.code === 'AGENT_SESSION_HISTORY_BUDGET' && typeof failure.detail === 'string') {
          try { budget = JSON.parse(failure.detail) } catch { /* Original error remains visible. */ }
        }
        if (!matches() || !Number.isSafeInteger(budget.requiredBytes) || !Number.isSafeInteger(budget.maxBytes) ||
          budget.requiredBytes! <= input.maxBytes! || budget.requiredBytes! > budget.maxBytes! ||
          typeof budget.cursor !== 'string' || !budget.cursor) throw error
        page = await read({ ...input, cursor: budget.cursor, maxBytes: budget.requiredBytes! }, controller.signal)
      }
      if (!matches()) return
      if (!page.userMessages || !page.scan || page.source !== source) throw new Error('Input history returned no matching typed query result.')
      setState(value => {
        if (value.scope !== scope || value.read !== read || value.query !== query) return value
        return { ...value, pages: value.pages.map(old => {
          if (old.source !== source) return old
          const messages = cursor ? [...old.messages] : []
          const ids = new Set(messages.map(message => message.id))
          for (const message of page.userMessages!) if (!ids.has(message.id)) { ids.add(message.id); messages.push(message) }
          return { source, messages, cursor: page.nextCursor, complete: page.scan!.complete,
            examined: (cursor ? old.examined : 0) + page.scan!.examined, loading: false, error: null }
        }) }
      })
    } catch (error) {
      if (matches()) setState(value => ({ ...value, pages: value.pages.map(page => page.source === source
        ? { ...page, loading: false, error: error instanceof Error ? error.message : String(error), retry: cursor ? { cursor } : {} } : page) }))
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
  useEffect(() => {
    current.current.generation++
    if (enabled) {
      const previous = stateRef.current
      const same = previous.scope === scope && previous.read === read
      const query = same ? previous.query : ''
      if (!same) { setDraftQuery(''); setState({ scope, read, query, pages: sources.map(empty) }) }
      for (const source of sources) void load(source, query)
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
  const loadMore = (source: InputHistorySource) => {
    const page = pages.find(page => page.source === source)
    if (!page || page.loading || (!page.error && !page.cursor)) return
    void load(source, valid ? state.query : '', page.error ? page.retry?.cursor : page.cursor ?? undefined)
  }
  return { scope, draftQuery, setDraftQuery, query: valid ? state.query : '', search, messages, pages, loadMore,
    loading: pages.some(page => page.loading), complete: pages.every(page => page.complete && !page.error),
    examined: pages.reduce((total, page) => total + page.examined, 0) }
}
