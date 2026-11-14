import { afterEach, expect, it, vi } from 'vitest'
import { connectSpaceMember } from '../src/space-member-client.js'
import { createSpaceSessionsFixture } from './helpers/space-session-fixture.js'
import type { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { parseSpaceMemberParams } from '../src/space-member-codec.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it('the original bounded conversation is readable without a current Run or Native observation', async () => {
  const f = await createSpaceSessionsFixture(cleanup), sid = 'original-reading-agent'
  await f.b.put(sid); const session = await f.d.put(sid)
  const admitted = await f.admit('D-in-B', f.d.owner.runtimeId, sid, 'original-reading-C')
  const store = Reflect.get(f.d.core, 'store') as AgentMuxMemoryAgentSessionStore
  await store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: { id: 'original-reading-record', agentSessionId: sid,
    kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Original result', content: 'Original durable result', createdAt: 1, updatedAt: 1 } })
  const native = vi.spyOn(f.d.core, 'runtimeSubject').mockRejectedValue(Error('A durable reading must not inspect Native state'))
  const observer = vi.spyOn(f.b.core, 'readAgentConversation').mockRejectedValue(Error('The namesake observer must not supply this record'))
  const effects = ['createAgent', 'resumeAgent', 'restartAgent', 'writeAgent', 'pasteAgent'] as const
  const calls = effects.map(method => vi.spyOn(f.d.core, method))
  const target = { kind: 'conversation' as const, reference: f.reference, regionId: admitted.address.regionId,
    runtimeId: f.d.owner.runtimeId, agentSessionId: sid, expectedAdmission: { kind: 'creation' as const, operationId: admitted.requestId } }
  const outcome = await (async () => {
    const client = await connectSpaceMember(f.b.rpc, target); cleanup.push(() => client.dispose())
    const page = await client.readAgentConversation({ hostId: 'local', agentSessionId: sid, limit: 3, maxBytes: 64 * 1024 })
    if (page.window.view) await client.releaseConversationView({ hostId: 'local', agentSessionId: sid, view: page.window.view })
    return page
  })().then(value => ({ value }), error => ({ error }))
  expect(outcome).toHaveProperty('value')
  expect(JSON.stringify(outcome)).toContain('Original durable result')
  const call = { method: 'runtime.invoke' as const, params: { consumerId: 'original-cli-reader', fence: {
    runtimeId: f.d.owner.runtimeId, ownerInstanceId: f.d.owner.ownerInstanceId }, invocation: { method: 'readAgentConversation' as const,
    args: [{ hostId: 'local', agentSessionId: sid, limit: 3, maxBytes: 65536 }] } } }
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.b.server.path, 'space', 'member', 'call', '--input', '-'], objectCliEnvironment(f.b.root), JSON.stringify({ target, call }))
  expect(cli.code, cli.stderr).toBe(0); expect(cli.stdout).toContain('Original durable result')
  const view = JSON.parse(cli.stdout).result.value.window.view
  if (view) await f.b.rpc.call('space.member.call', { target, call: { ...call, params: { ...call.params,
    invocation: { method: 'releaseConversationView', args: [{ hostId: 'local', agentSessionId: sid, view }] } } } })
  expect(native).not.toHaveBeenCalled(); expect(observer).not.toHaveBeenCalled()
  for (const call of calls) expect(call).not.toHaveBeenCalled()
  expect(await f.d.core.readAgentSession(sid)).toMatchObject({ run: session.run })
})

it('conversation-only member access cannot manufacture a Run, omit C/L or acquire Native/input methods', () => {
  const target = { kind: 'conversation' as const, reference: { runtimeId: 'source', spaceId: 'original' }, regionId: 'original-region',
    runtimeId: 'execution', agentSessionId: 'original-agent', expectedAdmission: { kind: 'creation' as const, operationId: 'original-C' } }
  const packet = (method: string, args: unknown[]) => ({ target, call: { method: 'runtime.invoke', params: {
    consumerId: 'original-reader', fence: { runtimeId: 'execution', ownerInstanceId: 'original-instance' }, invocation: { method, args } } } })
  const read = packet('readAgentConversation', [{ hostId: 'local', agentSessionId: 'original-agent', limit: 3, maxBytes: 65536 }])
  expect(() => parseSpaceMemberParams('space.member.call', read)).not.toThrow()
  expect(() => parseSpaceMemberParams('space.member.call', { ...read, target: { ...target, expectedRun: { runId: 'invented' } } })).toThrow()
  const { expectedAdmission: _pin, ...unpinned } = target
  expect(() => parseSpaceMemberParams('space.member.call', { ...read, target: unpinned })).toThrow()
  for (const method of ['runtimeSubject', 'readAgentSession', 'attachTerminal', 'writeAgent', 'pasteAgent', 'submitAgentPrompt', 'signalAgent', 'stopAgentInputWaiting', 'rejoinAgentInputWaiting']) {
    expect(() => parseSpaceMemberParams('space.member.call', packet(method, [{ kind: 'agent-session', agentSessionId: 'original-agent' }]))).toThrow()
  }
  expect(() => parseSpaceMemberParams('space.member.call', packet('readAgentConversation', [{ hostId: 'local', agentSessionId: 'namesake' }]))).toThrow()
  for (const method of ['runtime.bootstrap', 'runtime.events']) expect(() => parseSpaceMemberParams(method === 'runtime.events' ? 'space.member.watch' : 'space.member.call', {
    target, call: { method, params: { consumerId: 'reader', fence: { runtimeId: 'execution', ownerInstanceId: 'instance' }, agentSessionIds: ['original-agent'], sessions: 'full' } }
  })).toThrow()
})
