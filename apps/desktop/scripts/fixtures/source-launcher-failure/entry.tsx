import { flushSync } from 'react-dom'
import { mountThemeRuntime, updateThemeSelection } from '@agentmux/client-ui/theme'
import { useAppStore } from '../../../src/renderer/src/store'
import { api } from '../../../src/renderer/src/lib/api'
import { mountedAgentOpenKey, type MountedAgentOpenInput } from '../../../src/renderer/src/lib/space-mount-launch'

// The existing complete Workbench/NewTabSurface fixture owns native preview IO.
// This extension controls only public Source reply DTOs, never a real task.
mountThemeRuntime(window, { appAppearance: 'dark' })
await import('../launcher-launchpad/entry')
const launchpad = (window as any).launchpad
launchpad.scene({ executorCount: 2 })
const state = useAppStore.getState(), project = state.config!.workspaces[0]!
const target = { hostId: 'original-source', reference: { runtimeId: 'original-source-runtime', spaceId: 'original-source-space' }, workspaceId: project.id, zoneId: 'original-zone' }
const request = { operationId: 'original-creation-operation', content: { kind: 'new-agent' as const, executorId: 'original-executor', agentTarget: { hostId: 'original-agent-host', runtimeId: 'original-agent-runtime' }, prompt: 'The original submitted task is retained independently from this newer private draft.' }, destination: { spaceId: target.reference.spaceId, zoneId: target.zoneId, newTab: true as const }, focus: false }
type Report = NonNullable<MountedAgentOpenInput['receipt']>
const reference = { bindingId: 'original-binding', agentSessionId: 'original-agent-session', createOperationId: request.operationId }
const execution: NonNullable<Report['execution']> = { coordinatorRuntimeId: target.reference.runtimeId, reference, inspection: { bindingId: reference.bindingId, agentHostId: 'original-agent-host', resourceHostId: 'local', agentSessionId: reference.agentSessionId, resourceWorkspacePath: '/original/project', continuation: reference, state: 'unavailable', diagnostic: { code: 'EXECUTION_CREATION_UNCONFIRMED', message: 'The original protocol reader is unconfirmed.' }, helperStarts: { executor: { outcome: 'confirmed', runId: 'original-executor-helper' }, frontend: { outcome: 'confirmed', runId: 'original-frontend-helper' } } } }
const { diagnostic: _diagnostic, ...connectedInspection } = execution.inspection!
const writer: Report['issues'][number] = { step: 'creation', code: 'EXECUTION_OWNER_UNAVAILABLE', message: 'The original execution coordinator already has a writer.', recovery: 'Inspect the same original request.' }
const attach: Report['issues'][number] = { step: 'creation', code: 'EXECUTION_CREATION_UNCONFIRMED', message: "Expected ',' or ']' after array element in JSON at position 5 (line 1 column 6)", recovery: 'Inspect the same original request.', executionFailure: { reference: execution.reference, hostId: 'local', role: 'executor', stage: 'attach' } }
let scenario = 'attach'
let receipt: Report = { operationId: request.operationId, outcome: 'unknown' as const, from: null, to: null, agent: null, resource: null, execution,
  save: { layoutApplied: true, clientStateWritten: false, storageFlushRequested: false, diskDurability: 'confirmed' as const, reason: null }, issues: [attach] }
const input: MountedAgentOpenInput = { kind: 'agent-open', target, slot: { kind: 'new-work', zoneId: target.zoneId }, request, submitted: true, receipt,
  origin: { kind: 'ordinary-launcher', launcherId: 'region:launchpad-input', project, names: { agentName: '', tabName: '' } } }
let effects = 0, reads = 0, failed = false
api.ui.writeClipboardText = (text: string) => (window as any).agentmux.ui.writeClipboardText(text)
api.spaceMounts.call = (async (method: string) => {
  if (method !== 'inspect') { effects++; throw Error('The visual fixture never advances work: ' + method) }
  reads++
  if (failed) throw Error('The latest Source read is unavailable. The original creation receipt remains retained.')
  return { request: { known: true, operationId: request.operationId, report: { ...receipt, issues: [{ step: 'observation', code: 'HOST_ROUTE_AUTHORIZATION_REQUIRED', message: 'The current viewer has not confirmed its original observation route.', recovery: 'Read the same original request.' }] } } }
}) as typeof api.spaceMounts.call
flushSync(() => {
  useAppStore.setState({ mountedSpaceInputs: { [mountedAgentOpenKey(target, input.slot)]: input } })
  useAppStore.getState().setAgentComposerDraft('launchpad-input', 'Keep this newer private draft unsent while checking the original task.')
})
Object.assign(window, { sourceFailure: {
  scenario: (next: string) => {
    scenario = next; failed = false
    receipt = { ...receipt, execution: next === 'writer' ? { ...execution, inspection: null } : next === 'confirmed' ? { ...execution, inspection: { ...connectedInspection, state: 'connected' } } : execution, outcome: next === 'confirmed' ? 'opened' : next === 'retired' ? 'retired' : 'unknown', agent: next === 'confirmed' || next === 'retired' ? { hostId: 'original-agent-host', agentSessionId: 'original-agent-session', createOperationId: request.operationId, runId: 'original-agent-run', providerId: 'codex', executorId: 'original-executor', cwd: '/original/agent', initialPrompt: 'confirmed', ...(next === 'retired' ? { retirement: { source: 'user', observedAt: 2 } } : {}) } : null, issues: [next === 'writer' ? writer : attach] }
    const updated = { ...input, request: { ...request }, receipt }
    flushSync(() => useAppStore.setState({ mountedSpaceInputs: { [mountedAgentOpenKey(target, input.slot)]: updated } }))
  },
  theme: (appAppearance: 'dark' | 'light') => updateThemeSelection({ appAppearance }),
  fail: () => { failed = true },
  facts: () => ({ effects, reads, prompt: useAppStore.getState().agentComposerDrafts['launchpad-input'], request: input.request, calls: launchpad.facts().calls })
} })
