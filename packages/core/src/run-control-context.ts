import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'

export type RunControlActor = { kind: 'user' | 'device'; id: string }
/** Original Host context; never business JSON or a delegated Agent claim. */
export type RunControlContext = { actor: RunControlActor; requestSignal?: AbortSignal; assertCurrent?(): void | Promise<void> }
export function parseRunControlActor(value: unknown): RunControlActor {
  const p = rpcRecord(value, ['kind', 'id'])
  if (p.kind !== 'user' && p.kind !== 'device') throw new AgentMuxError('This native intent requires its original person/device context.', 'CONTROL_PERMISSION_DENIED')
  return { kind: p.kind, id: rpcString(p.id, 'Original native intent actor') }
}
