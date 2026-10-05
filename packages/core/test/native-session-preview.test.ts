import { fixtureIso } from '../../../test/fixture-values.mjs'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

async function fixture(providerId: 'codex' | 'claude' = 'codex') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-native-preview-'))), workspace = join(root, 'workspace')
  const home = join(root, 'provider'), env = providerId === 'codex' ? { CODEX_HOME: home } : { CLAUDE_CONFIG_DIR: home }
  const file = providerId === 'codex' ? join(home, 'sessions', 'rollout-preview-native.jsonl') : join(home, 'projects', 'workspace', 'preview-native.jsonl')
  await mkdir(workspace); await mkdir(dirname(file), { recursive: true })
  const records = providerId === 'codex' ? [
    { type: 'session_meta', payload: { id: 'preview-native', cwd: workspace, source: 'cli', timestamp: fixtureIso(0) } },
    { timestamp: fixtureIso(1), type: 'response_item', payload: { id: 'original-user', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Original external request' }] } },
    { timestamp: fixtureIso(2), type: 'response_item', payload: { id: 'original-assistant', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Original external response' }] } }
  ] : [
    { timestamp: fixtureIso(1), type: 'user', uuid: 'original-user', sessionId: 'preview-native', cwd: workspace, isSidechain: false, message: { role: 'user', content: 'Original external request' } },
    { timestamp: fixtureIso(2), type: 'assistant', uuid: 'original-assistant', sessionId: 'preview-native', cwd: workspace, isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Original external response' }] } }
  ]
  await writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  const store = new AgentMuxFileAgentSessionStore(join(root, 'managed-sessions.json')), client = new AgentMuxClient({ store })
  cleanup.push(async () => { await client.dispose(); await rm(root, { recursive: true, force: true }) })
  const kernel = Reflect.get(client, 'kernel')
  const controls = ['start', 'stop', 'input', 'connect'].map(method => vi.spyOn(kernel, method).mockImplementation(() => { throw new Error('Preview cannot control Runtime') }))
  const provider = client.providers.get(providerId)
  const source = (await client.listNativeAgentSessions({ providerId, env, workspacePath: workspace })).sessions[0]!.source
  return { root, workspace, home, env, file, records, client, provider, source, store, controls }
}

it.each(['codex', 'claude'] as const)('previews exact saved %s speech and stable older pages without a Core identity or Run', async providerId => {
  const f = await fixture(providerId), before = await readFile(f.file)
  const reading = f.client.readNativeAgentHistory({ source: f.source, env: f.env, limit: 1 })
  await expect(reading).resolves.toMatchObject({ source: { providerId, nativeSessionId: 'preview-native' } })
  const latest = await reading
  expect(latest).not.toHaveProperty('agentSessionId')
  expect(latest.source).toEqual({ providerId, nativeSessionId: 'preview-native' })
  expect(latest.items).toMatchObject([{ id: 'original-assistant', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Original external response' }] }])
  expect(latest.nextCursor).toBeTruthy()
  await appendFile(f.file, JSON.stringify(f.records.at(-1)) + '\n')
  const older = await f.client.readNativeAgentHistory({ source: f.source, env: f.env, limit: 1, cursor: latest.nextCursor! })
  expect(older.items).toMatchObject([{ id: 'original-user', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Original external request' }] }])
  expect(await loadAgentSessions(f.store)).toEqual([])
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
  expect((await readFile(f.file)).subarray(0, before.length)).toEqual(before)
})

it('retains native older-format CLI/editor main conversations while explicit child and unknown producer remain distinct', async () => {
  const f = await fixture()
  const metadata = f.records[0] as any
  for (const originator of ['codex_cli_rs', 'codex_vscode']) {
    const { source: _source, ...payload } = metadata.payload
    await writeFile(f.file, JSON.stringify({ ...metadata, payload: { ...payload, originator, cli_version: '0.42.0' } }) + '\n')
    const catalogue = await f.client.listNativeAgentSessions({ providerId: 'codex', env: f.env })
    expect(catalogue.sessions).toHaveLength(1); expect(catalogue.issues).toEqual([])
    await expect(f.provider.assertNativeResumeSource!({ source: catalogue.sessions[0]!.source, env: f.env,
      workspacePath: f.workspace, signal: new AbortController().signal })).resolves.toBeUndefined()
  }
  await writeFile(f.file, JSON.stringify({ ...metadata, payload: { ...metadata.payload, source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } } }) + '\n')
  expect((await f.client.listNativeAgentSessions({ providerId: 'codex', env: f.env })).sessions).toEqual([])
  await writeFile(f.file, JSON.stringify({ ...metadata, payload: { ...metadata.payload, source: undefined, originator: 'unconfirmed-tool', cli_version: '0.42.0' } }) + '\n')
  expect((await f.client.listNativeAgentSessions({ providerId: 'codex', env: f.env })).issues).toMatchObject([{ code: 'AGENT_NATIVE_SESSION_PROVENANCE_UNKNOWN' }])
})

it('refuses changed source before preview and verifies the same source again after Provider reading', async () => {
  const f = await fixture(), original = f.provider.readSessionHistoryPage!, read = vi.spyOn(f.provider, 'readSessionHistoryPage')
  await expect(f.client.readNativeAgentHistory({ source: { ...f.source, workspacePath: join(f.workspace, 'other') }, env: f.env })).rejects.toMatchObject({ code: 'AGENT_NATIVE_RESUME_SOURCE_CHANGED' })
  expect(read).not.toHaveBeenCalled()
  read.mockImplementationOnce(async context => {
    const page = await original(context), replacement = f.file + '.replacement'
    await writeFile(replacement, await readFile(f.file)); await rename(replacement, f.file)
    return page
  })
  await expect(f.client.readNativeAgentHistory({ source: f.source, env: f.env })).rejects.toMatchObject({ code: 'AGENT_NATIVE_RESUME_SOURCE_CHANGED' })
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('cancels only the original native preview reader and keeps a fresh read reachable', async () => {
  const f = await fixture(), controller = new AbortController(), waiting = Promise.withResolvers<void>()
  let nativeSignal!: AbortSignal
  vi.spyOn(f.provider, 'readSessionHistoryPage').mockImplementationOnce(async context => {
    nativeSignal = context.signal; waiting.resolve()
    return await new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }))
  })
  const page = f.client.readNativeAgentHistory({ source: f.source, env: f.env, signal: controller.signal })
  await waiting.promise; const cancelled = expect(page).rejects.toThrow('Cancelled preview')
  controller.abort(new Error('Cancelled preview')); await cancelled; expect(nativeSignal.aborted).toBe(true)
  await expect(f.client.readNativeAgentHistory({ source: f.source, env: f.env, limit: 1 })).resolves.toMatchObject({ items: [{ id: 'original-assistant' }] })
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it('normalizes every native page against its exact Provider-issued source', async () => {
  const f = await fixture(), original = f.provider.readSessionHistoryPage!
  vi.spyOn(f.provider, 'readSessionHistoryPage').mockImplementationOnce(async context => ({
    ...await original(context), source: { ...context.source, nativeSessionId: 'foreign-native' }
  }))
  await expect(f.client.readNativeAgentHistory({ source: f.source, env: f.env })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
})

it('reads an exact recorded image and never grants a caller-supplied replacement reference', async () => {
  const f = await fixture(), image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg=='
  await writeFile(f.file, [f.records[0], { type: 'response_item', timestamp: fixtureIso(3), payload: {
    id: 'image-user', type: 'message', role: 'user', content: [{ type: 'input_image', image_url: image }] }
  }].map(record => JSON.stringify(record)).join('\n') + '\n')
  const page = await f.client.readNativeAgentHistory({ source: f.source, env: f.env, limit: 1 }), item = page.items[0]!
  const request = { nativeSource: f.source, source: page.source, recordId: item.id, partIndex: 0, expectedReference: image, env: f.env }
  await expect(f.client.readNativeAgentHistoryResource(request)).resolves.toMatchObject({ source: page.source, result: { status: 'read', mimeType: 'image/png' } })
  await expect(f.client.readNativeAgentHistoryResource({ ...request, expectedReference: image.replace('AAAAE', 'AAAAC') })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_RESOURCE_MISMATCH' })
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})

it.each(['codex', 'claude'] as const)('reads complete %s native text extents and rejects a resource from another source', async providerId => {
  const f = await fixture(providerId), body = 'Exact large original history '.repeat(80_000), last = f.records.at(-1) as any
  if (providerId === 'codex') last.payload.content[0].text = body
  else last.message.content[0].text = body
  await writeFile(f.file, f.records.map(record => JSON.stringify(record)).join('\n') + '\n')
  const page = await f.client.readNativeAgentHistory({ source: f.source, env: f.env, limit: 1 }), item = page.items[0]!, part = item.contentParts[0]!
  expect(part).toMatchObject({ kind: 'resource', resourceType: 'text', content: { kind: 'text', encoding: 'json-utf8' } })
  if (part.kind !== 'resource') throw new Error('Large body must retain a native extent')
  const request = { nativeSource: f.source, source: page.source, recordId: item.id, partIndex: 0, expectedReference: part.reference, env: f.env, maxBytes: 128 * 1024 }
  await expect(f.client.readNativeAgentHistoryResource({ ...request, source: { ...page.source, nativeSessionId: 'another-native' } })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  let offsetBytes = 0; const bytes: Buffer[] = []
  for (;;) {
    const receipt = await f.client.readNativeAgentHistoryResource({ ...request, offsetBytes })
    expect(receipt).not.toHaveProperty('agentSessionId')
    if (receipt.result.status !== 'fragment') throw new Error('Native text must return exact bounded fragments')
    bytes.push(Buffer.from(receipt.result.dataBase64, 'base64'))
    if (receipt.result.nextOffsetBytes === null) break
    offsetBytes = receipt.result.nextOffsetBytes
  }
  expect(JSON.parse(Buffer.concat(bytes).toString('utf8'))).toEqual({ kind: 'text', text: body })
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
})
