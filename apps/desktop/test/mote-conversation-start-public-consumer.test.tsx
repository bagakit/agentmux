// @vitest-environment happy-dom
import { act, useContext, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteConversationStartFixture } from '../../host/test/helpers/mote-conversation-start-fixture'
import { ScratchTopics } from '../../host/src/mote-resources'
import { moteQuickBaseline } from '../../../packages/core/src/mote-preferences'
import { moteMainBaseline } from '../../../packages/core/src/spatial-agent-open-contract'
import { agentPromptSubmissionOutcome } from '../../../packages/core/src/agent-input-wait'
import type { MoteDialogueLink } from '../../../packages/core/src/mote-dialogue'
import type { ConversationChangesInput } from '../../../packages/core/src/conversation-changes'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { MoteConversationStart, desktopMoteStartHistory } from '../src/renderer/src/components/MoteConversationStart'
import { MoteMainActions } from '../src/renderer/src/components/MoteMainActions'
import * as originalMainActions from '../src/renderer/src/lib/mote-main-action'
import { MoteConversationThreads } from '@agentmux/client-ui/components/MoteConversationThreads'
import { MotePeriodConversation } from '@agentmux/client-ui/components/MotePeriodConversation'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { MoteDialogueViewProvider, useMoteDialogueView } from '../src/renderer/src/lib/mote-dialogue-view'
import { api } from '../src/renderer/src/lib/api'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { RuntimeController } from '../src/main/runtime-controller'
import { sessionInputWriteResult, unwrapSessionInputWriteResult } from '../src/shared/session-input-result'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { MoteWorkface } from '../src/renderer/src/components/MoteWorkface'
import { desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { moteAgent, seedMoteWorkface } from './fixtures/mote-workface'
import { MoteWorkfaceContext, type MoteRolloverStart, type MoteWorkfaceScope } from '../src/renderer/src/lib/mote-workface'

vi.mock('electron', () => ({ app: { isPackaged: false }, nativeImage: {} }))
type Source = Extract<MoteDialogueLink, { kind: 'main' }>
const closes: Array<() => unknown | Promise<unknown>> = []
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const prior = useAppStore.getState(), launcher = useLauncherState.getState()
  const dispose = await useAppStore.getState().initialize(); dispose?.()
  closes.push(() => { useAppStore.setState(prior, true); useLauncherState.setState(launcher, true) })
  localStorage.clear(); seedMoteWorkface()
  useLauncherState.setState({ drafts: {}, persistenceIssue: null })
})
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
})
async function wait(check: () => void) { await vi.waitFor(async () => { await act(async () => {}); check() }, { timeout: 8_000 }) }
async function mounted(node: ReactNode) {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element)
  closes.push(async () => { await act(async () => root.unmount()); element.remove() })
  await act(async () => root.render(<DesktopClientUiProvider>{node}</DesktopClientUiProvider>))
  return { element, root, render: async (next: ReactNode) => { await act(async () => root.render(<DesktopClientUiProvider>{next}</DesktopClientUiProvider>)) } }
}
async function click(element: HTMLElement, label: string) {
  const button = [...element.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  expect(button, label).toBeDefined(); await act(async () => button!.click())
}

async function originalWelcome(providerId: 'codex' | 'claude' = 'codex') {
  const f = await createMoteConversationStartFixture({ providerId }); closes.push(f.close)
  const workspace = { ...f.target.expectedResource, id: f.target.expectedResource.workspaceId, hostId: f.target.expectedResource.hostId,
    path: f.target.expectedResource.workspacePath, name: 'Original scratch', kind: 'folder' as const }
  const topic = await new ScratchTopics().readForDirectory(workspace, dirname(f.path))
  if (!topic) throw Error('The real Host Mote directory must be discoverable')
  const scope: MoteWorkfaceScope = { workspace, topic, rootPath: topic.directoryPath! }
  const state = useAppStore.getState()
  useAppStore.setState({ config: { ...state.config!, workspaces: [workspace], executors: { saved: { label: 'Saved', providerId, command: providerId, args: [], env: {}, injectAgentMuxGuide: false } } },
    spaceZoneBindings: { [f.target.zoneId]: { spaceId: f.target.spaceId, workspaceId: workspace.id, topicId: topic.id, contentKind: 'mote' } },
    moteMainCreationReferences: {}, dirtyDocuments: {}, documentIssues: {}, refreshScratchTopics: vi.fn(async () => {}) })
  const read = vi.spyOn(api.motePreferences, 'read').mockImplementation(input => f.rpc.call('space.mote.preferences.read', input))
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(input => f.rpc.call('space.mote.dialogue.read', input))
  vi.spyOn(api.moteDialogue, 'inspectSetup').mockImplementation(input => f.rpc.call('space.mote.dialogue.setup.inspect', input))
  const advance = vi.spyOn(api.moteDialogue, 'advanceSetup').mockImplementation(input => f.rpc.call('space.mote.dialogue.setup.advance', input))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => f.spatial.read())
  const open = vi.spyOn(api.spatial, 'openAgent').mockImplementation(input => f.rpc.call('agent.open', input))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  const key = 'mote-main-start:' + JSON.stringify([workspace.hostId, workspace.id, workspace.path, topic.id, scope.rootPath])
  const opened = vi.fn(), configure = vi.fn(), period = vi.fn()
  const node = (automatic?: MoteRolloverStart) => <MoteDialogueViewProvider scope={scope} active><MoteConversationStart scope={scope} active mode={automatic ? 'new' : 'start'} automatic={automatic}
    onConfigure={configure} onOpenMain={opened} onOpenPeriod={period} /></MoteDialogueViewProvider>
  return { ...f, scope, key, open, advance, read, opened, node }
}

it('actual Desktop welcome submits the original draft through helper and real Host no-input creation, CAS and deferred input once', async () => {
  const f = await originalWelcome(), query = 'Keep the original first Query and its commitments.'
  useLauncherState.getState().setDraft(f.key, 'prompt', query)
  const before = (await f.spatial.read())!, view = await mounted(f.node())
  expect(view.element.querySelector('[contenteditable=true]')).not.toBeNull()
  await wait(() => expect(view.element.querySelector<HTMLButtonElement>('[aria-label=Send]')?.disabled).toBe(false))
  expect(f.open).not.toHaveBeenCalled(); expect(f.h.started).toHaveLength(0)
  await click(view.element, 'Send')
  await wait(() => expect(f.opened, view.element.textContent ?? '').toHaveBeenCalledOnce())
  expect(f.open).toHaveBeenCalledOnce(); expect(f.h.started).toHaveLength(1)
  const request = f.open.mock.calls[0]![0], result = f.advance.mock.results[0]!
  expect(request.content).toEqual({ kind: 'new-agent', executorId: 'saved' })
  expect(request.moteMain?.deferredInput?.prompt).toBe(query)
  expect(JSON.stringify(f.h.started)).not.toContain(query)
  const accepted = await result.value
  expect(accepted.binding).toBe('confirmed')
  expect(agentPromptSubmissionOutcome(accepted.deferredInput?.record ?? null)).toBe('terminal-confirmed')
  expect(useLauncherState.getState().drafts[f.key]?.prompt).toBe('')
  expect((await f.spatial.read())!.graph.regions).toContainEqual(before.graph.regions[0])
  expect(await readFile(f.path, 'utf8')).toContain('Keep original cooperation notes.')
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

async function originalAutomatic() {
  const f = await originalWelcome('claude')
  await f.start('auto-original-main', 'Original human query before the native turn')
  await f.setup('auto-original-main')
  const idle = await f.qualifyMainIdle(1), reference = idle.snapshot.current!, native = idle.session!
  expect(native.currentActivity?.state).toBe('idle')
  const session = { ...moteAgent(reference.sessionId, null, 'waiting'), providerId: 'claude', executorId: 'saved', workspacePath: native.workspacePath,
    control: { kind: 'agent' as const, hostId: reference.hostId, agentSessionId: reference.sessionId, run: native.run } }
  const topic = await new ScratchTopics().readForDirectory(f.scope.workspace, dirname(f.path))
  expect(topic).not.toBeNull()
  const projected = desktopWorkbenchFromSpatial((await f.spatial.read())!.graph)
  const operationId = 'actual_ui_auto_query', prompt = 'Carry this original new Query to the next bound Main'
  const binding = { expectedRun: native.run, admissionIntent: { kind: 'manual-actor' as const } }
  const queue = { operationId, text: prompt, enqueuedAt: Date.now(), status: 'queued' as const, origin: 'manual' as const,
    sourceChannel: 'api' as const, runId: native.run.runId, promptCondition: null, directInputBinding: binding, directInputControl: session.control,
    moteMain: { target: f.target, expectedRoleRevision: idle.snapshot.roleRevision! } }
  useAppStore.setState({ tabs: projected.tabs as never, layouts: projected.layouts, sessions: [session],
    scratchTopicSnapshots: { [f.scope.workspace.id]: { scope: scratchTopicsScope(f.scope.workspace), revision: 0, topics: [topic!], error: null, reading: false } },
    agentSteerQueues: { [session.id]: [queue] }, agentComposerDrafts: { [session.id]: 'Separate original unsent composer draft' } })
  // Execute the original Main method. Only operation tracking/transport connect to the isolated real Host.
  const controller = Object.create(RuntimeController.prototype) as RuntimeController
  Object.assign(controller, { trackHostOperation: (_host: unknown, call: () => unknown) => call(),
    callOriginalCore: (_host: unknown, method: string, input: unknown) => f.rpc.call(method as never, input as never) })
  const envelopes: Awaited<ReturnType<typeof sessionInputWriteResult>>[] = []
  vi.spyOn(api.sessions, 'inspectInput').mockImplementation(async (_control, key) => (await f.rpc.call('agent.input.inspect', { key })).input ?? null)
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, text, id, condition, choice, human, note, channel) => {
    const envelope = await sessionInputWriteResult(() => controller.submitPrompt(control, text, id, condition, undefined, choice, human, note, channel))
    envelopes.push(envelope); return unwrapSessionInputWriteResult(envelope)
  })
  const before = f.h.inner.kernel.input.mock.calls.length
  let dispatchIssue: unknown
  await useAppStore.getState().sendQueuedAgentSteer(session.id, operationId).catch(error => { dispatchIssue = error })
  expect(submit).toHaveBeenCalledOnce()
  const due = useAppStore.getState().agentSteerQueues[session.id]![0]!
  expect(due.mainRollover?.queryOperationId, JSON.stringify({ due, envelopes, dispatchIssue })).toBe(operationId)
  expect(envelopes[0]?.ok).toBe(false)
  expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(before)
  expect(dispatchIssue).toBeUndefined()
  expect(due.error).toBeUndefined(); expect(due.logId).toBeUndefined()
  const node = () => <MoteWorkface workspaceId={f.scope.workspace.id} topicId={topic!.id} floating reference={reference} visible recoverOnOpen={false}>
    <AgentSessionComposer sessionId={session.id} visible />
  </MoteWorkface>
  return { f, idle, reference, native, session, topic: topic!, operationId, prompt, before, due, node, binding }
}

it('actual Desktop ordered queue and Composer carry an original Core native-idle rollover into real no-input Host binding before Query delivery', async () => {
  const { f, reference, native, session, operationId, prompt, before, due, node } = await originalAutomatic()
  let resume!: () => void
  const held = new Promise<void>(resolve => { resume = resolve })
  closes.push(() => resume())
  const advance = f.advance.getMockImplementation()!
  f.advance.mockImplementationOnce(async input => { await held; return advance(input) })
  const view = await mounted(node())
  await wait(() => expect(f.advance).toHaveBeenCalledOnce())
  expect(useAppStore.getState().agentSteerQueues[session.id]?.[0]?.archived).not.toBe(true)
  expect((await f.main.readCurrentMoteMain(f.target)).current).toEqual(reference)
  expect(JSON.stringify(f.h.inner.kernel.input.mock.calls.slice(before))).not.toContain(prompt)
  await act(async () => resume())
  await wait(() => expect(useAppStore.getState().agentSteerQueues[session.id]?.find(entry => entry.operationId === operationId)?.archived, view.element.textContent ?? '').toBe(true))
  expect(f.h.started).toHaveLength(2)
  expect(f.open.mock.calls.at(-1)?.[0].operationId).toBe(due.mainRollover!.creationOperationId)
  const result = await f.setup(due.mainRollover!.creationOperationId, false)
  expect(result.binding).toBe('confirmed')
  expect(agentPromptSubmissionOutcome(result.deferredInput?.record ?? null)).toBe('terminal-confirmed')
  expect(result.record?.moteMain?.deferredInput).toMatchObject({ operationId, prompt, sourceChannel: 'api' })
  expect(result.reference?.sessionId).not.toBe(reference.sessionId)
  expect(JSON.stringify(f.h.inner.kernel.input.mock.calls.slice(before).filter(([runId]: [string]) => runId === native.run.runId))).not.toContain(prompt)
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Separate original unsent composer draft')
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('automatic Main setup with a real unconfirmed Query never archives the original rollover queue', async () => {
  const { f, session, operationId, prompt, due, node } = await originalAutomatic()
  const archive = vi.spyOn(useAppStore.getState(), 'archiveAgentSteer')
  const input = f.h.inner.kernel.input.getMockImplementation()!
  f.h.inner.kernel.input.mockImplementation(async (...args: unknown[]) => {
    if (JSON.stringify(args).includes(prompt)) throw Error('Original automatic input transport acknowledgement unavailable')
    return input(...args)
  })
  const view = await mounted(node())
  await wait(() => expect(f.advance).toHaveBeenCalledOnce())
  const result = await f.advance.mock.results[0]!.value
  await wait(() => expect(view.element.textContent).toContain(due.mainRollover!.creationOperationId))
  expect(result.binding).toBe('confirmed')
  expect(agentPromptSubmissionOutcome(result.deferredInput?.record ?? null)).not.toMatch(/^(admitted|terminal-confirmed)$/u)
  expect(archive).not.toHaveBeenCalled()
  const original = useAppStore.getState().agentSteerQueues[session.id]?.find(entry => entry.operationId === operationId)
  expect(original?.archived).not.toBe(true)
  expect(original?.text).toBe(prompt)
  expect(original?.mainRollover?.creationOperationId).toBe(due.mainRollover!.creationOperationId)
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('multiple actual Core rollover Queries stay explicit and the selected original alone is carried and archived', async () => {
  const { f, idle, reference, native, session, operationId, due, node, binding } = await originalAutomatic()
  const secondId = 'actual_ui_second_auto_query', secondPrompt = 'Choose this second pending Query explicitly'
  const result = await f.rpc.call('space.mote.dialogue.input.submit', { target: f.target, expectedRoleRevision: idle.snapshot.roleRevision!,
    input: { agentSessionId: reference.sessionId, operationId: secondId, prompt: secondPrompt, ...binding, execution: 'immediate', sourceChannel: 'api' } })
  expect(result.disposition).toBe('rollover-required')
  const second = { ...due, operationId: secondId, text: secondPrompt, inputIntakeStarted: undefined, mainRollover: result.rollover!.decision! }
  useAppStore.setState({ agentSteerQueues: { [session.id]: [due, second] } })
  const view = await mounted(node())
  await wait(() => expect(view.element.textContent).toContain('待承接到新对话的输入'))
  await wait(() => expect(view.element.querySelector('.mote-workface__original')?.hasAttribute('hidden')).toBe(false))
  expect(view.element.querySelector('.mote-start')).toBeNull()
  expect(f.open).not.toHaveBeenCalled()
  await click(view.element, secondPrompt + ' · 接到新对话')
  await wait(() => expect(useAppStore.getState().agentSteerQueues[session.id]?.find(entry => entry.operationId === secondId)?.archived).toBe(true))
  expect(useAppStore.getState().agentSteerQueues[session.id]?.find(entry => entry.operationId === operationId)?.archived).not.toBe(true)
  expect(f.open).toHaveBeenCalledOnce()
  expect(f.open.mock.calls[0]?.[0].operationId).toBe(second.mainRollover.creationOperationId)
  const accepted = await f.setup(second.mainRollover.creationOperationId, false)
  expect(accepted.record?.moteMain?.deferredInput).toMatchObject({ operationId: secondId, prompt: secondPrompt })
  expect(f.h.started).toHaveLength(2)
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('an accepted different manual start with the same original Query is not proof for archiving an automatic rollover', async () => {
  const { f, idle, session, operationId, prompt, due } = await originalAutomatic()
  const preferences = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target })
  const baseline = moteQuickBaseline(preferences)!, unrelated = 'different-manual-same-query'
  await f.rpc.call('agent.open', { operationId: unrelated, content: { kind: 'new-agent', executorId: 'saved' },
    destination: { spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false,
    moteMain: { target: f.target, baseline: moteMainBaseline(baseline), expectedRoleRevision: idle.snapshot.roleRevision,
      sourceOperationId: unrelated + ':source', bindOperationId: unrelated + ':bind', handover: true,
      deferredInput: { operationId, prompt, sourceChannel: 'api' } } })
  const manual = await f.setup(unrelated)
  expect(agentPromptSubmissionOutcome(manual.deferredInput?.record ?? null)).toBe('terminal-confirmed')
  expect(manual.record?.moteMain?.rollover).toBeUndefined()
  // A real saved configuration gap keeps this a read/reconcile, rather than allowing
  // AutomaticStart to race the unrelated accepted receipt with another creation.
  const current = moteQuickBaseline(await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target }))!
  const { executorId: _executor, ...values } = current.defaults
  const selected = manual.reference!
  const unconfigured = await f.rpc.call('space.mote.preferences.save', { kind: 'quick', target: f.target, operationId: 'unset-executor-after-manual',
    baseline: current, values, destination: { kind: 'occurrence', displayWorkspaceId: selected.displayWorkspaceId,
      groupId: selected.groupId, tabId: selected.tabId, regionId: selected.regionId } })
  expect(unconfigured.status).toBe('saved')
  useAppStore.setState({ moteMainCreationReferences: { [JSON.stringify(f.target)]: { target: f.target, operationId: unrelated } } })
  const inspect = vi.mocked(api.moteDialogue.inspectSetup)
  const archive = vi.spyOn(useAppStore.getState(), 'archiveAgentSteer')
  const view = await mounted(f.node({ sessionId: session.id, decision: due.mainRollover!, query: { operationId, prompt } }))
  await wait(() => expect(inspect).toHaveBeenCalled())
  await Promise.all(inspect.mock.results.map(result => result.value))
  await wait(() => expect(view.element.textContent).toContain(unrelated))
  expect(archive).not.toHaveBeenCalled()
  const original = useAppStore.getState().agentSteerQueues[session.id]?.find(entry => entry.operationId === operationId)
  expect(original?.archived, view.element.textContent ?? '').not.toBe(true)
  expect(original?.mainRollover?.creationOperationId).toBe(due.mainRollover!.creationOperationId)
  expect(original?.text).toBe(prompt)
}, 45_000)

function OriginalRolloverProbe({ input }: { input: MoteRolloverStart }) {
  const context = useContext(MoteWorkfaceContext), dialogue = useMoteDialogueView()
  return <button type="button" disabled={!dialogue?.page} onClick={() => context?.startRollover?.(input)}>Open original rollover</button>
}
it('the actual Mote workface refuses a genuine rollover decision owned by another exact Mote', async () => {
  const { f, reference } = await originalAutomatic()
  // Another original Host fixture makes the foreign decision; no edited/fabricated due DTO.
  const other = await createMoteConversationStartFixture({ providerId: 'claude' }); closes.push(other.close)
  await other.start('foreign-main', 'Foreign original human Query'); await other.setup('foreign-main')
  const idle = await other.qualifyMainIdle(1), operationId = 'foreign_next_query', prompt = 'Foreign next Query'
  const due = await other.rpc.call('space.mote.dialogue.input.submit', { target: other.target, expectedRoleRevision: idle.snapshot.roleRevision!,
    input: { agentSessionId: idle.snapshot.current!.sessionId, operationId, prompt, expectedRun: idle.session!.run,
      admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' } })
  expect(due.disposition).toBe('rollover-required')
  // Keep this case focused on the workface router; do not auto-open the first Mote's own queued input.
  useAppStore.setState({ agentSteerQueues: {} })
  const view = await mounted(<MoteWorkface workspaceId={f.scope.workspace.id} topicId={f.scope.topic.id} floating reference={reference} visible recoverOnOpen={false}>
    <OriginalRolloverProbe input={{ sessionId: idle.snapshot.current!.sessionId, decision: due.rollover!.decision!, query: { operationId, prompt } }} />
  </MoteWorkface>)
  await wait(() => expect(view.element.querySelector<HTMLButtonElement>('button:not([disabled])')?.textContent).toBeDefined())
  await wait(() => expect([...view.element.querySelectorAll('button')].find(button => button.textContent === 'Open original rollover')?.disabled).toBe(false))
  await click(view.element, 'Open original rollover')
  expect(view.element.querySelector('.mote-start')).toBeNull()
  expect(f.open).not.toHaveBeenCalled()
}, 45_000)

it('a lost creation reply and remount inspect the same Host request without clearing a later original draft or resending Query', async () => {
  const f = await originalWelcome(), query = 'First retained query', later = 'Later unsent correction'
  useLauncherState.getState().setDraft(f.key, 'prompt', query)
  const original = f.open.getMockImplementation()!
  f.open.mockImplementationOnce(async input => { await original(input); throw Error('Original create acknowledgement lost') })
  const view = await mounted(f.node())
  await wait(() => expect(view.element.querySelector<HTMLButtonElement>('[aria-label=Send]')?.disabled).toBe(false))
  await click(view.element, 'Send')
  await wait(() => expect(view.element.textContent).toContain('Original creation unconfirmed'))
  expect(f.h.started).toHaveLength(1)
  await view.render(null)
  useLauncherState.getState().setDraft(f.key, 'prompt', later)
  await view.render(f.node())
  await wait(() => expect(view.element.textContent).toContain('继续原开始请求'))
  await click(view.element, '继续原开始请求')
  await wait(() => expect(f.advance).toHaveBeenCalled())
  await wait(() => expect(f.h.inner.kernel.input.mock.calls.map(call => JSON.stringify(call)).join('\n')).toContain(query))
  expect(f.open).toHaveBeenCalledOnce(); expect(f.h.started).toHaveLength(1)
  expect(useLauncherState.getState().drafts[f.key]?.prompt).toBe(later)
  expect(f.opened).not.toHaveBeenCalled()
  expect(JSON.stringify(f.h.inner.kernel.input.mock.calls)).not.toContain(later)
}, 45_000)

it('a real unconfirmed deferred input keeps its welcome draft and never opens the newly bound Main', async () => {
  const f = await originalWelcome(), query = 'Do not discard this unconfirmed original query'
  useLauncherState.getState().setDraft(f.key, 'prompt', query)
  const input = f.h.inner.kernel.input.getMockImplementation()!
  f.h.inner.kernel.input.mockImplementation(async (...args: unknown[]) => {
    if (JSON.stringify(args).includes(query)) throw Error('Original input transport acknowledgement unavailable')
    return input(...args)
  })
  const view = await mounted(f.node())
  await wait(() => expect(view.element.querySelector<HTMLButtonElement>('[aria-label=Send]')?.disabled).toBe(false))
  await click(view.element, 'Send')
  await wait(() => expect(f.advance.mock.results).toHaveLength(1))
  const result = await f.advance.mock.results[0]!.value
  await act(async () => {})
  expect(result.binding).toBe('confirmed')
  expect(agentPromptSubmissionOutcome(result.deferredInput?.record ?? null)).not.toMatch(/^(admitted|terminal-confirmed)$/u)
  expect(useLauncherState.getState().drafts[f.key]?.prompt).toBe(query)
  expect(f.opened).not.toHaveBeenCalled()
  expect(f.open).toHaveBeenCalledOnce(); expect(f.h.started).toHaveLength(1)
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
  const writes = f.h.inner.kernel.input.mock.calls.length
  await view.render(<MoteDialogueViewProvider scope={f.scope} active><MoteMainActions scope={f.scope} active presentation="menu" onConfigure={() => {}} /></MoteDialogueViewProvider>)
  await wait(() => expect(view.element.textContent).toContain('首条消息待核对'))
  const mainMenu = [...view.element.querySelectorAll('summary')].find(summary => summary.textContent === 'Main')!
  await act(async () => mainMenu.click())
  const disclosure = [...view.element.querySelectorAll('summary')].find(summary => summary.textContent?.includes('首条消息待核对'))!
  expect((disclosure.parentElement as HTMLDetailsElement).open).toBe(false)
  await act(async () => disclosure.click())
  expect(view.element.textContent).toContain('首条消息尚未确认，不重复发送。')
  await click(view.element, '继续原开始请求')
  await wait(() => expect(f.advance).toHaveBeenCalledTimes(2))
  await f.advance.mock.results[1]!.value
  expect(f.advance.mock.calls[1]?.[0].creation).toEqual(f.advance.mock.calls[0]?.[0].creation)
  expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(writes)
  expect(f.open).toHaveBeenCalledOnce(); expect(f.h.started).toHaveLength(1)
}, 45_000)

it('late canonical first-Query acceptance clears only its original draft without stealing later reading activity', async () => {
  const f = await originalWelcome(), query = 'Accepted after the reader moved to another control'
  const reads = vi.spyOn(originalMainActions, 'readMoteMainAction')
  useLauncherState.getState().setDraft(f.key, 'prompt', query)
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
  const original = f.advance.getMockImplementation()!
  f.advance.mockImplementationOnce(async input => { const result = await original(input); entered(); await held; return result })
  const view = await mounted(f.node())
  await wait(() => expect(view.element.querySelector<HTMLButtonElement>('[aria-label=Send]')?.disabled).toBe(false))
  await click(view.element, 'Send'); await ready
  const beforeAcceptance = reads.mock.calls.length
  await act(async () => document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  await act(async () => release())
  await wait(() => expect(useLauncherState.getState().drafts[f.key]?.prompt).toBe(''))
  await wait(() => expect(reads.mock.calls.length).toBeGreaterThanOrEqual(beforeAcceptance + 2))
  await Promise.all(reads.mock.results.map(result => result.value))
  await act(async () => {})
  expect(f.opened).not.toHaveBeenCalled()
  expect(f.open).toHaveBeenCalledOnce(); expect(f.h.started).toHaveLength(1)
}, 45_000)

it('same Host and SID in separate real Host Main tenures stay separate in shared history and Discussion', async () => {
  const f = await originalWelcome()
  await f.start('ui-period-a'); const a = await f.setup('ui-period-a')
  await f.start('ui-period-b', undefined, true); await f.setup('ui-period-b')
  const preferences = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target })
  const baseline = moteQuickBaseline(preferences)!
  await f.rpc.call('space.mote.preferences.save', { kind: 'quick', target: f.target, operationId: 'ui-select-a-again', baseline,
    values: { ...baseline.defaults, conversation: a.reference! }, destination: { kind: 'occurrence', displayWorkspaceId: a.reference!.displayWorkspaceId,
      groupId: a.reference!.groupId, tabId: a.reference!.tabId, regionId: a.reference!.regionId } })
  const page = await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'main' })
  const rows = desktopMoteStartHistory(page.links, page.main.roleRevision)
  expect(new Set(rows.map(row => row.item.id)).size).toBe(3)
  const view = await mounted(<MoteConversationThreads page={page} issue={null} actor={{ hostId: a.reference!.hostId, agentSessionId: a.reference!.sessionId }}
    name="Original Mote" visible conversationClient={null} renderCurrent={() => <p>Current exact Main</p>} />)
  expect(view.element.querySelectorAll('.mote-conversation__source')).toHaveLength(2)
  expect(view.element.textContent).toContain('Current exact Main')
}, 45_000)

it('a closed historical occurrence still opens its exact original Core Session read-only and returns to the retained history draft', async () => {
  const f = await originalWelcome('claude'), originalText = 'Original earlier Main query remains readable after closing its occurrence'
  await f.start('closed-period-a', originalText); const a = await f.setup('closed-period-a')
  await f.start('closed-period-b', 'Current Main stays separate', true); const b = await f.setup('closed-period-b')
  const state = (await f.spatial.read())!, graph = structuredClone(state.graph), old = a.reference!
  const removed = graph.regions.filter(region => region.tabId === old.tabId).map(region => region.regionId)
  graph.tabs = graph.tabs.filter(tab => tab.tabId !== old.tabId); graph.regions = graph.regions.filter(region => region.tabId !== old.tabId)
  delete graph.tabLayouts[old.tabId]
  for (const layout of Object.values(graph.layouts)) for (const group of layout.groups) {
    group.tabOrder = group.tabOrder.filter(id => id !== old.tabId)
    group.recentTabIds = group.recentTabIds.filter(id => id !== old.tabId)
    if (group.activeTabId === old.tabId) group.activeTabId = b.reference!.tabId
  }
  await f.spatial.commit({ expectedRevision: state.revision, graph, allowEntityRemoval: true })
  const projected = desktopWorkbenchFromSpatial((await f.spatial.read())!.graph)
  expect(projected.tabs[old.tabId]).toBeUndefined()
  const topic = (await new ScratchTopics().readForDirectory(f.scope.workspace, dirname(f.path)))!
  const sessions = [old, b.reference!].map(reference => {
    const native = f.h.client.agentSession(reference.sessionId)
    return { ...moteAgent(reference.sessionId, null, 'waiting'), providerId: 'claude', executorId: 'saved', workspacePath: native.workspacePath,
      control: { kind: 'agent' as const, hostId: reference.hostId, agentSessionId: reference.sessionId, run: native.run } }
  })
  useAppStore.setState({ tabs: projected.tabs as never, layouts: projected.layouts, sessions,
    scratchTopicSnapshots: { [f.scope.workspace.id]: { scope: scratchTopicsScope(f.scope.workspace), revision: 0, topics: [topic], error: null, reading: false } } })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: unknown[]) => void) {}
    observe(target: Element) { this.callback([{ target, isIntersecting: true }]) }
    unobserve() {} disconnect() {}
  })
  const latest = vi.spyOn(api.conversation, 'readAgentConversation').mockImplementation((input, options) => f.h.client.readAgentConversation(input, options))
  vi.spyOn(api.conversation, 'readConversationChanges').mockImplementation((input, options) => f.h.client.readConversationChanges(input, options))
  vi.spyOn(api.conversation, 'observeConversation').mockImplementation((input, callback, options) => f.h.client.observeConversation(input, callback, options))
  vi.spyOn(api.conversation, 'releaseConversationView').mockImplementation(input => f.h.client.releaseConversationView(input))
  const page = await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'main' })
  const source = page.links.find((link): link is Source => link.kind === 'main' && link.reference.sessionId === old.sessionId)!
  const inputWrites = f.h.inner.kernel.input.mock.calls.length
  const view = await mounted(<MoteWorkface workspaceId={f.scope.workspace.id} topicId={topic.id} floating reference={b.reference!} visible recoverOnOpen={false}><p>Original current workface</p></MoteWorkface>)
  await wait(() => expect([...view.element.querySelectorAll('button')].some(button => button.textContent === '开始新一轮对话')).toBe(true))
  await click(view.element, '开始新一轮对话')
  useLauncherState.getState().setDraft(f.key, 'prompt', 'Retain this unsent history draft')
  await wait(() => expect([...view.element.querySelectorAll<HTMLElement>('.mote-start-history li')].some(row => row.dataset.motePeriod === source.period!.id)).toBe(true))
  const row = [...view.element.querySelectorAll<HTMLElement>('.mote-start-history li')].find(row => row.dataset.motePeriod === source.period!.id)!
  await act(async () => row.querySelector<HTMLButtonElement>('button')!.click())
  await click(view.element, '打开原 Agent 对话')
  await wait(() => expect(latest.mock.calls.some(([input]) => input.hostId === old.hostId && input.agentSessionId === old.sessionId)).toBe(true))
  await wait(() => expect(view.element.textContent).toContain(originalText))
  expect(view.element.textContent).toContain('原 Session 全段')
  expect(view.element.querySelector('[data-mote-earlier-source] .mote-conversation__handoff > span')?.textContent).toContain('原 Agent 对话')
  expect(view.element.querySelector('[data-mote-earlier-source] .mote-conversation__handoff > small')?.textContent).toContain('完整 Session')
  await click(view.element, '← 返回这段历史'); await click(view.element, '← 返回对话')
  expect(useLauncherState.getState().drafts[f.key]?.prompt).toBe('Retain this unsent history draft')
  expect(f.open).not.toHaveBeenCalled()
  expect(f.h.started).toHaveLength(2)
  expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
  expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(inputWrites)
  expect(f.h.client.agentSession(old.sessionId).run).toEqual(sessions[0]!.control.run)
  expect((await f.spatial.read())!.graph.regions.some(region => removed.includes(region.regionId))).toBe(false)
}, 45_000)

async function originalPeriods() {
  const native = (id: string, content = id) => ({ type: 'user', sessionId: 'native-main', uuid: id, message: { role: 'user', content } })
  const f = await nativeHistoryFixture('claude', jsonl([native('outside-before')]))
  closes.push(f.close)
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const after = (await f.client.conversationCheckpoint(ref)).checkpoint
  await appendFile(f.path, jsonl([native('period-a-one', 'period-a-one ' + '中'.repeat(30_000)), native('period-a-two')]))
  const middle = (await f.client.conversationCheckpoint(ref)).checkpoint
  await appendFile(f.path, jsonl([native('period-b-one')]))
  const through = (await f.client.conversationCheckpoint(ref)).checkpoint
  await appendFile(f.path, jsonl([native('outside-after')]))
  const reference = { hostId: ref.hostId, sessionId: ref.agentSessionId, displayWorkspaceId: 'display', groupId: 'group', tabId: 'tab', regionId: 'region' }
  const source = (id: string, start: typeof after, end: typeof after): Source => ({ kind: 'main', sequence: 1,
    identity: { hostId: 'local', moteId: 'original-mote' }, operationId: id, associatedAt: 1, roleRevision: id,
    reference, range: 'whole-session', file: { resource: { hostId: 'local', workspaceId: 'fixture', workspacePath: f.root, path: 'MOTE.md' }, revision: 'fixture-source' },
    period: { id, roleRevision: id, reference, startedAt: 1, endedAt: 2, start: { kind: 'initial', operationId: id },
      end: { kind: 'manual-takeover', operationId: id + '-close' }, range: { kind: 'bounded', after: start, through: end } } })
  const pages: Awaited<ReturnType<typeof f.client.readConversationChanges>>[] = []
  const changes = vi.fn(async (input: ConversationChangesInput, options?: { signal?: AbortSignal }) => {
    // Exercise a supported smaller transport budget, with actual Core frames.
    const page = await f.client.readConversationChanges({ ...input, maxBytes: 32 * 1024, limit: 2 }, options)
    pages.push(page); return page
  })
  const latest = vi.spyOn(f.client, 'readAgentConversation'), observe = vi.spyOn(f.client, 'observeConversation')
  const release = vi.spyOn(f.client, 'releaseConversationView')
  const client = { readConversationChanges: changes, readAgentConversation: latest, observeConversation: observe, releaseConversationView: release }
  return { ...f, sourceA: source('period-a', after, middle), sourceB: source('period-b', middle, through), changes, pages, client, latest, observe, release }
}

it('actual shared period reader renders original Core wire frames with fixed after/through and excludes later same-SID work', async () => {
  const f = await originalPeriods(), view = await mounted(<MotePeriodConversation source={f.sourceA} client={f.client} name="Mote" visible />)
  await wait(() => expect(view.element.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('false'))
  if (view.element.textContent?.includes('显示正文')) await click(view.element, '显示正文')
  expect(view.element.textContent).toContain('period-a-one')
  expect(view.element.textContent).toContain('period-a-two')
  expect(view.element.textContent).not.toContain('period-b-one')
  expect(view.element.textContent).not.toContain('outside-after')
  expect(f.pages.length).toBeGreaterThan(1)
  expect(f.pages.some(page => !page.window.complete)).toBe(true)
  for (const [input] of f.changes.mock.calls) {
    expect(input.through).toEqual(f.sourceA.period!.range.kind === 'bounded' ? f.sourceA.period!.range.through : null)
    expect(input.checkpoint).toEqual(f.sourceA.period!.range.kind === 'bounded' ? f.sourceA.period!.range.after : null)
  }
  expect(f.latest).not.toHaveBeenCalled(); expect(f.observe).not.toHaveBeenCalled()
  const sourceAPages = f.pages.length, sourceACalls = f.changes.mock.calls.length
  await view.render(<MotePeriodConversation source={f.sourceB} client={f.client} name="Mote" visible />)
  await wait(() => expect(view.element.textContent).toContain('period-b-one'))
  expect(view.element.textContent).not.toContain('period-a-one')
  expect(f.release).toHaveBeenCalled()
  if (!process.env.AGENTMUX_TEST_ROOT_UI_MUTATION) {
    const source = Object.fromEntries(await Promise.all(['packages/core/src/conversation-reader.ts', 'packages/core/src/native-jsonl-history-reader.ts',
      'packages/core/src/providers/claude.ts', 'packages/client-ui/src/components/MotePeriodConversation.tsx'].map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])))
    await mkdir('.bagakit/mote-conversation-start', { recursive: true })
    await writeFile('.bagakit/mote-conversation-start/visual-bounded-source.json', JSON.stringify({ schema: 'agentmux.actual-core-bounded-visual-source.v1',
      boundary: 'Verbatim actual original Claude native JSONL Core changes frames, recorded while the shared period component rendered them. Isolated fixture Session; its temporary file has closed. Replay these original immutable frames under the exact original reference; not a live Host, user Run, new source or provider execution claim.',
      descriptorBoundary: 'The surrounding link/period id, manual cause, 1/2 millisecond dates and display/group/tab/region descriptor are controlled consumer fixture values, not a Host Main period owner receipt. Only after/through checkpoints and frames are original Core reader results.',
      source, link: f.sourceB, calls: f.changes.mock.calls.slice(sourceACalls).map(([input]) => input), frames: f.pages.slice(sourceAPages),
      wirePagedPeriod: { link: f.sourceA, calls: f.changes.mock.calls.slice(0, sourceACalls).map(([input]) => input), frames: f.pages.slice(0, sourceAPages) }
    }, null, 2) + '\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
  }
})

it('hidden shared periods do not read, and a cancelled opening retries when the same period becomes visible', async () => {
  const f = await originalPeriods(), small = f.sourceB
  const view = await mounted(<MotePeriodConversation source={small} client={f.client} name="Mote" visible={false} />)
  expect(f.changes).not.toHaveBeenCalled()
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const original = f.changes.getMockImplementation()!
  f.changes.mockImplementationOnce(async (...args) => { const page = await original(...args); await held; return page })
  await view.render(<MotePeriodConversation source={small} client={f.client} name="Mote" visible />)
  await wait(() => expect(f.pages).toHaveLength(1))
  await view.render(<MotePeriodConversation source={small} client={f.client} name="Mote" visible={false} />)
  await view.render(<MotePeriodConversation source={small} client={f.client} name="Mote" visible />)
  await act(async () => release())
  await wait(() => expect(view.element.textContent).toContain('period-b-one'))
  expect(f.changes.mock.calls.length).toBeGreaterThan(1)
})
