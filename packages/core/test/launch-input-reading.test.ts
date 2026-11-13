import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { consumeConversationWindowPage } from '../src/conversation-changes.js'
import { projectConversationWindow } from '../src/conversation.js'
import { hashAgentCapability, issueAgentCapability } from '../src/agent-capability.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { conversationReaderCli } from './helpers/conversation-reader-cli.js'
import type { AgentMuxAgentSession, AgentTimelineItem } from '../src/types.js'
import { core, fixture } from './helpers/prepared-resume-fixture.js'

async function reading(f: Awaited<ReturnType<typeof fixture>>, session: AgentMuxAgentSession, client = f.client) {
  const page = await client.readAgentConversation({ hostId: 'local', agentSessionId: session.agentSessionId, limit: 100 })
  const read = consumeConversationWindowPage(page)
  expect(read.kind).toBe('complete')
  if (read.kind !== 'complete') throw new Error('Expected the complete bounded captured conversation')
  const originals = read.snapshot.units.flatMap(unit => unit.records).flatMap(record => record.original.kind === 'captured' ? [record.original.item] : [])
  const projected = projectConversationWindow(read.snapshot)
  if (page.window.view) await client.releaseConversationView({ hostId: 'local', agentSessionId: session.agentSessionId, view: page.window.view })
  return { originals, projected }
}

async function creation(f: Awaited<ReturnType<typeof fixture>>, envelope = false) {
  const provider = { ...f.provider, buildLaunch(context: Parameters<typeof f.provider.buildLaunch>[0]) {
    const plan = f.provider.buildLaunch(context)
    return { ...plan, args: [...plan.args, ...(context.prompt ? [context.prompt] : [])] }
  } }
  f.client.providers.replace(provider)
  let initialMessage
  if (envelope) {
    const capability = issueAgentCapability(), previous = (await f.store.readMetadata(f.previous.agentSessionId))!
    await f.store.compareAndSwapMetadata(previous, { ...previous, capabilityHash: hashAgentCapability(capability), updatedAt: previous.updatedAt + 1 })
    initialMessage = { callerAgentSessionId: previous.agentSessionId, capability }
  }
  return await f.client.createAgentWithDelivery({ createOperationId: 'original-create', providerId: provider.id, executorId: provider.id,
    workspacePath: f.root, ...(f.request.args ? { args: f.request.args } : {}), injectAgentMuxGuide: false, prompt: 'Original public task', agentMuxNote: 'Private platform context',
    ...(initialMessage ? { initialMessage } : {}) })
}

function userRecord(originals: AgentTimelineItem[], content: string) {
  const item = originals.find(item => item.kind === 'user_message' && item.content === content)
  expect(item).toBeDefined()
  return item!
}

it('reads the exact creation input key through the common conversation without absorbing system context', async () => {
  const f = await fixture(), created = await creation(f), { originals, projected } = await reading(f, created.session)
  const prompt = userRecord(originals, 'Original public task'), key = created.creation.initialInputKey!
  expect(key).toBeDefined(); expect(prompt.inputRef).toEqual(key); expect(key.expectedRun).toEqual(created.session.run)
  expect(prompt.id).toBe('prompt:' + (await f.store.readMetadata(created.session.agentSessionId))!.initialInput!.lifecycleOperationId)
  expect(prompt).toMatchObject({ status: 'complete', source: 'user', publicContent: 'confirmed' })
  expect(projected.inputs.find(input => input.content === prompt.content)?.inputRef).toEqual(key)
  const context = originals.find(item => item.kind === 'system_message')!
  expect(context.content).toContain('Private platform context'); expect(context.inputRef).toBeUndefined()
  expect(projected.inputs.some(input => input.content.includes('Private platform context'))).toBe(false)
  expect(originals).toHaveLength(2)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  let cli: Awaited<ReturnType<typeof conversationReaderCli>> | undefined
  try {
    await server.start(); cli = await conversationReaderCli(f.root)
    const receipt = await cli.run(['agent', 'conversation', 'inspect', '--input', '-'], JSON.stringify({ hostId: 'local', agentSessionId: created.session.agentSessionId, limit: 100 }))
    expect(receipt.code, receipt.stderr).toBe(0)
    const page = JSON.parse(receipt.stdout).result as Parameters<typeof consumeConversationWindowPage>[0], read = consumeConversationWindowPage(page)
    expect(read.kind).toBe('complete'); if (read.kind !== 'complete') throw new Error('Expected the actual CLI bounded conversation')
    expect(projectConversationWindow(read.snapshot).inputs.find(input => input.content === prompt.content)?.inputRef).toEqual(key)
    const released = await cli.run(['agent', 'conversation', 'release', '--host', 'local', '--session', created.session.agentSessionId, '--view', page.window.view!])
    expect(released.code, released.stderr).toBe(0); expect(JSON.parse(released.stdout).result.released).toBe(true)
  } finally {
    const closed = await Promise.allSettled([cli?.close(), server.stop()])
    const failures = closed.flatMap(value => value.status === 'rejected' ? [value.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Private CLI fixture cleanup failed')
  }
  f.noReplacement()
})

it('keeps an initial envelope at its original message owner without inventing public prompt qualification', async () => {
  const f = await fixture(), created = await creation(f, true), { originals, projected } = await reading(f, created.session)
  const prompt = originals.find(item => item.kind === 'user_message')!
  expect(prompt).toBeDefined(); expect(prompt.authorAgentSessionId).toBe(f.previous.agentSessionId)
  expect(prompt.content).toContain('Original public task'); expect(prompt.publicContent).toBeUndefined(); expect(prompt.inputRef).toBeUndefined()
  expect(projected.inputs.every(input => input.inputRef === undefined)).toBe(true)
  expect(originals.find(item => item.kind === 'system_message')?.inputRef).toBeUndefined()
  const inspection = await f.client.inspectAgentCreation(created.session.agentSessionId)
  expect(inspection.kind).toBe('agent')
  if (inspection.kind !== 'agent') throw new Error('Expected the original created Agent')
  expect(created.creation.initialMessageId).toBeTruthy()
  expect(inspection.creation?.initialMessageId).toBe(created.creation.initialMessageId)
  f.noReplacement()
})

it('reads the normal resume original key and body through the common conversation', async () => {
  const f = await fixture(), resumed = await f.resume(), input = resumed.continuity!.launchInput!, { originals, projected } = await reading(f, resumed)
  const prompt = userRecord(originals, f.request.prompt!)
  expect(input.key).toBeDefined(); expect(prompt.inputRef).toEqual(input.key); expect(input.key!.expectedRun).toEqual(resumed.run)
  expect(prompt).toMatchObject({ id: 'prompt:' + input.input.submissionId, status: 'complete', publicContent: 'confirmed' })
  expect(projected.inputs.find(value => value.content === prompt.content)?.inputRef).toEqual(input.key)
  expect(originals.find(item => item.kind === 'system_message')?.inputRef).toBeUndefined(); f.noReplacement()
})

it.each(['positional-argv', 'post-launch-only'] as const)('reads the %s reconciled original key after an applied Start loses its acknowledgement', async delivery => {
  const f = await fixture(delivery)
  f.start.mockImplementationOnce(async (...args: any[]) => { await f.nativeStart(...args); throw new core.AgentMuxError('Original Start acknowledgement lost', 'CONTROL_UNAVAILABLE', undefined, { disposition: 'unknown', confirmedInputBytes: null }) })
  await expect(f.resume()).rejects.toMatchObject({ code: 'AGENT_RESUME_UNCONFIRMED' })
  expect((await f.store.loadTimeline(f.previous.agentSessionId)).items).toHaveLength(0)
  await f.client.dispose(); const second = await f.reader(), resumed = await f.resume({}, second), input = resumed.continuity!.launchInput!
  const { originals, projected } = await reading(f, resumed, second.client), prompt = userRecord(originals, f.request.prompt!)
  expect(input.key).toBeDefined(); expect(prompt.inputRef).toEqual(input.key); expect(input.key!.expectedRun).toEqual(resumed.run)
  expect(prompt).toMatchObject({ id: 'prompt:' + input.input.submissionId, status: 'complete', publicContent: 'confirmed' })
  expect(projected.inputs.find(value => value.content === prompt.content)?.inputRef).toEqual(input.key)
  expect(originals.find(item => item.kind === 'system_message')?.inputRef).toBeUndefined()
  expect((await f.resume({}, second)).run).toEqual(resumed.run); f.noReplacement(delivery === 'post-launch-only' ? 1 : 0)
})

it('keeps an unknown resume delivery unknown while its original captured key remains readable', async () => {
  const f = await fixture('post-launch-only'), originalInput = f.input.getMockImplementation()!
  f.input.mockImplementationOnce(async (...args: any[]) => { await originalInput(...args); throw new core.AgentMuxError('Original input acknowledgement lost', 'CONTROL_UNAVAILABLE') })
  const resumed = await f.resume(), input = resumed.continuity!.launchInput!, { originals, projected } = await reading(f, resumed)
  expect(input.state).toBe('unknown')
  const prompt = userRecord(originals, f.request.prompt!)
  expect(prompt).toMatchObject({ id: 'prompt:' + input.input.submissionId, status: 'failed', inputRef: input.key })
  expect(projected.inputs.find(value => value.content === prompt.content)?.inputRef).toEqual(input.key)
  expect((await f.client.inspectAgentPromptSubmission(input.key!))?.admission?.acknowledged).toBe(false); f.noReplacement(1)
})

it('keeps a no-key original record unchanged rather than migrating or guessing its identity', async () => {
  const f = await fixture(), resumed = await f.resume({ prompt: '', agentMuxNote: 'Context only' })
  const events: Array<{ code?: string }> = []; f.client.onEvent(event => { if (event.type === 'agent-error') events.push(event) })
  const writer = f.inner.recovery.ports.input.recordPromptMessageAfterSideEffect
  await writer(resumed, 'original-unkeyed', 'Prompt', { userContent: 'Original unkeyed body' })
  const before = (await f.store.loadTimeline(resumed.agentSessionId)).items.find(item => item.id === 'prompt:original-unkeyed')!
  expect(before.inputRef).toBeUndefined()
  await writer(resumed, 'original-unkeyed', 'Prompt', { userContent: before.content }, 'complete', {
    kind: 'prompt', agentSessionId: resumed.agentSessionId, expectedRun: resumed.run, submissionId: 'original-unkeyed' })
  const { originals, projected } = await reading(f, resumed)
  expect(originals.find(item => item.id === before.id)).toEqual(before)
  expect(projected.inputs.find(value => value.content === before.content)?.inputRef).toBeUndefined()
  expect(events.some(event => event.code === 'AGENT_TIMELINE_ID_CONFLICT')).toBe(true); f.noReplacement()
})

it('keeps the authored resume body readable when its unrelated journal lookup is unavailable', async () => {
  const f = await fixture()
  vi.spyOn(f.inner.messageQueue, 'inspectInput').mockRejectedValue(new Error('Original journal observation unavailable'))
  f.client.providers.replace({ ...f.provider, buildResumeLaunch: context => f.provider.buildResumeLaunch({ ...context, args: f.request.args! }) })
  const result = await f.client.ensureAgentContinuity({ agentSessionId: f.previous.agentSessionId, expectedRun: f.previous.run,
    operationId: f.request.operationId, trigger: 'input', input: { submissionId: 'original-authored-input', prompt: f.request.prompt!, authorHuman: true } })
  expect(result.kind).toBe('resumed')
  const resumed = f.client.agentSession(f.previous.agentSessionId), input = resumed.continuity!.launchInput!
  const { originals, projected } = await reading(f, resumed), prompt = userRecord(originals, f.request.prompt!)
  expect(prompt).toMatchObject({ id: 'prompt:' + input.input.submissionId, authorHuman: true, status: 'complete', inputRef: input.key })
  expect(projected.inputs.find(value => value.content === prompt.content)?.inputRef).toEqual(input.key); f.noReplacement()
})

it('keeps an ordinary authored journal input at its canonical record across repeated consumers', async () => {
  const f = await fixture(), resumed = await f.resume(), prompt = 'Ordinary journal-owned human input'
  const request = { agentSessionId: resumed.agentSessionId, expectedRun: resumed.run, operationId: 'ordinary-human',
    prompt, authorHuman: true, execution: 'immediate' as const, admissionIntent: { kind: 'manual-actor' as const } }
  await f.client.submitAgentPrompt(request)
  const key = { kind: 'prompt' as const, agentSessionId: resumed.agentSessionId, expectedRun: resumed.run, submissionId: request.operationId }
  const saved = await f.inner.messageQueue.inspectInput({ key })
  expect(saved.intent.source).toMatchObject({ kind: 'prompt', authorHuman: true, prompt })
  const before = await reading(f, resumed), original = userRecord(before.originals, prompt)
  expect(original.inputRef).toEqual(key); expect(original.inputOrigin).toBeDefined(); expect(original.inputSubmission).toBeDefined()
  await f.client.submitAgentPrompt(request)
  await f.inner.recovery.ports.input.recordPromptMessageAfterSideEffect(resumed, request.operationId, 'Prompt', { userContent: prompt, authorHuman: true }, 'complete', key)
  const after = await reading(f, resumed)
  expect(after.originals.filter(item => item.content === prompt)).toEqual([original])
  expect(after.projected.inputs.filter(input => input.content === prompt)).toHaveLength(1); f.noReplacement(1)
})
