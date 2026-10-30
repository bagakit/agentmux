import { dequal } from 'dequal'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseMoteDefaultConversation, parseMotePreferencesTarget, sameMotePreferencesTarget, type MoteDefaultConversation, type MotePreferencesTarget } from './mote-preferences.js'
import type { AgentMuxContinuityOperation } from './agent-session-recovery/continuity-contract.js'

/** Frozen admission on the original continuity operation, never a second current-role store. */
export type MoteMainEntrySource = {
  target: MotePreferencesTarget
  expectedRoleRevision: string
  reference: MoteDefaultConversation
}

/** Original in-flight/unknown receipts are observations, never another Start. */
export function unconfirmedMoteMainEntryOperation(operation: AgentMuxContinuityOperation | null | undefined): boolean {
  return Boolean(operation && (operation.kind === 'starting' ||
    ['runtime-unverified', 'provider-unverified', 'operation-unconfirmed', 'original-operation-unconfirmed'].includes(operation.reason)))
}

/** Discovery retains the original role generation, within the exact Mote and full reference. */
export function sameMoteMainEntrySource(original: MoteMainEntrySource | null | undefined, query: MoteMainEntrySource): boolean {
  return Boolean(original && sameMotePreferencesTarget(original.target, query.target) && dequal(original.reference, query.reference))
}

export function parseMoteMainEntrySource(value: unknown, code: 'INVALID_CONTROL_REQUEST' | 'CONTROL_PROTOCOL_ERROR' = 'INVALID_CONTROL_REQUEST'): MoteMainEntrySource {
  const p = rpcRecord(value, ['target', 'expectedRoleRevision', 'reference'], code)
  if (typeof p.expectedRoleRevision !== 'string' || !p.expectedRoleRevision.trim() || /[\0\r\n]/u.test(p.expectedRoleRevision))
    throw new AgentMuxError('The original Mote main role revision is required.', code)
  return { target: parseMotePreferencesTarget(p.target, code), expectedRoleRevision: p.expectedRoleRevision,
    reference: parseMoteDefaultConversation(p.reference, code) }
}
