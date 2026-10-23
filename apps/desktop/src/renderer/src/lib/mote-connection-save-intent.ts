import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { readConnectionHostingTarget } from '../../../shared/connection-hosting-target'
import { parseMotePreferencesSaveParams, type MoteConnectionPreferencesSaveParams } from '@agentmux/core/mote-preferences'

/** Submitted client input only; the original Files owner holds the preference and save result. */
export type MoteConnectionSaveIntent = {
  input: MoteConnectionPreferencesSaveParams
  hostingTarget?: ConnectionHostingTarget
  phase: 'not-dispatched' | 'may-have-dispatched'
}

export function restoredMoteConnectionSaveIntents(value: unknown): Record<string, MoteConnectionSaveIntent> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, MoteConnectionSaveIntent> = {}
  for (const [key, raw] of Object.entries(value)) {
    try {
      const entry = raw as MoteConnectionSaveIntent, input = parseMotePreferencesSaveParams(entry.input)
      if (input.kind !== 'connection' || key !== input.operationId) continue
      // Missing client phase never proves that the original request was not sent.
      const hostingTarget = readConnectionHostingTarget(entry.hostingTarget)
      result[key] = { input, ...(hostingTarget ? { hostingTarget } : {}), phase: entry.phase === 'not-dispatched' ? 'not-dispatched' : 'may-have-dispatched' }
    } catch { /* Invalid correlation cannot change the original file or dispatch a save. */ }
  }
  return result
}
