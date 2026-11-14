import type { FileDocument } from '@agentmux/core'
import type { FileReadResult } from '@agentmux/core/files'
import { parseMotePreferencesReadResult, parseMotePreferencesSaveResult, sameMoteDefaultConversation, type MoteQuickBaseline, type MoteQuickChoices, type MoteQuickPreferencesReadInput, type MoteQuickPreferencesSaveParams, type MotePresenceReading, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { scratchTopicLogicalPath, type MoteQuickDefaults } from '@agentmux/host/mote-model'
import type { MoteWorkfaceScope } from './mote-workface'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { confirmedMoteReference, emptyMoteDestination, type FileDestination } from './mote-materials-actions'
import { useAppStore } from '../store'
import { documentKey } from './workbench-tabs'
import { moteConnectionTarget } from './mote-connection-default'
import { api } from './api'
import { moteMainRoleRevision } from '@agentmux/core/mote-dialogue'
import type { MoteHeartbeatReports } from './mote-heartbeat-report'

export type SavedMoteQuickMode = { document: FileDocument | null; defaults: MoteQuickDefaults; choices?: MoteQuickChoices; issue?: string; source?: FileReadResult; pending?: MoteQuickPreferencesSaveParams; maintenance?: MotePresenceReading; reports?: MoteHeartbeatReports }
export async function readMoteQuickDefaults(scope: MoteWorkfaceScope, includeChoices: MoteQuickPreferencesReadInput['includeChoices'] = true): Promise<SavedMoteQuickMode> {
  const target = moteConnectionTarget(scope, useAppStore.getState().spaceZoneBindings)
  if (!target) return { document: null, defaults: {}, issue: 'The original Mote resource is unconfirmed. Its settings and conversations remain available.' }
  return readMoteQuickTarget(target, includeChoices)
}
export async function readMoteQuickTarget(target: MotePreferencesTarget, includeChoices: MoteQuickPreferencesReadInput['includeChoices'] = true): Promise<SavedMoteQuickMode> {
  const input = { kind: 'quick' as const, target, includeChoices }, result = parseMotePreferencesReadResult(await api.motePreferences.read(input), input)
  return { document: result.source?.result.status === 'read' ? result.source.result.document : null, defaults: result.defaults ?? {}, ...(result.choices ? { choices: result.choices } : {}), ...(result.source ? { source: result.source } : {}), ...(result.issue ? { issue: result.issue } : {}), ...(result.maintenance ? { maintenance: result.maintenance } : {}) }
}
export type MoteQuickWrite = { status: 'saved' | 'unchanged'; source: MoteQuickBaseline }
export class MoteQuickSaveError extends Error {
  constructor(cause: unknown, readonly writeStarted: boolean, readonly confirmed: MoteQuickWrite | null) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
  }
}
/** Client draft/navigation checks precede one original Host CAS writer. No YAML is written here. */
export async function saveMoteQuickDefaults(scope: MoteWorkfaceScope, defaults: MoteQuickDefaults, saved: SavedMoteQuickMode,
  _open: (path: string) => Promise<unknown>, stillCurrent: () => boolean, reference?: WorkbenchProjectionSelection | null, destination?: FileDestination,
  retain?: (input: MoteQuickPreferencesSaveParams) => Promise<void>): Promise<MoteQuickWrite> {
  let dispatched = false, confirmed: MoteQuickWrite | null = null
  try {
    const state = useAppStore.getState(), target = moteConnectionTarget(scope, state.spaceZoneBindings)
    const workspace = state.config?.workspaces.find(value => value.id === scope.workspace.id)
    if (workspace?.hostId !== scope.workspace.hostId || workspace.path !== scope.workspace.path || scratchTopicLogicalPath(scope.workspace, scope.topic) !== scope.rootPath) throw new Error('The original settings source changed. Keep your draft and reread it.')
    if (!target || saved.issue || !saved.source?.resource || !stillCurrent()) throw new Error(saved.issue ?? 'The original settings source changed. Keep your draft and reread it.')
    const path = scope.rootPath + '/MOTE.md', key = documentKey(scope.workspace.id, path)
    if (state.dirtyDocuments[key] || state.documentIssues[key]) throw new Error('The original settings Editor has an unsaved or unconfirmed draft. It is kept; review it before saving.')
    const pending = saved.pending
    const sameMain = sameMoteDefaultConversation(saved.defaults.conversation, defaults.conversation)
    const occurrence = sameMain || pending || destination ? null : confirmedMoteReference(state, scope, { reference })
    const empty = sameMain || pending ? null : destination ?? (occurrence ? null : emptyMoteDestination(state, scope, { reference }))
    const chosen = occurrence ? { kind: 'occurrence' as const, ...occurrence } : empty ? { kind: 'empty' as const, ...empty } : null
    if (!sameMain && !pending && !chosen) throw new Error('The original Mote display is unconfirmed. Your draft and existing work are kept.')
    const baseline = { resource: saved.source.resource, document: saved.document, defaults: saved.defaults }
    if (pending && JSON.stringify(pending.values) !== JSON.stringify(defaults)) throw new Error('The previous save has an unknown result. Retain that original request and inspect it before saving different settings.')
    const input: MoteQuickPreferencesSaveParams = pending ?? { kind: 'quick', target, baseline, values: structuredClone(defaults), ...(chosen ? { destination: chosen } : {}), operationId: crypto.randomUUID() }
    saved.pending = input
    await retain?.(input)
    if (!stillCurrent()) throw new Error('Your later selection is kept. The original request is retained and was not sent.')
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

/** A person explicitly adopts one fresh published guide for unclaimed future inputs. */
export async function adoptMoteHeartbeatGuidance(scope: MoteWorkfaceScope, saved: SavedMoteQuickMode, stillCurrent: () => boolean,
  retain: (input: MoteQuickPreferencesSaveParams) => Promise<void>) {
  let input = saved.pending
  if (input && input.action?.kind !== 'adopt-current-guidance') throw new Error('Inspect the retained original settings save before adopting guidance.')
  if (!input) {
    const current = await readMoteQuickDefaults(scope, false), schedule = current.maintenance?.schedule, guidance = current.maintenance?.guidance
    const main = current.defaults.conversation, resource = current.source?.resource
    if (current.issue || !schedule?.revision || !guidance?.currentDefinition || !main || !resource ||
      schedule.hostId !== main.hostId || schedule.agentSessionId !== main.sessionId ||
      schedule.managedSource?.revision !== moteMainRoleRevision(current.defaults, current.document?.revision ?? null)) throw new Error('Read this Mote’s current Main and original guidance before adopting. Your settings are kept.')
    input = { kind: 'quick', target: moteConnectionTarget(scope, useAppStore.getState().spaceZoneBindings)!, baseline: { resource, document: current.document, defaults: current.defaults },
      values: structuredClone(current.defaults), operationId: crypto.randomUUID(), action: { kind: 'adopt-current-guidance',
        expectedSchedule: { loopId: schedule.loopId, revision: schedule.revision }, expectedMain: { roleRevision: moteMainRoleRevision(current.defaults, current.document?.revision ?? null), reference: main },
        expectedDefinition: { intentId: guidance.currentDefinition.intentId, operationId: guidance.currentDefinition.operationId }, guidanceRevision: guidance.availableRevision } }
    saved.pending = input
  }
  await retain(input)
  if (!stillCurrent()) throw new Error('Your later selection is kept. The original adoption request remains retained.')
  const result = parseMotePreferencesSaveResult(await api.motePreferences.save(input), input)
  if (result.status === 'refused-before-write') delete saved.pending
  if (result.status !== 'unchanged' || !result.maintenanceAdoption || result.maintenanceAdoption.state !== 'adopted') throw new Error(result.message ?? 'The original guidance adoption remains unconfirmed. Check this same request again.')
  delete saved.pending
  return result
}
