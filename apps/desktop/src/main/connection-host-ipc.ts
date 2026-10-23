import { AgentMuxError } from '@agentmux/core'
import type { ConnectionHostingTarget } from '../shared/contracts.js'
import { readConnectionHostingTarget } from '../shared/connection-hosting-target.js'
import type { RuntimeController } from './runtime-controller.js'

export type ConnectionHostIpc = Pick<RuntimeController, 'connectionHostingTarget' | 'callConnectionHost' | 'watchConnectionMetadata'>

/** Only a new/default reading may discover a route; retained operations pass their original target. */
export async function connectionHostTarget(runtime: Pick<ConnectionHostIpc, 'connectionHostingTarget'>, value?: ConnectionHostingTarget) {
  if (value === undefined) return await runtime.connectionHostingTarget()
  const target = readConnectionHostingTarget(value)
  if (!target) throw new AgentMuxError('The original connector hosting target is unconfirmed.', 'RUNTIME_OWNER_MISMATCH')
  return target
}
