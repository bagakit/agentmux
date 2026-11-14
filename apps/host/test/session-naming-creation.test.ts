import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, stat } from 'node:fs/promises'
import { creationInputOwner } from '../../../packages/core/test/helpers/creation-input-owner.js'
import { AGENTMUX_SESSION_NAMING_ENTRY } from '../../../packages/core/src/agent-messaging-guidance.js'
import { createMoteConversationStartFixture } from './helpers/mote-conversation-start-fixture.js'
import type { RunSpec } from '@ctxmux/sdk'

const closes: Array<() => Promise<void>> = [], roots: string[] = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
    if (process.env.GENERAL_NAMING_FACTS) await appendFile(process.env.GENERAL_NAMING_FACTS, JSON.stringify({ kind: 'cleanup', root, absent: true }) + '\n')
  }
})
const record = async (fact: unknown) => {
  if (process.env.GENERAL_NAMING_FACTS) await appendFile(process.env.GENERAL_NAMING_FACTS, JSON.stringify(fact) + '\n')
}
// The older creation fixture supplies the Start leaf. Bind the current prepared
// dispatch to that same controlled Runtime, as the existing private chat does.
function bindPreparedRuntime(h: Awaited<ReturnType<typeof creationInputOwner>>) {
  const runtime = { runtimeId: 'session-naming-fixture', instanceId: 'session-naming-owner', buildIdentity: 'fixture', protocolVersion: 1 }
  h.inner.kernel.creationRuntimeIdentity = () => runtime
  h.inner.hookServer.createBinding = (_sessionId: string, _providerId: string, bindingId: string) => ({ bindingId,
    endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  h.inner.kernel.startPrepared = async (request: RunSpec, operationKey: string,
    expected: typeof runtime) => {
    expect(expected).toEqual(runtime)
    expect(request.env?.AGENTMUX_LIFECYCLE_OPERATION_ID).toBe(operationKey)
    return await h.inner.kernel.start({ ...request, operationKey })
  }
}

it('ordinary Core creation freezes shortest naming discovery with its original first task while the full guide stays off', async () => {
  const h = await creationInputOwner(); roots.push(h.root); closes.push(h.close)
  bindPreparedRuntime(h)
  const input = { agentSessionId: 'original-general-task', createOperationId: 'original-general-create', providerId: 'codex',
    executorId: 'codex', workspacePath: h.root, injectAgentMuxGuide: false, prompt: '  Preserve my first <task> & original body.\r\n' }
  const created = await h.client.createAgentWithDelivery(input)
  const saved = await h.store.readMetadata(created.session.agentSessionId)
  expect(saved?.initialInput?.message.systemContext).toContain(AGENTMUX_SESSION_NAMING_ENTRY)
  expect(saved!.initialInput!.message.systemContext!.split(AGENTMUX_SESSION_NAMING_ENTRY)).toHaveLength(2)
  expect(saved!.initialInput!.message.systemContext).not.toContain('AgentMux runtime guide:')
  expect(saved!.initialInput!.message.userContent).toBe(input.prompt)
  expect(saved!.initialInput!.input.prompt).toBe(input.prompt)
  expect(created.creation).toMatchObject({ agentMuxContext: 'confirmed', initialPrompt: 'confirmed' })
  expect(h.started).toHaveLength(1)
  const packet = structuredClone(saved!.initialInput)
  await h.client.createAgentWithDelivery(input)
  expect((await h.store.readMetadata(input.agentSessionId))?.initialInput).toEqual(packet)
  expect(h.started).toHaveLength(1)
  await record({ kind: 'ordinary-core', agentSessionId: created.session.agentSessionId, run: created.session.run,
    createOperationId: created.creation.createOperationId, message: packet!.message, packetKey: packet!.key, starts: h.started.length })
})

it('a genuinely empty guide-disabled Core creation does not acquire an initialization packet or naming input', async () => {
  const h = await creationInputOwner(); roots.push(h.root); closes.push(h.close)
  bindPreparedRuntime(h)
  const created = await h.client.createAgentWithDelivery({ agentSessionId: 'original-empty-session', createOperationId: 'original-empty-create',
    providerId: 'codex', executorId: 'codex', workspacePath: h.root, injectAgentMuxGuide: false })
  const saved = await h.store.readMetadata(created.session.agentSessionId)
  expect(saved?.initialInput).toBeUndefined()
  expect(created.creation.initialPrompt).toBe('not-requested')
  expect(created.creation.agentMuxContext).toBeUndefined()
  expect(h.started).toHaveLength(1); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  await record({ kind: 'empty-core', agentSessionId: created.session.agentSessionId, run: created.session.run,
    initialInput: saved?.initialInput ?? null, creation: created.creation, starts: h.started.length, inputs: h.inner.kernel.input.mock.calls.length })
})

it('actual original agent.open Main creation reuses the same Core entry in its existing platform context without a naming turn', async () => {
  const f = await createMoteConversationStartFixture({ providerId: 'claude' }); roots.push(f.h.root); closes.push(f.close)
  bindPreparedRuntime(f.h)
  const opened = await f.start('original-main-general-naming')
  expect(opened.agent, JSON.stringify(opened)).not.toBeNull()
  const setup = await f.setup('original-main-general-naming')
  expect(setup.binding).toBe('confirmed')
  const main = await f.main.readCurrentMoteMain(f.target)
  expect(main.current?.sessionId).toBe(opened.agent!.agentSessionId)
  const session = await f.h.store.readMetadata(opened.agent!.agentSessionId)
  expect(session?.initialInput?.message.systemContext).toContain(AGENTMUX_SESSION_NAMING_ENTRY)
  expect(session!.initialInput!.message.systemContext!.split(AGENTMUX_SESSION_NAMING_ENTRY)).toHaveLength(2)
  expect(session!.initialInput!.message.systemContext).not.toContain('AgentMux runtime guide:')
  expect(session!.initialInput!.message.systemContext).toContain('No request yet.')
  expect(session!.initialInput!.message.userContent).toBeUndefined()
  expect(session!.creation).toMatchObject({ initialPrompt: 'not-requested', agentMuxContext: 'confirmed' })
  expect(f.h.started).toHaveLength(1); expect(f.h.inner.kernel.input).toHaveBeenCalledOnce()
  expect(setup.deferredInput).toBeUndefined()
  await record({ kind: 'original-main', target: f.target, operationId: setup.operationId, agentSessionId: session!.agentSessionId,
    run: session!.run, role: main.current, binding: setup.binding, message: session!.initialInput!.message,
    starts: f.h.started.length, inputs: f.h.inner.kernel.input.mock.calls.length })
})
