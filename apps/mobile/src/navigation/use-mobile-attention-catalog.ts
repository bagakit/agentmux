import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { MobileAgentPresentation } from './mobile-agent-status'
import { mobileNeedsYou, type MobileNeedsYouItem } from './needs-you'

const INTERVAL_MS = 15_000
const EMPTY_ITEMS: readonly MobileNeedsYouItem[] = []
type Observation = { client: AgentMuxHostedClient | null; items: readonly MobileNeedsYouItem[]; confirmed: boolean; issue: string | null }
const sameItems = (left: readonly MobileNeedsYouItem[], right: readonly MobileNeedsYouItem[]) => left.length === right.length &&
  left.every((item, index) => item.agentSessionId === right[index]!.agentSessionId && item.reason === right[index]!.reason)

/**
 * Only the shell's typed needs-you membership is retained here; directory rows stay with their owner.
 * Every visible directory publishes its root catalog and pauses this reader. Otherwise one bounded
 * read runs on entry, foreground and interval, independent of Session events. Failure retains the
 * last membership as unconfirmed, with the original cause and a read-only recovery action.
 */
export function useMobileAttentionCatalog(client: AgentMuxHostedClient | null, active: boolean, paused: boolean) {
  const [state, setState] = useState<Observation>({ client: null, items: EMPTY_ITEMS, confirmed: false, issue: null })
  const [revision, setRevision] = useState(0)
  const owner = useRef(client); owner.current = client
  const publish = useCallback((source: AgentMuxHostedClient | null, rows: readonly MobileAgentPresentation[] | undefined, issue: string | null = null) => {
    if (source !== owner.current || rows === undefined && issue === null) return
    const items = rows === undefined ? undefined : mobileNeedsYou(rows)
    setState(previous => {
      const retained = previous.client === source ? previous.items : EMPTY_ITEMS
      const nextItems = items === undefined || sameItems(retained, items) ? retained : items
      const confirmed = rows !== undefined && issue === null
      if (previous.client === source && previous.items === nextItems && previous.confirmed === confirmed && previous.issue === issue) return previous
      return { client: source, items: nextItems, confirmed, issue }
    })
  }, [])
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  useEffect(() => {
    if (!active) {
      setState(previous => previous.client === client && previous.confirmed ? { ...previous, confirmed: false } : previous)
      return
    }
    if (!client || paused) return
    if (!client.forwardRpc) {
      publish(client, undefined, '暂时无法读取需要你列表，可以重新连接；已有对话仍可使用。')
      return
    }
    let disposed = false, inFlight = false, request: AbortController | undefined
    const read = async () => {
      if (disposed || inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      const controller = new AbortController(); request = controller
      try {
        const { catalog } = await client.forwardRpc!('space.ls', { target: {}, presentation: 'status' }, { signal: controller.signal })
        if (!disposed && owner.current === client) {
          if (catalog.agentPresentation === undefined) publish(client, undefined, '需要你列表暂时没有返回，可重新读取；已有对话仍可使用。')
          else publish(client, catalog.agentPresentation)
        }
      } catch (error) {
        if (!disposed) publish(client, undefined, error instanceof Error ? error.message : String(error))
      } finally { inFlight = false; if (request === controller) request = undefined }
    }
    const foreground = () => { if (document.visibilityState === 'visible') void read() }
    const interval = setInterval(() => { void read() }, INTERVAL_MS)
    document.addEventListener('visibilitychange', foreground)
    void read()
    return () => { disposed = true; request?.abort(); clearInterval(interval); document.removeEventListener('visibilitychange', foreground) }
  }, [client, active, paused, publish, revision])
  const current = state.client === client
  return { items: current ? state.items : EMPTY_ITEMS, unconfirmed: !active || !current || !state.confirmed,
    issue: current ? state.issue : null, publish, refresh }
}
