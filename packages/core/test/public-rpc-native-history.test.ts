import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtureIso } from '../../../test/fixture-values.mjs'
import { AgentMuxClient } from '../src/client.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxFileAgentSessionStore, loadAgentSessions } from '../src/agent-session-store.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { NativeJsonlHistoryReader } from '../src/native-jsonl-history-reader.js'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { agentMuxCommandHelp, AGENTMUX_CLI_SKILL } from '../src/agentmux-cli-help.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxRpcService, type AgentMuxRpcServiceOptions } from '../src/public-rpc-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseNativeHistoryParams, parseNativeHistoryResourceParams } from '../src/public-rpc-native-history.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentNativeResumeSource } from '../src/types.js'

const nativeId = '19d557c3-7a9c-4e1f-a566-913c06753520'
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
const jsonl = (records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n'
const exact = { priorUser: '  earlier request 中\n', priorAnswer: '  earlier answer 🙂\n',
  latestUser: '  latest request 中\n', latestAnswer: '  latest answer 🙂\n', appended: 'Newly appended answer' }
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII=', 'base64')

async function fixture(providerId: 'codex' | 'claude' = 'claude', aggregate = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amx-native-history-public-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'provider'), workspacePath = join(root, 'workspace')
  const transcriptPath = providerId === 'codex'
    ? join(home, 'sessions', ...fixtureIso(0).slice(0, 10).split('-'), 'rollout-original.jsonl')
    : join(home, 'projects', '-private-workspace', `${nativeId}.jsonl`)
  await mkdir(dirname(transcriptPath), { recursive: true }); await mkdir(workspacePath)
  const message = (id: string, role: 'user' | 'assistant', text: string) => providerId === 'codex'
    ? { type: 'response_item', timestamp: fixtureIso(1), payload: { type: 'message', id, role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }
    : { type: role, uuid: id, sessionId: nativeId, cwd: workspacePath, isSidechain: false,
      timestamp: fixtureIso(1), message: { role, content: [{ type: 'text', text }] } }
  const metadata = providerId === 'codex' ? [{ type: 'session_meta', timestamp: fixtureIso(0), payload: {
    id: nativeId, cwd: workspacePath, source: 'cli', timestamp: fixtureIso(0) } }] : []
  const records = [...metadata, message('prior-user', 'user', exact.priorUser), message('prior-answer', 'assistant', exact.priorAnswer),
    message('latest-user', 'user', exact.latestUser), message('latest-answer', 'assistant', exact.latestAnswer)]
  await writeFile(transcriptPath, jsonl(records))
  if (providerId === 'codex') await writeFile(join(home, 'session_index.jsonl'), jsonl([{ id: nativeId, thread_name: 'Saved original details' }]))
  const providers = new AgentProviderRegistry(), store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const executorOwner = new AgentMuxHostExecutorOwner({ path: join(root, 'executors.json'), runtimeId: 'native-history-owner', catalog: () => providers.catalog() })
  const executorId = 'history-original'
  const env = providerId === 'codex' ? { CODEX_HOME: home } : { CLAUDE_CONFIG_DIR: home }
  await executorOwner.configure({ executorId, config: { label: 'Original history Executor', providerId, command: process.execPath,
    args: [], env: { ...env, PRIVATE_SECRET: 'private-history-config' }, injectAgentMuxGuide: true } })
  const client = new AgentMuxClient({ store, hostExecutorOwner: executorOwner })
  cleanups.push(() => client.dispose())
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('Read must remain available without a Runtime handshake'))
  const kernel = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name as 'start'))
  const catalog = await client.listHostNativeAgentSessions({ executorId, workspacePath })
  expect(catalog.sessions).toHaveLength(1)
  const source: AgentNativeResumeSource = catalog.sessions[0]!.source
  expect(catalog.sessions[0]).not.toHaveProperty('managed')
  const ports: AgentMuxRpcServiceOptions = { coreClients: () => [{ hostId: 'local', client }] }
  if (aggregate) {
    ports.nativeAgentHistory = async (input, context) => {
      const { hostId, ...request } = input
      return { hostId, executorId: input.executorId, nativeSource: input.source,
        ...await client.readHostNativeAgentHistory({ ...request, ...(context?.signal ? { signal: context.signal } : {}) }) }
    }
    ports.nativeAgentHistoryResource = async (input, context) => {
      const { hostId, ...request } = input
      return { hostId, executorId: input.executorId, nativeSource: input.nativeSource,
        ...await client.readHostNativeAgentHistoryResource({ ...request, ...(context?.signal ? { signal: context.signal } : {}) }) }
    }
  }
  const server = new AgentMuxControlServer(ports, join(root, 'control.sock'))
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanups.push(() => rpc.dispose())
  const cli = (args: string[], input = '') => runCompiledObjectCli(['--endpoint', `unix:${server.path}`, ...args], objectCliEnvironment(root), input)
  const params = { hostId: 'local', executorId, source }
  const unchanged = async () => {
    expect(await loadAgentSessions(store)).toEqual([])
    expect(connect).not.toHaveBeenCalled()
    for (const control of controls) expect(control).not.toHaveBeenCalled()
  }
  return { root, source, params, client, store, rpc, cli, server, controls, message, transcriptPath, unchanged, records, executorOwner }
}

describe('saved native conversation history through its actual public reader', () => {
  it.each(['codex', 'claude'] as const)('pages exact %s file and stdin CLI details through the original Executor while Runtime is unavailable', async providerId => {
    const f = await fixture(providerId), params = { ...f.params, limit: 2 }, file = join(f.root, 'history.json')
    await writeFile(file, JSON.stringify(params))
    const firstOutput = await f.cli(['agent', 'native', 'history', '--input', file])
    expect(firstOutput.code, firstOutput.stdout + firstOutput.stderr).toBe(0)
    const first = await f.rpc.call('agent.native.history', params)
    expect(JSON.parse(firstOutput.stdout)).toMatchObject({ ok: true, result: first })
    expect(JSON.parse(firstOutput.stdout).result).toEqual(first)
    expect(first.nativeSource).toEqual(f.source)
    expect(first.source).toEqual({ providerId, nativeSessionId: nativeId })
    expect(first.items.map(item => [item.kind, item.contentParts])).toEqual([
      ['user-message', [{ kind: 'text', text: exact.latestUser }]], ['assistant-message', [{ kind: 'text', text: exact.latestAnswer }]]
    ])
    expect(first.nextCursor).toBeTypeOf('string')
    await appendFile(f.transcriptPath, jsonl([f.message('append-answer', 'assistant', exact.appended)]))
    const before = await readFile(f.transcriptPath)
    const next = { ...params, cursor: first.nextCursor! }, olderOutput = await f.cli(['agent', 'native', 'history', '--input', '-'], JSON.stringify(next))
    expect(olderOutput.code, olderOutput.stdout + olderOutput.stderr).toBe(0)
    const older = JSON.parse(olderOutput.stdout).result
    expect(older.items.map((item: { contentParts: unknown }) => item.contentParts)).toEqual([
      [{ kind: 'text', text: exact.priorUser }], [{ kind: 'text', text: exact.priorAnswer }]
    ])
    if (older.nextCursor !== null) {
      const tail = await f.rpc.call('agent.native.history', { ...params, cursor: older.nextCursor })
      expect(tail.items).toEqual([]); expect(tail.nextCursor).toBeNull()
    }
    const refreshed = await f.rpc.call('agent.native.history', params)
    expect(refreshed.items.at(-1)!.contentParts).toEqual([{ kind: 'text', text: exact.appended }])
    expect(await readFile(f.transcriptPath)).toEqual(before)
    expect(firstOutput.stdout).not.toContain('private-history-config')
    await f.unchanged()
    if (process.env.AMX_NATIVE_HISTORY_PUBLIC_RECEIPT) {
      const path = `${process.env.AMX_NATIVE_HISTORY_PUBLIC_RECEIPT}-${providerId}.json`
      await writeFile(path, JSON.stringify({ schema: 'agentmux.native-history-public-proof.v1', providerId,
        chain: 'compiled CLI → Unix public service → exact Host/Executor Core owner → original Provider history reader',
        providerInput: 'private persisted conversation through the original Provider saved JSONL reader',
        source: f.source, first, older, refreshed, nativeBytesSHA256: createHash('sha256').update(before).digest('hex'),
        sessionsCreated: 0, runControls: 0, runtimeConnections: 0 }, null, 2) + '\n')
    }
  })

  it('refuses wrong Host/Executor and replaced source files through the compiled CLI while preserving saved work', async () => {
    const f = await fixture(), inputFile = join(f.root, 'history.json')
    const otherHome = join(f.root, 'other-native-profile')
    await mkdir(join(otherHome, 'projects'), { recursive: true })
    await f.executorOwner.configure({ executorId: 'other-profile', config: { label: 'Different original profile', providerId: 'claude',
      command: process.execPath, args: [], env: { CLAUDE_CONFIG_DIR: otherHome }, injectAgentMuxGuide: true } })
    for (const [params, code] of [
      [{ ...f.params, hostId: 'other-host' }, 'UNKNOWN_HOST'], [{ ...f.params, executorId: 'other-executor' }, 'HOST_EXECUTOR_NOT_FOUND'],
      [{ ...f.params, executorId: 'other-profile' }, 'INVALID_AGENT_NATIVE_RESUME_SOURCE']
    ] as const) {
      await writeFile(inputFile, JSON.stringify(params))
      const output = await f.cli(['agent', 'native', 'history', '--input', inputFile])
      expect(output.code).not.toBe(0)
      expect(JSON.parse(output.stdout || output.stderr)).toMatchObject({ ok: false, error: { code } })
    }
    for (const source of [
      { ...f.source, workspacePath: join(f.root, 'other-workspace') },
      { ...f.source, nativeHandle: { ...f.source.nativeHandle, sessionId: 'other-native' } }
    ]) await expect(f.rpc.call('agent.native.history', { ...f.params, source })).rejects.toMatchObject({ code: 'AGENT_NATIVE_RESUME_SOURCE_CHANGED' })
    const savedPath = f.transcriptPath + '.original'
    await rename(f.transcriptPath, savedPath); await writeFile(f.transcriptPath, jsonl(f.records))
    const original = await readFile(savedPath), replacement = await readFile(f.transcriptPath)
    const output = await f.cli(['agent', 'native', 'history', '--input', '-'], JSON.stringify(f.params))
    expect(output.code).not.toBe(0)
    expect(JSON.parse(output.stdout || output.stderr)).toMatchObject({ ok: false, error: { code: 'AGENT_NATIVE_RESUME_SOURCE_CHANGED' } })
    expect(await readFile(savedPath)).toEqual(original); expect(await readFile(f.transcriptPath)).toEqual(replacement)
    await f.unchanged()
  })

  it.each([['page', false], ['resource', false], ['page', true], ['resource', true]] as const)(
    'cancels only the pending %s physical reader using the real transport signal (Host callback: %s)', async (kind, aggregate) => {
    const f = await fixture('claude', aggregate), entered = Promise.withResolvers<void>()
    let resourceInput
    if (kind === 'resource') {
      await appendFile(f.transcriptPath, jsonl([{ ...f.message('cancel-image', 'user', ''), message: { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } }
      ] } }]))
      const page = await f.rpc.call('agent.native.history', { ...f.params, limit: 1 }), part = page.items[0]!.contentParts[0]!
      if (part.kind !== 'resource') throw new Error('Missing cancel resource fixture')
      resourceInput = { hostId: f.params.hostId, executorId: f.params.executorId, nativeSource: f.source, source: page.source,
        recordId: page.items[0]!.id, partIndex: 0, expectedReference: part.reference }
    }
    const open = NativeJsonlHistoryReader.open.bind(NativeJsonlHistoryReader)
    let physicalSignal: AbortSignal | undefined
    vi.spyOn(NativeJsonlHistoryReader, 'open').mockImplementation(async (context, budget) => {
      physicalSignal = context.signal; entered.resolve()
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve()
        else context.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      return await open(context, budget)
    })
    const controller = new AbortController(), pending = resourceInput
      ? f.rpc.call('agent.native.history.resource', resourceInput, { signal: controller.signal })
      : f.rpc.call('agent.native.history', f.params, { signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
    await entered.promise
    expect(physicalSignal).toBeInstanceOf(AbortSignal); expect(physicalSignal!.aborted).toBe(false)
    controller.abort(); await rejected
    await vi.waitFor(() => expect(physicalSignal!.aborted).toBe(true))
    await f.unchanged()
  })

  it('strictly validates route, exact native resource and full Provider page at both public owner and client boundaries', async () => {
    const f = await fixture(), valid = await f.rpc.call('agent.native.history', { ...f.params, limit: 2 })
    const corruptions = [
      { ...valid, hostId: 'other' }, { ...valid, executorId: 'other' },
      { ...valid, nativeSource: { ...f.source, revision: 'f'.repeat(64) } },
      { ...valid, nativeSource: { ...f.source, workspacePath: join(f.root, 'other-workspace') } },
      { ...valid, nativeSource: { ...f.source, nativeHandle: { ...f.source.nativeHandle, transcriptPath: join(f.root, 'other.jsonl') } } },
      { ...valid, source: { ...valid.source, providerId: 'other' } }, { ...valid, source: { ...valid.source, nativeSessionId: 'other' } },
      { ...valid, items: [{ ...valid.items[0], privateField: 'secret' }] },
      { ...valid, items: [{ ...valid.items[0], contentParts: [{ kind: 'text', text: 'valid', env: {} }] }] },
      { ...valid, sourceSizeBytes: -1 }, { ...valid, nextCursor: '' }, { ...valid, agentSessionId: 'invented-core-session' }
    ]
    for (const bad of corruptions) {
      expect(() => parseRpcNativeResult('agent.native.history', bad, { ...f.params, limit: 2 })).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
      const malformedOwner = new AgentMuxRpcService({ nativeAgentHistory: async () => bad as never })
      await expect(malformedOwner.call('agent.native.history', { ...f.params, limit: 2 })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    }
    await f.unchanged()
  })

  it('rejects JSON authority overrides and malformed paging, and registers discovery/help with the real CLI parser', async () => {
    const f = await fixture(), path = join(f.root, 'input.json')
    for (const extra of [{ signal: 'forged' }, { env: {} }, { agentSessionId: 'invented' }, { prompt: 'send' }]) {
      await expect(f.rpc.call('agent.native.history', { ...f.params, ...extra } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
      await writeFile(path, JSON.stringify({ ...f.params, ...extra }))
      await expect(parseAgentMuxCliInvocation(['agent', 'native', 'history', '--input', path])).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    }
    for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: null }, { cursor: '' }]) {
      expect(() => parseNativeHistoryParams({ ...f.params, ...options })).toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_SESSION_HISTORY_OPTIONS' }))
    }
    await writeFile(path, JSON.stringify({ ...f.params, limit: 2 }))
    const parsed = await parseAgentMuxCliInvocation(['agent', 'native', 'history', '--input', path])
    expect(parsed.command.method).toBe('agent.native.history'); expect(parsed.params).toEqual({ ...f.params, limit: 2 })
    expect(agentMuxCommandHelp('agent.native.history')).toContain('nextCursor')
    expect(agentMuxCommandHelp('agent.native')).toContain('amux agent native history --input FILE|-')
    expect(AGENTMUX_CLI_SKILL).toContain('Reading and cancellation operate no Session or Run.')
    for (const command of [['agent', 'native', 'history'], ['agent', 'native', 'history', 'resource']]) {
      const help = await f.cli([...command, '--help'])
      expect(help.code, help.stderr).toBe(0)
      expect(help.stdout).toContain('--input FILE|-')
    }
    await f.unchanged()
  })

  it('reads complete text fragments and recorded image bytes through the compiled resource CLI without a Session', async () => {
    const f = await fixture(), text = 'Original 中文🙂 "quoted" \\ slash\n'.repeat(80_000)
    const record = { ...f.message('resource-asset', 'user', ''), message: { role: 'user', content: [
      { type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } }
    ] } }
    await appendFile(f.transcriptPath, jsonl([record]))
    const before = await readFile(f.transcriptPath), page = await f.rpc.call('agent.native.history', { ...f.params, limit: 1 })
    const item = page.items[0]!, part = item.contentParts[0]!
    expect(item.id).toBe('resource-asset')
    expect(part).toMatchObject({ kind: 'resource', resourceType: 'text', content: { kind: 'text', encoding: 'json-utf8' } })
    if (part.kind !== 'resource' || !part.content) throw new Error('Missing full text resource metadata')
    const chunks: Buffer[] = []
    let offsetBytes = 0, expectedReference = part.reference
    while (offsetBytes < part.content.byteLength) {
      const input = { hostId: f.params.hostId, executorId: f.params.executorId, nativeSource: f.source, source: page.source,
        recordId: item.id, partIndex: 0, expectedReference, offsetBytes, maxBytes: 131_072,
        ...(item.turnId === undefined ? {} : { turnId: item.turnId }) }
      const output = await f.cli(['agent', 'native', 'history', 'resource', '--input', '-'], JSON.stringify(input))
      expect(output.code, output.stdout + output.stderr).toBe(0)
      const receipt = JSON.parse(output.stdout).result
      expect(receipt).not.toHaveProperty('agentSessionId'); expect(receipt.nativeSource).toEqual(f.source)
      expect(receipt.result).toMatchObject({ status: 'fragment', offsetBytes, totalBytes: part.content.byteLength, sha256: part.content.sha256 })
      const bytes = Buffer.from(receipt.result.dataBase64, 'base64')
      chunks.push(bytes); offsetBytes += bytes.length
      expect(receipt.result.nextOffsetBytes).toBe(offsetBytes === part.content.byteLength ? null : offsetBytes)
      expectedReference = receipt.result.continuationReference ?? expectedReference
    }
    const content = Buffer.concat(chunks)
    expect(createHash('sha256').update(content).digest('hex')).toBe(part.content.sha256)
    expect(JSON.parse(content.toString('utf8'))).toEqual({ kind: 'text', text })
    const imagePart = item.contentParts[1]!
    expect(imagePart).toMatchObject({ kind: 'resource', resourceType: 'image' })
    if (imagePart.kind !== 'resource') throw new Error('Missing recorded image')
    const input = { hostId: f.params.hostId, executorId: f.params.executorId, nativeSource: f.source, source: page.source,
      recordId: item.id, partIndex: 1, expectedReference: imagePart.reference }, inputFile = join(f.root, 'resource.json')
    await writeFile(inputFile, JSON.stringify(input))
    const output = await f.cli(['agent', 'native', 'history', 'resource', '--input', inputFile])
    expect(output.code, output.stdout + output.stderr).toBe(0)
    const receipt = JSON.parse(output.stdout).result
    expect(receipt.result).toEqual({ status: 'read', mimeType: 'image/png', dataBase64: image.toString('base64'), byteLength: image.length })
    await expect(f.rpc.call('agent.native.history.resource', { ...input, expectedReference: join(f.root, 'arbitrary.png') }))
      .rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_RESOURCE_MISMATCH' })
    expect(await readFile(f.transcriptPath)).toEqual(before)
    await f.unchanged()
    if (process.env.AMX_NATIVE_HISTORY_PUBLIC_RECEIPT) await writeFile(`${process.env.AMX_NATIVE_HISTORY_PUBLIC_RECEIPT}-resource.json`, JSON.stringify({
      schema: 'agentmux.native-history-public-resource-proof.v1', providerId: 'claude', source: f.source,
      chain: 'compiled resource CLI → Unix service → exact Executor Core owner → real Provider-recorded JSONL resource',
      textBytes: content.length, textSHA256: part.content.sha256, originalTextSHA256: createHash('sha256').update(text).digest('hex'),
      image: receipt, sessionsCreated: 0, runControls: 0, arbitraryPathRefused: true }, null, 2) + '\n')
  })

  it('validates exact resource receipts and rejects authority overrides before the original reader', async () => {
    const f = await fixture()
    await appendFile(f.transcriptPath, jsonl([{ ...f.message('image-resource', 'user', ''), message: { role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } }
    ] } }]))
    const page = await f.rpc.call('agent.native.history', { ...f.params, limit: 1 }), item = page.items[0]!, part = item.contentParts[0]!
    if (part.kind !== 'resource') throw new Error('Missing resource fixture')
    const input = { hostId: f.params.hostId, executorId: f.params.executorId, nativeSource: f.source, source: page.source,
      recordId: item.id, partIndex: 0, expectedReference: part.reference }
    const reading = f.rpc.call('agent.native.history.resource', input)
    await expect(reading).resolves.toMatchObject({ nativeSource: f.source, source: page.source,
      recordId: item.id, partIndex: 0, result: { status: 'read', byteLength: image.length } })
    const valid = await reading
    for (const bad of [
      { ...valid, hostId: 'other' }, { ...valid, executorId: 'other' },
      { ...valid, nativeSource: { ...f.source, revision: 'f'.repeat(64) } },
      { ...valid, source: { ...valid.source, nativeSessionId: 'other' } }, { ...valid, recordId: 'other' },
      { ...valid, partIndex: 1 }, { ...valid, reference: 'other' }, { ...valid, turnId: 'invented' },
      { ...valid, result: { ...valid.result, byteLength: image.length - 1 } }, { ...valid, agentSessionId: 'invented' }
    ]) {
      expect(() => parseRpcNativeResult('agent.native.history.resource', bad, input)).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
      const service = new AgentMuxRpcService({ nativeAgentHistoryResource: async () => bad as never })
      await expect(service.call('agent.native.history.resource', input)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    }
    for (const extra of [{ signal: 'forged' }, { env: {} }, { commandOverride: 'arbitrary' }, { agentSessionId: 'invented' }]) {
      expect(() => parseNativeHistoryResourceParams({ ...input, ...extra })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
      await expect(f.rpc.call('agent.native.history.resource', { ...input, ...extra } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    }
    expect(() => parseNativeHistoryResourceParams({ ...input, source: { ...input.source, nativeSessionId: 'other' } }))
      .toThrowError(expect.objectContaining({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' }))
    expect(agentMuxCommandHelp('agent.native.history.resource')).toContain('reference grants no arbitrary path access')
    await f.unchanged()
  })
})
