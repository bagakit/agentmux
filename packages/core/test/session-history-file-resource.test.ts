import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import type { AgentMuxRpcMethod, AgentMuxRpcParams } from '../src/public-rpc.js'
import { parseSessionHistoryResourceResult, SESSION_HISTORY_IMAGE_MAX_BYTES } from '../src/session-history-resource.js'
import { readSessionHistoryTextResource } from '../src/session-history-content.js'
import type { AgentSessionHistoryResourceReadResult } from '../src/types.js'

const source = { providerId: 'droid', nativeSessionId: 'original-file-source' }
const sessionId = 'recorded-file-session'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function fixture(bytes = Buffer.from('%PDF-original bytes\n原始文件\n'), purpose: 'tool-result' | 'private' | 'unconfirmed' = 'tool-result') {
  const directory = await mkdtemp(join(tmpdir(), 'amx-recorded-file-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'native.jsonl')
  const documentSource: Record<string, unknown> = { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64'), parsed_data: 'A separate extracted summary', name: '原始报告.pdf' }
  const document = { type: 'document', source: documentSource }
  const records: Record<string, unknown>[] = [
    { type: 'session_start', id: source.nativeSessionId },
    { type: 'message', id: 'file-record', message: { role: 'user', ...(purpose === 'private' ? { visibility: 'llm_only' } : {}),
      content: purpose === 'unconfirmed' ? [document] : [{ type: 'tool_result', tool_use_id: 'document-tool', content: [document] }] } }
  ]
  const save = () => writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  await save()
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: sessionId, providerId: 'droid', executorId: 'droid', hostId: 'local', workspacePath: directory,
    run: { runId: 'original-healthy-file-run' }, retiredRuns: [], hookBindingId: 'file-binding', hookToken: 'file-token', createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1),
    nativeHandle: { kind: 'provider', providerId: 'droid', sessionId: source.nativeSessionId, transcriptPath: path } })
  const previousQueue = process.env.AGENTMUX_MESSAGE_QUEUE_PATH
  const provider = { ...new AgentProviderRegistry().get('droid') }
  let client: AgentMuxClient
  try {
    process.env.AGENTMUX_MESSAGE_QUEUE_PATH = join(directory, 'messages.ndjson')
    client = new AgentMuxClient({ store, providers: [provider] })
  } finally {
    if (previousQueue === undefined) delete process.env.AGENTMUX_MESSAGE_QUEUE_PATH
    else process.env.AGENTMUX_MESSAGE_QUEUE_PATH = previousQueue
  }
  cleanups.push(() => client.dispose())
  vi.spyOn(client, 'connect').mockRejectedValue(new Error('A recorded file read cannot connect a Run'))
  const runtime = new AgentMuxHostedRuntimeService(client, null, () => ({ runtimeId: 'file-semantic-host', ownerInstanceId: 'file-host-owner', protocolVersion: 2,
    processId: process.pid, availability: 'unverified', ctxmux: { hostId: 'local', buildIdentity: 'file-fixture', protocolVersion: 1, processId: null, instanceId: 'file-runtime', ownership: 'unverified' } }))
  cleanups.push(() => runtime.dispose())
  const socket = join(directory, 'control.sock')
  const server = new AgentMuxControlServer({ coreClients: () => [{ hostId: 'local', client }], hostedRuntime: () => runtime }, socket)
  await server.start()
  cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
  cleanups.push(() => rpc.dispose())
  const locate = async () => {
    const page = await client.sessionHistoryPage(sessionId)
    const record = page.items.find(item => item.id === 'file-record')!
    const partIndex = record.contentParts.findIndex(part => part.kind === 'resource')
    const part = record.contentParts[partIndex]!
    if (part.kind !== 'resource') throw new Error('The original native file part was not retained')
    const request = { source, recordId: record.id, partIndex, expectedReference: part.reference, representation: 'file' as const }
    return { input: { hostId: 'local', agentSessionId: sessionId, ...request }, request, part }
  }
  return { directory, path, records, save, client, provider, store, rpc, locate, documentSource, ...(await locate()), bytes }
}

async function cli(directory: string, socket: string, input: unknown) {
  const path = join(directory, 'resource-input.json')
  await writeFile(path, JSON.stringify(input))
  const child = spawn(process.execPath, [resolve(import.meta.dirname, '../dist/agentmux.js'), '--endpoint', `unix:${socket}`, 'agent', 'history', 'resource', '--input', path], {
    // A self-owned fixture service never borrows a production managed capability.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))), stdio: ['ignore', 'pipe', 'pipe']
  })
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('The fixture CLI did not complete')) }, 10000)
    child.once('error', error => { clearTimeout(deadline); reject(error) })
    child.once('close', code => { clearTimeout(deadline); resolveResult({ code, stdout, stderr }) })
  })
}

describe('original native file bytes through the public Core resource', () => {
  it('delivers the original document bytes and metadata through the actual Unix service and compiled CLI', async () => {
    const h = await fixture()
    const response = await cli(h.directory, join(h.directory, 'control.sock'), h.input)
    expect(response.code, response.stdout || response.stderr).toBe(0)
    const receipt = JSON.parse(response.stdout)
    expect(receipt).toMatchObject({ ok: true, operation: 'agent.history.resource', result: {
      hostId: 'local', agentSessionId: sessionId, source, recordId: 'file-record', partIndex: h.input.partIndex, reference: h.input.expectedReference,
      result: { status: 'file', mimeType: 'application/pdf', label: '原始报告.pdf', byteLength: h.bytes.length, dataBase64: h.bytes.toString('base64') }
    } })
    expect(digest(Buffer.from(receipt.result.result.dataBase64, 'base64'))).toBe(digest(h.bytes))
    expect(h.client.connect).not.toHaveBeenCalled()
    expect((await loadAgentSessions(h.store))[0]!.run).toEqual({ runId: 'original-healthy-file-run' })
  })

  it('reads a lazy signed file through SDK, Hosted and compiled CLI while retaining exact JSON fragments', async () => {
    const h = await fixture(Buffer.alloc(2 * 1024 * 1024, 79))
    expect(h.part).toMatchObject({ resourceType: 'text', content: { kind: 'resource' }, contentEligibility: 'public' })
    const socket = join(h.directory, 'control.sock')
    const cliReceipt = await cli(h.directory, socket, h.input)
    expect(cliReceipt.code).toBe(0)
    expectFile(JSON.parse(cliReceipt.stdout).result.result, h.bytes, '原始报告.pdf')
    const sdk = await h.client.sessionHistoryResource(sessionId, h.request)
    expectFile(sdk.result, h.bytes, '原始报告.pdf')
    const { representation: _representation, ...jsonInput } = h.request
    const original = await readSessionHistoryTextResource(h.part, h.input.partIndex, { source, recordId: h.input.recordId }, request => h.client.sessionHistoryResource(sessionId, request))
    expect(original).toMatchObject({ kind: 'resource', resourceType: 'file', label: '原始报告.pdf', reference: `data:application/pdf;base64,${h.bytes.toString('base64')}` })
    expect((await h.client.sessionHistoryResource(sessionId, { ...jsonInput, maxBytes: 128 * 1024, offsetBytes: 0 })).result.status).toBe('fragment')

    let completeProjection!: () => void
    const projection = new Promise<void>(resolveProjection => { completeProjection = resolveProjection })
    const port = { call: async <M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, options?: { signal?: AbortSignal }) => {
      const response = h.rpc.call(method, params, options)
      if (method === 'runtime.invoke' && (params as AgentMuxRpcParams<'runtime.invoke'>).invocation.method === 'runtimeProjection')
        void response.then(() => completeProjection(), () => completeProjection())
      return await response
    }, subscribe: h.rpc.subscribe.bind(h.rpc) }
    const hosted = await connectHostedAgentMux({ rpc: port, consumerId: 'file-resource-reader' })
    cleanups.push(() => hosted.dispose())
    // Await the already-existing admission RPC's real completion, not a timer or an extra probe.
    await projection
    expect(h.client.connect).toHaveBeenCalledTimes(1)
    vi.mocked(h.client.connect).mockClear()
    expectFile((await hosted.sessionHistoryResource(sessionId, h.request)).result, h.bytes, '原始报告.pdf')
    expect(h.client.connect).not.toHaveBeenCalled()
  })

  it('rejects another part of the signed original through the actual CLI', async () => {
    const h = await fixture(Buffer.alloc(2 * 1024 * 1024, 79))
    const response = await cli(h.directory, join(h.directory, 'control.sock'), { ...h.input, partIndex: h.input.partIndex + 1 })
    expect(response.code).toBe(1)
    const frames = (response.stdout + '\n' + response.stderr).split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ ok: false, error: { code: 'AGENT_SESSION_HISTORY_RESOURCE_MISMATCH' } })
  })

  it('locates the retained exact record beyond the moving first page without adding changes support', async () => {
    const h = await fixture()
    h.records.push(...Array.from({ length: 35 }, (_, i) => ({ type: 'message', id: `later-${i}`, message: { role: 'assistant', content: [{ type: 'text', text: 'independent later record' }] } })))
    await h.save()
    expect((await h.client.sessionHistoryPage(sessionId, { limit: 30 })).items.map(item => item.id)).not.toContain('file-record')
    expectFile((await h.client.sessionHistoryResource(sessionId, h.request)).result, h.bytes, '原始报告.pdf')
    expect(h.provider.readConversationChanges).toBeUndefined()
    await expect(h.client.sessionHistoryCheckpoint(sessionId)).rejects.toHaveProperty('code', 'AGENT_CONVERSATION_CHANGES_UNSUPPORTED')
  })

  it('keeps local private and unconfirmed files readable without changing their purpose or missing metadata', async () => {
    for (const purpose of ['private', 'unconfirmed'] as const) {
      const h = await fixture(undefined, purpose)
      delete h.documentSource.name
      delete h.documentSource.media_type
      await h.save()
      const { request, part } = await h.locate()
      expect(part.contentEligibility).toBe(purpose)
      const result = (await h.client.sessionHistoryResource(sessionId, request)).result
      expectFile(result, h.bytes)
      expect(result).not.toHaveProperty('label')
      // This is the converter's recorded default, not proof of an explicit native MIME or a valid PDF.
      expect(result).toHaveProperty('mimeType', 'application/pdf')
      expect(h.client.connect).not.toHaveBeenCalled()
    }
  })

  it('rejects forged identities, malformed bytes and path/remote sources while retaining independent reads', async () => {
    const h = await fixture()
    for (const patch of [{ recordId: 'another-record' }, { partIndex: h.input.partIndex + 1 }, { expectedReference: 'data:application/pdf;base64,Zm9yZ2Vk' }, { source: { ...source, nativeSessionId: 'another-native' } }])
      await expect(h.client.sessionHistoryResource(sessionId, { ...h.request, ...patch })).rejects.toHaveProperty('code')
    await expect(h.client.sessionHistoryResource(sessionId, { ...h.request, offsetBytes: 0 })).rejects.toHaveProperty('code', 'INVALID_AGENT_SESSION_HISTORY_RESOURCE')
    await expect(h.client.sessionHistoryResource(sessionId, { ...h.request, maxBytes: SESSION_HISTORY_IMAGE_MAX_BYTES + 1 })).rejects.toHaveProperty('code')
    expect((await h.client.sessionHistoryResource(sessionId, { ...h.request, maxBytes: h.bytes.length - 1 })).result.status).toBe('unavailable')
    for (const invalid of ['%%%%', 'Zg=']) {
      h.documentSource.data = invalid
      await h.save()
      const { request } = await h.locate()
      expect((await h.client.sessionHistoryResource(sessionId, request)).result).toMatchObject({ status: 'unavailable', code: 'AGENT_SESSION_HISTORY_RESOURCE_FORMAT_UNSUPPORTED' })
    }
    h.documentSource.data = ''
    await h.save()
    await expect(h.client.sessionHistoryResource(sessionId, h.request)).rejects.toHaveProperty('code', 'AGENT_SESSION_HISTORY_RESOURCE_MISMATCH')
    for (const path of [join(h.directory, 'not-authorized.pdf'), 'https://synthetic.invalid/not-authorized.pdf']) {
      h.documentSource.path = path
      await h.save()
      const { request } = await h.locate()
      expect((await h.client.sessionHistoryResource(sessionId, request)).result).toMatchObject({ status: 'unavailable', code: 'AGENT_SESSION_HISTORY_RESOURCE_REFERENCE_UNSUPPORTED' })
    }
    delete h.documentSource.path
    h.documentSource.data = h.bytes.toString('base64')
    await h.save()
    expectFile((await h.client.sessionHistoryResource(sessionId, h.request)).result, h.bytes, '原始报告.pdf')
    expect(h.client.connect).not.toHaveBeenCalled()
  })

  it('strictly validates the actual file receipt and preserves the image representation', async () => {
    const h = await fixture()
    const receipt = await h.rpc.call('agent.history.resource', h.input)
    expect(parseSessionHistoryResourceResult(receipt, h.input)).toEqual(receipt)
    for (const patch of [{ mimeType: ['application/pdf'] }, { label: {} }, { dataBase64: 'Zg=' }, { byteLength: 1 }, { status: ['file'] }, { extra: true }])
      expect(() => parseSessionHistoryResourceResult({ ...receipt, result: { ...receipt.result, ...patch } }, h.input)).toThrow()
    expect(() => parseSessionHistoryResourceResult(receipt, { ...h.input, representation: 'image' })).toThrow()
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII='
    h.records.push({ type: 'message', id: 'original-image', message: { role: 'assistant', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] } })
    await h.save()
    const image = { ...h.request, recordId: 'original-image', partIndex: 0, expectedReference: `data:image/png;base64,${png}`, representation: 'image' as const }
    expect((await h.client.sessionHistoryResource(sessionId, image)).result).toMatchObject({ status: 'read', width: 1, height: 1 })
    const { representation: _representation, ...defaultImage } = image
    expect((await h.client.sessionHistoryResource(sessionId, defaultImage)).result.status).toBe('read')
  })

  it('cancels only the original read and refuses a changed source without changing the healthy Run', async () => {
    const h = await fixture(), read = h.provider.readSessionHistoryRecord!
    let startRead!: () => void, releaseRead!: () => void
    const started = new Promise<void>(resolveStarted => { startRead = resolveStarted })
    const release = new Promise<void>(resolveRelease => { releaseRead = resolveRelease })
    h.provider.readSessionHistoryRecord = async context => { startRead(); await release; return read(context) }
    const abort = new AbortController()
    const pending = h.client.sessionHistoryResource(sessionId, { ...h.request, signal: abort.signal })
    await started
    abort.abort()
    releaseRead()
    await expect(pending).rejects.toBeInstanceOf(Error)
    h.provider.readSessionHistoryRecord = async context => {
      const item = await read(context), original = (await loadAgentSessions(h.store))[0]!
      await h.store.compareAndSwap(original, { ...original, updatedAt: _tailFixtureEpoch(0, 0, 2), nativeHandle: { kind: 'provider', providerId: 'droid', sessionId: 'changed-source', transcriptPath: h.path } })
      return item
    }
    await expect(h.client.sessionHistoryResource(sessionId, h.request)).rejects.toHaveProperty('code', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
    expect((await loadAgentSessions(h.store))[0]!.run).toEqual({ runId: 'original-healthy-file-run' })
    expect(h.client.connect).not.toHaveBeenCalled()
    expect(await readFile(h.path, 'utf8')).toContain('file-record')
  })
})

function expectFile(result: AgentSessionHistoryResourceReadResult['result'], bytes: Uint8Array, label?: string): void {
  expect(result.status).toBe('file')
  if (result.status !== 'file') throw new Error('No original file bytes were delivered')
  expect(result.mimeType).toBe('application/pdf')
  expect(result.byteLength).toBe(bytes.length)
  expect(result.label).toBe(label)
  expect(digest(Buffer.from(result.dataBase64, 'base64'))).toBe(digest(bytes))
}
