import { moteExecutorPriority, moteQuickBaseline, parseMotePreferencesReadResult,
  type MoteDefaultConversation, type MoteQuickPreferencesReadResult } from '@agentmux/core/mote-preferences'
import { moteMainBaseline, moteMainCreatedReference, pendingMoteMainCreation, spatialAgentOpenRecord } from '@agentmux/core/spatial-graph'
import { pendingMoteMainStarts, type MoteDialoguePage, type MoteMainSetupResult, type MoteMainDeferredInput, type MoteMainRolloverDecision } from '@agentmux/core/mote-dialogue'
import type { MoteWorkfaceScope } from './mote-workface'
import { moteConnectionTarget } from './mote-connection-default'
import { api } from './api'
import { useAppStore, retainMoteMainCreationReference } from '../store'
import { documentKey } from './workbench-tabs'
import type { MoteMainCreationReference } from '../../../shared/mote-main-action'
import { checkpointLauncherState, useLauncherState } from './launcher-state'
import { moteEntryDraftKey } from './mote-entry-hold'

export type MoteMainActionReading = { preferences: MoteQuickPreferencesReadResult; dialogue: MoteDialoguePage;
  operationId: string | null; pendingOperationId: string | null; pendingStarts: string[]; executor: { id: string; name: string } | null; issue: string | null;
  previousCreation?: MoteMainActionResult | null }
export type MoteMainActionResult = { operationId: string; reference: MoteDefaultConversation | null;
  creation: 'confirmed' | 'unconfirmed'; source: 'confirmed' | 'not-needed' | 'unconfirmed';
  binding: 'confirmed' | 'refused' | 'unconfirmed'; issue: string | null } & Partial<Pick<MoteMainSetupResult, 'record' | 'deferredInput' | 'handoverInput'>>
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
/** Custody of this exact caller text, not proof of Native delivery. */
export function originalMainCreationRetainsInput(reference: MoteMainCreationReference, result: MoteMainActionResult | null | undefined): boolean {
  const query = reference.deferredInput, original = result?.record?.moteMain?.deferredInput
  return !query || result?.record?.requestId === reference.operationId && original?.operationId === query.operationId && original.prompt === query.prompt && same(original.focusTask, query.focusTask)
}
/** Explicit local draft transfer. It never starts, advances or replays the original business input. */
export async function moveMoteMainFirstInputToDraft(scope: MoteWorkfaceScope, reference: MoteMainCreationReference): Promise<void> {
  const key = JSON.stringify(reference.target), current = () => useAppStore.getState().moteMainCreationReferences[key]
  if (!same(targetOf(scope), reference.target) || !reference.deferredInput || !same(current(), reference)) throw new Error('The original first-message intent changed. Keep its text and inspect that same Mote.')
  const draftKey = moteEntryDraftKey(scope), originalDraft = useLauncherState.getState().drafts[draftKey], draft = originalDraft?.prompt ?? '', prompt = reference.deferredInput.prompt
  const merged = draft === prompt ? draft : [prompt, draft].filter(value => value.trim()).join('\n\n')
  const focusTask = reference.deferredInput.focusTask
  if (originalDraft?.focusTask && focusTask && !same(originalDraft.focusTask, focusTask)) throw new Error('This draft retains another original Focus task. Both tasks are kept; choose an empty draft before moving the original question.')
  const saved = focusTask ? useLauncherState.getState().setTaskDraft(draftKey, { prompt: merged, focusTask }, { draft: originalDraft })
    : useLauncherState.getState().setDraft(draftKey, 'prompt', merged)
  if (!saved) throw new Error('The original question is retained; its draft transfer could not be saved.')
  await checkpointLauncherState(); await api.ui.requestStorageFlush()
  if (useLauncherState.getState().drafts[draftKey]?.prompt !== merged || focusTask && !same(useLauncherState.getState().drafts[draftKey]?.focusTask, focusTask) || !same(current(), reference)) throw new Error('A later draft or original intent changed during saving. Both are kept; the original question remains retained.')
  await retainMoteMainCreationReference({ target: reference.target, operationId: reference.operationId }, reference.operationId)
}
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
  const target = targetOf(scope), input = { kind: 'quick' as const, target, includeChoices: 'executors' as const }
  const [raw, dialogue, spatial] = await Promise.all([api.motePreferences.read(input), api.moteDialogue.read({ target, kind: 'main' }), api.spatial.read()])
  const preferences = parseMotePreferencesReadResult(raw, input), baseline = moteQuickBaseline(preferences)
  const configured = preferences.defaults?.executorId
  const executor = preferences.defaults ? moteExecutorPriority(preferences.defaults).map(id => preferences.choices?.executors?.find(item => item.id === id)).find(Boolean) ?? null : null
  const issue = preferences.status !== 'ready' || !baseline || preferences.issue ? preferences.issue ?? 'Mote 的设置暂未确认，写下的想法会保留。可以重新核对。'
    : dialogue.main.status !== 'ready' || dialogue.main.documentRevision !== (baseline.document?.revision ?? null) || !same(dialogue.main.current, baseline.defaults.conversation ?? null)
      ? '主对话的来源尚未核对一致，原对话和草稿仍保留。可以重新核对。'
      : !configured ? '先在设置中选择此 Mote 的默认执行器，就能开始对话。'
        : !executor ? preferences.choices?.issues?.executors ?? '已保存的执行器暂未在原 Host 中确认，可以检查设置或重新核对。' : null
  const pendingStarts = spatial ? pendingMoteMainStarts(spatial.graph, target).map(item => item.requestId) : []
  const pendingOperationId = spatial ? pendingMoteMainCreation(spatial.graph, target)?.requestId ?? null : null
  const retained = useAppStore.getState().moteMainCreationReferences[JSON.stringify(target)]
  const previousId = pendingOperationId ?? (pendingStarts.length === 1 ? pendingStarts[0]! : retained?.operationId)
  const previousCreation = previousId ? await inspectMoteMainAction(scope, previousId) : null
  return { preferences, dialogue, pendingStarts, pendingOperationId, operationId: baseline && configured ? await actionId(preferences) : null,
    executor, issue, previousCreation }
}

function refuseDirty(scope: MoteWorkfaceScope) {
  const state = useAppStore.getState(), key = documentKey(scope.workspace.id, scope.rootPath + '/MOTE.md')
  if (state.dirtyDocuments[key] || state.documentIssues[key]) throw new Error('MOTE.md has an unsaved or unconfirmed Editor draft. Keep it and review before changing Main.')
}
/** Explicit action only. Default creation is admitted once by the original Core spatial owner. */
export async function createMoteMain(scope: MoteWorkfaceScope, reading: MoteMainActionReading, query?: MoteMainDeferredInput, rollover?: MoteMainRolloverDecision,
  onRetained?: ((query: MoteMainDeferredInput) => void | Promise<void>) | undefined): Promise<MoteMainActionResult> {
  if (reading.issue || !reading.operationId || !reading.executor) throw new Error(reading.issue ?? 'Choose the original configured default Executor first.')
  if (!same(targetOf(scope), reading.preferences.target)) throw new Error('This action belongs to another original Mote resource. Its conversations are kept.')
  refuseDirty(scope)
  const operationId = rollover?.creationOperationId ?? reading.operationId, target = reading.preferences.target, baseline = moteQuickBaseline(reading.preferences)!
  const key = JSON.stringify(target), prior = useAppStore.getState().moteMainCreationReferences[key]
  if (prior) {
    if (prior.operationId === operationId || reading.previousCreation?.operationId !== prior.operationId || reading.previousCreation.binding === 'unconfirmed')
      return await inspectMoteMainAction(scope, prior.operationId)
    if (!originalMainCreationRetainsInput(prior, reading.previousCreation)) throw new Error('本设备仍保留一条未由原创建保管的问题。请先移回草稿，再开始另一轮。')
  }
  // Preserve this caller's first text before any Core read or launch can wait. It is an
  // intent, never a reconstructed creation/delivery ACK; the original owners still decide those.
  await retainMoteMainCreationReference({ target, operationId, ...(query ? { deferredInput: query } : {}) }, prior?.operationId ?? null)
  if (query) await onRetained?.(query)
  const existing = await api.spatial.read()
  const pending = existing ? pendingMoteMainCreation(existing.graph, target) : null
  if (pending && pending.requestId !== operationId) {
    const inspected = await inspectMoteMainAction(scope, pending.requestId)
    return { ...inspected, issue: [inspected.issue, 'Another original Main start is pending. This first message is retained on this device and was not sent.'].filter(Boolean).join('\n') }
  }
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
      if (original) return await inspectMoteMainAction(scope, original.requestId)
    }
    return { operationId, reference: null, creation: 'unconfirmed', source: 'unconfirmed', binding: 'unconfirmed',
      issue: `Original creation unconfirmed: ${message(cause)}. Inspect this same request; do not create again.` }
  }
  return await continueMoteMainAction(scope, operationId)
}

/** Read only the original spatial admission. It is not a creation, handover or role-binding ACK. */
export async function readMoteMainStartPosition(scope: MoteWorkfaceScope, operationId: string) {
  const originals = Object.values(useAppStore.getState().moteMainCreationReferences).filter(value => value.operationId === operationId)
  if (originals.length > 1) throw new Error('The original Main request has more than one resource. Its original records are kept.')
  const target = originals[0]?.target ?? targetOf(scope), state = await api.spatial.read()
  const record = state && spatialAgentOpenRecord(state.graph, operationId)
  if (!record) return null
  if (!record.moteMain || !same(record.moteMain.target, target)) throw new Error('The original Main request belongs to another Mote. No replacement is selected.')
  const reference = moteMainCreatedReference(record)
  return reference ? { operationId, reference } : null
}

/** Reconcile only the original creation and stage keys. No creation, input or stop is replayed. */
export const inspectMoteMainAction = (scope: MoteWorkfaceScope, operationId: string) => reconcileMoteMain(scope, operationId, false)
export const continueMoteMainAction = (scope: MoteWorkfaceScope, operationId: string) => reconcileMoteMain(scope, operationId, true)
async function reconcileMoteMain(scope: MoteWorkfaceScope, operationId: string, advance: boolean): Promise<MoteMainActionResult> {
  if (advance) refuseDirty(scope)
  const originals = Object.values(useAppStore.getState().moteMainCreationReferences).filter(reference => reference.operationId === operationId)
  if (originals.length > 1) throw new Error('The original Main creation resource is ambiguous. Keep this same operation and its drafts.')
  const input = {target:originals[0]?.target ?? targetOf(scope),creation:{hostId:'local',operationId}}
  const result = await (advance ? api.moteDialogue.advanceSetup(input) : api.moteDialogue.inspectSetup(input))
  if (result.binding === 'confirmed') await useAppStore.getState().refreshScratchTopics(scope.workspace.id,true,scope.topic.id)
  return result
}
