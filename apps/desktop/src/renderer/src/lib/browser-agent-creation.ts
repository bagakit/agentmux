import { getAmuxProtocolTemplate, renderAmuxProtocol } from '@agentmux/core/amux-protocol'
import { SCRATCH_WORKSPACE_ID } from '@agentmux/host/mote-model'
import type { BrowserWorkbenchSurface } from './workbench-tabs'
import { mintObjectId } from '@agentmux/core/object-id'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxSpaceMutationReport } from '@agentmux/core/control'
import type { SplitDirection } from '@agentmux/layout'
import type { AgentSessionControl } from '../../../shared/contracts'
import type { SpatialRequestBinding } from '../../../shared/space-addresses'
import { api } from './api'
import { defaultExecutorChoice, executorsForHost } from './executors'
import { useLauncherState } from './launcher-state'
import { scratchTopicsForWorkspace } from './scratch-topic-snapshots'
import { spatialCatalog } from './space-agent-control'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { fileNavigationSelection, retainBrowserAgentIntent, useAppStore } from '../store'

type Intent = NonNullable<SpatialRequestBinding['browserAgent']>
export type BrowserAgentCreationResult = { kind: 'confirmed' } | { kind: 'setup-unconfirmed'; message: string } |
  { kind: 'input-unconfirmed'; message: string; agentSessionId: string; messageOperationId: string; runId: string }
const active = new Map<string, Promise<BrowserAgentCreationResult>>()
const prompt = getAmuxProtocolTemplate('browser-task', 'observe')
export type BrowserAgentCreationOptions = {
  executorId?: string
  task?: string
  split?: SplitDirection
  expectedPage?: { navigationId: string; controlRevision: number }
  expectedExecution?: { hostId: string; path: string }
}
type CreationState = Pick<ReturnType<typeof useAppStore.getState>, 'config' | 'executorDetections' | 'hostExecutorInventories'>
export type BrowserAgentCreationExecutor = { id: string; label: string; detail?: string }
export const browserAgentCreationDraftKey = (browserId: string) => `browser-agent:${JSON.stringify(browserId)}`

/** The creation menu and the actual command consume one choice policy. Observation failure is not missing. */
export function browserAgentCreationContext(state: CreationState, workspaceId: string, preferred: string | undefined) {
  const workspace = state.config?.workspaces.find(item => item.id === workspaceId)
  if (!workspace) return { workspace: undefined, executors: [] as BrowserAgentCreationExecutor[], defaultExecutorId: undefined, profileLabel: undefined as string | undefined }
  const candidates = executorsForHost(state.config, workspace.hostId, state.executorDetections, state.hostExecutorInventories[workspace.hostId])
  const retainedRemote = preferred && !candidates.length && state.config?.hosts.find(host => host.id === workspace.hostId)?.kind === 'ssh'
    ? { id: preferred, label: state.config?.executors[preferred]?.label ?? preferred, detail: 'Host discovery unconfirmed' } : undefined
  const executor = defaultExecutorChoice(candidates, preferred) ?? retainedRemote
  const executors: BrowserAgentCreationExecutor[] = candidates.map(item => ({ id: item.id, label: item.label ?? item.id,
    ...(item.detection?.state === 'missing' ? { detail: 'Not found at last check' } : item.detection?.state !== 'ready' ? { detail: 'Availability unconfirmed' } : {}) }))
  if (retainedRemote) executors.push(retainedRemote)
  return { workspace, executors, defaultExecutorId: executor?.id, profileLabel: undefined as string | undefined }
}

/** Observe only this preparation wait; the original Store owns navigation after command admission. */
export function watchBrowserAgentPreparationNavigation() {
  const expected = fileNavigationSelection(useAppStore.getState())
  let current = true
  const dispose = useAppStore.subscribe(state => {
    if (fileNavigationSelection(state) !== expected) current = false
  })
  return { isCurrent: () => current, dispose }
}

/** Main prepares only independent Survey resources; existing project and pending requests keep their original owner. */
export async function prepareBrowserAgentCreationContext(browser: BrowserWorkbenchSurface, surface?: 'survey') {
  const state = useAppStore.getState()
  if (surface !== 'survey' || browser.workspaceId !== SCRATCH_WORKSPACE_ID) {
    return browserAgentCreationContext(state, browser.workspaceId, useLauncherState.getState().executors[browser.workspaceId])
  }
  const prepared = await api.browser.prepareAgentWorkspace({ browserId: browser.browserId,
    expected: { workspaceId: browser.workspaceId, mode: browser.mode ?? 'normal', profileId: browser.profileId ?? null } })
  if (prepared.outcome !== 'ready' || !prepared.workspace || prepared.registration !== 'confirmed' || prepared.directory.status === 'unconfirmed') {
    throw new Error(`Agent directory ${prepared.issue?.step ?? 'preparation'} is unconfirmed on Host ${prepared.directory.hostId}${prepared.directory.path ? ` at ${prepared.directory.path}` : ' (path unconfirmed)'}. ${prepared.issue?.message ?? 'Inspect this Browser and its original Host/path before trying again.'} The page and task are kept; no Agent was created.`)
  }
  if (prepared.source.browserId !== browser.browserId || prepared.source.workspaceId !== browser.workspaceId ||
    prepared.source.mode !== (browser.mode ?? 'normal') || prepared.source.profileId !== (browser.profileId ?? null) ||
    prepared.workspace.hostId !== prepared.directory.hostId || prepared.workspace.path !== prepared.directory.path) {
    throw new Error('The execution directory receipt belongs to another Browser environment. Keep this page and inspect its original Host.')
  }
  const resource = prepared.workspace
  // Project the confirmed Main registration into the existing config cache, never write a second registry.
  useAppStore.setState(current => {
    if (!current.config || current.config.workspaces.some(item => item.id === resource.id)) return current
    return { config: { ...current.config, workspaces: [...current.config.workspaces, resource] } }
  })
  const context = browserAgentCreationContext(useAppStore.getState(), resource.id, useLauncherState.getState().executors[browser.workspaceId])
  if (context.workspace?.hostId !== resource.hostId || context.workspace.path !== resource.path) throw new Error('The registered execution resource changed. Its original Browser and task are kept.')
  return { ...context, profileLabel: prepared.profileLabel ?? (prepared.scope === 'survey-private' ? 'Private Browser' : undefined) }
}

function initialPrompt(task: string | undefined): string {
  if (!task?.trim()) return prompt
  return renderAmuxProtocol('browser-task', 'act', { task })
}

/** Check one original occurrence; unrelated Sessions never participate in this hot path. */
function originalBrowser(intent: Pick<Intent, 'source' | 'browserId' | 'workspaceId' | 'hostId' | 'executionPath' | 'executionWorkspaceId' | 'environment' | 'browserResource'>) {
  const state = useAppStore.getState(), { source } = intent
  const tab = state.tabs[source.tabId], surface = tab?.regions[source.regionId]
  const group = state.layouts[source.displayWorkspaceId]?.groups.find(item => item.id === source.groupId)
  const resource = state.config?.workspaces.find(item => item.id === intent.workspaceId)
  const workspace = state.config?.workspaces.find(item => item.id === (intent.executionWorkspaceId ?? intent.workspaceId))
  if (surface?.kind !== 'browser' || surface.browserId !== intent.browserId || surface.workspaceId !== intent.workspaceId ||
    intent.browserResource && (resource?.hostId !== intent.browserResource.hostId || resource.path !== intent.browserResource.path) ||
    workspace?.hostId !== intent.hostId || workspace.path !== intent.executionPath ||
    intent.environment && (intent.environment.mode !== (surface.mode ?? 'normal') || intent.environment.profileId !== (surface.profileId ?? null)) ||
    !group?.tabOrder.includes(source.tabId)) throw new Error('The original Browser occurrence or execution Workspace changed. Its Agent and original request are kept; inspect the same request before choosing another target.')
  return surface
}
function beforeHandoff(intent: Intent): boolean {
  try {
    const browser = originalBrowser(intent)
    return browser.navigationId === intent.navigationId && browser.control?.owner === 'human' &&
      browser.control.agent === null && browser.control.revision === intent.controlRevision
  } catch { return false }
}
function sameRecipient(a: AgentSessionControl, b: AgentSessionControl): boolean {
  return a.hostId === b.hostId && a.agentSessionId === b.agentSessionId && a.run.runId === b.run.runId
}
function retained(requestId: string): Intent {
  const record = useAppStore.getState().spatialRequests[requestId]
  if (record?.purpose !== 'browser-agent' || !record.browserAgent) throw new Error('The original Browser Agent admission is unavailable. Keep its request ID; no replacement Agent was created.')
  return record.browserAgent
}

async function continueOriginal(requestId: string, report: AgentMuxSpaceMutationReport): Promise<BrowserAgentCreationResult> {
  let intent = retained(requestId)
  const fact = report.agent
  if (!fact || !fact.runId || fact.agentSessionId !== useAppStore.getState().spatialRequests[requestId]?.agentSessionId) {
    return { kind: 'setup-unconfirmed', message: `Agent creation is unconfirmed. Check request ${requestId}; the original page and reserved Region are kept. No creation was repeated.` }
  }
  if (fact.hostId !== intent.hostId || fact.cwd !== intent.executionPath) throw new Error(`The created Agent execution resource differs from the original Browser click. Agent ${fact.agentSessionId} and request ${requestId} are kept; no handoff or input was dispatched.`)
  const recipient: AgentSessionControl = { kind: 'agent', hostId: fact.hostId, agentSessionId: fact.agentSessionId, run: { runId: fact.runId } }
  if (intent.recipient && !sameRecipient(intent.recipient, recipient)) throw new Error(`The original Agent Run changed. Check request ${requestId}; no new recipient or input was substituted.`)
  if (!intent.recipient) {
    const next = { ...intent, recipient }
    await retainBrowserAgentIntent(requestId, intent, next)
    intent = next
  }
  const queued = useAppStore.getState().agentSteerQueues[recipient.agentSessionId]?.some(entry => entry.operationId === intent.messageOperationId)
  if (intent.inputStarted || queued) {
    const receipt = await api.sessions.inspectInput(recipient, { kind: 'prompt', agentSessionId: recipient.agentSessionId,
      expectedRun: recipient.run, submissionId: intent.messageOperationId })
    return receipt?.status === 'admitted' || receipt?.status === 'terminal-confirmed'
      ? { kind: 'confirmed' } : { kind: 'input-unconfirmed', agentSessionId: recipient.agentSessionId, messageOperationId: intent.messageOperationId,
        runId: recipient.run.runId, message: `The Agent exists. Initial input is unconfirmed; inspect its original message ${intent.messageOperationId} in the Agent queue. No input was resent.` }
  }
  const prior = originalBrowser(intent)
  const completedHandoff = prior.navigationId === intent.navigationId && prior.control?.owner === 'agent' &&
    prior.control.revision === intent.controlRevision + 1 && prior.control.agent?.hostId === recipient.hostId &&
    prior.control.agent.agentSessionId === recipient.agentSessionId
  if (!completedHandoff && !beforeHandoff(intent)) throw new Error(`The Browser changed after this click. Agent ${recipient.agentSessionId} remains available. Check request ${requestId}; no newer human control or page was overridden.`)
  const snapshot = completedHandoff ? prior : await api.browser.returnControl(intent.browserId,
    { agent: recipient, navigationId: intent.navigationId, expectedRevision: intent.controlRevision })
  const observed = originalBrowser(intent)
  if (observed.navigationId !== intent.navigationId || observed.control && snapshot.control && observed.control.revision > snapshot.control.revision) {
    throw new Error(`A newer Browser page or control decision arrived during handoff. The Agent and original request ${requestId} are kept; no task was sent.`)
  }
  useAppStore.getState().applyBrowserEvent({ type: 'updated', browser: snapshot }, intent.navigationId)
  const current = originalBrowser(intent)
  if (snapshot.id !== intent.browserId || snapshot.navigationId !== intent.navigationId || snapshot.control?.owner !== 'agent' ||
    snapshot.control.agent?.hostId !== recipient.hostId || snapshot.control.agent.agentSessionId !== recipient.agentSessionId ||
    current.navigationId !== intent.navigationId || current.control?.revision !== snapshot.control.revision || current.control.owner !== 'agent') {
    throw new Error(`Browser handoff is unconfirmed. The created Agent and request ${requestId} are kept; no initial task was sent.`)
  }
  const state = useAppStore.getState()
  if (!state.enqueueAgentSteer(recipient.agentSessionId, intent.prompt, undefined, intent.messageOperationId, 'manual', intent.note,
    { browserRecipient: recipient, awaitingExplicitSend: true })) throw new Error(`The Agent exists, but its initial task was not queued. Original task ${intent.messageOperationId} is retained in request ${requestId}.`)
  // No await separates queue admission and this marker. A crash between them still finds
  // the original queue above. A refused admission leaves the original input retryable.
  const next = { ...intent, inputStarted: true as const }
  await retainBrowserAgentIntent(requestId, intent, next)
  const afterSave = originalBrowser(intent)
  if (afterSave.navigationId !== intent.navigationId || afterSave.control?.owner !== 'agent' ||
    afterSave.control.revision !== snapshot.control.revision) throw new Error(`Browser control changed before initial input. The Agent and original task in request ${requestId} are kept in its queue.`)
  const result = await useAppStore.getState().sendQueuedAgentSteer(recipient.agentSessionId, intent.messageOperationId)
  return result === 'submitted' ? { kind: 'confirmed' } : { kind: 'input-unconfirmed', agentSessionId: recipient.agentSessionId,
    messageOperationId: intent.messageOperationId, runId: recipient.run.runId,
    message: `The Agent has this Browser. Initial input is unconfirmed; inspect message ${intent.messageOperationId} in its queue. No input is repeated.` }
}

async function createOrInspect(browserId: string, source: WorkbenchProjectionSelection, surface?: 'survey', options: BrowserAgentCreationOptions = {}): Promise<BrowserAgentCreationResult> {
  const state = useAppStore.getState(), tab = state.tabs[source.tabId], browser = tab?.regions[source.regionId]
  if (browser?.kind !== 'browser' || browser.browserId !== browserId) throw new Error('The exact Browser source is unavailable. Its page is kept.')
  if (browser.agentCreationRequestId) {
    const requestId = browser.agentCreationRequestId
    const result = await state.executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: mintObjectId(), operation: 'space.inspect', target: { requestId } })
    if (result.operation !== 'space.inspect') throw new Error(`The Agent request ${requestId} of this Browser could not be read, so no second Agent was created. Retry to read it again.`)
    if (result.request?.report) return continueOriginal(requestId, result.request.report)
    // space.inspect observes the client's retained binding; known:false is not Core's proof
    // that the original creation did not happen. Keep its identity even when that binding is unreadable.
    throw new Error(`The original Agent request ${requestId} of this Browser is unavailable or still being confirmed, so no second Agent was created. Keep this request ID and inspect its original Core connection.`)
  }
  if (browser.control?.owner !== 'human' || browser.control.agent !== null || !browser.navigationId) throw new Error('The Browser has no confirmed unassociated control state. Keep this page and refresh its original connection.')
  if (options.expectedPage && (browser.navigationId !== options.expectedPage.navigationId || browser.control.revision !== options.expectedPage.controlRevision)) {
    throw new Error('This Browser page or control changed while creation options were open. Your task and choices are kept; inspect the current page before creating its Agent.')
  }
  const browserResource = state.config?.workspaces.find(item => item.id === browser.workspaceId)
  const navigation = surface ? watchBrowserAgentPreparationNavigation() : null
  try {
    const context = await prepareBrowserAgentCreationContext(browser, surface)
    const workspace = context.workspace
    if (!workspace) throw new Error('The original Browser execution Workspace is unconfirmed. No other directory was selected.')
    if (options.expectedExecution && (workspace.hostId !== options.expectedExecution.hostId || workspace.path !== options.expectedExecution.path)) {
      throw new Error('The Browser execution Host or directory changed while creation options were open. Your task and choices are kept; inspect the original Workspace before creating its Agent.')
    }
    const executor = context.executors.find(item => item.id === (options.executorId ?? context.defaultExecutorId))
    if (!executor) throw new Error('No configured Agent executor is available on this Browser Workspace Host. Choose one in the Launcher; this page is kept.')
    const current = useAppStore.getState(), sourceResource = current.config?.workspaces.find(item => item.id === browser.workspaceId)
    const catalog = spatialCatalog(current, scratchTopicsForWorkspace(current.scratchTopicSnapshots, sourceResource) ?? [])
    if (!catalog.locations.some(item => item.tabId === source.tabId && item.regionId === source.regionId &&
      item.displayWorkspaceId === source.displayWorkspaceId && item.groupId === source.groupId)) throw new Error('The original Browser presentation is unconfirmed. No other presentation was selected.')
    const requestId = mintObjectId()
    const intent: Intent = { browserId, navigationId: browser.navigationId, controlRevision: browser.control.revision,
      source: { ...source }, workspaceId: browser.workspaceId, ...(browserResource ? { browserResource: { hostId: browserResource.hostId, path: browserResource.path } } : {}), executionWorkspaceId: workspace.id, hostId: workspace.hostId, executionPath: workspace.path,
      environment: { mode: browser.mode ?? 'normal', profileId: browser.profileId ?? null }, messageOperationId: mintObjectId(), prompt: initialPrompt(options.task),
      note: renderAmuxProtocol('browser-task', 'original', { reference: JSON.stringify({ browserId, navigationId: browser.navigationId,
        ...(browser.mode === 'private' ? {} : { url: browser.url, title: browser.title, profileId: browser.profileId }),
        mode: browser.mode, workspaceId: browser.workspaceId, executionWorkspaceId: workspace.id, hostId: workspace.hostId, source }) }) }
    const reveal = navigation?.isCurrent() ?? true
    navigation?.dispose()
    const result = await state.executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId, operation: 'agent.open',
      content: { kind: 'new-agent', executorId: executor.id, executionWorkspaceId: workspace.id },
      destination: { ...source, split: options.split ?? 'right' }, focus: true }, undefined,
    { purpose: 'browser-agent', browserAgent: intent, authorize: () => beforeHandoff(intent),
      ...(surface ? { localFocus: { surface, reference: source, reveal } } : {}) })
    if (result.operation !== 'agent.open') throw new Error(`Unexpected creation receipt. Inspect original request ${requestId}.`)
    if (!useAppStore.getState().spatialRequests[requestId]?.browserAgent) throw new Error(result.issues.map(issue => issue.message).join('\n') || `Creation was not admitted. Original request: ${requestId}.`)
    return continueOriginal(requestId, result)
  } finally { navigation?.dispose() }
}

/** A repeated activation joins the same call, even through another Browser presentation. */
export function createBrowserAgent(browserId: string, source: WorkbenchProjectionSelection, surface?: 'survey', options?: BrowserAgentCreationOptions): Promise<BrowserAgentCreationResult> {
  const pending = active.get(browserId)
  if (pending) return pending
  const promise = createOrInspect(browserId, source, surface, options).finally(() => { if (active.get(browserId) === promise) active.delete(browserId) })
  active.set(browserId, promise)
  return promise
}
