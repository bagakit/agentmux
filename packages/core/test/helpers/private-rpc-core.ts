import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import { DurableAgentMuxMessageQueue } from '../../src/agent-global-message-queue.js'
import { AgentMuxError } from '../../src/errors.js'

/** Borrow the real persisted Session/message owner without a Native connection or Agent process. */
export async function privateRpcCorePort(storePath: string, queuePath: string) {
  const store = new AgentMuxFileAgentSessionStore(storePath)
  const client = new AgentMuxClient({ store })
  const inner = client as unknown as {
    connected: boolean; kernel: { isConnected(): boolean; status(runId: string): Promise<never> }
    registry: { load(hostId: string): Promise<void> }; messageQueue: DurableAgentMuxMessageQueue
  }
  inner.connected = true
  inner.kernel.isConnected = () => true
  inner.kernel.status = async () => { throw new AgentMuxError('This isolated persisted-facts fixture has no Native status owner.', 'STATUS_UNAVAILABLE') }
  inner.messageQueue = new DurableAgentMuxMessageQueue(queuePath)
  await inner.registry.load('local')
  return {
    client,
    // This fixture models an authoritative Host port reading its own durable facts.
    // Native/Run/TTY behavior is covered separately by the existing real process fixtures.
    async clients() { await inner.registry.load('local'); return [{ hostId: 'local', client }] },
    async dispose() { await client.dispose() }
  }
}
