import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createHistoryQueryFixture, createHostedHistoryFixture } from './helpers/session-history-query.js'
import { inputCorrelationCore } from './helpers/input-correlation.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { parseAgentSessionHistoryReadPage } from '../src/session-history-read-codec.js'
import { normalizeAgentTimelineMutation } from '../src/session-timeline.js'
import { consumeConversationWindowPage } from '../src/conversation-changes.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('the original public input writer records only exact userContent, independently of author and delivery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amux-content-origin-')); closes.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'queue.ndjson'))
  const f = await inputCorrelationCore('traex'); closes.push(f.dispose)
  const body = '  public request 中文🙂\n<amux from="amux">user quotation</amux>  '
  await f.hosted.submitAgentPrompt({ ...agentPromptCondition(f.core.agentSession('private-agent')), agentSessionId: 'private-agent',
    operationId: 'content-boundary-operation', prompt: body, agentMuxNote: 'internal generated context sentinel', authorHuman: true })
  const timeline = await f.store.loadTimeline('private-agent')
  expect(timeline.items.filter(item => item.kind === 'system_message')).toMatchObject([{ content: 'internal generated context sentinel' }])
  expect(timeline.items.filter(item => item.kind === 'system_message').every(item => item.publicContent === undefined)).toBe(true)
  expect(timeline.items.find(item => item.kind === 'user_message')).toMatchObject({ content: body, publicContent: 'confirmed', authorHuman: true })
  const input = { hostId: 'local', agentSessionId: 'private-agent', source: 'captured' as const, kind: 'user-message' as const }
  const page = await f.hosted.readAgentSessionHistory(input)
  expect(page.userMessages).toMatchObject([{ content: body, publicContent: 'confirmed', author: { kind: 'human' } }])
  expect(page.userMessages![0]!.content).not.toContain('internal generated context sentinel')
  expect(f.core.agentSession('private-agent').run).toEqual({ runId: 'original' })
  // Read metadata did not consume or replay the input; the existing Native byte receipt remains separate.
  expect(f.input).toHaveBeenCalledTimes(1)
  const original = timeline.items.find(item => item.kind === 'user_message')!
  await f.store.applyTimelineMutation({ type: 'update', agentSessionId: 'private-agent', itemId: original.id,
    updatedAt: original.updatedAt + 1, status: 'failed' })
  expect((await f.hosted.readAgentSessionHistory(input)).userMessages![0]).toMatchObject({ publicContent: 'confirmed', deliveryStatus: 'failed' })
  await f.store.applyTimelineMutation({ type: 'update', agentSessionId: 'private-agent', itemId: original.id,
    updatedAt: original.updatedAt + 2, content: 'Updated original body without a userContent fact' })
  expect((await f.hosted.readAgentSessionHistory(input)).userMessages![0]).toMatchObject({ publicContent: 'unknown', author: { kind: 'human' },
    content: 'Updated original body without a userContent fact' })
  await f.hosted.writeAgent({ agentSessionId: 'private-agent', expectedRun: { runId: 'original' }, data: 'ordinary draft', source: 'user' })
  expect(f.input).toHaveBeenCalledTimes(2)
})

it('legacy captured content stays unknown even with a known author, and distinct equal native inputs stay unknown', async () => {
  const f = await createHistoryQueryFixture(closes)
  const captured = await f.client.readAgentSessionHistory({ ...f.reference, source: 'captured', kind: 'user-message' })
  expect(captured.userMessages).toHaveLength(4)
  expect(captured.userMessages!.every(message => message.publicContent === 'unknown' && message.author.kind === 'human')).toBe(true)
  const same = captured.userMessages!.filter(message => message.content === 'same input')
  expect(same).toHaveLength(2); expect(same[0]!.id).not.toBe(same[1]!.id)
  const native = await f.client.readAgentSessionHistory({ ...f.reference, source: 'native', kind: 'user-message' })
  expect(native.userMessages).toHaveLength(5)
  expect(native.userMessages!.every(message => message.publicContent === 'unknown' && message.author.kind === 'unknown' && message.source.kind === 'native')).toBe(true)
  await f.noControls()
})

it('the Hosted SDK, public RPC and actual compiled CLI preserve the same original content boundary', async () => {
  const f = await createHostedHistoryFixture(); closes.push(f.dispose)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId,
    item: { ...f.captured(9, 'Exact owned public content'), publicContent: 'confirmed', authorHuman: undefined } })
  const path = join(f.root, 'control.sock')
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: () => [{ hostId: 'local', client: f.ownerClient }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); closes.push(() => rpc.dispose())
  for (const source of ['captured', 'native'] as const) {
    const input = { ...f.reference, source, kind: 'user-message' as const }
    const hosted = await f.client.readAgentSessionHistory(input), publicPage = await rpc.call('agent.history', input)
    expect(publicPage.userMessages).toEqual(hosted.userMessages)
    const cli = await runCompiledObjectCli(['agent', 'history', '--host', 'local', '--session', f.session.agentSessionId,
      '--source', source, '--kind', 'user-message'], objectCliEnvironment(f.root))
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout).result.userMessages).toEqual(publicPage.userMessages)
    expect(publicPage.userMessages!.every(message => message.publicContent === (source === 'captured' && message.rawId === 'captured-9' ? 'confirmed' : 'unknown'))).toBe(true)
  }
  const raw = await f.ownerClient.sessionHistoryPage(f.session.agentSessionId)
  expect(raw.items).toHaveLength(5)
  expect(raw.items.every(item => !Object.hasOwn(item, 'publicContent'))).toBe(true)
  const shared = consumeConversationWindowPage(await f.client.readAgentConversation(f.reference))
  const publicShared = consumeConversationWindowPage(await rpc.call('agent.conversation.inspect', f.reference))
  const cli = await runCompiledObjectCli(['agent', 'conversation', 'inspect', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(f.reference))
  expect(cli.code, cli.stderr).toBe(0)
  const cliShared = consumeConversationWindowPage(JSON.parse(cli.stdout).result)
  expect(shared.kind).toBe('complete'); expect(publicShared.kind).toBe('complete'); expect(cliShared.kind).toBe('complete')
  if (shared.kind !== 'complete' || publicShared.kind !== 'complete' || cliShared.kind !== 'complete') throw Error('Expected complete original Reader windows')
  expect(shared.snapshot.units).not.toHaveLength(0)
  expect(publicShared.snapshot.units).toEqual(shared.snapshot.units)
  expect(cliShared.snapshot.units).toEqual(shared.snapshot.units)
  const originals = shared.snapshot.units.flatMap(unit => unit.records)
  expect(originals.filter(record => record.original.kind === 'native')).toHaveLength(5)
  expect(originals.find(record => record.original.item.id === 'captured-9')?.original.item).toMatchObject({ content: 'Exact owned public content', publicContent: 'confirmed' })
  await f.noControls()
})

it('strict original result and timeline codecs reject coerced or invented public-content facts', async () => {
  const f = await createHistoryQueryFixture(closes), input = { ...f.reference, source: 'native' as const, kind: 'user-message' as const }
  const page = await f.client.readAgentSessionHistory(input)
  expect(parseAgentSessionHistoryReadPage(page, input)).toEqual(page)
  for (const value of ['confirmed', ['unknown'], null, {}, true]) {
    const forged = structuredClone(page); Object.assign(forged.userMessages![0]!, { publicContent: value })
    expect(() => parseAgentSessionHistoryReadPage(forged, input)).toThrow()
  }
  const item = f.captured(10, 'Original legacy body')
  for (const value of ['unknown', ['confirmed'], null, {}, true]) {
    expect(() => normalizeAgentTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item: { ...item, publicContent: value } })).toThrow()
  }
  expect(() => normalizeAgentTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId,
    item: { ...item, kind: 'system_message', source: 'agentmux', publicContent: 'confirmed' } })).toThrow()
  expect(normalizeAgentTimelineMutation({ type: 'append', agentSessionId: f.session.agentSessionId, item })).toMatchObject({ item: { content: item.content } })
  await f.noControls()
})

it('the actual public RPC and compiled CLI reject a coerced content-boundary response', async () => {
  const f = await createHistoryQueryFixture(closes)
  const input = { ...f.reference, source: 'native' as const, kind: 'user-message' as const }
  const forged = await f.client.readAgentSessionHistory(input)
  Object.assign(forged.userMessages![0]!, { publicContent: ['unknown'] })
  vi.spyOn(f.client, 'readAgentSessionHistory').mockResolvedValue(forged)
  const path = join(f.root, 'control.sock')
  const server = new AgentMuxControlServer({ socketPath: path, coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); closes.push(() => rpc.dispose())
  const cli = await runCompiledObjectCli(['agent', 'history', '--host', 'local', '--session', f.session.agentSessionId,
    '--source', 'native', '--kind', 'user-message'], objectCliEnvironment(f.root))
  expect(cli.code).not.toBe(0)
  expect(cli.stdout + cli.stderr).toContain('CONTROL_PROTOCOL_ERROR')
  await expect(rpc.call('agent.history', input)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  await f.noControls()
})
