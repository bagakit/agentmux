import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Nodes } from 'mdast'
import * as core from '@agentmux/core'
import * as connectors from '@agentmux/connectors'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { startAgentMuxHost } from '../../../apps/host/src/host.js'
import { feishuConfig, feishuSdkTransport } from './fixtures/feishu.js'
import { feishuMediaPlatform } from './fixtures/feishu-media-platform.js'
import { FeishuAdapter } from '../src/adapters/feishu/index.js'
import type { PublicationOperation } from '../src/publication-store.js'

// The oracle deliberately uses standard CommonMark, as the native card does.
const nativeMarkdown = unified().use(remarkParse).use(remarkGfm)
const privateHome = vi.hoisted(() => ({ directory: undefined as string | undefined }))
vi.mock('node:os', async load => { const original = await load<typeof import('node:os')>(); return { ...original, homedir: () => privateHome.directory ?? original.homedir() } })
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { privateHome.directory = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs() } })
const plain = (node: Nodes): string => 'value' in node ? String(node.value) : 'children' in node ? node.children.map(plain).join('') : ''
function nodes(node: Nodes, type: Nodes['type']): Nodes[] {
  return [...(node.type === type ? [node] : []), ...('children' in node ? node.children.flatMap(child => nodes(child, type)) : [])]
}
const card = (operation: PublicationOperation) => JSON.parse(JSON.parse(operation.prepared!.request.body!).content)
function markdown(value: any): string[] {
  if (!value || typeof value !== 'object') return []
  return [...(value.tag === 'markdown' ? [value.content as string] : []), ...Object.values(value).flatMap(item => Array.isArray(item) ? item.flatMap(markdown) : markdown(item))]
}
const parsed = (value: any) => markdown(value).map(text => nativeMarkdown.parse(text))
function operation(text: string, mode: 'human' | 'progress' | 'final' | 'a2a' = 'final'): PublicationOperation {
  return { operationId: 'cjk-' + mode, projectionId: 'original-projection', sourceRevision: 'original-source', bindingId: 'original-binding', bindingRevision: 1,
    reference: { hostId: 'local', agentSessionId: 'original-agent', source: { kind: 'native', providerId: 'claude', nativeSessionId: 'original-native', recordId: 'original-record' } },
    target: { connectionId: feishuConfig.connectionId, application: feishuConfig.application, externalConversationId: 'original-room' }, effect: 'upsert', fragment: { ordinal: 0, count: 1 }, state: 'pending',
    speaker: { kind: mode === 'human' ? 'human' : 'agent', name: 'Original speaker' }, ...(mode === 'a2a' ? { originalMessage: { messageId: 'original-peer-message', senderSessionId: 'original-peer' } } : {}),
    payload: { kind: 'speech', text, ...(mode === 'progress' || mode === 'final' ? { phase: mode } : {}) } }
}
async function sdk(text: string, mode: Parameters<typeof operation>[1] = 'final') {
  feishuSdkTransport(); const remote = await feishuMediaPlatform(); cleanup.push(remote.close)
  const adapter = new FeishuAdapter().publication, original = operation(text, mode), prepared = adapter.prepare(original)
  const signal = new AbortController().signal
  const receipt = await adapter.dispatch(prepared, original.target, 'synthetic-cjk-credential', signal)
  expect(receipt.state).toBe('confirmed')
  if (receipt.state !== 'confirmed') throw Error('Fixture SDK delivery did not confirm')
  expect(await adapter.inspect(prepared, original.target, 'synthetic-cjk-credential', signal, receipt.mapping)).toEqual(receipt)
  const creates = remote.calls.filter(call => call.method === 'POST')
  expect(creates).toHaveLength(1)
  const wire = JSON.parse((creates[0]!.body as { content: string }).content)
  expect(wire).toEqual(card({ ...original, prepared }))
  return wire
}
async function host() {
  const original = await rpcOwnerFixture(['cjk-agent'], core, root => ({ providerId: 'claude', executorId: 'claude', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'cjk-native', transcriptPath: join(root, 'native.jsonl') } }))
  cleanup.push(original.close); privateHome.directory = original.root
  const transcript = join(original.root, 'native.jsonl')
  await writeFile(transcript, JSON.stringify({ type: 'user', sessionId: 'cjk-native', uuid: 'before-binding', message: { role: 'user', content: 'Earlier private input' } }) + '\n')
  await original.client.dispose(); feishuSdkTransport()
  const remote = await feishuMediaPlatform(); cleanup.push(remote.close)
  const factory = connectors.createConnectionServices, opened: connectors.ConnectionServices[] = []
  vi.spyOn(connectors, 'createConnectionServices').mockImplementation(async options => { const service = await factory(options); opened.push(service); return service })
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner; await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => false
  })
  let runtime: Awaited<ReturnType<typeof startAgentMuxHost>>
  const socketPath = join(original.root, 'cjk.sock')
  try { runtime = await startAgentMuxHost({ store: original.store, socketPath, desktopSocketPath: join(original.root, 'absent-desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile'), connections: { directory: join(original.root, 'connections') } }) }
  finally { connect.mockRestore() }
  cleanup.push(() => runtime.dispose())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => rpc.dispose())
  const owner = (await rpc.call('runtime.owner.identity', {})).owner
  const secret = await rpc.call('connection.credential.store', { operationId: 'cjk-secret', secret: 'synthetic-cjk-credential' }, { runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
  await rpc.call('connection.configure', { operationId: 'cjk-configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: secret.credentialRef } })
  expect(await rpc.call('connection.bind', { operationId: 'cjk-bind', bindingId: 'cjk-binding', connectionId: feishuConfig.connectionId, expectedConnectionRevision: 1,
    executionHostId: 'local', agentSessionId: 'cjk-agent', externalConversationId: 'original-room', expectedSource: { providerId: 'claude', nativeSessionId: 'cjk-native' },
    scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })).toMatchObject({ state: 'applied' })
  const operations = () => opened.at(-1)!.publication!.store.list({ bindingId: 'cjk-binding', revision: 1 }, 100).filter(row => row.payload.kind === 'speech')
  return { original, remote, rpc, operations, async send(prompt: string, native = false) {
    if (native) await appendFile(transcript, JSON.stringify({ type: 'assistant', sessionId: 'cjk-native', uuid: 'original-answer', message: { role: 'assistant', content: [{ type: 'text', text: prompt }] } }) + '\n')
    else await runtime.client.submitAgentPrompt({ agentSessionId: 'cjk-agent', expectedRun: { runId: 'run-cjk-agent' }, operationId: 'original-input', prompt,
      authorHuman: true, sourceChannel: 'message-tool', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' })
    opened.at(-1)!.publication!.refresh()
    await vi.waitFor(() => { const result = operations(); expect(result.length).toBeGreaterThan(0); expect(result.every(row => row.state === 'confirmed'), JSON.stringify(result.map(row => ({ state: row.state, reason: row.reason, fragment: row.fragment })))).toBe(true) }, { timeout: 10000 })
  } }
}

it('default Host sends CJK emphasis through the actual SDK without changing original source or delivery identity', async () => {
  const f = await host(), text = '**1. 目标与现状：**目标是正常聊天。'
  await f.send(text)
  const original = f.operations(); expect(original).toHaveLength(1)
  expect(original[0]!.payload).toMatchObject({ kind: 'speech', text })
  const trees = parsed(card(original[0]!)); expect(trees).toHaveLength(1)
  expect(trees.flatMap(tree => nodes(tree, 'strong').map(plain))).toEqual(['1. 目标与现状：'])
  expect(trees.map(plain).join('')).toBe('1. 目标与现状：目标是正常聊天。')
  const receipt = await f.rpc.call('connection.delivery.inspect', { operationId: original[0]!.operationId })
  expect(receipt.delivery).toMatchObject({ operationId: original[0]!.operationId, state: 'confirmed' })
  const outgoing = f.remote.calls.filter(call => call.method === 'POST').map(call => JSON.stringify(call.body))
  expect(outgoing.some(wire => wire.includes('&#x76EE;'))).toBe(true)
  if (process.env.FEISHU_CJK_PREVIEW) await writeFile(join(process.env.FEISHU_CJK_PREVIEW, 'host-cjk.json'), JSON.stringify(card(original[0]!), null, 2))
})

it.each(['human', 'progress', 'final', 'a2a'] as const)('official SDK preserves CJK emphasis and nested meaning for the %s role', async mode => {
  const wire = await sdk('先看**「粗体*内部斜体*」**再继续。', mode)
  const trees = parsed(wire); expect(trees).toHaveLength(1)
  expect(trees.flatMap(tree => nodes(tree, 'strong').map(plain))).toEqual(['「粗体内部斜体」'])
  expect(trees.flatMap(tree => nodes(tree, 'emphasis').map(plain))).toEqual(['内部斜体'])
  expect(trees.map(plain).join('')).toBe('先看「粗体内部斜体」再继续。')
})

it('official SDK keeps authored escapes, code, ambiguous markers and HTML literal while preserving the link target', async () => {
  const text = '\\*\\*「保留」\\*\\*文字\n\n`**「代码」**文字`\n\n```ts\nconst original = "**「围栏」**文字";\n```\n\n**「标点」 **文字\n\n原标签 <at id="all">all</at>\n\n[**「链接」**文字](https://example.com/path?q=a%20b#part)'
  const wire = await sdk(text), trees = parsed(wire)
  expect(trees.flatMap(tree => nodes(tree, 'strong').map(plain))).toEqual(['「链接」'])
  expect(trees.flatMap(tree => nodes(tree, 'code').map(plain))).toEqual(['const original = "**「围栏」**文字";'])
  expect(trees.flatMap(tree => nodes(tree, 'inlineCode').map(plain))).toEqual(['**「代码」**文字', '<at id="all">', '</at>'])
  expect(trees.flatMap(tree => nodes(tree, 'link')).map(node => node.type === 'link' ? node.url : '')).toEqual(['https://example.com/path?q=a%20b#part'])
  expect(trees.map(plain).join('')).toContain('**「保留」**文字')
  expect(trees.map(plain).join('')).toContain('**「标点」 **文字')
  if (process.env.FEISHU_CJK_PREVIEW) await writeFile(join(process.env.FEISHU_CJK_PREVIEW, 'literal-cjk.json'), JSON.stringify(wire, null, 2))
})

it('official SDK keeps native table structure and CJK cell meaning between unchanged prose and code', async () => {
  const wire = await sdk('**「正文」**相邻。\n\n| 列名 | 内容 |\n| --- | --- |\n| **「单元格」**相邻 | `**原代码**` |\n\n```text\n原始围栏内容\n```')
  const tables = wire.body.elements.filter((element: any) => element.tag === 'table')
  expect(tables).toHaveLength(1)
  expect(tables[0].rows).toHaveLength(1)
  const cell = nativeMarkdown.parse(tables[0].rows[0].c0)
  expect(nodes(cell, 'strong').map(plain)).toEqual(['「单元格」'])
  expect(plain(cell)).toBe('「单元格」相邻')
  expect(nodes(nativeMarkdown.parse(tables[0].rows[0].c1), 'inlineCode').map(plain)).toEqual(['**原代码**'])
  expect(parsed(wire).flatMap(tree => nodes(tree, 'code').map(plain))).toEqual(['原始围栏内容'])
  if (process.env.FEISHU_CJK_PREVIEW) await writeFile(join(process.env.FEISHU_CJK_PREVIEW, 'table-cjk.json'), JSON.stringify(wire, null, 2))
})

it('default Host budgets the actual normalized native requests and preserves complete original source fragments', async () => {
  const f = await host(), block = '**「段落」**相邻文字。', text = Array.from({ length: 800 }, () => block).join('\n\n')
  await f.send(text, true)
  const original = f.operations(); expect(original.length).toBeGreaterThan(1)
  expect(original.map(row => row.payload.kind === 'speech' ? row.payload.text : '').join('')).toBe(text)
  expect(original.every(row => Buffer.byteLength(row.prepared!.request.body!) <= 30 * 1024)).toBe(true)
  const trees = original.flatMap(row => parsed(card(row)))
  expect(trees.flatMap(tree => nodes(tree, 'strong').map(plain))).toEqual(Array.from({ length: 800 }, () => '「段落」'))
  expect(trees.map(plain).join('')).toBe('「段落」相邻文字。'.repeat(800))
})

it('default Host keeps a fitting normalized request whole even when its escaped source exceeds the wire budget', async () => {
  const f = await host(), text = '\\!'.repeat(16000)
  expect(Buffer.byteLength(text)).toBeGreaterThan(30 * 1024)
  await f.send(text, true)
  const original = f.operations(); expect(original).toHaveLength(1)
  expect(original[0]!.payload).toMatchObject({ text })
  expect(parsed(card(original[0]!)).map(plain).join('')).toBe('!'.repeat(16000))
  expect(Buffer.byteLength(original[0]!.prepared!.request.body!)).toBeLessThanOrEqual(30 * 1024)
})

it('default Host preserves mixed CJK prose, table rows and oversized code through original block continuations', async () => {
  const f = await host(), values = Array.from({ length: 20 }, (_, index) => `原行${index}`), code = Array.from({ length: 90 }, (_, index) => `line_${index} = "${'完整'.repeat(90)}";`).join('\n')
  const text = '**「开头」**继续。\n\n| 标记 | 内容 |\n| --- | --- |\n' + values.map(value => `| **「表格」**相邻 | ${value} |`).join('\n') + '\n\n```ts\n' + code + '\n```\n\n**「结尾」**完整。'
  await f.send(text, true)
  const original = f.operations(); expect(original.length).toBeGreaterThan(1)
  expect(original.map(row => row.payload.kind === 'speech' ? row.payload.text : '').join('')).toBe(text)
  expect(original.every(row => Buffer.byteLength(row.prepared!.request.body!) <= 30 * 1024)).toBe(true)
  const cards = original.map(card), tables = cards.flatMap(value => value.body.elements.filter((element: any) => element.tag === 'table'))
  expect(tables.flatMap(table => table.rows.map((row: any) => row.c1))).toEqual(values)
  expect(tables.flatMap(table => table.rows.map((row: any) => nodes(nativeMarkdown.parse(row.c0), 'strong').map(plain)))).toEqual(values.map(() => ['「表格」']))
  const trees = cards.flatMap(parsed)
  expect(trees.flatMap(tree => nodes(tree, 'code').map(plain)).join('')).toBe(code)
  expect(trees.flatMap(tree => nodes(tree, 'strong').map(plain))).toEqual(['「开头」', '「结尾」'])
})
