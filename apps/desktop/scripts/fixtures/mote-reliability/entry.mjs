// Complete production App and ordinary initialize, sharing the existing private public-port fixture.
import { stagedMotePreferenceReader, bindMotePreferenceReader } from './ports.mjs'
import '../mote-initialization/entry.mjs'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { initializeLauncherState, useLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { serializeMoteQuickMode, PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '@agentmux/host/mote-model'
import { parseScheduleRpcParams } from '@agentmux/core/schedule-rpc'
import { moteMainRoleRevision } from '@agentmux/core/mote-dialogue'
import { observeNotifications } from '../../../src/renderer/src/lib/notification-observation'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'

await initializeLauncherState()
const original = useAppStore.getState(), session = original.sessions.find(value => value.id === 'mote-primary')
if (!session || session.control.kind !== 'agent') throw Error('Original controlled Session required')
const restoring = window.moteInit.phase === 'initialization-restore'
const inputAtEntry = structuredClone({ drafts: useLauncherState.getState().drafts, agentDrafts: original.agentComposerDrafts,
  tab: original.tabs['original-initialization-tab'], layouts: original.layouts, selection: original.workbenchSpaceSelection, focus: original.agentFocus, control: session.control })
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
  return { schedule: input.scheduleId === 'original-mote-heartbeat' ? schedule() : null, executionScope: 'connected-host' }
}
bindMotePreferenceReader()
await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true, PMO_TEAMS_TOPIC_ID)
const retainedKey = 'private-mote-reliability-original-draft'
if (!restoring) { useLauncherState.getState().setDraft(retainedKey, 'prompt', 'Original retained Mote draft across a real Renderer restart.'); fixtureWrites.push('launcher-draft') }
window.moteReliability = { ready: true, reference,
  facts: () => ({ ...window.moteInit.facts(), variant, inputAtEntry, fixtureWrites: [...fixtureWrites], agentDrafts: useAppStore.getState().agentComposerDrafts, focus: useAppStore.getState().agentFocus,
    readingIssues: [...globalThis.document.querySelectorAll('.conversation-read-issues__source')].map(node => node.textContent), session: useAppStore.getState().sessions.find(value => value.id === session.id) }),
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
  startup() {
    originalCreation = { createOperationId: 'original-start-operation', initialPrompt: 'unconfirmed', createdRun: session.control.run,
      workspaceTrust: { lifecycleOperationId: 'original-start-operation', workspacePath: session.workspacePath, status: 'unconfirmed', step: 'trust-record', trustKey: null,
        code: 'NATIVE_CONFIGURATION_UNAVAILABLE', issue: 'The original native configuration could not be read. The original Session is kept.', observedAt: Date.now() } }
    useAppStore.setState(state => ({ sessions: state.sessions.map(value => value.id === session.id ? { ...value, creation: originalCreation } : value) }))
  }
}
