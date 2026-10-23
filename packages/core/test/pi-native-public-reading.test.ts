import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { consumeConversationWindowPage, parseConversationChangesPage, parseConversationReadPage } from '../src/conversation-changes.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseAgentSessionHistoryReadPage } from '../src/session-history-read-codec.js'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

function originals(page: Parameters<typeof consumeConversationWindowPage>[0]) {
  const result = consumeConversationWindowPage(page)
  expect(result.kind).toBe('complete')
  if (result.kind !== 'complete') throw new Error('The original small Pi window must fit one complete frame.')
  const records = result.snapshot.units.flatMap(unit => unit.records)
  expect(records.length).toBeGreaterThan(0)
  expect(records.every(record => record.original.kind === 'native' && record.reference.source.kind === 'native' &&
    record.reference.source.providerId === 'pi' && record.reference.source.nativeSessionId === 'native-main')).toBe(true)
  return records.map(record => {
    if (record.original.kind !== 'native') throw new Error('This exact original Pi scope has no captured records.')
    return { id: record.original.item.id, contentParts: record.original.item.contentParts }
  })
}

it('Pi original SDK RPC and compiled CLI consume independent windows with the same native records and cuts', async () => {
  const message = (id: string, parentId: string | null) => ({ type: 'message', id, parentId,
    message: { role: 'assistant', content: [{ type: 'text', text: 'Same original Pi reply.' }] } })
  const f = await nativeHistoryFixture('pi', cwd => jsonl([
    { type: 'session', version: 3, id: 'native-main', cwd }, message('original', null)
  ]))
  const metadata = await f.store.loadMetadata()
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'),
    coreClients: () => [{ hostId: 'local', client: f.client }] })
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  const ref = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const appended = jsonl([message('same-body-new', 'original'), message('untimed-new', 'same-body-new')])
  const cli = async (args: string[], stdin = ''): Promise<unknown> => {
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, ...args], objectCliEnvironment(f.root), stdin)
    expect(output.code, output.stdout + output.stderr).toBe(0)
    const envelope = JSON.parse(output.stdout)
    expect(envelope.ok).toBe(true)
    return envelope.result
  }
  try {
    await server.start()
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    const sdkInitial = await f.client.readAgentConversation(ref)
    const rpcInitial = await rpc.call('agent.conversation.inspect', ref)
    const cliInitial = parseConversationReadPage(await cli([
      'agent', 'conversation', 'inspect', '--host', ref.hostId, '--session', ref.agentSessionId
    ]), ref)
    expect(originals(rpcInitial)).toEqual(originals(sdkInitial))
    expect(originals(cliInitial)).toEqual(originals(sdkInitial))
    expect(cliInitial.scope).toEqual(rpcInitial.scope)
    expect(rpcInitial.scope).toEqual(sdkInitial.scope)
    expect(cliInitial.window.checkpoint.frontier).toEqual(sdkInitial.window.checkpoint.frontier)
    expect(rpcInitial.window.checkpoint.frontier).toEqual(sdkInitial.window.checkpoint.frontier)
    expect(new Set([sdkInitial.window.view, rpcInitial.window.view, cliInitial.window.view]).size).toBe(3)
    await appendFile(f.path, appended)
    const sdk = await f.client.readConversationChanges({ ...ref, view: sdkInitial.window.view!, checkpoint: sdkInitial.window.checkpoint })
    const rpcInput = { ...ref, view: rpcInitial.window.view!, checkpoint: rpcInitial.window.checkpoint }
    const rpcChanged = await rpc.call('agent.conversation.changes', rpcInput)
    const cliInput = { ...ref, view: cliInitial.window.view!, checkpoint: cliInitial.window.checkpoint }
    const cliChanged = parseConversationChangesPage(await cli([
      'agent', 'conversation', 'changes', '--input', '-'
    ], JSON.stringify(cliInput)), cliInput)
    expect(originals(sdk).map(record => record.id)).toEqual(['untimed-new', 'same-body-new', 'original'])
    expect(originals(rpcChanged)).toEqual(originals(sdk))
    expect(originals(cliChanged)).toEqual(originals(sdk))
    expect(rpcChanged.window.checkpoint.frontier).toEqual(sdk.window.checkpoint.frontier)
    expect(cliChanged.window.checkpoint.frontier).toEqual(sdk.window.checkpoint.frontier)
    const historyInput = { ...ref, source: 'native' as const, limit: 10 }
    const history = await rpc.call('agent.history', historyInput)
    const cliHistory = parseAgentSessionHistoryReadPage(await cli([
      'agent', 'history', '--host', ref.hostId, '--session', ref.agentSessionId, '--source', 'native', '--limit', '10'
    ]), historyInput)
    expect(cliHistory).toEqual(history)
    expect(history.items).toHaveLength(3)
    expect(history.items.every(entry => entry.kind === 'item')).toBe(true)
    expect(history.items.flatMap(entry => entry.kind === 'item' ? [entry.item.id] : []))
      .toEqual(['original', 'same-body-new', 'untimed-new'])
    expect(await f.store.loadMetadata()).toEqual(metadata)
    expect(await readFile(f.path)).toEqual(Buffer.concat([f.before.native, Buffer.from(appended)]))
    expect(f.controls).toHaveLength(6)
    f.controls.forEach(control => expect(control).not.toHaveBeenCalled())
  } finally { await rpc?.dispose(); await server.stop(); await f.close() }
})
