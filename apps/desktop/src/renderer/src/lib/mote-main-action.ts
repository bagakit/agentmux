import { moteQuickBaseline, parseMotePreferencesReadResult,
  type MoteDefaultConversation, type MoteQuickPreferencesReadResult } from '@agentmux/core/mote-preferences'
import { moteMainBaseline, pendingMoteMainCreation, spatialAgentOpenRecord } from '@agentmux/core/spatial-graph'
import { pendingMoteMainStarts, type MoteDialoguePage, type MoteMainSetupResult, type MoteMainDeferredInput, type MoteMainRolloverDecision } from '@agentmux/core/mote-dialogue'
import type { MoteWorkfaceScope } from './mote-workface'
import { moteConnectionTarget } from './mote-connection-default'
import { api } from './api'
import { useAppStore, retainMoteMainCreationReference } from '../store'
import { documentKey } from './workbench-tabs'

export type MoteMainActionReading = { preferences: MoteQuickPreferencesReadResult; dialogue: MoteDialoguePage;
  operationId: string | null; pendingOperationId: string | null; pendingStarts: string[]; executor: { id: string; name: string } | null; issue: string | null }
export type MoteMainActionResult = { operationId: string; reference: MoteDefaultConversation | null;
  creation: 'confirmed' | 'unconfirmed'; source: 'confirmed' | 'not-needed' | 'unconfirmed';
  binding: 'confirmed' | 'refused' | 'unconfirmed'; issue: string | null } & Partial<Pick<MoteMainSetupResult, 'record' | 'deferredInput' | 'handoverInput'>>
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
async function actionId(read: MoteQuickPreferencesReadResult): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([read.target, read.source?.result.status === 'read' ? read.source.result.document.revision : null, read.defaults?.executorId]))
  return 'mote-main:' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('')
}
function targetOf(scope: MoteWorkfaceScope) {
  const target = moteConnectionTarget(scope, useAppStore.getState().spaceZoneBindings)
  if (!target) throw new Error('The original Mote resource is unconfirmed. Existing Agents are kept; reread this Mote.')
  return target
}
export async function readMoteMainAction(scope: MoteWorkfaceScope): Promise<MoteMainActionReading> {
  const target = targetOf(scope), input = { kind: 'quick' as const, target }
  const [raw, dialogue, spatial] = await Promise.all([api.motePreferences.read(input), api.moteDialogue.read({ target, kind: 'main' }), api.spatial.read()])
  const preferences = parseMotePreferencesReadResult(raw, input), baseline = moteQuickBaseline(preferences)
  const configured = preferences.defaults?.executorId
  const executor = preferences.choices.executors.find(item => item.id === configured) ?? null
  const issue = preferences.status !== 'ready' || !baseline || preferences.issue ? preferences.issue ?? 'Mote 的设置暂未确认，写下的想法会保留。可以重新核对。'
    : dialogue.main.status !== 'ready' || dialogue.main.documentRevision !== (baseline.document?.revision ?? null) || !same(dialogue.main.current, baseline.defaults.conversation ?? null)
      ? '主对话的来源尚未核对一致，原对话和草稿仍保留。可以重新核对。'
      : !configured ? '先在设置中选择此 Mote 的默认执行器，就能开始对话。'
        : !executor ? '已保存的执行器暂未在原 Host 中确认，可以检查设置或重新核对。' : null
  const pendingStarts = spatial ? pendingMoteMainStarts(spatial.graph, target).map(item => item.requestId) : []
  return { preferences, dialogue, pendingStarts, pendingOperationId: spatial ? pendingMoteMainCreation(spatial.graph, target)?.requestId ?? null : null, operationId: baseline && configured ? await actionId(preferences) : null, executor, issue }
}

function refuseDirty(scope: MoteWorkfaceScope) {
  const state = useAppStore.getState(), key = documentKey(scope.workspace.id, scope.rootPath + '/MOTE.md')
  if (state.dirtyDocuments[key] || state.documentIssues[key]) throw new Error('MOTE.md has an unsaved or unconfirmed Editor draft. Keep it and review before changing Main.')
}
/** Explicit action only. Default creation is admitted once by the original Core spatial owner. */
export async function createMoteMain(scope: MoteWorkfaceScope, reading: MoteMainActionReading, query?: MoteMainDeferredInput, rollover?: MoteMainRolloverDecision): Promise<MoteMainActionResult> {
  if (reading.issue || !reading.operationId || !reading.executor) throw new Error(reading.issue ?? 'Choose the original configured default Executor first.')
  if (!same(targetOf(scope), reading.preferences.target)) throw new Error('This action belongs to another original Mote resource. Its conversations are kept.')
  refuseDirty(scope)
  const operationId = rollover?.creationOperationId ?? reading.operationId, target = reading.preferences.target, baseline = moteQuickBaseline(reading.preferences)!
  const currentSpatial = await api.spatial.read()
  const pending = currentSpatial ? pendingMoteMainCreation(currentSpatial.graph, target) : null
  if (pending) return await inspectMoteMainAction(scope, pending.requestId)
  const key = JSON.stringify(target), prior = useAppStore.getState().moteMainCreationReferences[key]
  if (prior) {
    const inspected = await inspectMoteMainAction(scope, prior.operationId)
    if (prior.operationId === operationId || inspected.binding === 'unconfirmed') return inspected
  }
  await retainMoteMainCreationReference({ target, operationId }, prior?.operationId ?? null)
  const existing = await api.spatial.read()
  if (existing && spatialAgentOpenRecord(existing.graph, operationId)) return await inspectMoteMainAction(scope, operationId)
  try {
    await api.spatial.openAgent({ operationId, content: { kind: 'new-agent', executorId: reading.executor.id },
      destination: { spaceId: target.spaceId, zoneId: target.zoneId, newTab: true }, focus: false,
      moteMain: { target, baseline: moteMainBaseline(baseline), expectedRoleRevision: reading.dialogue.main.roleRevision,
        sourceOperationId: operationId + ':source', bindOperationId: operationId + ':bind',
        ...(query ? { deferredInput: query } : {}), ...(baseline.defaults.conversation ? { handover: true as const } : {}), ...(rollover ? { rollover } : {}) } })
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'MOTE_MAIN_CREATION_PENDING') {
      const current = await api.spatial.read(), original = current && pendingMoteMainCreation(current.graph, target)
      if (original) { await retainMoteMainCreationReference({ target, operationId: original.requestId }, operationId); return await inspectMoteMainAction(scope, original.requestId) }
    }
    return { operationId, reference: null, creation: 'unconfirmed', source: 'unconfirmed', binding: 'unconfirmed',
      issue: `Original creation unconfirmed: ${message(cause)}. Inspect this same request; do not create again.` }
  }
  return await continueMoteMainAction(scope, operationId)
}

/** Reconcile only the original creation and stage keys. No creation, input or stop is replayed. */
export const inspectMoteMainAction = (scope: MoteWorkfaceScope, operationId: string) => reconcileMoteMain(scope, operationId, false)
export const continueMoteMainAction = (scope: MoteWorkfaceScope, operationId: string) => reconcileMoteMain(scope, operationId, true)
async function reconcileMoteMain(scope: MoteWorkfaceScope, operationId: string, advance: boolean): Promise<MoteMainActionResult> {
  if (advance) refuseDirty(scope)
  const input = {target:targetOf(scope),creation:{hostId:'local',operationId}}
  const result = await (advance ? api.moteDialogue.advanceSetup(input) : api.moteDialogue.inspectSetup(input))
  if (result.binding === 'confirmed') await useAppStore.getState().refreshScratchTopics(scope.workspace.id,true,scope.topic.id)
  return result
}
