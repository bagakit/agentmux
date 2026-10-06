import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { historyReaderFixture, core } from './fixtures/session-history-reader.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const release of close.splice(0).reverse()) await release() })
const row = (id: string, text = 'Same original reply') => JSON.stringify({ sessionId: 'original-native', uuid: id,
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'

it('cuts existing history and resumes original append order after the Client is replaced', async () => {
  const f = await historyReaderFixture(true, true); close.push(f.close)
  const checkpoint = await f.client.conversationCheckpoint(f.reference.agentSessionId)
  await f.unchanged()
  expect(Buffer.from(checkpoint.cursor, 'base64url').toString()).not.toContain(f.root)
  await appendFile(f.transcript, row('first') + row('second'))
  await f.client.dispose()
  const replacement = new core.AgentMuxClient({ store: new core.AgentMuxFileAgentSessionStore(f.storePath) }); close.push(() => replacement.dispose())
  const first = await replacement.readConversationChanges(f.reference.agentSessionId, { checkpoint, limit: 1 })
  expect(first.items.map(item => item.id)).toEqual(['first'])
  expect(first.more).toBe(true)
  const next = await replacement.readConversationChanges(f.reference.agentSessionId, { checkpoint: first.checkpoint })
  expect(next.items.map(item => item.id)).toEqual(['second'])
  expect(next.items[0]!.contentParts).toEqual(first.items[0]!.contentParts)
  expect(next.more).toBe(false)
  expect((await replacement.readConversationChanges(f.reference.agentSessionId, { checkpoint: next.checkpoint })).items).toEqual([])
})

it('does not consume a partial append or turn repeated notifications into missing records', async () => {
  const f = await historyReaderFixture(true, true); close.push(f.close)
  const checkpoint = await f.client.conversationCheckpoint(f.reference.agentSessionId)
  const value = row('partial')
  await appendFile(f.transcript, value.slice(0, -1))
  const incomplete = await f.client.readConversationChanges(f.reference.agentSessionId, { checkpoint })
  expect(incomplete.items).toEqual([])
  expect(incomplete.more).toBe(false)
  expect(incomplete.checkpoint).toEqual(checkpoint)
  await appendFile(f.transcript, '\n')
  const completed = await f.client.readConversationChanges(f.reference.agentSessionId, { checkpoint: incomplete.checkpoint })
  expect(completed.items.map(item => item.id)).toEqual(['partial'])
  const repeated = await f.client.readConversationChanges(f.reference.agentSessionId, { checkpoint })
  expect(repeated).toEqual(completed)
})

it('rejects replaced, truncated and changed sources while retaining the original checkpoint', async () => {
  const f = await historyReaderFixture(true, true); close.push(f.close)
  const checkpoint = await f.client.conversationCheckpoint(f.reference.agentSessionId)
  const original = await readFile(f.transcript)
  await rename(f.transcript, join(f.root, 'retained.jsonl'))
  await writeFile(f.transcript, original)
  await expect(f.client.readConversationChanges(f.reference.agentSessionId, { checkpoint })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  const current = await f.client.conversationCheckpoint(f.reference.agentSessionId)
  await writeFile(f.transcript, '')
  await expect(f.client.readConversationChanges(f.reference.agentSessionId, { checkpoint: current })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await expect(f.client.readConversationChanges('another-session', { checkpoint })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  await expect(f.client.readConversationChanges(f.reference.agentSessionId, { checkpoint: { ...checkpoint, source: { ...checkpoint.source, nativeSessionId: 'another-native' } } })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
})

it('advances bounded bookkeeping pages without scanning unrelated history or manufacturing a message', async () => {
  const f = await historyReaderFixture(true, true); close.push(f.close)
  const checkpoint = await f.client.conversationCheckpoint(f.reference.agentSessionId)
  await appendFile(f.transcript, JSON.stringify({ type: 'progress' }) + '\n' + row('public'))
  const page = await f.client.readConversationChanges(f.reference.agentSessionId, { checkpoint, limit: 1 })
  expect(page.items).toEqual([])
  expect(page.more).toBe(true)
  expect(page.checkpoint).not.toEqual(checkpoint)
  expect((await f.client.readConversationChanges(f.reference.agentSessionId, { checkpoint: page.checkpoint, limit: 1 })).items.map(item => item.id)).toEqual(['public'])
})

it('compiled CLI checkpoints and changes consume the exact original Host reader', async () => {
  const f = await historyReaderFixture(true, true); close.push(f.close)
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); close.push(() => server.stop())
  const env = objectCliEnvironment(f.root)
  const cut = await runCompiledObjectCli(['agent', 'conversation', 'checkpoint', '--host', 'local', '--session', f.reference.agentSessionId], env)
  expect(cut.code, cut.stderr).toBe(0)
  const input = JSON.parse(cut.stdout).result
  await appendFile(f.transcript, row('cli-reply'))
  const changes = await runCompiledObjectCli(['agent', 'conversation', 'changes', '--input', '-'], env, JSON.stringify(input))
  expect(changes.code, changes.stderr).toBe(0)
  expect(JSON.parse(changes.stdout).result).toMatchObject({ ...f.reference, items: [{ id: 'cli-reply' }], more: false })
  const wrong = await runCompiledObjectCli(['agent', 'conversation', 'changes', '--input', '-'], env, JSON.stringify({ ...input, hostId: 'another-host' }))
  expect(wrong.code).not.toBe(0)
})

it('public watch wakes the same original reader and cancellation only releases the observation', async () => {
  const f = await historyReaderFixture(true, true); close.push(f.close)
  const socketPath = join(f.root, 'control.sock'), server = new core.AgentMuxControlServer({ socketPath, coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); close.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); close.push(() => rpc.dispose())
  const observed = vi.fn(), opening = vi.fn()
  const sub = await rpc.subscribe('agent.conversation.watch', f.reference, { onInitial: opening, onEvent: observed })
  close.push(() => sub.dispose())
  const checkpoint = await f.client.conversationCheckpoint(f.reference.agentSessionId)
  expect(opening).toHaveBeenCalledWith({ ...f.reference, source: checkpoint.source })
  await appendFile(f.transcript, row('observed'))
  await vi.waitFor(() => expect(observed).toHaveBeenCalledWith({ type: 'snapshot', data: { ...f.reference,
    observation: { agentSessionId: f.reference.agentSessionId, source: checkpoint.source, kind: 'invalidated' } } }))
  expect((await f.client.readConversationChanges(f.reference.agentSessionId, { checkpoint })).items.map(item => item.id)).toEqual(['observed'])
  await sub.dispose()
  const count = observed.mock.calls.length
  await appendFile(f.transcript, row('after-release'))
  expect((await f.client.readConversationChanges(f.reference.agentSessionId, { checkpoint })).items.map(item => item.id)).toEqual(['observed', 'after-release'])
  expect(observed.mock.calls.length).toBe(count)
})

it('validates exact public sources, malformed cursors and page scope before exposing records', async () => {
  const f = await historyReaderFixture(true, true); close.push(f.close)
  const checkpoint = await f.client.conversationCheckpoint(f.reference.agentSessionId)
  await expect(f.client.readConversationChanges(f.reference.agentSessionId, { checkpoint: { ...checkpoint, cursor: Buffer.from('null').toString('base64url') } })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  const page = await f.client.readConversationChanges(f.reference.agentSessionId, { checkpoint })
  expect(() => core.parseConversationChangesPage({ ...page, agentSessionId: 'wrong' }, { ...f.reference, checkpoint })).toThrow()
  expect(() => core.parseConversationChangesInput({ ...f.reference, checkpoint, limit: 101 })).toThrow()
  await f.unchanged()
})

it('Codex saved changes use its original source metadata and converter without duplicating event copies', async () => {
  const f = await historyReaderFixture(true); close.push(f.close)
  const original = await f.store.readMetadata(f.reference.agentSessionId)
  await f.store.compareAndSwap(original, { ...original!, providerId: 'codex', executorId: 'codex',
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native', transcriptPath: f.transcript } })
  await writeFile(f.transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'original-native', cwd: f.root } }) + '\n')
  const checkpoint = await f.client.conversationCheckpoint(f.reference.agentSessionId)
  await appendFile(f.transcript, [
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Reply' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'speech', content: [{ type: 'output_text', text: 'Reply' }] } }
  ].map(value => JSON.stringify(value)).join('\n') + '\n')
  const page = await f.client.readConversationChanges(f.reference.agentSessionId, { checkpoint })
  expect(page.source.providerId).toBe('codex')
  expect(page.items.map(item => item.kind)).toEqual(['activity', 'assistant-message'])
  expect(page.items[1]).toMatchObject({ id: 'speech', contentParts: [{ kind: 'text', text: 'Reply' }] })
  expect(core.projectConversationRecords({ agentSessionId: f.reference.agentSessionId, historyPage: { ...page, nextCursor: null } }).filter(record => record.author?.kind === 'agent')).toHaveLength(1)
})

it('compiled CLI watch follows the original source and Ctrl-C releases only its reader', async () => {
  const f = await historyReaderFixture(true, true); close.push(f.close)
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); close.push(() => server.stop())
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/amux', import.meta.url)), 'agent', 'conversation', 'watch', '--host', 'local', '--session', f.reference.agentSessionId],
    { env: objectCliEnvironment(f.root), stdio: ['pipe', 'pipe', 'pipe'] })
  close.push(async () => { child.kill('SIGKILL') })
  let output = '', error = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { error += value }); child.stdin.end()
  await vi.waitFor(() => expect(output.split('\n').filter(Boolean).length, error).toBeGreaterThanOrEqual(1))
  expect(JSON.parse(output.split('\n')[0]!).result.initial).toMatchObject(f.reference)
  await appendFile(f.transcript, row('cli-follow'))
  await vi.waitFor(() => expect(output).toContain('invalidated'))
  const ended = new Promise<number | null>(resolve => child.once('close', resolve))
  child.kill('SIGINT')
  expect(await ended).toBe(0)
  const checkpoint = await f.client.conversationCheckpoint(f.reference.agentSessionId)
  expect(checkpoint.source.nativeSessionId).toBe('original-native')
})
