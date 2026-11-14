import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { parseNodePublishingResult } from '@agentmux/core/node-publishing'

let connected: AgentMuxHostedClient | null
const readers = new Map<string, AbortController>()

/** Only the current authenticated device workface can supply map facts. */
export function bindDesktopNodeLocation(client: AgentMuxHostedClient | null) {
  if (client === connected) return
  for (const reader of readers.values()) reader.abort()
  connected = client
}

Object.assign(window, {
  async readOriginalNodeLocation(token: string) {
    const client = connected
    if (!client?.forwardRpc) return null
    const controller = new AbortController()
    readers.set(token, controller)
    try {
      const input = { hostId: 'local' }, signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
      const result = await client.forwardRpc('node.location', input, { signal })
      signal.throwIfAborted()
      return parseNodePublishingResult('node.location', result, input)
    } finally { readers.delete(token) }
  },
  cancelNodeLocationRead(token: string) { readers.get(token)?.abort() },
})
