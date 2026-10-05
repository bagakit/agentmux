import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core/control'
import { parseMotePreferencesReadResult, parseMotePreferencesSaveResult, type MotePreferencesReadInput,
  type MotePreferencesReadResult, type MotePreferencesSaveParams } from '@agentmux/core/mote-preferences'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID, scratchTopicIdentityPath, scratchTopicLogicalPath } from '../../../shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../../../shared/space-addresses'
import { api } from './api'
import { fileNavigationSelection, useAppStore } from '../store'
import { executorsForHost } from './executors'
import { workbenchTabDisplayName } from './workbench-tab-presentation'
import { spatialCatalog } from './space-agent-control'
import { scratchTopicKind } from './scratch-topic-snapshots'
import { confirmedMoteReference, confirmedMoteDestination, openMoteMaterialAt } from './mote-materials-actions'
import { moteConversationChoices, moteConversationLabel } from './mote-quick-preferences'
import { MoteQuickSaveError, readMoteQuickDefaults, saveMoteQuickDefaults, type MoteQuickWrite } from './mote-quick-mode'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)

async function originalScope(input: MotePreferencesReadInput) {
  const state = useAppStore.getState(), expected = input.target.expectedResource
  const workspace = state.config?.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID && item.id === expected.workspaceId &&
    item.hostId === expected.hostId && item.path === expected.workspacePath)
  if (!workspace) throw new Error('The original Mote Host and resource are unconfirmed. Your original choices are kept.')
  const topics = await api.scratch.listTopics(workspace.id)
  const matches = topics.filter(topic => !topic.readError && scratchTopicKind(topic.id, topics) === 'mote' &&
    directoryIdentity(workspace.hostId, scratchTopicIdentityPath(workspace, topic)) === input.target.spaceId)
  const topic = matches.length === 1 ? matches[0]! : null
  const rootPath = topic ? scratchTopicLogicalPath(workspace, topic) : null
  if (!topic || !rootPath || input.target.zoneId !== homeZoneId(input.target.spaceId))
    throw new Error('The original Mote directory is unconfirmed. Its identity and work are kept; retry discovery.')
  const current = useAppStore.getState().config?.workspaces.find(item => item.id === workspace.id)
  if (current?.hostId !== workspace.hostId || current.path !== workspace.path) throw new Error('The original Mote resource changed during discovery.')
  return { scope: { topic, workspace, rootPath }, topics }
}
export async function readMotePreferences(input: MotePreferencesReadInput): Promise<MotePreferencesReadResult> {
  const base = { kind: input.kind, target: input.target }
  try {
    const { scope, topics } = await originalScope(input), state = useAppStore.getState()
    const saved = await readMoteQuickDefaults(scope), catalog = spatialCatalog(useAppStore.getState(), topics)
    const destinations: MotePreferencesReadResult['choices']['destinations'] = catalog.locations.flatMap(location => {
      const reference = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }
      return location.spaceId === input.target.spaceId && confirmedMoteReference(useAppStore.getState(), scope, { reference }) ? [{
        reference: { kind: 'occurrence' as const, ...reference }, label: [state.config?.workspaces.find(w => w.id === location.displayWorkspaceId)?.name ?? 'Workspace',
          workbenchTabDisplayName(state.tabs[location.tabId]!, state.sessions, state.agentNames, state.timelines), `Pane ${(state.layouts[location.displayWorkspaceId]?.groups.findIndex(g => g.id === location.groupId) ?? -1) + 1}`,
          `Region ${Object.keys(state.tabs[location.tabId]!.regions).indexOf(location.regionId) + 1}`].join(' · ')
      }] : []
    })
    if (!destinations.length) for (const [displayWorkspaceId, layout] of Object.entries(state.layouts)) for (const group of layout.groups) {
      const reference = { displayWorkspaceId, groupId: group.id }
      if (confirmedMoteDestination(useAppStore.getState(), scope, reference, true)) destinations.push({ reference: { kind: 'empty', ...reference },
        label: `${state.config?.workspaces.find(w => w.id === displayWorkspaceId)?.name ?? 'Workspace'} · Empty Mote · Pane ${layout.groups.indexOf(group) + 1}` })
    }
    return parseMotePreferencesReadResult({ ...base, status: saved.issue || !saved.source?.resource ? 'unconfirmed' : 'ready',
      source: saved.source ?? null, defaults: saved.issue ? null : saved.defaults, main: scope.topic.id === PMO_TEAMS_TOPIC_ID,
      issue: saved.issue ?? (!saved.source?.resource ? 'The original File mapping is unconfirmed.' : null), choices: {
        executors: executorsForHost(state.config, scope.workspace.hostId, state.executorDetections, state.hostExecutorInventories[scope.workspace.hostId]).map(e => ({ id: e.id, name: e.label, providerId: e.providerId })),
        conversations: moteConversationChoices(state, scope.topic, scope.workspace.id, catalog).map(reference => ({ reference, label: moteConversationLabel(state, reference) ?? 'Original conversation' })), destinations
      } }, input)
  } catch (error) {
    return parseMotePreferencesReadResult({ ...base, status: 'unconfirmed', source: null, defaults: null, main: null,
      issue: error instanceof Error ? error.message : String(error), choices: { executors: [], conversations: [], destinations: [] } }, input)
  }
}
export async function executeMotePreferencesControl(request: Extract<AgentMuxControlRequest, { operation: 'space.mote.preferences.read' | 'space.mote.preferences.save' }>, signal?: AbortSignal): Promise<AgentMuxControlResult> {
  const { operation, requestId, schemaVersion: _schema, ...input } = request
  if (request.operation === 'space.mote.preferences.read') return { operation: request.operation, ...await readMotePreferences(request) }
  const params: MotePreferencesSaveParams = { ...request, operationId: requestId }
  const fail = (status: 'refused-before-write' | 'unconfirmed', error: unknown) => ({ operation: 'space.mote.preferences.save' as const, requestId,
    ...input, status, source: null, message: error instanceof Error ? error.message : String(error) })
  let unsubscribe = () => {}, cancel = () => {}, completed: MoteQuickWrite | null = null
  try {
    const { scope } = await originalScope(request)
    if (scope.topic.id === PMO_TEAMS_TOPIC_ID && request.values.recovery === 'on-open') throw new Error('Main Mote restores at startup. Your other choices are kept.')
    const navigation = fileNavigationSelection(useAppStore.getState()), controller = new AbortController()
    cancel = () => controller.abort()
    if (signal?.aborted) cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    unsubscribe = useAppStore.subscribe(state => { if (fileNavigationSelection(state) !== navigation) cancel() })
    const stillCurrent = () => !controller.signal.aborted && (() => {
      const workspace = useAppStore.getState().config?.workspaces.find(item => item.id === scope.workspace.id)
      return workspace?.hostId === scope.workspace.hostId && workspace.path === scope.workspace.path
    })()
    const chosen = request.destination, reference = chosen.kind === 'occurrence' ? chosen : null
    const open = async (path: string) => (await openMoteMaterialAt(scope, path, reference, chosen, controller.signal))?.reference
    const written = await saveMoteQuickDefaults(scope, request.values, { ...request.baseline, source: { resource: request.baseline.resource,
      result: request.baseline.document ? { status: 'read', document: request.baseline.document } : { status: 'deleted' } } },
      open, stillCurrent, reference, chosen.kind === 'empty' ? chosen : undefined)
    completed = written
    const { operationId: _id, ...body } = parseMotePreferencesSaveResult({ kind: 'quick', target: request.target, operationId: requestId,
      ...written, message: null }, params)
    return { operation: 'space.mote.preferences.save', requestId, ...body }
  } catch (error) {
    const confirmed = completed ?? (error instanceof MoteQuickSaveError ? error.confirmed : null)
    if (confirmed) {
      try {
        const { operationId: _id, ...body } = parseMotePreferencesSaveResult({ kind: 'quick', target: request.target, operationId: requestId,
          ...confirmed, message: message(error) }, params)
        return { operation: 'space.mote.preferences.save', requestId, ...body }
      } catch { /* The writer completed, but its public receipt cannot be validated. This is never a no-write fact. */ }
    }
    const result = fail(confirmed || error instanceof MoteQuickSaveError && error.writeStarted ? 'unconfirmed' : 'refused-before-write', error)
    // Only public result fields leave the original owner; no request baseline is echoed as a new receipt.
    return { operation: result.operation, requestId, kind: 'quick', target: request.target, status: result.status, source: null, message: result.message }
  } finally { unsubscribe(); signal?.removeEventListener('abort', cancel) }
}
