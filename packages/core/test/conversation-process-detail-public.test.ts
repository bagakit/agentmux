import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { consumeConversationWindowPage, type AgentConversationReadPage } from '../src/conversation.js'
import { runCompiledObjectCli, objectCliEnvironment } from './helpers/object-cli-rpc.js'
const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
it('compiled CLI and route-scoped RPC discover and consume the same deferred original/detail contract', async () => {
  const body = 'public exact tool payload '.repeat(4500)
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'assistant', uuid: 'native-tool', sessionId: 'native-main', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'inspect', input: { body } }] } }]))
  closes.push(f.close)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: { id: 'captured-tool', agentSessionId: f.session.agentSessionId,
    kind: 'tool_call', source: 'native-hook', status: 'failed', title: 'captured', toolInput: body, createdAt: 1, updatedAt: 2 } })
  const socketPath = join(f.root, 'control.sock'), server = new AgentMuxControlServer({ socketPath, coreClients: () => [{ hostId: 'original-route', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); closes.push(() => rpc.dispose())
  const input = { hostId: 'original-route', agentSessionId: f.session.agentSessionId, processDetails: 'deferred' as const }
  const page = await rpc.call('agent.conversation.inspect', input), result = consumeConversationWindowPage(page)
  expect(result.kind).toBe('complete'); expect(page.hostId).toBe('original-route'); expect(page.sourceHostId).toBe('local')
  expect(JSON.stringify(page)).not.toContain(body)
  if (result.kind !== 'complete') throw Error('Expected headers in one public frame')
  const cli = await runCompiledObjectCli(['agent', 'conversation', 'inspect', '--host', input.hostId, '--session', input.agentSessionId, '--process-details', 'deferred'], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0)
  const cliPage = JSON.parse(cli.stdout).result as AgentConversationReadPage
  expect(cliPage.processDetails).toBe('deferred'); expect(JSON.stringify(cliPage)).not.toContain(body)
  const help = await runCompiledObjectCli(['agent', 'conversation', 'inspect', '--help'], objectCliEnvironment(f.root))
  expect(help.code).toBe(0); expect(help.stdout).toContain('--process-details deferred')
  const guide = await runCompiledObjectCli(['agent', '--skill'], objectCliEnvironment(f.root))
  expect(guide.code).toBe(0); expect(guide.stdout).toContain('--process-details deferred')
  for (const source of result.snapshot.units.flatMap(unit => unit.records)) {
    const anchor = { record: source.reference!, revision: source.revision, frontier: result.snapshot.window.checkpoint }
    const detail = await rpc.call('agent.conversation.inspect', { hostId: input.hostId, agentSessionId: input.agentSessionId, anchor, maxBytes: 1048576 })
    const assembled = consumeConversationWindowPage(detail)
    expect(assembled.kind).toBe('complete')
    expect(JSON.stringify(detail)).toContain(body)
    expect(detail.hostId).toBe(input.hostId); expect(detail.sourceHostId).toBe('local')
    const detailCli = await runCompiledObjectCli(['agent', 'conversation', 'inspect', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify({ hostId: input.hostId, agentSessionId: input.agentSessionId, anchor, maxBytes: 1048576 }))
    expect(detailCli.code, detailCli.stderr).toBe(0); expect(detailCli.stdout).toContain(body)
  }
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}, 30000)
