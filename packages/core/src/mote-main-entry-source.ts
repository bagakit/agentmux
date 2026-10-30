import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseMoteDefaultConversation, parseMotePreferencesTarget, type MoteDefaultConversation, type MotePreferencesTarget } from './mote-preferences.js'

/** Frozen admission on the original continuity operation, never a second current-role store. */
export type MoteMainEntrySource = {
  target: MotePreferencesTarget
  expectedRoleRevision: string
  reference: MoteDefaultConversation
}

export function parseMoteMainEntrySource(value: unknown, code: 'INVALID_CONTROL_REQUEST' | 'CONTROL_PROTOCOL_ERROR' = 'INVALID_CONTROL_REQUEST'): MoteMainEntrySource {
  const p = rpcRecord(value, ['target', 'expectedRoleRevision', 'reference'], code)
  if (typeof p.expectedRoleRevision !== 'string' || !p.expectedRoleRevision.trim() || /[\0\r\n]/u.test(p.expectedRoleRevision))
    throw new AgentMuxError('The original Mote main role revision is required.', code)
  return { target: parseMotePreferencesTarget(p.target, code), expectedRoleRevision: p.expectedRoleRevision,
    reference: parseMoteDefaultConversation(p.reference, code) }
}
