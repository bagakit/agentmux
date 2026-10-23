import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../core/src/index.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'
import { context } from './fixtures/room-binding.js'
import { permissionActionsFixture } from './fixtures/permission-actions.js'
import type { ConnectionHost } from '../src/connection-host.js'

import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import { fragmentFeishuReply } from '../src/adapters/feishu/reply-card.js'
import type { PublicationOperation } from '../src/publication-store.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { unified } from 'unified'
import remarkParse from 'remark-parse'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function host() {
  const remote = await feishuPublicationHttp(); cleanup.push(remote.close)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(input => remote.http.request(input))
  const f = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'codex', executorId: 'codex', nativeHandle: {
    kind: 'provider', providerId: 'codex', sessionId: 'original-native', transcriptPath: join(root, 'native.jsonl')
  } })); cleanup.push(f.close)
  const transcript = join(f.root, 'native.jsonl')
  await writeFile(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'original-native', cwd: f.root, history_mode: 'paginated' } }) + '\n')
  const native = (id: string, phase: string, text: string) => JSON.stringify({ timestamp: new Date(60_000).toISOString(), type: 'response_item', payload: {
    type: 'message', id, role: 'assistant', phase, content: [{ type: 'output_text', text }]
  } }) + '\n'
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Team', hostId: 'local', directoryPath: f.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['region'] }],
    regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: f.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' } }, resources: {}
  } })
  const conversation = createPublicationConversationPort(f.coreClients)
  const options: Parameters<typeof createConnectionServices>[0] = { directory: join(f.root, 'connectors'), encryption: {
    isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async text => Buffer.from(text),
    decryptStringAsync: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false })
  }, bindings: { spatial, checkpoint: input => f.client.conversationCheckpoint(input) }, publication: conversation }
  const services = await createConnectionServices(options); cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'fixture-credential', secret: 'fixture-credential' })
  await services.connections.configure({ operationId: 'fixture-configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind({ operationId: 'fixture-bind', bindingId: 'fixture-binding', connectionId: feishuConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'region' }, externalConversationId: 'original-room',
    expectedSource: { providerId: 'codex', nativeSessionId: 'original-native' }, scope: { input: 'all-messages', publication: 'future-native-user-facing' } }, context)
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw Error('Fixture Binding was not applied')
  await vi.waitFor(() => expect(services.publication!.store.list(bound.binding).some(op => op.payload.kind === 'binding-lifecycle' && op.state === 'confirmed')).toBe(true))
  const operations = () => services.publication!.store.list(bound.binding, 100).filter(op => op.payload.kind === 'speech')
  return { ...f, remote, services, transcript, native, operations, conversation, binding: bound.binding }
}
function original(text: string): PublicationOperation {
  return { operationId: 'reply-original', projectionId: 'reply-projection', sourceRevision: 'source-original', bindingId: 'binding-original', bindingRevision: 1,
    reference: { hostId: 'local', agentSessionId: 'agent-original', source: { kind: 'native', providerId: 'codex', nativeSessionId: 'native-original', recordId: 'record-original' } },
    target: { connectionId: feishuConfig.connectionId, application: feishuConfig.application, externalConversationId: 'original-room' }, effect: 'upsert',
    fragment: { ordinal: 0, count: 1 }, state: 'pending', presentationTime: 0, payload: { kind: 'speech', phase: 'final', text } }
}
const nativeCard = (body: string) => JSON.parse(JSON.parse(body).content)
const markdownText = (card: any) => card.body.elements.filter((element: any) => element.tag === 'markdown').map((element: any) => element.content).join('')

it('default Desktop/Core publication renders a complete ordinary long reply in one native Markdown card', async () => {
  const f = await host(), text = '**Verified reply**\n\n'+ 'A complete ordinary paragraph with Unicode 中文😀.\n\n'.repeat(95)
  await appendFile(f.transcript, f.native('long-final', 'final_answer', text)); f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.operations().every(row => row.state === 'confirmed') && f.operations().length > 0).toBe(true))
  expect(f.operations()).toHaveLength(1)
  const operation = f.operations()[0]!, card = nativeCard(operation.prepared!.request.body!)
  expect(card.header).toBeUndefined(); expect(card.schema).toBe('2.0')
  expect(markdownText(card)).toBe(text); expect(card.config.summary.content).toContain('Agent reply')
  expect(Buffer.byteLength(operation.prepared!.request.body!)).toBeLessThanOrEqual(30 * 1024)
})

it('actual SDK creates, reads and replaces native Markdown, tables and code while keeping tags literal', async () => {
  const remote = await feishuPublicationHttp(); cleanup.push(remote.close)
  const adapter = new FeishuAdapter({ http: remote.http }).publication
  const text = '**卡片呈现验收样例**\n\n此卡用于验收布局，不代表线上操作结果。\n\n| 内容 | 处理 |\n| :--- | :--- |\n| Agent 自己的进度与回复 | 排除 |\n| 群友的新发言 | 保留 |\n\n```ts\nconst context = await readContext();\n```\n\n原标签 <at user_id="all">all</at> 只是字面内容。'
  const operation = original(text), prepared = adapter.prepare(operation), card = nativeCard(prepared.request.body!)
  expect(card.header).toBeUndefined(); expect(card.body.elements.map((element: any) => element.tag)).toEqual(['markdown', 'table', 'markdown'])
  expect(card.body.elements[1].rows).toEqual([{ c0: 'Agent 自己的进度与回复', c1: '排除' }, { c0: '群友的新发言', c1: '保留' }])
  expect(markdownText(card)).toContain('```ts\nconst context = await readContext();\n```')
  expect(markdownText(card)).toContain('` <at user_id="all"> `')
  const signal = new AbortController().signal, receipt = await adapter.dispatch(prepared, operation.target, 'fixture-credential', signal)
  expect(receipt.state).toBe('confirmed'); if (receipt.state !== 'confirmed') throw Error('Native card was not delivered')
  expect(await adapter.inspect(prepared, operation.target, 'fixture-credential', signal, receipt.mapping)).toEqual(receipt)
  const updated = adapter.prepare({ ...operation, operationId: 'reply-update', mapping: receipt.mapping, payload: { kind: 'speech', phase: 'final', text: text + '\n\n原始请求的确认结果保持。' } })
  expect(await adapter.dispatch(updated, operation.target, 'fixture-credential', signal, receipt.mapping)).toEqual(receipt)
  expect(await adapter.inspect(updated, operation.target, 'fixture-credential', signal, receipt.mapping)).toEqual(receipt)
  if (process.env.FEISHU_REPLY_OUTPUT) {
    mkdirSync(process.env.FEISHU_REPLY_OUTPUT, { recursive: true })
    writeFileSync(join(process.env.FEISHU_REPLY_OUTPUT, 'card.json'), JSON.stringify(card, null, 2))
  }
})

it('default Host preserves complete table rows and fenced code at the actual native envelope boundary', async () => {
  const f = await host()
  const rows = Array.from({ length: 45 }, (_, i) => `| row-${i} | ${'原始内容😀'.repeat(80)} |`)
  const code = Array.from({ length: 160 }, (_, i) => `line_${i} = "${'完整代码'.repeat(15)}";`).join('\n')
  const text = '| 原行 | 原值 |\n| :--- | :--- |\n'+rows.join('\n')+'\n\n```ts\n'+code+'\n```'
  await appendFile(f.transcript, f.native('oversized-final', 'final_answer', text)); f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.operations().length > 1 && f.operations().every(row => row.state === 'confirmed'), JSON.stringify({ operations: f.operations().map(row => ({ state: row.state, reason: row.reason, fragment: row.fragment })), observation: f.services.publication!.observation(f.binding.bindingId, f.binding.revision) })).toBe(true), { timeout: 10000 })
  const cards = f.operations().map(row => nativeCard(row.prepared!.request.body!))
  expect(f.operations().every(row => Buffer.byteLength(row.prepared!.request.body!) <= 30 * 1024)).toBe(true)
  const tables = cards.flatMap(card => card.body.elements.filter((element: any) => element.tag === 'table'))
  expect(tables.flatMap(table => table.rows.map((row: any) => row.c0))).toEqual(rows.map((_, i) => 'row-'+i))
  expect(tables.flatMap(table => table.rows.map((row: any) => row.c1))).toEqual(rows.map(() => '原始内容😀'.repeat(80)))
  const snippets = cards.flatMap(card => card.body.elements.filter((element: any) => element.tag === 'markdown').map((element: any) => element.content)).filter((value: string) => value.includes('```ts'))
  expect(snippets.length).toBeGreaterThan(1)
  const actual = snippets.map((value: string) => value.slice(value.indexOf('```ts\n')+6, value.lastIndexOf('\n```'))).join('')
  expect(actual).toBe(code)
  expect(cards.every((card: any, i: number) => card.body.elements.at(-1).text.content === `Reply · ${i+1}/${cards.length}`)).toBe(true)
})

it('retains a single oversize Unicode code line without splitting surrogate pairs or dropping content', async () => {
  const adapter = new FeishuAdapter().publication, code = 'const value = "'+ '中文😀'.repeat(12000)+'";'
  const text = '```js\n'+code+'\n```', operation = original(text)
  const parts = adapter.fragmentText!(operation.payload as Extract<PublicationOperation['payload'],{kind:'speech'}>, operation.target)!
  expect(parts.length).toBeGreaterThan(1)
  expect(parts.map(part => part.text).join('')).toBe(text)
  parts.forEach((part, i) => {
    const prepared = adapter.prepare({ ...operation, fragment: { ordinal: i, count: parts.length }, payload: { kind: 'speech', phase: 'final', ...part } })
    expect(Buffer.byteLength(prepared.request.body!)).toBeLessThanOrEqual(30 * 1024)
  })
})

it('does not add a continuation card when the actual single-card request fits', () => {
  const adapter = new FeishuAdapter().publication, text = 'A'.repeat(30205), operation = original(text)
  expect(Buffer.byteLength(adapter.prepare(operation).request.body!)).toBeLessThanOrEqual(30 * 1024)
  expect(adapter.fragmentText!(operation.payload as never, operation.target)).toEqual([{ text }])
})

it('bounds native render work for long text while adapting to different encoded character sizes', () => {
  const adapter = new FeishuAdapter().publication, text = 'R'.repeat(512 * 1024) + '中文😀'.repeat(6000), operation = original(text)
  let renders = 0
  const parts = fragmentFeishuReply(text, part => {
    renders++
    if (Buffer.byteLength(part.text) > 30 * 1024) return false
    try {
      return Buffer.byteLength(adapter.prepare({ ...operation, fragment: { ordinal: text.length - 1, count: text.length },
        payload: { kind: 'speech', phase: 'final', ...part } }).request.body!) <= 30 * 1024
    } catch (error) {
      if (error instanceof core.AgentMuxError && error.code === 'FEISHU_PUBLICATION_REQUEST_TOO_LARGE') return false
      throw error
    }
  })
  expect(parts.map(part => part.text).join('')).toBe(text)
  expect(renders).toBeLessThan(parts.length * 4 + 48)
  parts.forEach((part, ordinal) => expect(Buffer.byteLength(adapter.prepare({ ...operation,
    fragment: { ordinal, count: parts.length }, payload: { kind: 'speech', phase: 'final', ...part } }).request.body!)).toBeLessThanOrEqual(30 * 1024))
})

it('reads an original frozen prior-version card without rewriting it into Markdown', async () => {
  const remote = await feishuPublicationHttp(); cleanup.push(remote.close)
  const adapter = new FeishuAdapter({ http: remote.http }).publication, operation = original('Original frozen reply')
  const prepared = adapter.prepare(operation), body = JSON.parse(prepared.request.body!)
  const oldCard = { config: { update_multi: true }, header: { title: { tag: 'plain_text', content: 'Agent reply' } },
    elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Original frozen reply' } }] }
  const frozen = { ...prepared, renderVersion: 'feishu-conversation-v3', request: { ...prepared.request, body: JSON.stringify({ ...body, content: JSON.stringify(oldCard) }) } }
  const bytes = JSON.stringify(frozen), signal = new AbortController().signal
  const receipt = await adapter.dispatch(frozen, operation.target, 'fixture-credential', signal)
  expect(receipt.state).toBe('confirmed'); if (receipt.state !== 'confirmed') throw Error('Original prior card did not reach controlled platform')
  expect(await adapter.inspect(frozen, operation.target, 'fixture-credential', signal, receipt.mapping)).toEqual(receipt)
  expect(JSON.stringify(frozen)).toBe(bytes)
  expect(remote.messageCalls().map(call => call.method)).toEqual(['POST', 'GET'])
})

it.each([
  'first\n\n\n\n' + 'A'.repeat(40000),
  '\n\n```text\r\n' + '`x'.repeat(150000) + '\r\n```\n\n',
  '```' + 'lang'.repeat(9000) + '\nbody\n```',
  ('    alpha beta gamma\n').repeat(3000),
  '| ' + 'A'.repeat(40000) + ' | B |\n| --- | --- |\n',
  '| A | B |\n| --- | --- |\n| ' + '原值😀'.repeat(12000) + ' | tail |\n'
])('retains exact original slices and complete visible content across pathological block limits', text => {
  const adapter = new FeishuAdapter().publication, operation = original(text)
  const parts = adapter.fragmentText!(operation.payload as never, operation.target)!
  expect(parts.map(part => part.text).join('')).toBe(text)
  expect(parts.every(part => part.text.trim().length > 0)).toBe(true)
  parts.forEach((part, ordinal) => expect(Buffer.byteLength(adapter.prepare({ ...operation,
    fragment: { ordinal, count: parts.length }, payload: { kind: 'speech', phase: 'final', ...part } }).request.body!)).toBeLessThanOrEqual(30 * 1024))
})

it('preserves escaped pipes and excess cells instead of leaking table delimiters or dropping values', () => {
  const adapter = new FeishuAdapter().publication
  const card = nativeCard(adapter.prepare(original('| A | B |\n| --- | --- |\n| left\\|right | **bold** | extra |\n')).request.body!)
  const table = card.body.elements[0]
  expect(table.columns.map((column: any) => column.display_name)).toEqual(['A', 'B', ' '])
  expect(table.rows).toEqual([{ c0: 'left\\|right', c1: '**bold**', c2: 'extra' }])
})

it('keeps multiline native-looking tags literal in the actual SDK card', async () => {
  const remote = await feishuPublicationHttp(); cleanup.push(remote.close)
  const adapter = new FeishuAdapter({ http: remote.http }).publication
  const operation = original('<div>\n<at user_id="all">literal</at>\n</div>\n'), prepared = adapter.prepare(operation)
  const rendered = markdownText(nativeCard(prepared.request.body!)), tree = unified().use(remarkParse).parse(rendered)
  const html: unknown[] = [], visit = (node: any) => { if (node.type === 'html') html.push(node); node.children?.forEach(visit) }
  visit(tree); expect(html).toEqual([]); expect(rendered).toContain('<at user_id="all">literal</at>')
  expect((await adapter.dispatch(prepared, operation.target, 'fixture-credential', new AbortController().signal)).state).toBe('confirmed')
})

it('the default Host restores an original deferred text resource through native fragmentation', async () => {
  const f = await host(), text = 'R'.repeat(2 * 1024 * 1024 + 1)
  const resource = f.conversation.resource.bind(f.conversation)
  let unavailable = true
  const reads = vi.spyOn(f.conversation, 'resource').mockImplementation((...args) => {
    if (unavailable) return Promise.reject(Error('Original resource is temporarily unavailable'))
    return resource(...args)
  })
  await appendFile(f.transcript, f.native('deferred-reply', 'final_answer', text)); f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.store.coverage(f.binding).gaps.some(gap => gap.reason === 'resource-unavailable')).toBe(true), { timeout: 10000 })
  expect(reads).toHaveBeenCalled(); expect(f.operations()).toEqual([])
  unavailable = false; f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.operations().some(row => row.state === 'confirmed'), JSON.stringify({ reads: reads.mock.calls.length, calls: f.remote.messageCalls().map(call => ({ method: call.method, bytes: Buffer.byteLength(call.body) })), ops: f.operations().map(row => ({ state: row.state, reason: row.reason, fragment: row.fragment })), coverage: f.services.publication!.store.coverage(f.binding), observation: f.services.publication!.observation(f.binding.bindingId, f.binding.revision) })).toBe(true), { timeout: 30000 })
  expect(f.services.publication!.store.coverage(f.binding)).toMatchObject({ state: 'complete', gaps: [] })
  expect(f.operations().map(row => row.payload.kind === 'speech' ? row.payload.text : '').join('')).toBe(text)
  expect(f.operations().length).toBeLessThan(100)
  const prepared = f.operations().filter(row => row.prepared)
  expect(prepared.length).toBeGreaterThan(0)
  expect(prepared.every(row => Buffer.byteLength(row.prepared!.request.body!) <= 30 * 1024)).toBe(true)
}, 45000)
