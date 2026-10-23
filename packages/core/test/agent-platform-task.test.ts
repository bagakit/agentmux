import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '../src/index.js'
import { creationInputOwner as learningCore } from './helpers/creation-input-owner.js'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const task = 'Perform the exact platform task. Preserve <literal> source bytes & uncertainty.'

it('starts an explicit platform task in the final Runtime wire without inventing a human body', async () => {
  const h = await learningCore(); cleanups.push(h.close)
  const input = { agentSessionId: 'created-task', createOperationId: 'task-create', providerId: 'codex', executorId: 'codex', workspacePath: h.root,
    injectAgentMuxGuide: true, agentMuxTask: task, agentMuxNote: 'Original separate destination context.' }
  const result = await h.client.createAgentWithDelivery(input), stored = (await h.store.readMetadata(input.agentSessionId))!
  expect(result.creation).toMatchObject({ initialPrompt: 'not-requested', agentMuxContext: 'confirmed' })
  expect(stored.initialInput!.prompt).toContain('Begin that task within its stated scope')
  expect(stored.initialInput!.prompt).toContain(task.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'))
  expect(stored.initialInput!.prompt).not.toContain('No request yet.')
  expect(stored.initialInput!.message).toEqual({ systemContext: expect.stringContaining(task) })
  expect(h.started[0].args).toContain(stored.initialInput!.prompt)
  expect((await h.store.loadTimeline(input.agentSessionId)).items.filter(item => item.kind === 'user_message')).toEqual([])
  expect((await h.client.createAgentWithDelivery(input)).session.run).toEqual(result.session.run)
  await expect(h.client.createAgentWithDelivery({ ...input, agentMuxTask: task + '\nAnother task.' })).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
  expect(h.started).toHaveLength(1); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('preserves the actual frozen platform-only packet on pending creation and a new Core reader', async () => {
  const h = await learningCore(true); cleanups.push(h.close)
  const originalInput = h.inner.kernel.input.getMockImplementation()!
  h.inner.kernel.input.mockImplementationOnce(async (...args: any[]) => { await originalInput(...args); throw new Error('Original input ACK is unknown') })
  const input = { agentSessionId: 'deferred-task', createOperationId: 'deferred-create', providerId: 'codex', executorId: 'codex', workspacePath: h.root,
    injectAgentMuxGuide: false, agentMuxTask: task }
  const result = await h.client.createAgentWithDelivery(input), frozen = structuredClone((await h.store.readMetadata(input.agentSessionId))!.initialInput!)
  expect(result.creation).toMatchObject({ initialPrompt: 'not-requested', agentMuxContext: 'unconfirmed' })
  const record = await h.client.inspectAgentPromptSubmission(frozen.key!)
  expect(record?.admission?.intent).toMatchObject({ prompt: frozen.prompt, message: frozen.message })
  expect(h.inner.kernel.input.mock.calls[0][1].data).toBe(frozen.prompt + '\r')
  expect(frozen.message).toEqual({ systemContext: expect.stringContaining(input.agentMuxTask) })
  const reader = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.store.path), providers: [h.provider] }); cleanups.push(() => reader.dispose())
  const inner = reader as any; inner.connected = true; await inner.registry.load('local')
  for (const key of ['isConnected', 'identity', 'status', 'list', 'start', 'stop', 'input']) inner.kernel[key] = h.inner.kernel[key]
  const replayed = await reader.createAgentWithDelivery(input)
  expect(replayed.creation).toEqual(result.creation)
  expect((await h.store.readMetadata(input.agentSessionId))!.initialInput).toEqual(frozen)
  expect(h.inner.kernel.input).toHaveBeenCalledOnce(); expect(h.started).toHaveLength(1)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('continues a frozen unattempted task after owner restoration on a Provider without initialization control', async () => {
  const h = await learningCore(true); cleanups.push(h.close)
  await h.inner.recovery.dispose()
  h.inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => { throw new Error('Owner exits after Session commit') }, close: async () => {} })
  const input = { agentSessionId: 'unattempted-task', createOperationId: 'unattempted-create', providerId: 'codex', executorId: 'codex', workspacePath: h.root,
    injectAgentMuxGuide: false, agentMuxTask: task }
  await h.client.createAgentWithDelivery(input)
  const frozen = structuredClone((await h.store.readMetadata(input.agentSessionId))!.initialInput!)
  expect(frozen.state).toBe('prepared'); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  const reader = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(h.store.path), providers: [h.provider] }); cleanups.push(() => reader.dispose())
  const inner = reader as any; inner.connected = true; await inner.registry.load('local')
  for (const key of ['isConnected', 'identity', 'status', 'list', 'start', 'stop', 'input']) inner.kernel[key] = h.inner.kernel[key]
  inner.screenEvidence.wait = vi.fn(async () => 0)
  inner.recovery.restore(await h.store.load())
  await expect.poll(async () => (await h.store.readMetadata(input.agentSessionId))!.initialInput!.state).toBe('terminal-confirmed')
  const recovered = (await h.store.readMetadata(input.agentSessionId))!
  expect(recovered.initialInput).toMatchObject({ prompt: frozen.prompt, message: frozen.message, key: frozen.key })
  expect(recovered.creation).toMatchObject({ initialPrompt: 'not-requested', agentMuxContext: 'confirmed' })
  expect(h.inner.kernel.input.mock.calls[0][1].data).toBe(frozen.prompt + '\r')
  await reader.createAgentWithDelivery(input)
  expect(h.inner.kernel.input).toHaveBeenCalledOnce(); expect(h.started).toHaveLength(1)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('keeps note-only launches waiting and rejects malformed platform-task input at the actual SDK boundary', async () => {
  const h = await learningCore(); cleanups.push(h.close)
  const input = { agentSessionId: 'note-only', createOperationId: 'note-create', providerId: 'codex', executorId: 'codex', workspacePath: h.root,
    injectAgentMuxGuide: false, agentMuxNote: 'A note alone is not an explicit task.' }
  await h.client.createAgentWithDelivery(input)
  expect(h.started[0].args).toContainEqual(expect.stringContaining('No request yet.'))
  await expect(h.client.createAgentWithDelivery({ ...input, agentSessionId: 'invalid-task', createOperationId: 'invalid-create',
    agentMuxTask: ['forged task'] as unknown as string })).rejects.toMatchObject({ code: 'INVALID_AGENT_PROMPT' })
  expect(h.started).toHaveLength(1)
})
