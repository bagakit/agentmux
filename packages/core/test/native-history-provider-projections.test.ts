import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { readSessionHistoryTextResource } from '../src/session-history-content.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryItem, AgentSessionHistoryPageOptions } from '../src/types.js'

const fixtures: Awaited<ReturnType<typeof nativeHistoryFixture>>[] = []
const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  for (const fixture of fixtures.splice(0)) await fixture.close()
})
const id = '00000000-0000-4000-8000-000000000001'
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
function expectExactParts(actual: AgentSessionHistoryContentPart[], expected: AgentSessionHistoryContentPart[]): void {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, ordered(entry)])) : value
  const left = JSON.stringify(ordered(actual)), right = JSON.stringify(ordered(expected))
  expect(left === right).toBe(true)
  expect(digest(left)).toBe(digest(right))
}
const payload = (large: boolean) => 'Original 中文🙂 "quoted" \\ slash\n'.repeat(large ? 80_000 : 3)
async function complete(f: Awaited<ReturnType<typeof nativeHistoryFixture>>, item: AgentSessionHistoryItem,
  source: { providerId: string; nativeSessionId: string }, env?: Record<string, string>): Promise<AgentSessionHistoryContentPart[]> {
  const parts: AgentSessionHistoryContentPart[] = []
  for (const [partIndex, part] of item.contentParts.entries()) {
    if (part.kind !== 'resource' || part.resourceType !== 'text') { parts.push(part); continue }
    const value = await readSessionHistoryTextResource(part, partIndex, { source, recordId: item.id,
      ...(item.turnId === undefined ? {} : { turnId: item.turnId }), ...(env ? { env } : {}) },
      input => f.client.sessionHistoryResource(f.session.agentSessionId, input))
    parts.push(value)
  }
  return parts
}
function untouched(f: Awaited<ReturnType<typeof nativeHistoryFixture>>) {
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  return f.bytes().then(bytes => {
    expect(bytes.native.equals(f.before.native)).toBe(true)
    expect(bytes.store.equals(f.before.store)).toBe(true)
  })
}

it.each([false, true])('Antigravity trims only the user request across a physical boundary (large: %s)', async large => {
  const text = payload(large), preamble = 'System wrapper ' + 'P'.repeat(65_501)
  const f = await nativeHistoryFixture('antigravity', jsonl([
    { id: 'user', step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT',
      content: preamble + '<USER_REQUEST>\u2003\n ' + text + ' \n\u2003</USER_REQUEST>System suffix' },
    { id: 'assistant', step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: text }
  ]), { nativeSessionId: id, relativePath: `${id}/.system_generated/logs/transcript.jsonl` })
  fixtures.push(f)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 2 })
  expect(page.items.map(item => item.kind)).toEqual(['user-message', 'assistant-message'])
  expectExactParts(await complete(f, page.items[0]!, page.source), [{ kind: 'text', text: text.trim() }])
  expectExactParts(await complete(f, page.items[1]!, page.source), [{ kind: 'text', text }])
  await untouched(f)
}, 30_000)

it.each([false, true])('Droid retains document text and exact decoded attachment bytes (large: %s)', async large => {
  const text = payload(large)
  const document = { type: 'document', source: { type: 'text', mediaType: 'text/plain', name: 'original.txt', data: text } }
  const f = await nativeHistoryFixture('droid', jsonl([
    { type: 'session_start', id },
    { type: 'message', id: 'user', message: { role: 'user', content: [document] } },
    { type: 'message', id: 'tool', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tool-one', is_error: true, content: [document] }
    ] } }
  ]), { nativeSessionId: id, relativePath: `${id}.jsonl` })
  fixtures.push(f)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 2 })
  expect(page.items.map(item => item.kind)).toEqual(['user-message', 'activity'])
  const expectedFile = { kind: 'resource', resourceType: 'file', label: 'original.txt',
    reference: `data:text/plain;base64,${Buffer.from(text).toString('base64')}` }
  const user = await complete(f, page.items[0]!, page.source), tool = await complete(f, page.items[1]!, page.source)
  expectExactParts(user, [{ kind: 'text', text }, expectedFile as AgentSessionHistoryContentPart])
  expectExactParts(tool, [{ kind: 'tool-result', output: text, callId: 'tool-one', failed: true }, expectedFile as AgentSessionHistoryContentPart])
  const attachment = user[1]!
  if (attachment.kind !== 'resource') throw new Error('Expected document attachment')
  const bytes = Buffer.from(attachment.reference.split(',')[1]!, 'base64')
  expect(bytes.length).toBe(Buffer.byteLength(text))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest(text))
  await untouched(f)
}, 30_000)

it.each(['claude', 'pi', 'grok', 'kimi'] as const)('%s preserves large speech, nested tool JSON and unknown payloads', async provider => {
  const text = payload(true)
  const f = await nativeHistoryFixture(provider, root => provider === 'claude' ? jsonl([
    { sessionId: id, uuid: 'speech', type: 'assistant', message: { content: [{ type: 'text', text }] } },
    { sessionId: id, uuid: 'tool', type: 'assistant', message: { content: [{ type: 'tool_use', name: 'inspect', id: 'call', input: { payload: text } }] } },
    { sessionId: id, uuid: 'unknown', type: 'new_activity', data: text }
  ]) : provider === 'pi' ? jsonl([
    { type: 'session', version: 3, id, cwd: root },
    { type: 'message', id: 'speech', parentId: null, message: { role: 'assistant', content: [{ type: 'text', text }] } },
    { type: 'message', id: 'tool', parentId: 'speech', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'inspect', id: 'call', arguments: { payload: text } }] } },
    { type: 'custom_message', id: 'unknown', parentId: 'tool', content: { data: text } }
  ]) : provider === 'grok' ? jsonl([
    { type: 'assistant', content: text },
    { type: 'assistant', tool_calls: [{ name: 'inspect', id: 'call', arguments: { payload: text } }] },
    { type: 'new_activity', data: text }
  ]) : jsonl([
    { type: 'context.append_message', uuid: 'speech', message: { role: 'assistant', content: [{ type: 'text', text }] } },
    { type: 'context.append_loop_event', event: { type: 'step.begin', uuid: 'tool' } },
    { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'inspect', toolCallId: 'call', args: { payload: text } } },
    { type: 'context.append_loop_event', event: { type: 'step.end', uuid: 'tool' } }
  ]), { nativeSessionId: id, relativePath: provider === 'grok' ? 'chat_history.jsonl'
    : provider === 'kimi' ? 'kimi/sessions/native/agents/main/wire.jsonl' : 'native.jsonl' })
  fixtures.push(f)
  let env: Record<string, string> | undefined
  if (provider === 'grok') await writeFile(join(f.root, 'summary.json'), JSON.stringify({ info: { id, cwd: f.root } }))
  if (provider === 'kimi') {
    const home = join(f.root, 'kimi'); env = { KIMI_CODE_HOME: home }
    await writeFile(join(home, 'session_index.jsonl'), jsonl([{ sessionId: id, sessionDir: join(home, 'sessions/native'), workDir: f.root }]))
  }
  const options: AgentSessionHistoryPageOptions = { limit: 3, ...(env ? { env } : {}) }
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId, options)
  expect(page.items[0]!.kind).toBe('assistant-message')
  expectExactParts(await complete(f, page.items[0]!, page.source, env), [{ kind: 'text', text }])
  const parts = await complete(f, page.items[1]!, page.source, env)
  expect(parts).toHaveLength(1)
  const call = parts[0]!
  if (call.kind !== 'tool-call') throw new Error('Expected original tool call')
  expect({ name: call.name, callId: call.callId }).toEqual({ name: 'inspect', callId: 'call' })
  expect(call.input === JSON.stringify({ payload: text })).toBe(true)
  expect(JSON.parse(call.input)).toEqual({ payload: text })
  if (provider !== 'kimi') {
    expect(page.items[2]!.kind).toBe('activity')
    const unknown = (await complete(f, page.items[2]!, page.source))[0]!
    if (unknown.kind !== 'text') throw new Error('Expected neutral unknown activity')
    expect(JSON.parse(unknown.text).data).toBe(text)
  }
  await untouched(f)
}, 30_000)

it('RPC and compiled CLI serve the same projected Droid document bytes', async () => {
  const text = payload(true)
  const f = await nativeHistoryFixture('droid', jsonl([{ type: 'session_start', id },
    { type: 'message', id: 'document', message: { role: 'user', content: [
      { type: 'document', source: { type: 'text', name: 'document.txt', data: text } }
    ] } }]), { nativeSessionId: id })
  fixtures.push(f)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })
  const part = page.items[0]!.contentParts[1]!
  if (part.kind !== 'resource' || part.resourceType !== 'text' || !part.content) throw new Error('Expected projected complete attachment')
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); closes.push(() => server.stop())
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] }); closes.push(() => service.dispose())
  const request = { hostId: 'local', agentSessionId: f.session.agentSessionId, source: page.source,
    recordId: page.items[0]!.id, partIndex: 1, expectedReference: part.reference, maxBytes: 128 * 1024 }
  const first = await service.call('agent.history.resource', request)
  if (first.result.status !== 'fragment') throw new Error('Expected projected fragment')
  const input = join(f.root, 'resource-input.json')
  await writeFile(input, JSON.stringify({ ...request, offsetBytes: first.result.nextOffsetBytes }))
  const result = await runCompiledObjectCli(['agent', 'history', 'resource', '--input', input], objectCliEnvironment(f.root))
  expect(result.code, result.stderr).toBe(0)
  const receipt = JSON.parse(result.stdout).result
  expect(receipt.reference).toBe(part.reference)
  expect(receipt.result.sha256).toBe(part.content.sha256)
  expect(receipt.result.offsetBytes).toBe(first.result.nextOffsetBytes)
  const { hostId: _host, agentSessionId: _session, ...resourceRequest } = request
  const direct = await f.client.sessionHistoryResource(f.session.agentSessionId,
    { ...resourceRequest, offsetBytes: first.result.nextOffsetBytes! })
  expect(receipt.result).toEqual(direct.result)
  await untouched(f)
}, 30_000)

it.each(['pi', 'droid'] as const)('%s canonicalizes alternate JSON escapes at UTF-8 and surrogate boundaries', async provider => {
  const text = 'a'.repeat(65_530) + '🙂' + ('中🙂 / " \\ \n').repeat(180_000)
  const data = provider === 'pi' ? jsonl([
    { type: 'session', version: 3, id, cwd: '__WORKSPACE__' },
    { type: 'message', id: 'encoded', parentId: null, message: { role: 'assistant', content: [
      { type: 'toolCall', id: 'call', name: 'inspect', arguments: { payload: text } }
    ] } }
  ]) : jsonl([{ type: 'session_start', id }, { type: 'message', id: 'encoded', message: { role: 'user', content: [
    { type: 'document', source: { type: 'text', data: text } }
  ] } }])
  const f = await nativeHistoryFixture(provider, root => data.replace('__WORKSPACE__', root)
    .replaceAll('中', '\\u4e2d').replaceAll('🙂', '\\ud83d\\ude42').replaceAll('/', '\\/'), { nativeSessionId: id })
  fixtures.push(f)
  const page = await f.client.sessionHistoryPage(f.session.agentSessionId, { limit: 1 })
  const parts = await complete(f, page.items[0]!, page.source)
  if (provider === 'pi') {
    expectExactParts(parts, [{ kind: 'tool-call', name: 'inspect', callId: 'call', input: JSON.stringify({ payload: text }) }])
  } else {
    expectExactParts(parts, [{ kind: 'text', text }, { kind: 'resource', resourceType: 'file',
      reference: 'data:text/plain;base64,' + Buffer.from(text).toString('base64') }])
  }
  await untouched(f)
}, 30_000)
