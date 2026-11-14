// Complete production App and ordinary initialize, sharing the existing private public-port fixture.
import './ports.mjs'
import '../mote-initialization/entry.mjs'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { initializeLauncherState, useLauncherState } from '../../../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../../../src/renderer/src/lib/workbench-tabs'
import { serializeMoteQuickMode, PMO_TEAMS_TOPIC_ID, SCRATCH_WORKSPACE_ID, scratchTopicDirectoryName } from '@agentmux/host/mote-model'
import { parseScheduleRpcParams } from '@agentmux/core/schedule-rpc'

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
const readPreferences = api.motePreferences.read
let variant = 'paused'
const schedule = () => ({ loopId: 'original-mote-heartbeat', hostId: reference.hostId, agentSessionId: reference.sessionId, providerId: session.providerId, workspacePath: session.workspacePath,
  everyMs: 1800000, intervalMs: 1800000, revision: variant === 'active' ? 5 : 4, prompt: 'Check current work and unfinished commitments.',
  status: variant === 'active' ? 'active' : 'paused', nextCheckAt: Date.now() + 25 * 60000, lastTickAt: Date.now() - 5 * 60000,
  lastOutcome: variant === 'active' ? 'sent' : 'unknown', lastDecision: variant === 'active' ? 'The original input was accepted.' : 'The original Host connection was unavailable. Delivery remains unconfirmed.',
  ...(variant === 'active' ? {} : { pendingCompletion: { id: 'original-occurrence', operationId: 'original-heartbeat-input', condition: { expectedRun: session.control.run, afterSubmissionId: null }, prompt: 'Check current work and unfinished commitments.', agentMuxNote: 'Original maintenance input.' } }) })
api.motePreferences.read = async input => ({ ...await readPreferences(input), maintenance: variant === 'unbound' ? { status: 'unbound', schedule: null, issue: null }
  : { status: variant === 'active' ? 'active' : 'paused', schedule: schedule(), issue: variant === 'active' ? null : 'Delivery remains unconfirmed. The original input is kept; check its original schedule.' } })
api.schedule.list = async input => { parseScheduleRpcParams('schedule.list', input); return { schedules: [schedule()], executionScope: 'connected-host' } }
api.moteDialogue.read = async ({ target }) => ({ main: { target, identity: { hostId: 'local', moteId: PMO_TEAMS_TOPIC_ID }, status: 'ready', resource: null,
  documentRevision: document.document.revision, roleRevision: 'original-main-role', current: reference, issue: null }, links: [], incarnation: 'original-dialogue', throughSequence: 0, next: null,
  coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null })
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
  variant(value) { variant = value },
  startup() {
    originalCreation = { createOperationId: 'original-start-operation', initialPrompt: 'unconfirmed', createdRun: session.control.run,
      workspaceTrust: { lifecycleOperationId: 'original-start-operation', workspacePath: session.workspacePath, status: 'unconfirmed', step: 'trust-record', trustKey: null,
        code: 'NATIVE_CONFIGURATION_UNAVAILABLE', issue: 'The original native configuration could not be read. The original Session is kept.', observedAt: Date.now() } }
    useAppStore.setState(state => ({ sessions: state.sessions.map(value => value.id === session.id ? { ...value, creation: originalCreation } : value) }))
  }
}
