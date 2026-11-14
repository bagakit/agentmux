// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { dirname } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMoteHumanInputFixture } from './helpers/mote-human-input-fixture'
import { RuntimeController } from '../src/main/runtime-controller'
import { sessionInputWriteResult, unwrapSessionInputWriteResult } from '../src/shared/session-input-result'
import { useAppStore } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { api } from '../src/renderer/src/lib/api'
import { desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { MoteWorkface } from '../src/renderer/src/components/MoteWorkface'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { moteAgent, moteTopics, seedMoteWorkface } from './fixtures/mote-workface'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp/private-mote-human-input' }, nativeImage: {} }))
const closes: Array<() => Promise<unknown>> = []
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const original = useAppStore.getState(), launcher = useLauncherState.getState()
  const stop = await original.initialize(); stop?.()
  closes.push(async () => { useAppStore.setState(original, true); useLauncherState.setState(launcher, true) })
  localStorage.clear(); seedMoteWorkface(); useLauncherState.setState({ drafts: {}, persistenceIssue: null })
})
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of closes.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Private Mote human input cleanup failed')
})
async function wait(check: () => unknown) { await vi.waitFor(async () => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }); await check()
}, { timeout: 6000 }) }
async function mount(node: ReactNode) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  closes.push(async () => { await act(async () => root.unmount()); container.remove() })
  await act(async () => root.render(<DesktopClientUiProvider>{node}</DesktopClientUiProvider>))
  return container
}
async function originalMain(state: 'idle' | 'working') {
  const f = await createMoteHumanInputFixture(closes, state)
  const workspace = { id: '__scratch__', hostId: 'local', path: f.target.expectedResource.workspacePath, name: 'Private original Mote', kind: 'folder' as const }
  const topic = { ...moteTopics[0]!, directoryPath: dirname(f.motePath), topicPath: dirname(f.motePath) + '/topic.md',
    quickMode: { status: 'saved' as const, version: f.snapshot.documentRevision!, defaults: { conversation: f.snapshot.current! } } }
  const projected = desktopWorkbenchFromSpatial((await f.spatial.read())!.graph)
  const session = { ...moteAgent('primary', topic.id), providerId: 'codex', executorId: 'codex', workspacePath: f.root,
    nativeHandle: (await f.client.readAgentSession('primary'))!.nativeHandle, status: { state: state === 'working' ? 'working' as const : 'running' as const,
      source: 'native-hook' as const, observedAt: Date.now() }, control: { kind: 'agent' as const, hostId: 'local', agentSessionId: 'primary', run: { runId: f.run.runId } } }
  useAppStore.setState({ config: { ...useAppStore.getState().config!, workspaces: [workspace], executors: { codex: {
    label: 'Original Codex', providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: true } } },
    sessions: [session], tabs: projected.tabs as never, layouts: projected.layouts, agentComposerDrafts: { primary: '' },
    spaceZoneBindings: { [f.target.zoneId]: { spaceId: f.target.spaceId, workspaceId: workspace.id, topicId: topic.id, contentKind: 'mote' } },
    scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), topics: [topic], revision: 0, error: null, reading: false } } })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic]); vi.spyOn(api.scratch, 'readTopic').mockResolvedValue(topic)
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.continuousProgress, 'pauseForInput').mockResolvedValue(undefined)
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(input => f.mainRpc.call('space.mote.dialogue.read', input))
  vi.spyOn(api.motePreferences, 'read').mockImplementation(input => f.mainRpc.call('space.mote.preferences.read', input))
  vi.spyOn(api.moteDialogue, 'inspectRecovery').mockResolvedValue({ operation: null } as never)
  const recover = vi.spyOn(api.moteDialogue, 'ensureRecovery').mockRejectedValue(Error('A healthy original TUI must not recover'))
  const routes: Array<{ method: string; input: any }> = []
  const controller = Object.assign(Object.create(RuntimeController.prototype), {
    trackHostOperation: (_host: unknown, call: () => unknown) => call(),
    callOriginalCore: (host: string, method: string, input: any) => {
      expect(host).toBe('local'); routes.push({ method, input: structuredClone(input) }); return f.mainRpc.call(method as never, input)
    } }) as RuntimeController
  vi.spyOn(api.sessions, 'inspectInput').mockImplementation(async (_control, key) => (await f.mainRpc.call('agent.input.inspect', { key })).input ?? null)
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockImplementation(async (control, text, id, condition, choice, human, note, channel) =>
    unwrapSessionInputWriteResult(await sessionInputWriteResult(() => controller.submitPrompt(control, text, id, condition, undefined, choice, human, note, channel))))
  const view = await mount(<MoteWorkface workspaceId={workspace.id} topicId={topic.id} floating visible recoverOnOpen={false} reference={f.snapshot.current!}>
    <AgentSessionComposer sessionId="primary" visible />
  </MoteWorkface>)
  await wait(() => expect(view.querySelector('.mote-composer-surface [data-placeholder]')?.getAttribute('data-placeholder')).toBe('Ask, steer, or paste a command…'))
  const send = async (text: string) => {
    const editor = view.querySelector<HTMLElement & { editor: import('@tiptap/core').Editor }>('.mote-composer-surface .tiptap')!
    await act(async () => { editor.focus(); editor.replaceChildren(Object.assign(document.createElement('p'), { textContent: text }));
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    // A working turn keeps Stop as its button; Cmd+Enter is the product's immediate human Send.
    await act(async () => {
      if (state === 'idle') view.querySelector<HTMLButtonElement>('button[aria-label=Send]')!.click()
      else editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
    })
    await wait(() => expect(submit).toHaveBeenCalledOnce())
    return submit.mock.calls[0]![2]
  }
  return { ...f, view, send, submit, routes, recover, session }
}

it.each(['idle', 'working'] as const)('mounted Mote fresh human Send reaches its original ordinary %s TUI without a native actor', async state => {
  const f = await originalMain(state), prompt = 'Original explicit Mote question ' + state
  const operation = await f.send(prompt)
  await wait(() => expect(f.byteWrites.length + f.nativePreparation.mock.calls.length).toBeGreaterThan(0))
  expect(f.nativePreparation, 'Fresh manual Main input must not require an optional native actor').not.toHaveBeenCalled()
  await wait(async () => expect((await f.client.inspectAgentInput({ key: f.inputKey(operation) }))?.status).toBe('terminal-confirmed'))
  const original = await f.mainRpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: operation })
  expect(f.submit.mock.calls[0]![3]).toEqual({ expectedRun: f.session.control.run, admissionIntent: { kind: 'manual-actor' } })
  expect(original.route).toMatchObject({ roleRevision: f.snapshot.roleRevision, reference: f.snapshot.current, key: f.inputKey(operation) })
  expect(original.record?.admission?.intent?.admissionIntent).toMatchObject({ kind: 'manual-actor' })
  expect(original.input?.status).toBe('terminal-confirmed')
  expect((await f.store.readMetadata('primary'))?.nativeActor).toBeUndefined()
  await wait(async () => expect(await f.replay()).toContain('BYTES:'))
  expect(f.byteWrites.join('')).toContain(prompt)
  expect((await f.native.status(f.run.runId)).pid).toBe(f.run.pid)
  expect(f.recover).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)

it.each(['role', 'Run'] as const)('mounted Mote refuses a changed original %s before writing any terminal bytes', async change => {
  const f = await originalMain('working')
  if (change === 'role') await f.switchRole('member')
  else {
    const original = (await f.store.readMetadata('primary'))!
    await f.store.compareAndSwapMetadata(original, { ...original, run: { runId: 'a-later-original-run' } })
    await f.inner.registry.load('local')
  }
  const operation = await f.send('Keep the original Main target')
  await wait(() => expect(useAppStore.getState().agentSteerQueues.primary?.find(item => item.operationId === operation)?.errorCode).toBeDefined())
  expect(f.byteWrites).toEqual([]); expect(f.nativePreparation).not.toHaveBeenCalled()
  const record = useAppStore.getState().agentSteerQueues.primary!.find(item => item.operationId === operation)!
  expect(record.directInputBinding).toEqual({ expectedRun: f.session.control.run, admissionIntent: { kind: 'manual-actor' } })
  expect(record.moteMain?.expectedRoleRevision).toBe(f.snapshot.roleRevision)
  expect(record.text).toBe('Keep the original Main target')
  expect(f.recover).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)

it.each(['waiting', 'unknown'] as const)('a new mounted manual Send cannot retype or replay an original %s directed input', async outcome => {
  const f = await originalMain('working')
  // This private original input models a previously frozen directed request. Its native service
  // is an injected protocol leaf, never a capability or actor added to the ordinary live TUI.
  const directedPreparation = outcome === 'unknown' ? vi.fn(f.originalNativePreparation) : f.nativePreparation
  if (outcome === 'unknown') {
    f.loseNotice()
    f.client.providers.replace({ ...f.client.providers.get('codex'), prepareNativeInput: directedPreparation })
  }
  const request = { target: f.target, expectedRoleRevision: f.snapshot.roleRevision!, input: {
    agentSessionId: 'primary', expectedRun: { runId: f.run.runId }, operationId: 'previous-original-directed-' + outcome,
    prompt: 'Previously frozen original question', admissionIntent: { kind: 'session-conversation' as const },
    execution: 'immediate' as const, sourceChannel: 'message-tool' as const } }
  await f.mainRpc.call('space.mote.dialogue.input.submit', request)
  const read = () => f.mainRpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: request.input.operationId })
  await wait(async () => expect((await read()).input?.status).toBe(outcome))
  const original = await read(), calls = directedPreparation.mock.calls.length, nativeWrites = f.writes.length
  if (outcome === 'unknown') expect(original.record?.admission?.intent?.admissionIntent).toMatchObject({ kind: 'session-conversation' })
  await expect(f.mainRpc.call('space.mote.dialogue.input.submit', { ...request, input: { ...request.input,
    admissionIntent: { kind: 'manual-actor' } } })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
  expect(await f.mainRpc.call('space.mote.dialogue.input.submit', request)).toEqual(original)
  expect(f.byteWrites).toEqual([])
  const operation = await f.send('A separate new human question')
  await wait(async () => expect((await f.client.inspectAgentInput({ key: f.inputKey(operation) }))?.status).toBe('terminal-confirmed'))
  expect(await read()).toEqual(original)
  expect(directedPreparation).toHaveBeenCalledTimes(calls); expect(f.writes).toHaveLength(nativeWrites)
  expect(f.byteWrites.join('')).toContain('A separate new human question')
  expect(f.recover).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)
