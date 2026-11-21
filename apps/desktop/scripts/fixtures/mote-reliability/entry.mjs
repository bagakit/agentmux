// Complete production App and ordinary initialize, sharing the existing private public-port fixture.
import { stagedMotePreferenceReader, bindMotePreferenceReader } from './ports.mjs'
import '../mote-initialization/entry.mjs'
import { useAppStore, retainMoteMainCreationReference } from '../../../src/renderer/src/store'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-recovery'
import { api } from '../../../src/renderer/src/lib/api'
import { initializeLauncherState, useLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { serializeMoteQuickMode, PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '@agentmux/host/mote-model'
import { parseScheduleRpcParams } from '@agentmux/core/schedule-rpc'
import { moteMainRoleRevision } from '@agentmux/core/mote-dialogue'
import { moteEntryDraftKey } from '../../../src/renderer/src/lib/mote-entry-hold'
import { requestPmoTeamsTopicFloatingOpen } from '../../../src/renderer/src/lib/pmo-teams-topic-floating'
import { scratchTopicLogicalPath } from '@agentmux/host/mote-model'
import { observeNotifications } from '../../../src/renderer/src/lib/notification-observation'
import { topicSpaceIconTarget } from '../../../src/renderer/src/lib/space-object-appearance'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'

await initializeLauncherState()
const original = useAppStore.getState(), session = original.sessions.find(value => value.id === 'mote-primary')
if (!session || session.control.kind !== 'agent') throw Error('Original controlled Session required')
const restoring = window.moteInit.phase === 'initialization-restore'
const inputAtEntry = structuredClone({ drafts: useLauncherState.getState().drafts, agentDrafts: original.agentComposerDrafts,
  tab: original.tabs['original-initialization-tab'], layouts: original.layouts, selection: original.workbenchSpaceSelection, focus: original.agentFocus, control: session.control, mainRequests: original.moteMainCreationReferences })
const fixtureWrites = []
let originalCreation = session.creation
const refreshSession = api.sessions.refresh
api.sessions.refresh = async control => {
  const value = await refreshSession(control)
  return value.kind === 'agent' && value.control.agentSessionId === session.control.agentSessionId ? { ...value, creation: originalCreation } : value
}
const tabId = 'original-initialization-tab', regionId = 'original-initialization-region', groupId = 'original-initialization-group'
const reference = { hostId: session.control.hostId, sessionId: session.control.agentSessionId, displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId, tabId, regionId }
if (restoring) {
  const region = original.tabs[tabId]?.regions[regionId]
  if (region?.kind !== 'agent' || region.sessionId !== session.id) throw Error('The exact persisted Agent Tab is missing; the restore fixture cannot reconstruct it')
} else {
  const tab = original.tabs[tabId].regions[regionId]?.kind === 'agent' ? original.tabs[tabId] : { ...createWorkbenchTab(tabId, { kind: 'agent', phase: 'attached', regionId, workspaceId: SCRATCH_WORKSPACE_ID, sessionId: session.id }, original.tabs[tabId].name),
    topicId: PMO_TEAMS_TOPIC_ID, space: original.tabs[tabId].space }
  useAppStore.setState({ tabs: { ...original.tabs, [tabId]: tab }, agentComposerDrafts: { ...original.agentComposerDrafts, [session.id]: 'My original draft stays here while startup is checked.' } })
  fixtureWrites.push('tab-and-agent-draft')
}
const path = scratchTopicDirectoryName(PMO_TEAMS_TOPIC_ID) + '/MOTE.md'
const document = await api.files.read(SCRATCH_WORKSPACE_ID, path)
if (document.status !== 'read') throw Error('Original controlled Mote file required')
await api.files.write(SCRATCH_WORKSPACE_ID, { path, content: serializeMoteQuickMode(document.document.content, { executorId: 'cck3', conversation: reference, presence: { enabled: true, intervalMs: 1800000 } }), expectedRevision: document.document.revision })
const readPreferences = stagedMotePreferenceReader()
const currentDocument = await api.files.read(SCRATCH_WORKSPACE_ID, path)
if (currentDocument.status !== 'read') throw Error('Current original Mote file required')
const roleRevision = moteMainRoleRevision({ conversation: reference }, currentDocument.document.revision)
const heartbeatReads = []
let variant = 'paused'
const heartbeatIconPreview = new URLSearchParams(location.search).has('heartbeat-icon')
let heartbeatIconOccurrence = 1000
const schedule = () => ({ loopId: 'original-mote-heartbeat', hostId: reference.hostId, agentSessionId: reference.sessionId, providerId: session.providerId, workspacePath: session.workspacePath,
  managedSource: { sourceId: 'mote-main:private-original', revision: roleRevision },
  everyMs: 1800000, intervalMs: 1800000, revision: variant === 'active' ? 5 : 4, creationOperationId: 'original-mote-heartbeat-creation', futureIntentId: 'original-mote-heartbeat-standing-intent', prompt: 'Check current work and unfinished commitments.',
  status: variant === 'active' ? 'active' : 'paused', nextCheckAt: Date.now() + 25 * 60000, lastTickAt: Date.now() - 5 * 60000,
  lastOutcome: variant === 'active' ? 'sent' : 'unknown', lastDecision: variant === 'active' ? 'The original input was accepted.' : 'The original Host connection was unavailable. Delivery remains unconfirmed.',
  ...(variant === 'active' || variant === 'legacy' || variant === 'legacy-without-key' ? {} : { pause: { reason: variant === 'manual' ? 'manual' : 'input-unconfirmed', episodeId: 'private-original-pause', pausedAt: 1794362400000 } }),
  ...(variant === 'active' || variant === 'legacy-without-key' ? {} : { pendingCompletion: { id: 'original-occurrence', operationId: 'original-heartbeat-input', condition: { expectedRun: session.control.run, afterSubmissionId: null }, prompt: 'Check current work and unfinished commitments.', agentMuxNote: 'Original maintenance input.' } }) })
api.motePreferences.read = async input => {
  heartbeatReads.push({ method: 'preferences', target: input.target })
  if (variant === 'unavailable') throw Error('The original heartbeat observation is unavailable. Its last reading is kept.')
  return { ...await readPreferences(input), maintenance: variant === 'unbound' ? { status: 'unbound', schedule: null, issue: null }
    : { status: variant === 'active' ? 'active' : 'paused', schedule: schedule(), issue: variant === 'active' ? null : 'Delivery remains unconfirmed. The original input is kept; check its original schedule.' } }
}
api.schedule.list = async input => { parseScheduleRpcParams('schedule.list', input); return { schedules: [schedule()], executionScope: 'connected-host' } }
api.schedule.inspect = async input => {
  parseScheduleRpcParams('schedule.inspect', input); heartbeatReads.push({ method: 'inspect', scheduleId: input.scheduleId })
  if (variant === 'unavailable') throw Error('The original heartbeat observation is unavailable.')
  const record = input.scheduleId === 'original-mote-heartbeat' ? schedule() : null
  const receipt = record && heartbeatIconPreview && variant === 'active' ? {
    inputKey: { kind: 'prompt', agentSessionId: reference.sessionId, expectedRun: session.control.run, submissionId: 'care-' + heartbeatIconOccurrence },
    futureIntent: { intentId: record.futureIntentId, occurrenceAt: heartbeatIconOccurrence },
    definitionOperationId: record.creationOperationId, managedSource: record.managedSource, preparedAt: heartbeatIconOccurrence,
  } : null
  return receipt ? { schedule: { ...record, lastInputRef: receipt }, executionScope: 'connected-host',
    input: { reference: receipt, status: 'confirmed', delivery: 'terminal-confirmed', nativeResult: { state: 'unsupported' } } }
    : { schedule: record, executionScope: 'connected-host' }
}
bindMotePreferenceReader()
await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true, PMO_TEAMS_TOPIC_ID)
if (heartbeatIconPreview) {
  const current = useAppStore.getState(), workspace = current.config.workspaces.find(item => item.id === SCRATCH_WORKSPACE_ID)
  const topic = await api.scratch.readTopic(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)
  const target = workspace && topic && topicSpaceIconTarget(workspace, topic, current.spaceZoneBindings)
  if (!target) throw Error('The original avatar target is required for the heartbeat proof')
  useAppStore.setState({ spaceObjectIcons: { ...current.spaceObjectIcons, [target.key]: {
    kind: 'series', source: { origin: 'builtin', seriesId: 'mote-silhouettes', entryId: 'low-poly', revision: 'sha256:' + '1'.repeat(64) },
    parameters: { kind: 'image', zoom: 1, offsetX: 0, offsetY: 0 }, image: { kind: 'image', fileName: 'a'.repeat(64) + '.png' },
  } } })
}
const retainedKey = 'private-mote-reliability-original-draft'
if (!restoring) { useLauncherState.getState().setDraft(retainedKey, 'prompt', 'Original retained Mote draft across a real Renderer restart.'); fixtureWrites.push('launcher-draft') }
window.moteReliability = { ready: true, reference,
  facts: () => ({ ...window.moteInit.facts(), variant, inputAtEntry, fixtureWrites: [...fixtureWrites], agentDrafts: useAppStore.getState().agentComposerDrafts, focus: useAppStore.getState().agentFocus,
    mainRequests: useAppStore.getState().moteMainCreationReferences, readingIssues: [...globalThis.document.querySelectorAll('.conversation-read-issues__source')].map(node => node.textContent), session: useAppStore.getState().sessions.find(value => value.id === session.id) }),
  editDrafts({ agent, launcher }) {
    if (restoring || !agent?.trim() || !launcher?.trim()) throw Error('Only the seed process can author nonempty original drafts')
    useAppStore.getState().setAgentComposerDraft(session.id, agent)
    if (!useLauncherState.getState().setDraft(retainedKey, 'prompt', launcher)) throw Error('Original Launcher draft write was not accepted')
    fixtureWrites.push('seed-authored-draft-witness')
  },
  persistedInputs: async () => {
    const raw = await api.ui.readWorkbenchState()
    if (!raw) return null
    const document = JSON.parse(raw), launcher = document.desktopFragments?.launcher
    return { agentDrafts: document.state?.agentComposerDrafts ?? null,
      drafts: typeof launcher === 'string' ? JSON.parse(launcher).state?.drafts ?? null : null }
  },
  careFacts: () => ({ reads: [...heartbeatReads], receipts: useAppStore.getState().noticeReadReceipts,
    lamp: globalThis.document.querySelector('.mote-space-frame__header .mote-heartbeat-lamp')?.dataset.moteCare,
    notifications: observeNotifications({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'private-care-notice-reading', operation: 'inspect.notifications',
      target: { domain: 'client.notifications', hostId: 'local', list: { section: 'current', category: 'operations', limit: 32 } }, includeRaw: true, maxBytes: 65536 }) }),
  persistedCare: async () => { const raw = await api.ui.readWorkbenchState(); return raw ? JSON.parse(raw).state?.noticeReadReceipts ?? null : null },
  variant(value) { variant = value },
  advanceHeartbeatIcon() { heartbeatIconOccurrence++ },
  startup() {
    originalCreation = { createOperationId: 'original-start-operation', initialPrompt: 'unconfirmed', createdRun: session.control.run,
      workspaceTrust: { lifecycleOperationId: 'original-start-operation', workspacePath: session.workspacePath, status: 'unconfirmed', step: 'trust-record', trustKey: null,
        code: 'NATIVE_CONFIGURATION_UNAVAILABLE', issue: 'The original native configuration could not be read. The original Session is kept.', observedAt: Date.now() } }
    useAppStore.setState(state => ({ sessions: state.sessions.map(value => value.id === session.id ? { ...value, creation: originalCreation } : value) }))
  }
}

// Optional bounded work-cycle view over the same full App and private durable profile.
if (new URL(location.href).searchParams.has('heartbeat-surface')) {
  const preferences = api.motePreferences.read, dialogue = api.moteDialogue.read, save = api.motePreferences.save
  const saves = []
  let surface = 'quiet'
  const originalKey = { kind: 'prompt', agentSessionId: reference.sessionId, expectedRun: session.control.run, submissionId: 'original-care-input' }
  const originalReference = { inputKey: originalKey, futureIntent: { intentId: 'original-mote-heartbeat-standing-intent', occurrenceAt: 1000 }, definitionOperationId: 'original-mote-heartbeat-creation', managedSource: { sourceId: 'mote-main:private-original', revision: roleRevision }, preparedAt: 1200 }
  const currentSchedule = () => ({ ...schedule(), revision: 5, status: surface === 'paused' ? 'paused' : 'active',
    ...(surface === 'paused' ? { pause: { reason: 'input-unconfirmed', episodeId: 'original-care-pause', pausedAt: 1300 } } : {}),
    lastInputRef: originalReference, lastOutcome: 'sent', lastTickAt: 1200 })
  const input = () => ({ reference: originalReference, status: 'confirmed', delivery: surface === 'failed' ? 'native-admitted' : 'terminal-confirmed',
    nativeResult: surface === 'failed' ? { state: 'failed', observedAt: 1600 } : { state: 'unsupported' } })
  api.motePreferences.read = async query => ({ ...await preferences(query), maintenance: { status: surface === 'paused' ? 'paused' : 'active', schedule: currentSchedule(), issue: null,
    guidance: { availableRevision: 'updated-care-guidance', currentDefinition: { intentId: originalReference.futureIntent.intentId, operationId: originalReference.definitionOperationId }, adoptedRevision: null, adoptions: [] } } })
  api.schedule.inspect = async query => ({ schedule: query.scheduleId === 'original-mote-heartbeat' ? currentSchedule() : null, input: input(), executionScope: 'connected-host' })
  api.moteDialogue.read = async query => {
    const page = await dialogue(query)
    if (query.kind !== 'heartbeat') return page
    return { ...page, throughSequence: 1, links: [{ kind: 'heartbeat', attribution: 'agent-statement', sequence: 1, identity: page.main.identity, operationId: 'original-care-report', associatedAt: 1700,
      source: { inputKey: originalKey, scheduleId: 'original-mote-heartbeat', definitionIntentId: originalReference.futureIntent.intentId, occurrenceAt: 1000, mainRoleRevision: roleRevision },
      author: { hostId: reference.hostId, agentSessionId: reference.sessionId, run: session.control.run },
      report: { disposition: surface === 'attention' ? 'needs-attention' : 'quiet', summary: 'Reviewed the open work and saved a small experiment for the next discussion.', inspected: [{ kind: 'work', incarnation: page.incarnation, throughSequence: 0, next: null, sourceStatus: 'read', issue: null }],
        actions: [{ kind: 'idea', path: 'ideas/care-experiment.md', resource: { ...page.main.resource, path: page.main.resource.path.replace(/MOTE\.md$/u, 'ideas/care-experiment.md') }, revision: currentDocument.document.revision }] },
      ideaEvidence: [{ actionIndex: 0, status: 'observed-file', revision: currentDocument.document.revision, observedAt: 1750 }] }] }
  }
  api.motePreferences.save = async query => {
    if (!query.action) return save(query)
    saves.push(structuredClone(query))
    return { kind: 'quick', target: query.target, operationId: query.operationId, status: 'unconfirmed', source: null, message: 'The original adoption receipt is unavailable. Its complete request is retained for inspection.' }
  }
  window.moteHeartbeatSurface = { ready: true, saves, variant(value) { surface = value; variant = value === 'paused' ? 'paused' : 'active' }, pending: () => Object.entries(useLauncherState.getState().drafts).find(([, value]) => value.moteQuick?.pending) ?? null }
  variant = 'active'
}


// A controlled original Core failure. This scene changes no real Runtime or Provider.
if (new URLSearchParams(location.search).get('main-recovery-escape') === '1' || new URLSearchParams(location.search).get('main-policy-service') === '1') {
  const tab = useAppStore.getState().tabs[tabId], workspace = useAppStore.getState().config.workspaces.find(value => value.id === SCRATCH_WORKSPACE_ID)
  const target = { spaceId: tab.space.spaceId, zoneId: tab.space.zoneId, expectedResource: { hostId:workspace.hostId, workspaceId:workspace.id, workspacePath:workspace.path } }
  const topic = await api.scratch.readTopic(SCRATCH_WORKSPACE_ID,PMO_TEAMS_TOPIC_ID)
  if (!topic) throw Error('Original Mote draft scope is unavailable')
  const draftKey = moteEntryDraftKey({workspace,topic,rootPath:scratchTopicLogicalPath(workspace,topic) ?? scratchTopicDirectoryName(topic.id)})
  let mode = 'unavailable'
  const sendAttempts = []
  const originalRecovery = () => ({ operationId:'original-main-recovery',agentSessionId:session.id,previousRun:session.control.run,
    trigger:'manual',policy:{...DEFAULT_AGENT_CONTINUITY_POLICY},admittedAt:1,observedAt:2,rechecks:1,
    kind:mode === 'unknown' ? 'pending' : 'unavailable',reason:mode === 'unknown' ? 'operation-unconfirmed' : 'native-handle-unavailable',
    evidence:mode === 'unknown' ? {kind:'run-unknown',observedAt:2,message:'Original recovery reply is unconfirmed'} : {kind:'run-ended',state:'exited',observedAt:2} })
  const apply = () => useAppStore.setState(state => ({ sessions:state.sessions.map(value => value.id === session.id ? { ...value,processState:'exited',continuity:mode === 'unreported' ? undefined : originalRecovery(),
    status:{state:'error',source:'run-process',observedAt:2,exitCode:0,exitReason:'unknown',...(mode === 'unavailable' ? {continuity:'unavailable',continuityReason:'native-handle-unavailable'} : {})} } : value) }))
  apply()
  const refresh = api.sessions.refresh
  api.sessions.refresh = async control => control.agentSessionId === session.id ? useAppStore.getState().sessions.find(value => value.id === session.id) : refresh(control)
  api.moteDialogue.inspectRecovery = async request => ({ operation: mode === 'unreported' ? null :
    {...originalRecovery(),operationId:request.operationId,moteMainEntry:{target:request.target,expectedRoleRevision:request.expectedRoleRevision,reference:request.reference}} })
  api.moteDialogue.ensureRecovery = async () => { throw Error('This read-only failure scene does not admit a recovery mutation') }
  if (new URLSearchParams(location.search).has('main-policy-service')) {
    const groupCall = api.moteGroup.call
    api.moteGroup.call = async (method, params) => method === 'space.mote.direct.list'
      ? { threads: [], nextBeforeSequence: null } : groupCall(method, params)
    const recover = api.sessions.recover
    api.sessions.recover = async (control, workspacePath, operationId, request) => {
      if (mode !== 'unreported' || control.agentSessionId !== session.id || !request?.moteMain || !request.input)
        return recover(control, workspacePath, operationId, request)
      sendAttempts.push({ control, operationId, request })
      const continuity = { ...originalRecovery(), operationId, trigger: 'input',
        launchInput: { input: request.input, prompt: request.input.prompt, message: { userContent: request.input.prompt },
          digest: 'original-input', delivery: 'post-launch', lifecycleOperationId: operationId, state: 'prepared' } }
      return { kind: continuity.kind, agentSessionId: continuity.agentSessionId, previousRun: continuity.previousRun,
        reason: continuity.reason, evidence: continuity.evidence, continuity,
        inputFailure: { name: 'AgentMuxError', code: 'AGENT_NATIVE_IDENTITY_UNCONFIRMED', message: '需要接续原会话。',
          controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } } }
    }
  }
  window.moteRecoveryEscape = { ready:true, target, draftKey,
    floating() { requestPmoTeamsTopicFloatingOpen({targetTopicId:PMO_TEAMS_TOPIC_ID}) },
    variant(value) { mode=value;apply() },
    async policy(value, split = false) {
      const current = await api.files.read(SCRATCH_WORKSPACE_ID, path)
      if (current.status !== 'read') throw Error('Original policy document is unavailable')
      await api.files.write(SCRATCH_WORKSPACE_ID, { path, expectedRevision:current.document.revision,
        content:serializeMoteQuickMode(current.document.content, { executorId:'cck3',conversation:reference,presence:{enabled:true,intervalMs:1800000},
          ...(value === 'automatic' ? {conversationRollover:{kind:'idle',idleMs:60000}} : value === 'keep-current' ? {conversationRollover:{kind:'keep-current'}} : {}) }) })
      await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID,true,PMO_TEAMS_TOPIC_ID)
      useAppStore.setState({ projectRailOpen:split,toolsOpen:split,workspaceTool:'files-branches',toolDockWidth:340 })
    },
    async retainOriginal(prompt,draft) {
      if (restoring || !prompt?.trim()) throw Error('Only the original seed process can author this retained request')
      if (!draft?.trim() || !useLauncherState.getState().setDraft(draftKey,'prompt',draft)) throw Error('The original Mote draft is not retained')
      await retainMoteMainCreationReference({target,operationId:'original-unknown-main-start',deferredInput:{operationId:'original-unknown-first-query',prompt}},null)
      fixtureWrites.push('seed-original-unknown-request')
    },
    facts: () => ({ mainRequests:structuredClone(useAppStore.getState().moteMainCreationReferences),session:useAppStore.getState().sessions.find(value=>value.id===session.id),
      sendAttempts, queue: useAppStore.getState().agentSteerQueues[session.id] ?? [] })
  }
}
