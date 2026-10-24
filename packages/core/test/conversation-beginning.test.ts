import { appendFileSync } from 'node:fs'
import { appendFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'
import { parseConversationCheckpointInput, consumeConversationWindowPage, type ConversationChangesInput,
  type ConversationChangesPage, type ConversationCheckpointPage, type ConversationWindowAssembly } from '../src/conversation.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxError } from '../src/errors.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const release of close.splice(0).reverse()) await release(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const ref = { hostId: 'local', agentSessionId: 'private-agent' }
const claudeRow = (id: string) => ({ sessionId: 'native-main', uuid: id, type: 'assistant', message: { role: 'assistant', content: id } })
const codexRow = (id: string) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', id, content: [{ type: 'output_text', text: id }] } })
async function fixture(provider: 'claude' | 'codex') {
  const f = await nativeHistoryFixture(provider, root => jsonl(provider === 'claude' ? [claudeRow('first-reply'), claudeRow('second-reply')]
    : [{ type: 'session_meta', payload: { id: 'native-main', cwd: root } }, codexRow('first-reply'), codexRow('second-reply')]))
  close.push(f.close); return f
}
function native(page: ConversationCheckpointPage) {
  const cut = page.checkpoint.frontier.cuts.find(value => value.kind === 'native')
  expect(cut, JSON.stringify(page.coverage)).toBeDefined()
  if (!cut || cut.kind !== 'native') throw Error('Original native cut is required')
  return cut.checkpoint
}
async function originals(read: (input: ConversationChangesInput) => Promise<ConversationChangesPage>, cut: ConversationCheckpointPage) {
  let pending: ConversationWindowAssembly | undefined, cursor: string | undefined
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    const page = await read({ ...ref, checkpoint: cut.checkpoint, ...(cursor ? { cursor } : {}), limit: 100 })
    const consumed = consumeConversationWindowPage(page, pending)
    if (consumed.kind === 'complete') return consumed.snapshot.units.flatMap(unit => unit.records)
      .filter(record => record.original.kind === 'native').map(record => record.original.item.id)
    pending = consumed.pending; cursor = page.nextCursor!
  }
  throw Error('The original bounded window must complete')
}
function witness(facts: unknown) {
  if (process.env.T030_CORE_FACTS) appendFileSync(process.env.T030_CORE_FACTS, JSON.stringify(facts) + '\n')
}

it.each(['claude', 'codex'] as const)('%s beginning checkpoint consumes no first record and leaves captured at its current cut', async provider => {
  const f = await fixture(provider)
  const page = await f.client.providers.get(provider).readConversationChanges!({ agentSessionId: ref.agentSessionId,
    source: { providerId: provider, nativeSessionId: 'native-main' }, workspacePath: f.root, transcriptPath: f.path,
    command: provider, args: [], env: {}, limit: 1, signal: new AbortController().signal, head: true })
  expect(page.items).toEqual([])
  const initialIds = (await f.client.readSessionHistoryChanges(ref.agentSessionId, { checkpoint: { agentSessionId: ref.agentSessionId, source: page.source, cursor: page.cursor }, limit: 100 })).items.map(item => item.id)
  witness({ provider, providerCutItems: page.items.map(item => item.id), initialIds })
  expect(initialIds).toEqual(['first-reply', 'second-reply'])
  const tail = await f.client.conversationCheckpoint(ref)
  const beginning = await f.client.conversationCheckpoint({ ...ref, nativePosition: 'beginning' })
  const headIds = await originals(input => f.client.readConversationChanges(input), beginning)
  const tailIds = await originals(input => f.client.readConversationChanges(input), tail)
  witness({ provider, headIds, tailIds, source: native(beginning).source })
  expect(headIds.sort()).toEqual(['first-reply', 'second-reply'])
  expect(tailIds).toEqual([])
  expect(beginning.checkpoint.frontier.cuts.filter(value => value.kind === 'captured')).toEqual(tail.checkpoint.frontier.cuts.filter(value => value.kind === 'captured'))
  const direct = await f.client.sessionHistoryCheckpoint(ref.agentSessionId, { position: 'beginning' })
  expect(direct).toEqual(native(beginning))
  await appendFile(f.path, jsonl([provider === 'claude' ? claudeRow('later-reply') : codexRow('later-reply')]))
  const after = await f.client.readSessionHistoryChanges(ref.agentSessionId, { checkpoint: native(beginning), limit: 100 })
  expect(after.items.map(item => item.id)).toEqual(['first-reply', 'second-reply', 'later-reply'])
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('Pi beginning retains its original header and linear-branch validation', async () => {
  const f = await nativeHistoryFixture('pi', root => jsonl([
    { type: 'session', version: 3, id: 'native-main', cwd: root },
    { type: 'message', id: 'first-reply', parentId: null, message: { role: 'assistant', content: 'First' } }
  ])); close.push(f.close)
  const first = await f.client.sessionHistoryCheckpoint(ref.agentSessionId, { position: 'beginning' })
  expect((await f.client.readSessionHistoryChanges(ref.agentSessionId, { checkpoint: first, limit: 100 })).items.map(item => item.id)).toEqual(['first-reply'])
  await appendFile(f.path, jsonl([{ type: 'message', id: 'foreign-branch', parentId: null, message: { role: 'assistant', content: 'Another branch' } }]))
  await expect(f.client.readSessionHistoryChanges(ref.agentSessionId, { checkpoint: first, limit: 100 })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  const invalid = await nativeHistoryFixture('pi', root => jsonl([{ type: 'session', version: 3, id: 'another-native', cwd: root }])); close.push(invalid.close)
  await expect(invalid.client.sessionHistoryCheckpoint(ref.agentSessionId, { position: 'beginning' })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
})

it('strict input, cancellation and missing native source preserve independent captured reading and healthy Run controls', async () => {
  expect(parseConversationCheckpointInput({ ...ref, nativePosition: 'beginning' })).toEqual({ ...ref, nativePosition: 'beginning' })
  for (const invalid of [{ ...ref, nativePosition: 'tail' }, { ...ref, nativePosition: null }, { ...ref, position: 'beginning' }, { ...ref, cursor: '0' }])
    expect(() => parseConversationCheckpointInput(invalid)).toThrow()
  const f = await fixture('claude'), cancelled = new AbortController(); cancelled.abort(new Error('Original read cancelled'))
  await expect(f.client.conversationCheckpoint({ ...ref, nativePosition: 'beginning' }, { signal: cancelled.signal })).rejects.toThrow('Original read cancelled')
  await rename(f.path, join(f.root, 'retained-native.jsonl'))
  const page = await f.client.conversationCheckpoint({ ...ref, nativePosition: 'beginning' })
  expect(page.checkpoint.frontier.cuts.filter(value => value.kind === 'native')).toEqual([])
  expect(page.coverage.find(value => value.source.kind === 'native')!.current).toBe('unavailable')
  expect(page.checkpoint.frontier.cuts.some(value => value.kind === 'captured')).toBe(true)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('real RPC, Hosted SDK and compiled CLI preserve beginning through the original public owner', async () => {
  const f = await fixture('claude')
  vi.spyOn(f.client, 'connect').mockRejectedValue(new AgentMuxError('Synthetic Runtime is offline; original file reading remains available.', 'CTXMUX_DISCONNECTED'))
  const hostedOwner = new AgentMuxHostedRuntimeService(f.client, f.storePath, () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', protocolVersion: 2, processId: process.pid, availability: 'connected', ctxmux: null }))
  close.push(() => hostedOwner.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], hostedRuntime: () => hostedOwner })
  await server.start(); close.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); close.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc }); close.push(() => hosted.dispose())
  const routedRef = { ...ref, hostId: 'configured-original-host' }
  const routed = new AgentMuxRpcService({ coreClients: () => [{ hostId: routedRef.hostId, client: hosted }] }); close.push(() => routed.dispose())
  const routedHead = await routed.call('agent.conversation.checkpoint', { ...routedRef, nativePosition: 'beginning' })
  expect(routedHead.hostId).toBe(routedRef.hostId); expect(routedHead.sourceHostId).toBe('local')
  expect((await originals(input => hosted.readConversationChanges(input), { ...routedHead, hostId: 'local', checkpoint: { ...routedHead.checkpoint, hostId: 'local' } })).sort()).toEqual(['first-reply', 'second-reply'])
  const publicHead = await rpc.call('agent.conversation.checkpoint', { ...ref, nativePosition: 'beginning' })
  expect(native(publicHead)).toEqual(native(routedHead))
  await expect(rpc.call('agent.conversation.checkpoint', { ...ref, nativePosition: 'tail' } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  const env = objectCliEnvironment(f.root)
  const cli = await runCompiledObjectCli(['agent', 'conversation', 'checkpoint', '--host', 'local', '--session', ref.agentSessionId, '--native-position', 'beginning'], env)
  expect(cli.code, cli.stderr || cli.stdout).toBe(0)
  const cliHead = JSON.parse(cli.stdout).result as ConversationCheckpointPage
  expect(native(cliHead)).toEqual(native(publicHead))
  const ids = await originals(input => rpc.call('agent.conversation.changes', input), cliHead)
  witness({ publicConsumer: true, cliExitCode: cli.code, ids, nativeCut: native(cliHead) })
  expect(ids.sort()).toEqual(['first-reply', 'second-reply'])
  const defaultCli = await runCompiledObjectCli(['agent', 'conversation', 'checkpoint', '--host', 'local', '--session', ref.agentSessionId], env)
  expect(defaultCli.code, defaultCli.stderr).toBe(0)
  expect(await originals(input => rpc.call('agent.conversation.changes', input), JSON.parse(defaultCli.stdout).result)).toEqual([])
  for (const name of ['start', 'input', 'resize', 'stop', 'attach']) expect(f.controls[['start', 'input', 'resize', 'stop', 'attach', 'status'].indexOf(name)]).not.toHaveBeenCalled()
})
