import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core/control'
import { parseMotePreferencesReadResult, parseMotePreferencesSaveResult, type MoteQuickPreferencesReadInput, type MoteQuickPreferencesReadResult } from '@agentmux/core/mote-preferences'
import { api } from './api'

/** The Desktop business bridge is a client of the same Host preferences owner. */
export async function readMotePreferences(input: MoteQuickPreferencesReadInput): Promise<MoteQuickPreferencesReadResult> {
  return parseMotePreferencesReadResult(await api.motePreferences.read(input), input)
}
export async function executeMotePreferencesControl(request: Extract<AgentMuxControlRequest, { operation: 'space.mote.preferences.read' | 'space.mote.preferences.save' }>, signal?: AbortSignal): Promise<AgentMuxControlResult> {
  signal?.throwIfAborted()
  if (request.operation === 'space.mote.preferences.read') {
    const input = { kind: request.kind, target: request.target }
    return { operation: request.operation, ...parseMotePreferencesReadResult(await api.motePreferences.read(input), input) }
  }
  const { operation, requestId, schemaVersion: _schema, ...input } = request
  const params = { ...input, operationId: requestId }
  const { operationId: _id, ...result } = parseMotePreferencesSaveResult(await api.motePreferences.save(params), params)
  return { operation, requestId, ...result }
}
