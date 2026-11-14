import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { build, type Plugin } from 'esbuild'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { appendFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { ObjectCliProbe } from './helpers/object-cli-rpc.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { agentLifecycleOperationIdentity, cloneSession } from '../src/agent-session-identity.js'
import { normalizeAgentSession, normalizeAgentInteractionRequest } from '../src/agent-session-codec.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const closes: Array<() => Promise<unknown>> = []
const evidence = async (value: object) => { if (process.env.SESSION_CODEC_FACTS) await appendFile(process.env.SESSION_CODEC_FACTS, JSON.stringify(value) + '\n') }
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
let browserCode: string
beforeAll(async () => {
  const entry = fileURLToPath(new URL('../src/hosted.ts', import.meta.url))
  const inspection = fileURLToPath(new URL('../src/agent-creation-inspection.ts', import.meta.url))
  const overlay = process.env.SESSION_CODEC_OVERLAY
    ? await import(/* @vite-ignore */ process.env.SESSION_CODEC_OVERLAY) : undefined
  const plugins: Plugin[] = overlay ? [overlay.esbuildOverlay()] : []
  const bundle = await build({ stdin: { contents: `export { connectHostedAgentMux } from ${JSON.stringify(entry)}; export { parseCreationInspection } from ${JSON.stringify(inspection)}`,
    resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'browser', target: 'es2022', format: 'iife', globalName: 'SessionBrowser',
    write: false, metafile: true, plugins, logLevel: 'silent' })
  expect(Object.values(bundle.metafile!.outputs).flatMap(output => output.imports)).toEqual([])
  expect(Object.keys(bundle.metafile!.inputs).some(input => input.startsWith('node:'))).toBe(false)
  browserCode = bundle.outputFiles![0]!.text
  await evidence({ scenario: 'actual-hosted-browser-module', sha256: createHash('sha256').update(browserCode).digest('hex'), inputs: Object.keys(bundle.metafile!.inputs), nodeShims: false })
})
function browser(bridge?: (method: string, params: string) => Promise<string>) {
  const context = vm.createContext({ TextEncoder, TextDecoder, AbortController, AbortSignal, setTimeout, clearTimeout, crypto: globalThis.crypto, bridge })
  // Wire values are JSON DTOs. Clone inside the browser realm, preserving its ordinary prototypes.
  vm.runInContext('globalThis.structuredClone = value => JSON.parse(JSON.stringify(value))', context)
  vm.runInContext(browserCode, context)
  expect(vm.runInContext('typeof Buffer + ":" + typeof process', context)).toBe('undefined:undefined')
  return context
}
function original(): AgentMuxStoredAgentSession {
  const agentSessionId = 'original-session', run = { runId: 'original-run' }, createOperationId = 'original-create'
  return { kind: 'agent', agentSessionId, providerId: 'codex', executorId: 'original-executor', hostId: 'local',
    workspacePath: fileURLToPath(new URL('.', import.meta.url)), run, retiredRuns: [], createdAt: 1, updatedAt: 1,
    hookBindingId: 'private-binding', hookToken: 'private-token', creation: { createOperationId, initialPrompt: 'unknown', createdRun: run,
      resolution: { operationId: 'explicit-resolution', createOperationId, agentSessionId,
        originalCreationKey: agentLifecycleOperationIdentity('create', agentSessionId, createOperationId), runtimeId: 'original-runtime', admittedAt: 1,
        source: { kind: 'prepared-dispatch' }, historicalEffect: 'unknown', initialInputContinuation: 'held', outcome: 'retained', retainedRun: run } } }
}
function readInBrowser(context: vm.Context, value: unknown): unknown {
  context.wire = JSON.stringify(value)
  return vm.runInContext('SessionBrowser.parseCreationInspection(JSON.parse(wire))', context)
}
it('decodes active, retired, prepared and closed original creations without Node globals', () => {
  const context = browser(), stored = original(), active = cloneSession(stored)
  expect(JSON.parse(JSON.stringify(readInBrowser(context, active)))).toEqual(active)
  const history = { providerId: stored.providerId, executorId: stored.executorId, workspacePath: stored.workspacePath, createdAt: stored.createdAt, creation: stored.creation }
  const retired = { kind: 'retired-agent', agentSessionId: stored.agentSessionId, hostId: 'local', run: stored.run, source: 'user', observedAt: 1, history }
  expect(JSON.parse(JSON.stringify(readInBrowser(context, retired)))).toEqual(retired)
  const creation = { createOperationId: 'original-create', initialPrompt: 'unknown' }
  const base = { agentSessionId: stored.agentSessionId, providerId: stored.providerId, executorId: stored.executorId, hostId: 'local', workspacePath: stored.workspacePath, creation }
  expect(readInBrowser(context, { kind: 'prepared-agent-creation', ...base })).toMatchObject({ kind: 'prepared-agent-creation' })
  const resolution = { ...stored.creation!.resolution!, outcome: 'fenced' }; delete (resolution as { retainedRun?: unknown }).retainedRun
  expect(readInBrowser(context, { kind: 'closed-agent-creation', ...base, resolution })).toMatchObject({ kind: 'closed-agent-creation' })
})
it.each(['private-field', 'activity-extra', 'activity-run', 'creation-key'] as const)('the real browser decoder refuses %s', shape => {
  const context = browser(), value = cloneSession(original()) as unknown as Record<string, unknown>
  if (shape === 'private-field') value.hookToken = 'must-not-be-public'
  else if (shape === 'creation-key') (value.creation as NonNullable<AgentMuxStoredAgentSession['creation']>).resolution!.originalCreationKey = 'foreign-key'
  else {
    value.nativeHandle = { kind: 'provider', providerId: 'codex', sessionId: 'original-native' }
    value.currentActivity = { state: 'idle', source: 'native-hook', run: { runId: shape === 'activity-run' ? 'foreign-run' : 'original-run' },
      nativeSessionId: 'original-native', nativeTurnId: 'original-turn', sourceId: 'original-source', sequence: 1, hookReceiptId: 'original-hook', observedAt: 1,
      ...(shape === 'activity-extra' ? { unauthorized: true } : {}) }
  }
  expect(() => readInBrowser(context, value)).toThrow()
})
it('preserves original lifecycle digest and UTF-8 field boundaries', () => {
  for (const kind of ['create', 'resume', 'stop', 'reopen', 'restart'] as const) {
    const expected = createHash('sha256').update(JSON.stringify(['agentmux-agent-lifecycle-v1', kind, '原Session', '原操作\ud800'])).digest('base64url')
    expect(agentLifecycleOperationIdentity(kind, '原Session', '原操作\ud800')).toBe(expected)
  }
  for (const id of ['界'.repeat(170) + 'aa', 'x'.repeat(509) + '\ud800']) {
    expect(Buffer.byteLength(id)).toBe(512)
    expect(normalizeAgentSession({ ...original(), agentSessionId: id, creation: undefined }).agentSessionId).toBe(id)
    expect(() => normalizeAgentSession({ ...original(), agentSessionId: id + 'a', creation: undefined })).toThrow()
  }
})
it('checks original permission response digest bytes rather than trusting a copied response', () => {
  const response = { kind: 'permission', requestId: 'original-permission', decision: { outcome: 'selected', optionId: 'allow' } }
  const request = { kind: 'permission', id: 'original-permission', agentSessionId: 'original-session', title: 'Original permission',
    options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' }], evidence: { source: 'native-hook', run: { runId: 'original-run' }, observedAt: 1, hookReceiptId: 'original-permission' },
    permissionHook: { receiptId: 'original-permission', response: { operationId: 'original-response', value: response,
      responseDigest: createHash('sha256').update(JSON.stringify(response)).digest('base64url'), delivery: 'saved' } } }
  expect(normalizeAgentInteractionRequest(request)).toMatchObject({ permissionHook: { response: { operationId: 'original-response' } } })
  const pending = { request, response: { value: response,
    responseDigest: request.permissionHook.response.responseDigest, operationId: 'original-response',
    acknowledged: false, inputByteRange: { startByte: 0, endByte: 1 } } }
  expect(normalizeAgentSession({ ...original(), pendingInteraction: pending })).toMatchObject({ pendingInteraction: { response: { acknowledged: false } } })
  pending.response.responseDigest = 'foreign-digest'
  expect(() => normalizeAgentSession({ ...original(), pendingInteraction: pending })).toThrow()
  request.permissionHook.response.responseDigest = 'foreign-digest'
  expect(() => normalizeAgentInteractionRequest(request)).toThrow()
})
it('uses actual FileStore, Host SDK browser creation inspection and public source CLI on the original identity', async () => {
  const h = await rpcOwnerFixture(['original-session']); const root = h.root
  closes.push(async () => { await h.close(); await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' }); await evidence({ scenario: 'private-fixture-cleanup', root, absent: true }) })
  const previous = (await h.store.readMetadata('original-session'))!, stored = { ...original(), workspacePath: root }
  await h.store.compareAndSwap(previous, stored); await h.inner.registry.load('local')
  const cold = new AgentMuxFileAgentSessionStore(h.store.path)
  expect((await cold.readMetadata(stored.agentSessionId))?.creation).toEqual(stored.creation)
  const service = new AgentMuxHostedRuntimeService(h.client, null, () => hostedTestOwner(h.client)); closes.push(() => service.dispose())
  const methods: string[] = [], context = browser(async (method, params) => { methods.push(method); return JSON.stringify(await service.call(method, JSON.parse(params))) })
  const sdk = await vm.runInContext(`SessionBrowser.connectHostedAgentMux({connectOnDemand:true,consumerId:'original-browser',rpc:{call:async(method,params)=>JSON.parse(await bridge(method,JSON.stringify(params))),subscribe:async()=>{throw Error('No background observation is needed')}}})`, context)
  closes.push(() => sdk.dispose()); expect(JSON.parse(JSON.stringify(await sdk.inspectAgentCreation(stored.agentSessionId)))).toEqual(cloneSession(stored))
  expect(methods).toEqual(['runtime.owner.identity', 'runtime.invoke'])
  const rpc = new AgentMuxRpcService({ coreClients: h.coreClients }); closes.push(() => rpc.dispose())
  const probe = new ObjectCliProbe(request => rpc.call(request.method as never, request.params as never)); await probe.start(); closes.push(() => probe.stop())
  const loader = process.env.SESSION_CODEC_LOADER ? new URL(process.env.SESSION_CODEC_LOADER) : undefined
  const result = await runSourceObjectCli(['agent', 'creation', 'inspect', '--host', 'local', '--operation-id', 'original-create', '--session', stored.agentSessionId], probe.environment(), '', 15000, loader)
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({ result: { hostId: 'local', inspection: { kind: 'agent', agentSessionId: stored.agentSessionId, run: stored.run } } })
  expect(h.rawInput).not.toHaveBeenCalled(); expect((await h.store.readMetadata(stored.agentSessionId))?.creation).toEqual(stored.creation)
  await evidence({ scenario: 'actual-file-sdk-source-cli', root, methods, cliMethods: probe.requests.map(request => request.method), agentSessionId: stored.agentSessionId, run: stored.run, inputWrites: h.rawInput.mock.calls.length })
})
