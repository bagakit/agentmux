import type { AgentMuxClient } from '../../src/client.js'
import type { AgentMuxHostedClient } from '../../src/hosted-client-contract.js'
import type { AgentMuxClientEventPublisher } from '../../src/client-event-publisher.js'

// Checked by the Core typecheck lane. This function is never invoked.
export function verifySynchronousEventContract(core: AgentMuxClient, hosted: AgentMuxHostedClient,
  publisher: AgentMuxClientEventPublisher): void {
  core.onEvent(() => {})
  hosted.onEvent(() => 1)
  publisher.onStatusEvent(() => {})
  const synchronous: () => void = () => {}
  core.onEvent(synchronous)
  // @ts-expect-error Consumer async work must not become an event callback.
  core.onEvent(async () => {})
  // @ts-expect-error Hosted SDK preserves the Core callback contract.
  hosted.onEvent(async () => {})
  // @ts-expect-error Low-frequency observations have the same synchronous contract.
  publisher.onStatusEvent(() => Promise.resolve())
}
