import type { AgentExecutionProtocol } from './protocol.js'

type Plan = NonNullable<ReturnType<NonNullable<AgentExecutionProtocol['restoreConnection']>>>

/** One private handshake on a newly spawned native transport. The identical
 * request ID on that transport never enters the original client's journal. */
export function nativeConnectionRecovery(plan: Plan) {
  let resolve!: (accepted: boolean) => void
  const response = new Promise<boolean>(settle => { resolve = settle })
  let end!: () => void
  const cancelled = new Promise<false>(settle => { end = () => settle(false) })
  let stopped = false
  const cancel = () => { stopped = true; resolve(false); end() }
  return {
    receive(requestId: string | number, payload: unknown): boolean {
      if (requestId !== plan.requestId) return false
      resolve(plan.accepts(payload))
      return true
    },
    cancel,
    async negotiate(send: (frame: unknown) => Promise<void>): Promise<boolean> {
      // This bounds only one optional private handshake. Later requests can
      // retry on the original socket; a slow handshake cannot retire the Agent.
      const deadline = setTimeout(cancel, 20_000)
      deadline.unref()
      const initialize = async () => {
        await send(plan.request)
        if (stopped || !await response || stopped) return false
        await send(plan.initialized)
        return !stopped
      }
      try {
        return await Promise.race([initialize(), cancelled])
      } catch { return false }
      finally { clearTimeout(deadline) }
    },
  }
}
