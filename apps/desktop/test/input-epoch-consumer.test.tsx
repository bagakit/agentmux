// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bridge, control, owningBridge } from './helpers/first-execution-ipc-bridge'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, recoveryCandidateSession } from '../src/renderer/src/store'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { initialNativeComposerBinding } from '../src/renderer/src/lib/initial-native-composer-binding'
import { interactionNativeComposerBinding } from '../src/renderer/src/lib/interaction-native-composer-binding'
import { sendConversationQuestionReply } from '../src/renderer/src/lib/conversation-question'
import { restoredQuestionReplies } from '../src/renderer/src/lib/conversation-question-intent'
import { projectRuntimeEvent } from '../src/renderer/src/lib/session-state'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { recoveryDigest } from '@agentmux/core'
import { assertGoalDispatchReference } from '../src/shared/goal-dispatch'
import { parseAgentMuxControlRequest } from '@agentmux/core'

const initial = useAppStore.getState(), roots: string[] = []
let disposePreview: (() => void) | undefined
beforeAll(async () => { disposePreview = await useAppStore.getState().initialize() })
beforeEach(() => useAppStore.setState({ ...initial, loading: false, config: composerConfig, sessions: [], agentSteerQueues: {}, tabs: {}, layouts: {}, notificationEvents: [], error: null }, true))
afterEach(async () => { vi.restoreAllMocks(); useAppStore.setState(initial, true); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))) })
afterAll(() => disposePreview?.())
function running(inputEpoch?: string) {
  const session = { ...composerSession('epoch-agent'), status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 }, ...(inputEpoch === undefined ? {} : { inputEpoch }) }
  const tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', regionId: 'original-region', workspaceId: 'workspace', sessionId: session.id })
  useAppStore.setState({ sessions: [session], tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('original-group', [tab.id]) }, activeWorkspaceId: 'workspace' })
  return session
}

it('the actual preload/Main namespace reader does not connect Native or fill another operation', async () => {
  const f = await owningBridge(), read = vi.fn(async () => 'current-original-cut')
  Object.assign(f.client, { readAgentInputEpoch: read })
  const before = vi.mocked(f.client.connect).mock.calls.length
  try {
    expect(await bridge.api!.sessions.readInputEpoch('local')).toBe('current-original-cut')
    expect(read).toHaveBeenCalledExactlyOnceWith()
    expect(vi.mocked(f.client.connect).mock.calls).toHaveLength(before)
    expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled(); expect(f.client.submitAgentPrompt).not.toHaveBeenCalled()
  } finally { await f.dispose() }
})

it('authoritative Core Session epochs reach Main snapshots and original Renderer event projections', async () => {
  const f = await owningBridge()
  try {
    const original = await f.client.runtimeSubject({ kind: 'agent-session', agentSessionId: control.agentSessionId })
    const subject = { ...original, agentSession: { ...original.agentSession, inputEpoch: 'original-snapshot-cut' } }
    vi.mocked(f.client.runtimeSubject).mockResolvedValue(subject)
    Object.assign(f.client, { refreshAgentSession: vi.fn(async () => subject.agentSession) })
    const snapshot = await bridge.api!.sessions.refresh(control)
    expect(snapshot).toMatchObject({ inputEpoch: 'original-snapshot-cut' })
    const next = projectRuntimeEvent({ ...useAppStore.getState(), sessions: [snapshot] }, { hostId: 'local', event: { type: 'agent-session',
      session: { ...subject.agentSession, inputEpoch: 'next-observed-cut', updatedAt: subject.agentSession.updatedAt + 1 } } } as never)
    expect(next.state.sessions[0]).toMatchObject({ inputEpoch: 'next-observed-cut' })
  } finally { await f.dispose() }
})

it('Main maps the frozen create epoch to the original Core request without reading a replacement value', async () => {
  const f = await owningBridge(), create = vi.fn(async () => { throw new Error('Controlled original Core intake boundary') }), read = vi.fn(async () => 'wrong-later-cut')
  Object.assign(f.client, { createAgentWithDelivery: create, readAgentInputEpoch: read })
  try {
    for (const prompt of ['Original first prompt', undefined]) {
      await expect(f.runtime.launchAgent({ hostId: 'local', workspacePath: '/original/workspace', executorId: 'private', agentSessionId: 'new-original-sid', createOperationId: 'same-original-create', inputEpoch: 'original-birth-cut', inputRuntimeId: 'original-runtime', ...(prompt === undefined ? {} : { prompt }) },
        { ...composerConfig, executors: { private: { providerId: 'codex', command: 'codex', args: [], env: {}, injectAgentMuxGuide: false } } })).rejects.toThrow('Controlled original Core intake')
      expect(create.mock.calls.at(-1)![0]).toMatchObject({ createOperationId: 'same-original-create', inputEpoch: 'original-birth-cut', inputRuntimeId: 'original-runtime' })
    }
    expect(read).not.toHaveBeenCalled()
  } finally { await f.dispose() }
})

it('Main preserves the original resume-input epoch and leaves a no-input recovery independent', async () => {
  const f = await owningBridge()
  try {
    const input = { submissionId: 'original-recovery-message', prompt: 'Original recovery input' }
    const config = { ...composerConfig, executors: { private: composerConfig.executors.codex! } }
    await f.runtime.recoverSession(control, config, '/original/workspace', 'original-resume', { trigger: 'input', input, inputEpoch: 'original-birth-cut' })
    expect(f.client.ensureAgentContinuity).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: 'original-resume', inputEpoch: 'original-birth-cut', input }))
    await f.runtime.recoverSession(control, config, '/original/workspace', 'observe-original-resume')
    expect(f.client.ensureAgentContinuity.mock.calls.at(-1)![0]).not.toHaveProperty('inputEpoch')
  } finally { await f.dispose() }
})

it('Main preserves the original public resume request cut through preload without reading a replacement', async () => {
  const f = await owningBridge(), resume = vi.fn(async () => { throw new Error('Controlled original resume intake') }), reader = vi.fn(async () => 'wrong-fresh-cut')
  Object.assign(f.client, { resumeAgent: resume, readAgentInputEpoch: reader })
  try {
    for (const inputEpoch of ['original-public-resume-cut', undefined]) {
      await expect(bridge.api!.sessions.resume(control, 'Original public continuation', 'same-original-resume', undefined, inputEpoch)).rejects.toThrow('Controlled original resume intake')
      if (inputEpoch === undefined) expect(resume.mock.calls.at(-1)![0]).not.toHaveProperty('inputEpoch')
      else expect(resume.mock.calls.at(-1)![0]).toMatchObject({ inputEpoch, operationId: 'same-original-resume' })
    }
    expect(reader).not.toHaveBeenCalled()
  } finally { await f.dispose() }
})

it('the actual public resume control consumer forwards only its frozen request cut across a newer Session', async () => {
  const session = running('wrong-new-session-cut'), resume = vi.spyOn(api.sessions, 'resume').mockResolvedValue(session)
  for (const inputEpoch of ['original-public-control-cut', undefined]) {
    const request = parseAgentMuxControlRequest({ schemaVersion: 5, requestId: 'original-public-resume', operation: 'resume',
      target: { kind: 'agent-session', agentSessionId: session.id }, text: 'Original continuation', ...(inputEpoch === undefined ? {} : { inputEpoch }) })
    await useAppStore.getState().executeControl(request)
    expect(resume.mock.calls.at(-1)).toEqual([session.control, 'Original continuation', 'original-public-resume', undefined, inputEpoch])
  }
})

it('a new manual composer freezes its current Session epoch before the asynchronous first intake', async () => {
  const session = running('original-birth-cut'), submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  let release!: () => void
  vi.spyOn(api.sessions, 'inspectInput').mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(null) }))
  expect(useAppStore.getState().send(session.id, 'Original manual input', undefined, 'manual')).toBe(true)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  useAppStore.setState({ sessions: [{ ...session, inputEpoch: 'later-current-cut' }] })
  release(); await useAppStore.getState().flushAgentSteerQueue(session.id)
  expect(submit.mock.calls[0]![3]).toMatchObject({ expectedRun: session.control.run, inputEpoch: 'original-birth-cut', admissionIntent: { kind: 'manual-actor' } })
  expect(useAppStore.getState().agentSteerQueues[session.id]![0]).toMatchObject({ operationId: submit.mock.calls[0]![2], inputEpoch: 'original-birth-cut' })
})

it('an old queued key never borrows a fresh Session epoch when its original condition is first materialized', async () => {
  const session = running('new-current-cut'), submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
  useAppStore.setState({ agentSteerQueues: { [session.id]: [{ operationId: 'old-queued-key', inputEpoch: 'original-old-cut', text: 'Original queued words', runId: session.control.run.runId, promptCondition: null, status: 'queued', awaitingExplicitSend: true, execution: 'default' }] } })
  await useAppStore.getState().sendQueuedAgentSteer(session.id, 'old-queued-key')
  expect(submit).toHaveBeenCalledOnce()
  expect(submit.mock.calls[0]![3]).toMatchObject({ inputEpoch: 'original-old-cut' })
})

it('original Goal references retain their birth cut or missing legacy cut without a fresh Session upgrade', () => {
  const session = running('wrong-new-session-cut')
  for (const kind of ['goalDispatch', 'goalPmo'] as const) for (const inputEpoch of [undefined, 'original-goal-birth-cut']) {
    const operationId = `${kind}-${inputEpoch ?? 'legacy'}`
    const reference = { goalId: 'original-goal', operationId, ...(inputEpoch === undefined ? {} : { inputEpoch }) }
    if (kind === 'goalDispatch') assertGoalDispatchReference(reference)
    expect(useAppStore.getState().enqueueAgentSteer(session.id, 'Original Goal words', undefined, operationId, undefined, undefined,
      { [kind]: reference, awaitingExplicitSend: true })).toBe(true)
    const original = useAppStore.getState().agentSteerQueues[session.id]!.find(entry => entry.operationId === operationId)!
    expect(original.inputEpoch).toBe(inputEpoch)
    expect(original[kind]).toEqual(reference)
  }
  expect(() => assertGoalDispatchReference({ goalId: 'original-goal', operationId: 'original-key', inputEpoch: '' })).toThrow()
})

it.each(['First user body', undefined])('a genuinely new user create freezes namespace observation even for body %s', async prompt => {
  const tab = createWorkbenchTab('original-launcher', { kind: 'launcher', regionId: 'original-launcher-region', workspaceId: 'workspace' })
  useAppStore.setState({ sessions: [], tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('original-group', [tab.id]) }, activeWorkspaceId: 'workspace' })
  const reader = vi.spyOn(api.sessions, 'readInputEpoch').mockResolvedValue('new-user-birth-cut')
  const launch = vi.spyOn(api.sessions, 'launchAgent').mockRejectedValue(Object.assign(new Error('Controlled original creation result unavailable'), { code: 'CONTROL_UNAVAILABLE' }))
  await expect(useAppStore.getState().launchAgent('codex', prompt, 'original-group', { tabId: tab.id, regionId: tab.layout.activeRegionId })).rejects.toThrow('Controlled original creation result unavailable')
  expect(reader).toHaveBeenCalledExactlyOnceWith('local'); expect(launch).toHaveBeenCalledOnce()
  expect(launch.mock.calls[0]![0]).toMatchObject({ inputEpoch: 'new-user-birth-cut' })
  const retained = Object.values(useAppStore.getState().pendingAgentLaunches)[0]!.request!
  expect(retained).toMatchObject({ inputEpoch: 'new-user-birth-cut', createOperationId: launch.mock.calls[0]![0].createOperationId })
})

it('Core-native initial/interaction producers and saved recovery candidates preserve their observed epoch', () => {
  const session = { ...composerSession(), inputEpoch: 'observed-current-cut', nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'native-original' },
    capabilities: { ...composerSession().capabilities, nativeConversationInput: { managedRuns: true, interactionQueue: true } } }
  const initialSession = { ...session, terminalFrontend: { state: 'starting', run: session.control.run, initialization: { phase: 'ready', native: { state: 'confirmed', sessionId: 'native-original' } } } } as Parameters<typeof initialNativeComposerBinding>[0]
  expect(initialNativeComposerBinding(initialSession)).toMatchObject({ inputEpoch: session.inputEpoch })
  expect(interactionNativeComposerBinding({ ...session, pendingInteraction: {} } as never)).toMatchObject({ inputEpoch: session.inputEpoch })
  const candidate = recoveryCandidateSession({ agentSessionId: session.id, hostId: session.hostId, workspacePath: session.workspacePath, providerId: session.providerId,
    executorId: session.executorId, capabilities: session.capabilities, inputEpoch: session.inputEpoch, label: session.label, createdAt: 1, updatedAt: 1, run: session.control.run }, { kind: 'pending', detail: 'Original current metadata' })
  expect(candidate).toMatchObject({ inputEpoch: session.inputEpoch })
})

it('a fresh question reply freezes its epoch and an unknown original reply retains it across a newer Session', async () => {
  const session = { ...running('original-question-cut'), nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native' }, nativeHandlePersistence: 'confirmed' as const }
  useAppStore.setState({ sessions: [session] })
  const reply = vi.spyOn(api.sessions, 'replyQuestion').mockRejectedValue(new Error('Controlled unknown original question receipt'))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  const input = { source: { providerId: 'codex', nativeSessionId: 'original-native' }, turnId: 'original-turn', recordId: 'original-record', answers: [{ questionId: 'original-question', answer: 'Original answer' }] }
  await expect(sendConversationQuestionReply(session.control, input)).rejects.toThrow('Controlled unknown original question receipt')
  const original = reply.mock.calls[0]![1]
  expect(original).toMatchObject({ inputEpoch: 'original-question-cut' })
  useAppStore.setState({ sessions: [{ ...session, inputEpoch: 'new-question-cut' }], questionReplies: restoredQuestionReplies(useAppStore.getState().questionReplies) })
  await expect(sendConversationQuestionReply(session.control, input)).rejects.toThrow('Controlled unknown original question receipt')
  expect(reply.mock.calls[1]![1]).toMatchObject({ operationId: original.operationId, inputEpoch: 'original-question-cut' })
})

it('Main-only restoration holds old queues while the unchanged Core namespace has no epoch and fresh user input remains available', async () => {
  const session = running(), root = await mkdtemp('/tmp/amux-main-only-input-cut-'); roots.push(root)
  const user = new WorkbenchUserStateStore(join(root, 'user.json')), source = join(root, 'original'), output = join(root, 'prepared'); await mkdir(output)
  const state = useAppStore.persist.getOptions().partialize!({ ...useAppStore.getState(), agentSteerQueues: { [session.id]: [{ operationId: 'old-legacy-input', text: 'Original legacy input', runId: session.control.run.runId, promptCondition: null, status: 'queued' }] } })
  const bytes = JSON.stringify({ version: 1, state }); await writeFile(source, bytes, { mode: 0o600 })
  const result = await user.recoverySource().prepareRestore!([{ id: 'document', file: source, target: user.path, kind: 'file', capturedAt: 1, operationId: 'restore-original-user-doc', sha256: recoveryDigest(bytes) }], output)
  if (result.state !== 'prepared') throw Error('Original document preparation required')
  await user.recoverySource().restoreMissing!(result.members[0]!)
  const restored = JSON.parse((await user.read())!).state
  const merged = useAppStore.persist.getOptions().merge!(restored, useAppStore.getState())
  useAppStore.setState({ ...merged, loading: false }, true)
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue(undefined), recover = vi.spyOn(api.sessions, 'recover'), inspect = vi.spyOn(api.sessions, 'inspectInput').mockResolvedValue(null)
  expect(useAppStore.getState().sessions[0]).not.toHaveProperty('inputEpoch')
  expect(useAppStore.getState().agentSteerQueues[session.id]![0]).toMatchObject({ operationId: 'old-legacy-input', awaitingExplicitSend: true })
  await useAppStore.getState().flushAgentSteerQueue(session.id)
  expect(submit).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled()
  expect(useAppStore.getState().send(session.id, 'New explicit user input', undefined, 'manual')).toBe(true)
  await useAppStore.getState().flushAgentSteerQueue(session.id)
  expect(submit).toHaveBeenCalledOnce(); expect(submit.mock.calls[0]![3]).not.toHaveProperty('inputEpoch')
})
