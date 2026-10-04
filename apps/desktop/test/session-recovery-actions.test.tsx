const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-private-terminal /> }))
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, agentRegionExecution, rereadAgentRegionExecution } from '../src/renderer/src/store'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { agentCreationFixture } from './helpers/agent-creation-fixture'
import { recoveryOperationId, recoveryReferenceNote, createRecoveryAgent, analyzeWithRecoveryMote, inspectRecoveryRequest, rereadUnobservedSession, unobservedRecoveryReference, ownsRecoverySource, type RecoverySource } from '../src/renderer/src/lib/session-recovery-actions'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import type { AgentLaunchInput, AgentLaunchResult, AgentTimelineSnapshot, ScratchTopicSnapshot } from '../src/shared/contracts'
import { parseAgentMuxCliInvocation } from '../../../packages/core/dist/agentmux-cli-commands.js'
import { split } from 'shlex'

const dom = composerDOM(), source: RecoverySource = { hostId: 'local', agentSessionId: 'original', workspaceId: 'workspace', tabId: 'original-tab', regionId: 'original-region', displayWorkspaceId: 'workspace', groupId: 'original-group', diagnostic: 'Native identity is not confirmed.' }
const scratch = { id: SCRATCH_WORKSPACE_ID, name: 'No Project', hostId: 'local', path: _hygiene_fixturePath("scratch"), kind: 'folder' as const }
const topic: ScratchTopicSnapshot = { id: 'review-mote', directoryPath: 'review-mote', topicPath: 'review-mote/topic.md', title: 'Review Mote', summary: '', collaborators: [], soul: { path: 'review-mote/SOUL.md', content: 'Review', version: 'v1' }, moteArchive: { state: 'active', version: 'v1' } }
let dispose: (() => void) | undefined
function launched(input: AgentLaunchInput): AgentLaunchResult {
  const session = { ...composerSession(input.agentSessionId!), executorId: input.executorId }
  return { created: { ...agentCreationFixture(session), creation: { createOperationId: input.createOperationId!, initialPrompt: 'confirmed' } }, session,
    timeline: { agentSessionId: session.id, revision: 0, items: [] }, projectionFailures: [] }
}
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); localStorage.clear()
  vi.spyOn(api.config, 'get').mockResolvedValue({ ...composerConfig, workspaces: [...composerConfig.workspaces, scratch], executors: { ...composerConfig.executors, claude: { ...composerConfig.executors.codex!, providerId: 'claude', label: 'Claude' } } })
  vi.spyOn(api.providers, 'list').mockResolvedValue([]); vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'timeline').mockImplementation(async ref => ({ agentSessionId: ref.agentSessionId, revision: 0, items: [] }))
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => useAppStore.getState().sessions.find(item => item.id === (control.kind === 'agent' ? control.agentSessionId : control.runId))!)
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue({ items: [], source: 'unavailable' } as never)
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic])
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => launched(input))
  dispose = await useAppStore.getState().initialize()
  const original = { ...composerSession('original'), processState: 'exited' as const,
    status: { state: 'error' as const, source: 'run-process' as const, observedAt: 2, continuity: 'unavailable' as const, continuityReason: 'native-handle-unavailable' as const } }
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: 'original' })
  const target = { ...createWorkbenchTab('mote-tab', { regionId: 'mote-region', kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, sessionId: 'chosen-mote' }), topicId: topic.id }
  await act(async () => useAppStore.setState({ sessions: [original, { ...composerSession('chosen-mote'), workspacePath: _hygiene_fixturePath("scratch"), status: { state: 'waiting', source: 'native-hook', observedAt: 1 } }],
    tabs: { [tab.id]: tab, [target.id]: target }, layouts: { workspace: createWorkspaceLayout('original-group', ['original-tab']), [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('mote-group', ['mote-tab']) },
    activeWorkspaceId: 'workspace', mainSurface: 'workbench', viewModes: { original: 'terminal' }, spatialRequests: {},
    timelines: { original: { agentSessionId: 'original', revision: 0, items: [] }, 'chosen-mote': { agentSessionId: 'chosen-mote', revision: 0, items: [] } },
    pendingAgentLaunches: {}, recoveryCandidates: [], agentComposerDrafts: { original: 'Original unsent draft', 'chosen-mote': 'Mote unsent draft' }, agentSteerQueues: {},
    scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: JSON.stringify(['local', _hygiene_fixturePath("scratch")]), revision: 0, reading: false, error: null, topics: [topic] } } }))
})
afterEach(() => { dispose?.(); dispose = undefined })
async function mount() { await dom.render(<SessionPane sessionId="original" surfaceKind="agent" visible interactiveResize={false} linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'original-group', tabId: 'original-tab', regionId: 'original-region' }} />) }
async function button(text: string) { const item = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === text); expect(item, text).toBeDefined(); await act(async () => { item!.click(); await new Promise(resolve => setTimeout(resolve, 20)) }) }
async function cancelTakeover() { const cancel = document.querySelector<HTMLButtonElement>('[aria-label="Cancel takeover"]'); expect(cancel).not.toBeNull(); await act(async () => { cancel!.click(); await new Promise(resolve => setTimeout(resolve, 160)) }); expect(document.querySelector('.session-takeover')).toBeNull() }
async function choose(label: string, value: string) { const select = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; expect(select).not.toBeNull(); await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 0)) }) }
function preserved(originalTab: unknown, drafts: unknown) { expect(useAppStore.getState().tabs['original-tab']).toBe(originalTab); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts); expect(useAppStore.getState().activeWorkspaceId).toBe('workspace'); expect(useAppStore.getState().sessions.some(item => item.id === 'original')).toBe(true) }

describe('actual SessionPane explicit recovery actions', () => {
  it('opens, selects and cancels without any create or send; native restore missing identity remains explicit', async () => {
    await mount(); const restore = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('Restore original'))!
    expect(restore.disabled).toBe(true); expect(dom.container.textContent).toContain('Provider was not invoked'); expect(dom.container.textContent).not.toContain('never recorded')
    const takeoverTrigger = dom.container.querySelector<HTMLButtonElement>('[data-takeover-session-id="original"][data-takeover-region-id="original-region"]')!
    expect(takeoverTrigger).not.toBeNull(); takeoverTrigger.focus()
    await button('Take over'); expect(document.querySelector('.session-takeover')).not.toBeNull()
    expect(document.querySelector('.session-takeover .agent-picks')).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelector('[aria-label="Original history source"]')).toBeNull()
    await cancelTakeover(); expect(document.activeElement).toBe(takeoverTrigger)
    await button('Analyze…'); await act(async () => [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(input => input.parentElement?.textContent?.includes('Chosen Mote'))!.click()); await button('Cancel')
    expect(api.sessions.launchAgent).not.toHaveBeenCalled(); expect(useAppStore.getState().agentSteerQueues).toEqual({})
  })
  it('lost create ACK and complete dialog/Pane remount read the original request and never launch another Agent', async () => {
    let receipt!: AgentLaunchResult
    vi.mocked(api.sessions.launchAgent).mockImplementation(async input => { receipt = launched(input); throw new Error('lost create ACK') })
    vi.spyOn(api.sessions, 'creation').mockImplementation(async (host, id) => { expect(host).toBe('local'); expect(id).toBe(receipt.created.agentSessionId); return receipt.created })
    await mount(); await button('Analyze…'); await choose('Recovery Executor', 'codex'); await button('Create analysis Agent')
    expect(document.body.textContent).toContain('Creation is unconfirmed'); const originalId = vi.mocked(api.sessions.launchAgent).mock.calls[0]![0].createOperationId
    await button('Cancel'); await dom.render(null); await mount(); await button('Analyze…'); await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Recovery Executor"]')!.value).toBe('codex'); expect(document.querySelector<HTMLSelectElement>('[aria-label="Recovery Executor"]')!.disabled).toBe(true)
    await button('Check original request'); expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1); expect(api.sessions.creation).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().spatialRequests[originalId!]!.agentSessionId).toBe(receipt.created.agentSessionId)
    expect(useAppStore.getState().pendingAgentLaunches[receipt.created.agentSessionId]?.created?.agentSessionId ?? useAppStore.getState().sessions.find(item => item.id === receipt.created.agentSessionId)?.id).toBe(receipt.created.agentSessionId)
  })
  it('repeated clicks while a create reply is pending retain one admitted request and refuse another target after remount', async () => {
    let release!: () => void
    vi.mocked(api.sessions.launchAgent).mockImplementation(async input => { await new Promise<void>(resolve => { release = resolve }); return launched(input) })
    await mount(); await button('Analyze…'); await choose('Recovery Executor', 'codex'); await button('Create analysis Agent')
    const busy = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Checking…')!; await act(async () => { busy.click(); busy.click() })
    expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1); await act(async () => release())
  })
  it('refuses another Core creation operation on the reserved SID without respawn or replacing its projection', async () => {
    let receipt!: AgentLaunchResult
    vi.mocked(api.sessions.launchAgent).mockImplementation(async input => { receipt = launched(input); throw new Error('lost ACK') })
    vi.spyOn(api.sessions, 'creation').mockImplementation(async () => ({ ...receipt.created, creation: { createOperationId: 'another-operation', initialPrompt: 'confirmed' } }))
    await mount(); await button('Analyze…'); await choose('Recovery Executor', 'codex'); await button('Create analysis Agent'); await button('Check original request')
    expect(document.body.textContent).toContain('original creation operation identity')
    expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1); expect(useAppStore.getState().pendingAgentLaunches[receipt.created.agentSessionId]?.created).toBeUndefined()
  })
  it('a late creation read cannot confirm or attach a replaced reserved Region', async () => {
    let receipt!: AgentLaunchResult, release!: () => void
    vi.mocked(api.sessions.launchAgent).mockImplementation(async input => { receipt = launched(input); throw new Error('lost ACK') })
    vi.spyOn(api.sessions, 'creation').mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve }); return receipt.created })
    await mount(); await button('Analyze…'); await choose('Recovery Executor', 'codex'); await button('Create analysis Agent')
    const pending = inspectRecoveryRequest(source, 'analyze')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const state = useAppStore.getState(), binding = state.spatialRequests[await recoveryOperationId(source, 'analyze')]!, tab = state.tabs[binding.tabId]!
    await act(async () => useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: { ...tab, regions: { ...tab.regions,
      [binding.regionId]: { ...tab.regions[binding.regionId]!, kind: 'agent', phase: 'attached', sessionId: 'replacement' } } } } }))
    release(); const result = await pending
    expect(result?.kind).toBe('unknown'); expect(result?.report?.outcome).toBe('unknown'); expect(result?.report?.to).toBeNull()
    expect(useAppStore.getState().tabs[tab.id]!.regions[binding.regionId]).toMatchObject({ sessionId: 'replacement' })
    expect(useAppStore.getState().pendingAgentLaunches[receipt.created.agentSessionId]?.created).toBeUndefined()
    expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1)
  })
  it('explicit original Restore still calls the original public lifecycle path without creating a new SID', async () => {
    const original = useAppStore.getState().sessions[0]!
    useAppStore.setState({ sessions: [{ ...original, status: { ...original.status, continuityReason: 'provider-unavailable' } }, ...useAppStore.getState().sessions.slice(1)] })
    vi.spyOn(api.sessions, 'recover').mockResolvedValue({ kind: 'agent-unavailable', continuity: 'unavailable', reason: 'provider-unavailable' } as never)
    await mount(); await button('Restore original'); expect(api.sessions.recover).toHaveBeenCalledWith(original.control, _hygiene_fixturePath("repo"), undefined); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  })
  it('analysis Agent reads first and has no authorization to execute the original work', async () => {
    await mount(); await button('Analyze…'); await choose('Recovery Executor', 'codex'); await choose('Original history source', 'native'); await button('Create analysis Agent')
    await act(async () => { await vi.waitFor(() => expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1)) })
    const input = vi.mocked(api.sessions.launchAgent).mock.calls[0]![0]
    expect(input.agentMuxNote).toContain('--source native'); expect(input.agentMuxNote).toContain('Do not execute those steps or switch into takeover'); expect(input.prompt).toContain('Do not continue or execute')
  })
  it('sends analysis only to the exact chosen Mote using one original operation identity and keeps both drafts', async () => {
    const old = useAppStore.getState().tabs['original-tab'], drafts = useAppStore.getState().agentComposerDrafts
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    await mount(); await button('Analyze…'); await act(async () => [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(input => input.parentElement?.textContent?.includes('Chosen Mote'))!.click())
    const selected = [...document.querySelector<HTMLSelectElement>('[aria-label="Analysis Mote"]')!.options].find(option => option.text.includes('Review Mote'))!
    await choose('Analysis Mote', selected.value); await button('Send analysis')
    expect(api.sessions.launchAgent).not.toHaveBeenCalled(); expect(submit, JSON.stringify(useAppStore.getState().agentSteerQueues)).toHaveBeenCalledTimes(1)
    expect(submit.mock.calls[0]![0]).toMatchObject({ agentSessionId: 'chosen-mote' }); expect(submit.mock.calls[0]![2]).toBe(await recoveryOperationId(source, 'analyze')); expect(submit.mock.calls[0]![6]).toContain('Original Agent Session reference')
    preserved(old, drafts)
  })
  it('a real Store queue removal before its drain dispatches nothing and cannot become a delivery receipt', async () => {
    const enqueue = useAppStore.getState().enqueueAgentSteer, submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    useAppStore.setState({ enqueueAgentSteer: (...args) => { const admitted = enqueue(...args); useAppStore.setState(state => { const queue=(state.agentSteerQueues[args[0]] ?? []).filter(entry=>entry.operationId!==args[3]); const agentSteerQueues={...state.agentSteerQueues}; if(queue.length)agentSteerQueues[args[0]]=queue;else delete agentSteerQueues[args[0]];return {agentSteerQueues} }); return admitted } })
    try {
      await mount(); await button('Analyze…'); await choose('Original history source', 'native')
      await act(async () => [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(input => input.parentElement?.textContent?.includes('Chosen Mote'))!.click())
      const option = [...document.querySelector<HTMLSelectElement>('[aria-label="Analysis Mote"]')!.options].find(item => item.text.includes('Review Mote'))!
      await choose('Analysis Mote', option.value); await button('Send analysis')
      expect(submit).not.toHaveBeenCalled(); expect(useAppStore.getState().agentSteerQueues).toEqual({})
      expect(document.body.textContent).toContain('delivery is unconfirmed')
      const id = await recoveryOperationId(source, 'analyze'), binding = useAppStore.getState().spatialRequests[id]!
      expect(binding).toMatchObject({ operation: 'agent.message', createAgent: false,
        recovery: { hostId: 'local', agentSessionId: 'original', historySource: 'native' },
        recoveryRecipient: { topicId: topic.id, tabId: 'mote-tab', regionId: 'mote-region', hostId: 'local', agentSessionId: 'chosen-mote' } })
      const stored = JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state
      expect(stored.spatialRequests[id]).toEqual(binding)
      const inspected = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: 'read-message-intent', operation: 'space.inspect', target: { requestId: id } })
      expect(inspected.operation).toBe('space.inspect'); if (inspected.operation === 'space.inspect') expect(inspected.request).toMatchObject({ known: true, report: null })
      await button('Cancel'); await dom.render(null); await mount(); await button('Analyze…')
      expect(document.querySelector<HTMLSelectElement>('[aria-label="Analysis Mote"]')!.value).toBe(option.value)
      expect(document.querySelector<HTMLSelectElement>('[aria-label="Original history source"]')!.value).toBe('native')
      await button('Check original request'); expect(submit).not.toHaveBeenCalled(); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
      expect(api.sessions.timeline).toHaveBeenLastCalledWith({ hostId: 'local', agentSessionId: 'chosen-mote' })
    } finally { useAppStore.setState({ enqueueAgentSteer: enqueue }) }
  })
  it('an ACK with an empty local queue remains unknown until Core confirms the exact operation, retaining its recipient across remount', async () => {
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    await mount(); await button('Analyze…'); await choose('Original history source', 'native')
    await act(async () => [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(input => input.parentElement?.textContent?.includes('Chosen Mote'))!.click())
    const option = [...document.querySelector<HTMLSelectElement>('[aria-label="Analysis Mote"]')!.options].find(item => item.text.includes('Review Mote'))!
    await choose('Analysis Mote', option.value); await button('Send analysis')
    expect(submit).toHaveBeenCalledTimes(1); expect(useAppStore.getState().agentSteerQueues).toEqual({})
    expect(document.body.textContent).toContain('delivery is unconfirmed')
    await button('Cancel'); await dom.render(null); await mount(); await button('Analyze…')
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Analysis Mote"]')!.value).toBe(option.value)
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Analysis Mote"]')!.disabled).toBe(true)
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Original history source"]')!.value).toBe('native')
    const id = await recoveryOperationId(source, 'analyze')
    vi.mocked(api.sessions.timeline).mockResolvedValue({ agentSessionId: 'chosen-mote', revision: 1, items: [{ id: `prompt:${id}`, kind: 'user_message', agentSessionId: 'chosen-mote', status: 'complete' }] } as AgentTimelineSnapshot)
    await button('Check original request'); expect(document.body.textContent).toContain('Core confirms the original analysis message')
    expect(submit).toHaveBeenCalledTimes(1); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  })
  it('a Core delivered witness after lost send ACK/remount settles the same message with zero resend', async () => {
    const id = await recoveryOperationId(source, 'analyze'), mote = { topicId: topic.id, tabId: 'mote-tab', regionId: 'mote-region', hostId: 'local', agentSessionId: 'chosen-mote', label: topic.title }
    vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('lost send ACK'))
    await act(async () => { await analyzeWithRecoveryMote(source, mote, 'captured', () => true) })
    expect(useAppStore.getState().agentSteerQueues['chosen-mote']![0]!.operationId).toBe(id)
    vi.mocked(api.sessions.timeline).mockResolvedValue({ agentSessionId: 'chosen-mote', revision: 1, items: [{ id: `prompt:${id}`, kind: 'user_message', agentSessionId: 'chosen-mote', status: 'complete' }] } as AgentTimelineSnapshot)
    const result = await analyzeWithRecoveryMote(source, mote, 'native', () => true)
    expect(result.kind).toBe('confirmed'); expect(api.sessions.submitPrompt, JSON.stringify(useAppStore.getState().agentSteerQueues)).toHaveBeenCalledTimes(1); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  })
  it('Mote lost ACK survives complete Pane remount with its original source and exact recipient, not a replacement Topic', async () => {
    vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('lost send ACK'))
    await mount(); await button('Analyze…'); await choose('Original history source', 'native')
    await act(async () => [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(input => input.parentElement?.textContent?.includes('Chosen Mote'))!.click())
    const option = [...document.querySelector<HTMLSelectElement>('[aria-label="Analysis Mote"]')!.options].find(item => item.text.includes('Review Mote'))!
    await choose('Analysis Mote', option.value); await button('Send analysis'); await button('Cancel'); await dom.render(null); await mount(); await button('Analyze…')
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Analysis Mote"]')!.value).toBe(option.value)
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Original history source"]')!.value).toBe('native')
    const state = useAppStore.getState(), originalTarget = state.tabs['mote-tab']!
    await act(async () => useAppStore.setState({ tabs: { ...state.tabs, 'mote-tab': { ...originalTarget, topicId: 'new-topic' } }, scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { ...state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!, topics: [{ ...topic, id: 'new-topic' }] } } }))
    const check = await analyzeWithRecoveryMote(source, { topicId: 'new-topic', tabId: 'mote-tab', regionId: 'mote-region', hostId: 'local', agentSessionId: 'chosen-mote', label: topic.title }, 'captured', () => true)
    expect(check.kind).toBe('unknown'); expect(api.sessions.timeline).toHaveBeenLastCalledWith({ hostId: 'local', agentSessionId: 'chosen-mote' })
    expect(useAppStore.getState().spatialRequests[check.requestId]!.recoveryRecipient?.topicId).toBe(topic.id)
    expect(api.sessions.submitPrompt).toHaveBeenCalledTimes(1); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  })
  it.each(['source', 'topic', 'tab', 'region'] as const)('rejects late %s replacement after the receipt read, without queue admission or input', async changed => {
    let release!: () => void
    const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
    vi.mocked(api.sessions.timeline).mockImplementation(async ref => { await new Promise<void>(resolve => { release = resolve }); return { agentSessionId: ref.agentSessionId, revision: 0, items: [] } })
    const mote = { topicId: topic.id, tabId: 'mote-tab', regionId: 'mote-region', hostId: 'local', agentSessionId: 'chosen-mote', label: topic.title }
    const pending = analyzeWithRecoveryMote(source, mote, 'captured', () => true)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const state = useAppStore.getState(), target = state.tabs['mote-tab']!
    if (changed === 'source') useAppStore.setState({ tabs: { ...state.tabs, 'original-tab': createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'agent', phase: 'attached', workspaceId: 'workspace', sessionId: 'replacement' }) } })
    else if (changed === 'topic') useAppStore.setState({ tabs: { ...state.tabs, 'mote-tab': { ...target, topicId: 'another-topic' } } })
    else if (changed === 'tab') useAppStore.setState({ tabs: { 'original-tab': state.tabs['original-tab']! } })
    else useAppStore.setState({ tabs: { ...state.tabs, 'mote-tab': addWorkbenchRegion(target, 'mote-region', 'right', { regionId: 'other-region', kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID }) } })
    release(); await expect(pending).rejects.toThrow(/changed|replacement/); expect(useAppStore.getState().agentSteerQueues).toEqual({}); expect(submit).not.toHaveBeenCalled(); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  })
  it('scopes stable correlation to the exact original Host/SID/Region and shell-quotes references without copying history', async () => {
    const id = await recoveryOperationId(source, 'analyze'); expect(await recoveryOperationId({ ...source }, 'analyze')).toBe(id)
    for (const other of [{ ...source, hostId: 'remote' }, { ...source, agentSessionId: 'other' }, { ...source, regionId: 'other-region' }]) expect(await recoveryOperationId(other, 'analyze')).not.toBe(id)
    expect(recoveryReferenceNote({ ...source, hostId: "host'with quote" }, 'analyze', 'captured')).toContain("--host 'host'\\''with quote'")
  })
  it('parses real emitted read commands with the compiled production CLI, preserving exact Host/SID and no invented inspect flag', async () => {
    const note = recoveryReferenceNote({ ...source, hostId: "remote'host", agentSessionId: 'exact-original' }, 'analyze', 'native')
    const history = note.split('\n').find(line => line.startsWith('agentmux agent history '))!
    const parsed = await parseAgentMuxCliInvocation(split(history).slice(1))
    expect(parsed.command.method).toBe('agent.history'); expect(parsed.params).toMatchObject({ hostId: "remote'host", agentSessionId: 'exact-original', source: 'native', limit: 20, maxBytes: 32768 })
    const inspect = note.match(/Optional diagnostics: (agentmux agent inspect .*?)\. This inspect/)![1]!
    const diagnostic = await parseAgentMuxCliInvocation(split(inspect).slice(1))
    expect(diagnostic.command.method).toBe('agent.inspect'); expect(diagnostic.params).toEqual({ target: { kind: 'agent-session', agentSessionId: 'exact-original' } })
    expect(note).toContain('not Host-qualified'); expect(note).toContain('Do not infer a cross-Host binding')
  })
})


const identity = { agentSessionId: 'original', tabId: 'original-tab', regionId: 'original-region', displayWorkspaceId: 'workspace', groupId: 'original-group' }
async function unobservedOriginal(hostId = 'exact-original-host') {
  const state = useAppStore.getState(), original = state.sessions.find(item => item.id === 'original')!
  const observed = { ...original, kind: 'agent' as const, hostId, control: { ...original.control, kind: 'agent' as const, hostId, agentSessionId: 'original' } }
  useAppStore.setState({ sessions: state.sessions.filter(item => item.id !== 'original'),
    config: { ...state.config!, hosts: [...state.config!.hosts, { id: hostId, kind: 'ssh', label: 'Original execution owner', hostname: 'private-fixture-host' }] } })
  vi.spyOn(api.sessions, 'recover').mockRejectedValue(new Error('Unexpected native recovery'))
  vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValue(new Error('Unexpected Run launch'))
  vi.spyOn(api.sessions, 'submitPrompt').mockRejectedValue(new Error('Unexpected input'))
  await new Promise(resolve => setTimeout(resolve, 0))
  const result = observed as Extract<typeof original, { kind: 'agent' }>
  vi.spyOn(api.spatial, 'read').mockResolvedValue(graphFor(result)); await rereadAgentRegionExecution(identity)
  return result
}
function candidate(original: Awaited<ReturnType<typeof unobservedOriginal>>) {
  return { agentSessionId: original.id, hostId: original.control.hostId, workspacePath: original.workspacePath, providerId: original.providerId, executorId: original.executorId, capabilities: original.capabilities, label: original.label, createdAt: 1, updatedAt: 2, run: original.control.run }
}
function observe(original: Awaited<ReturnType<typeof unobservedOriginal>>) {
  const creation = vi.spyOn(api.sessions, 'creation').mockResolvedValue({ ...agentCreationFixture(original), hostId: 'local' })
  vi.mocked(api.sessions.refresh).mockResolvedValue(original)
  return creation
}
function noLifecycle() {
  expect(api.sessions.launchAgent).not.toHaveBeenCalled(); expect(api.sessions.launchTerminal).not.toHaveBeenCalled()
  expect(api.sessions.recover).not.toHaveBeenCalled(); expect(api.sessions.submitPrompt).not.toHaveBeenCalled()
}
function graphFor(original: Awaited<ReturnType<typeof unobservedOriginal>>) {
  const state = useAppStore.getState()
  return { schemaVersion: 1 as const, revision: 20, graph: desktopSpatialGraph({ ...state, sessions: [...state.sessions, original] }, [topic]) }
}

describe('actual unobserved SessionPane original reference', () => {
  it('the retired-history recovery caller opens the same central picker and leaves history and drafts intact on cancel', async () => {
    const state = useAppStore.getState(), originalTab = state.tabs['original-tab'], drafts = state.agentComposerDrafts
    const original = state.sessions.find(item => item.id === 'original')!
    vi.spyOn(api.sessions, 'historySources').mockResolvedValue([{ agentSessionId: 'original', hostId: 'local', state: 'retired', retiredAt: 10,
      history: { providerId: 'codex', executorId: 'codex', workspacePath: _hygiene_fixturePath("repo"), createdAt: 1 } }])
    vi.spyOn(api.spatial, 'read').mockResolvedValue(graphFor(original as Awaited<ReturnType<typeof unobservedOriginal>>))
    await act(async () => useAppStore.setState({ sessions: state.sessions.filter(item => item.id !== 'original') }))
    await mount()
    await vi.waitFor(() => expect(dom.container.querySelector('[data-agent-surface-mode]')?.getAttribute('data-agent-surface-mode')).toBe('retained-history'))
    await button('Take over'); expect(document.querySelector('.session-takeover .agent-picks')).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(document.querySelector('[aria-label="Original history source"]')).toBeNull()
    await cancelTakeover()
    expect(dom.container.querySelector('[data-agent-surface-mode]')?.getAttribute('data-agent-surface-mode')).toBe('retained-history')
    expect(useAppStore.getState().tabs['original-tab']).toBe(originalTab); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
    expect(api.sessions.launchAgent).not.toHaveBeenCalled(); expect(useAppStore.getState().sessions.some(item => item.id === 'original')).toBe(false)
  })
  it('a known candidate without a current Session offers choices and re-reads only its exact original Host', async () => {
    const original = await unobservedOriginal(); useAppStore.setState({ recoveryCandidates: [candidate(original)] }); const creation = observe(original)
    const tab = useAppStore.getState().tabs['original-tab'], drafts = useAppStore.getState().agentComposerDrafts
    await mount(); await button('Take over'); await cancelTakeover(); await button('Analyze…'); await button('Cancel'); noLifecycle()
    await button('Check original'); expect(creation).toHaveBeenCalledWith('exact-original-host', 'original')
    expect(api.sessions.refresh).toHaveBeenCalledWith(original.control); expect(useAppStore.getState().sessions.find(item => item.id === 'original')).toEqual(original)
    expect(useAppStore.getState().tabs['original-tab']).toBe(tab); expect(useAppStore.getState().agentComposerDrafts).toBe(drafts); noLifecycle()
  })
  it('an accepted create without snapshot offers choices and never uses the server-local receipt as the endpoint', async () => {
    const original = await unobservedOriginal(); const created = { ...agentCreationFixture(original), hostId: 'local', creation: { createOperationId: 'original-admitted-operation', initialPrompt: 'confirmed' as const } }
    useAppStore.setState({ pendingAgentLaunches: { original: { request: { executorId: 'codex', hostId: 'exact-original-host', workspacePath: _hygiene_fixturePath("original"), prompt: 'Original submitted request' }, events: [], overflowed: false, created, projectionFailures: [{ step: 'session', message: 'Original snapshot unavailable.' }] } } })
    const creation = observe(original); await mount(); expect(dom.container.querySelector('[data-agent-surface-mode]')?.getAttribute('data-agent-surface-mode')).toBe('unconfirmed')
    await button('Take over'); await cancelTakeover(); await button('Analyze…'); await button('Cancel')
    creation.mockResolvedValue({ ...agentCreationFixture(original), creation: { createOperationId: 'another-operation', initialPrompt: 'confirmed' } })
    await button('Check original'); expect(dom.container.textContent).toContain('original creation operation is not confirmed'); expect(api.sessions.refresh).not.toHaveBeenCalled(); noLifecycle()
    creation.mockResolvedValue({ ...agentCreationFixture(original), creation: { createOperationId: 'original-admitted-operation', initialPrompt: 'confirmed' } })
    await button('Check original'); expect(creation).toHaveBeenCalledWith('exact-original-host', 'original'); expect(api.sessions.refresh).toHaveBeenCalledWith(original.control); noLifecycle()
  })
  it('the preserved Core Region execution keeps its Host after display moves and rejects another SID or Region', async () => {
    const original = await unobservedOriginal(), graph = graphFor(original)
    vi.spyOn(api.spatial, 'read').mockResolvedValue(graph); await rereadAgentRegionExecution(identity)
    expect(agentRegionExecution({ ...identity, agentSessionId: 'replacement' })).toBeNull(); expect(agentRegionExecution({ ...identity, regionId: 'replacement-region' })).toBeNull()
    await mount(); await button('Take over'); expect(document.querySelector('.session-takeover')).not.toBeNull(); expect(agentRegionExecution(identity)?.hostId).toBe('exact-original-host'); await cancelTakeover(); noLifecycle()
  })
  it('a missing Host explicitly re-reads the existing Core owner, preserving original layout and drafts', async () => {
    const original = await unobservedOriginal(), graph = graphFor(original), creation = observe(original)
    const unknown = { ...graph, graph: { ...graph.graph, regions: graph.graph.regions.map(region => region.regionId === identity.regionId ? { ...region, execution: null } : region) } }
    const read = vi.mocked(api.spatial.read); read.mockResolvedValue(unknown); await rereadAgentRegionExecution(identity)
    read.mockClear(); read.mockResolvedValue(graph); const state = useAppStore.getState()
    await mount(); expect(dom.container.textContent).toContain('original execution Host is not confirmed'); expect(dom.container.textContent).not.toContain('Take over')
    await button('Check original identity'); expect(read).toHaveBeenCalledTimes(1); expect(creation).toHaveBeenCalledWith('exact-original-host', 'original')
    expect(useAppStore.getState().tabs['original-tab']).toBe(state.tabs['original-tab']); expect(useAppStore.getState().layouts).toBe(state.layouts); expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts); noLifecycle()
  })
  it('conflicting original Hosts remain unknown and an empty re-read cannot erase the confirmed spatial reference', async () => {
    const original = await unobservedOriginal(), graph = graphFor(original); const read = vi.spyOn(api.spatial, 'read').mockResolvedValue(graph)
    await rereadAgentRegionExecution(identity); useAppStore.setState({ recoveryCandidates: [{ ...candidate(original), hostId: 'other-original-host' }] }); const creation = observe(original)
    read.mockResolvedValue(null); await mount(); expect(dom.container.textContent).toContain('Original Host references conflict'); expect(dom.container.textContent).not.toContain('Take over')
    await button('Check original identity'); expect(dom.container.textContent).toContain('original Core spatial document was not returned'); expect(agentRegionExecution(identity)?.hostId).toBe('exact-original-host'); expect(creation).not.toHaveBeenCalled(); noLifecycle()
  })
  it('a failed exact original read retains its real error and both explicit alternatives', async () => {
    const original = await unobservedOriginal(); useAppStore.setState({ recoveryCandidates: [candidate(original)] })
    vi.spyOn(api.sessions, 'creation').mockRejectedValue(new Error('Original Host is unavailable: observation receipt missing.'))
    await mount(); await button('Check original'); expect(dom.container.textContent).toContain('Original Host is unavailable: observation receipt missing.')
    expect(dom.container.textContent).toContain('Take over'); expect(dom.container.textContent).toContain('Analyze…'); expect(api.sessions.refresh).not.toHaveBeenCalled(); noLifecycle()
  })
  it('a late original creation read cannot query or attach to a replaced Region', async () => {
    const original = await unobservedOriginal(); useAppStore.setState({ recoveryCandidates: [candidate(original)] }); let release!: () => void
    vi.spyOn(api.sessions, 'creation').mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve }); return agentCreationFixture(original) })
    const pending = rereadUnobservedSession(identity, () => true); await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const state = useAppStore.getState(), tab = state.tabs['original-tab']!
    useAppStore.setState({ tabs: { ...state.tabs, [tab.id]: { ...tab, regions: { ...tab.regions, 'original-region': { ...tab.regions['original-region']!, kind: 'agent', phase: 'attached', sessionId: 'replacement' } } } } })
    release(); await expect(pending).rejects.toThrow('original observation scope'); expect(api.sessions.refresh).not.toHaveBeenCalled(); expect(useAppStore.getState().sessions.some(item => item.id === 'original')).toBe(false); noLifecycle()
  })
  it('a late Session read is refused after the original Host or creation intent changes', async () => {
    const original = await unobservedOriginal(); useAppStore.setState({ recoveryCandidates: [candidate(original)] }); observe(original); let release!: () => void
    vi.mocked(api.sessions.refresh).mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve }); return original })
    const pending = rereadUnobservedSession(identity, () => true); await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    useAppStore.setState({ pendingAgentLaunches: { original: { request: { executorId: 'codex', hostId: 'exact-original-host', prompt: 'A different admitted request' }, events: [], overflowed: false } } })
    release(); await expect(pending).rejects.toThrow('creation intent changed'); expect(useAppStore.getState().sessions.some(item => item.id === 'original')).toBe(false); noLifecycle()
  })
  it('a late Core document read cannot adopt facts from a replacement document owner', async () => {
    const original = await unobservedOriginal(), graph = graphFor(original), state = useAppStore.getState()
    let release!: () => void
    vi.mocked(api.spatial.read).mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return graph })
    const pending = rereadAgentRegionExecution(identity)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    dispose?.(); dispose = undefined
    vi.mocked(api.spatial.read).mockResolvedValue(graph)
    dispose = await useAppStore.getState().initialize()
    useAppStore.setState({ tabs: state.tabs, layouts: state.layouts, sessions: state.sessions, agentComposerDrafts: state.agentComposerDrafts, recoveryCandidates: state.recoveryCandidates, pendingAgentLaunches: state.pendingAgentLaunches })
    release(); await expect(pending).rejects.toThrow('Core spatial owner changed')
    expect(useAppStore.getState().tabs).toBe(state.tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts); noLifecycle()
  })
  it('a normal accepted intent removal during an exact read does not refuse the same confirmed Session', async () => {
    const original = await unobservedOriginal(), created = agentCreationFixture(original)
    useAppStore.setState({ pendingAgentLaunches: { original: { request: { executorId: 'codex', hostId: original.control.hostId, prompt: 'Original admitted input' }, events: [], overflowed: false, created, projectionFailures: [] } } })
    let release!: () => void
    vi.spyOn(api.sessions, 'creation').mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve }); return created })
    vi.mocked(api.sessions.refresh).mockResolvedValue(original)
    const pending = rereadUnobservedSession(identity, () => true)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    useAppStore.setState({ pendingAgentLaunches: {} }); release(); await expect(pending).resolves.toBeUndefined()
    expect(useAppStore.getState().sessions.find(item => item.id === original.id)).toEqual(original); noLifecycle()
  })

  it('new unknown references recheck original Host without restricting existing Core-history-only references', async () => {
    const original = await unobservedOriginal(), unknown = unobservedRecoveryReference(identity).source!
    expect(unknown.observation).toBe('unconfirmed'); expect(ownsRecoverySource(unknown)).toBe(true)
    const { observation: _observation, ...historyReference } = unknown
    void _observation
    useAppStore.setState({ recoveryCandidates: [{ ...candidate(original), hostId: 'another-original-host' }] })
    expect(ownsRecoverySource(unknown)).toBe(false); expect(ownsRecoverySource(historyReference)).toBe(true); noLifecycle()
  })
  it('an explicit analysis cannot admit a creation after its new unknown reference becomes conflicting', async () => {
    const original = await unobservedOriginal(), unknown = unobservedRecoveryReference(identity).source!
    const pending = createRecoveryAgent(unknown, 'analyze', 'codex', 'captured', () => true)
    useAppStore.setState({ recoveryCandidates: [{ ...candidate(original), hostId: 'another-original-host' }] })
    await expect(pending).rejects.toThrow('original Session or this selection changed'); noLifecycle()
  })

})
