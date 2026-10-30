import type { FileDocument } from '@agentmux/core'
import type { FileReadResult } from '@agentmux/core/files'
import { parseMotePreferencesReadResult, parseMotePreferencesSaveResult, type MoteQuickBaseline, type MoteQuickPreferencesSaveParams, type MotePresenceReading } from '@agentmux/core/mote-preferences'
import type { MoteQuickDefaults } from '../../../shared/mote-quick-mode'
import type { MoteWorkfaceScope } from './mote-workface'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { confirmedMoteReference, emptyMoteDestination, type FileDestination } from './mote-materials-actions'
import { useAppStore } from '../store'
import { documentKey } from './workbench-tabs'
import { moteConnectionTarget } from './mote-connection-default'
import { api } from './api'

export type SavedMoteQuickMode = { document: FileDocument | null; defaults: MoteQuickDefaults; issue?: string; source?: FileReadResult; pending?: MoteQuickPreferencesSaveParams; maintenance?: MotePresenceReading }
export async function readMoteQuickDefaults(scope: MoteWorkfaceScope): Promise<SavedMoteQuickMode> {
  const target = moteConnectionTarget(scope, useAppStore.getState().spaceZoneBindings)
  if (!target) return { document: null, defaults: {}, issue: 'The original Mote resource is unconfirmed. Its settings and conversations remain available.' }
  const input = { kind: 'quick' as const, target }, result = parseMotePreferencesReadResult(await api.motePreferences.read(input), input)
  return { document: result.source?.result.status === 'read' ? result.source.result.document : null, defaults: result.defaults ?? {}, ...(result.source ? { source: result.source } : {}), ...(result.issue ? { issue: result.issue } : {}), ...(result.maintenance ? { maintenance: result.maintenance } : {}) }
}
export type MoteQuickWrite = { status: 'saved' | 'unchanged'; source: MoteQuickBaseline }
export class MoteQuickSaveError extends Error {
  constructor(cause: unknown, readonly writeStarted: boolean, readonly confirmed: MoteQuickWrite | null) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}
/** Client draft/navigation checks precede one original Host CAS writer. No YAML is written here. */
export async function saveMoteQuickDefaults(scope: MoteWorkfaceScope, defaults: MoteQuickDefaults, saved: SavedMoteQuickMode,
  _open: (path: string) => Promise<unknown>, stillCurrent: () => boolean, reference?: WorkbenchProjectionSelection | null, destination?: FileDestination): Promise<MoteQuickWrite> {
  let dispatched = false, confirmed: MoteQuickWrite | null = null
  try {
    const state = useAppStore.getState(), target = moteConnectionTarget(scope, state.spaceZoneBindings)
    if (!target || saved.issue || !saved.source?.resource || !stillCurrent()) throw new Error(saved.issue ?? 'The original settings source changed. Keep your draft and reread it.')
    const path = scope.rootPath + '/MOTE.md', key = documentKey(scope.workspace.id, path)
    if (state.dirtyDocuments[key] || state.documentIssues[key]) throw new Error('The original settings Editor has an unsaved or unconfirmed draft. It is kept; review it before saving.')
    const occurrence = destination ? null : confirmedMoteReference(state, scope, { reference })
    const empty = destination ?? (occurrence ? null : emptyMoteDestination(state, scope, { reference }))
    const chosen = occurrence ? { kind: 'occurrence' as const, ...occurrence } : empty ? { kind: 'empty' as const, ...empty } : null
    if (!chosen) throw new Error('The original Mote display is unconfirmed. Your draft and existing work are kept.')
    const baseline = { resource: saved.source.resource, document: saved.document, defaults: saved.defaults }
    const pending = saved.pending
    if (pending && JSON.stringify(pending.values) !== JSON.stringify(defaults)) throw new Error('The previous save has an unknown result. Retain that original request and inspect it before saving different settings.')
    const input: MoteQuickPreferencesSaveParams = pending ?? { kind: 'quick', target, baseline, values: structuredClone(defaults), destination: chosen, operationId: crypto.randomUUID() }
    saved.pending = input
    dispatched = true
    const result = parseMotePreferencesSaveResult(await api.motePreferences.save(input), input)
    if ((result.status !== 'saved' && result.status !== 'unchanged') || !result.source) {
      if (result.status === 'refused-before-write') delete saved.pending
      throw new Error(result.message ?? 'The original save is unconfirmed. Keep this request; do not replay or overwrite it.')
    }
    confirmed = { status: result.status, source: result.source }
    delete saved.pending
    // Saved settings do not select/open a document or change a later workface.
    await useAppStore.getState().refreshScratchTopics(scope.workspace.id, true, scope.topic.id)
    if (result.message) throw new Error(result.message)
    return confirmed
  } catch (cause) { throw new MoteQuickSaveError(cause, dispatched, confirmed) }
}
