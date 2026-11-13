import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { MobileAgentPresentation } from './mobile-agent-status'

const INTERVAL_MS = 15_000

/**
 * The shell's read of the original Focus presentation rows, for needs-you counts only.
 *
 * While the Focus directory is visible it already reads the same catalog; it publishes here and this
 * reader pauses, so the shell never doubles that read. Otherwise one bounded read runs on entry, on
 * return to the foreground and on a fixed interval, independent of how many Sessions change. A failed
 * read keeps the last confirmed rows; nothing here starts, recovers or answers an Agent.
 */
export function useMobileAttentionCatalog(client: AgentMuxHostedClient | null, active: boolean, paused: boolean) {
  const [state, setState] = useState<{ client: AgentMuxHostedClient | null; rows: MobileAgentPresentation[] | undefined }>({ client: null, rows: undefined })
  const owner = useRef(client); owner.current = client
  const publish = useCallback((source: AgentMuxHostedClient | null, rows: readonly MobileAgentPresentation[] | undefined) => {
    if (source !== owner.current || rows === undefined) return
    setState({ client: source, rows: [...rows] })
  }, [])
  useEffect(() => {
    if (!client?.forwardRpc || !active || paused) return
    let disposed = false, inFlight = false
    const read = async () => {
      if (inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      try {
        const { catalog } = await client.forwardRpc!('space.ls', { target: {}, presentation: true })
        if (!disposed && owner.current === client && catalog.agentPresentation) setState({ client, rows: catalog.agentPresentation })
      } catch { /* The last confirmed rows remain; the directory that owns the read reports its failure. */ }
      finally { inFlight = false }
    }
    const foreground = () => { if (document.visibilityState === 'visible') void read() }
    const interval = setInterval(() => { void read() }, INTERVAL_MS)
    document.addEventListener('visibilitychange', foreground)
    void read()
    return () => { disposed = true; clearInterval(interval); document.removeEventListener('visibilitychange', foreground) }
  }, [client, active, paused])
  return { rows: state.client === client ? state.rows : undefined, publish }
}
