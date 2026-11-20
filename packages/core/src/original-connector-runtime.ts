import type { AgentMuxHostedClient, AgentMuxHostedForwardRpc } from './hosted-client-contract.js'

type ConnectorRuntimeClient = {
  hostId: string
  client: Partial<Pick<AgentMuxHostedClient, 'runtimeOwnerIdentity' | 'forwardRpc'>>
}

/** Select an existing confirmed Host connection and fence calls to its actual connector owner. */
export async function originalConnectorRuntime(
  clients: () => readonly ConnectorRuntimeClient[] | Promise<readonly ConnectorRuntimeClient[]>,
  runtimeId: string, unavailable: () => Error, signal?: AbortSignal
): Promise<{ call: AgentMuxHostedForwardRpc; assertCurrent(): Promise<void> }> {
  const matches = (await clients()).filter(entry => entry.client.runtimeOwnerIdentity?.()?.runtimeId === runtimeId)
  if (matches.length !== 1 || !matches[0]!.client.forwardRpc) throw unavailable()
  const { hostId, client } = matches[0]!
  const assertCurrent = async () => {
    signal?.throwIfAborted()
    const current = (await clients()).filter(item => item.hostId === hostId)
    if (current.length !== 1 || current[0]!.client !== client || client.runtimeOwnerIdentity?.()?.runtimeId !== runtimeId) throw unavailable()
  }
  await assertCurrent()
  const observation = signal ? { signal } : {}
  const { owner } = await client.forwardRpc!('runtime.owner.identity', { expectedRuntimeId: runtimeId }, observation)
  if (owner.runtimeId !== runtimeId) throw unavailable()
  const fence = { runtimeId, ownerInstanceId: owner.ownerInstanceId }
  if ((await client.forwardRpc!('connection.owner.inspect', {}, observation, fence)).ownership !== 'local') throw unavailable()
  await assertCurrent()
  const call: AgentMuxHostedForwardRpc = async (method, input, context) => {
    await assertCurrent()
    return await client.forwardRpc!(method, input, context ?? observation, fence)
  }
  return { call, assertCurrent }
}
