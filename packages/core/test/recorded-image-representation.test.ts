import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeHistoryFixture, jsonl } from './fixtures/native-history-session.js'
import { recordedRaster } from './helpers/recorded-raster.js'
import { readSessionHistoryTextResource } from '../src/session-history-content.js'

import * as nativeSource from '../src/native-history-source.js'
import { loadAgentSessions } from '../src/agent-session-store.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it('the same original signed image part retains complete JSON and explicitly returns its exact raster', async () => {
  const image = recordedRaster()
  expect(image.reference.length).toBeGreaterThan(2 * 1024 * 1024)
  const f = await nativeHistoryFixture('claude', jsonl([{ sessionId: 'native-main', uuid: 'deferred-original-raster', type: 'assistant', message: { role: 'assistant', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.bytes.toString('base64') } }
  ] } }])); closes.push(f.close)
  const page = await f.client.sessionHistoryPage('private-agent', { limit: 10 }), part = page.items[0]!.contentParts[0]!
  expect(part).toMatchObject({ kind: 'resource', resourceType: 'text', content: { kind: 'resource', encoding: 'json-utf8' } })
  if (part.kind !== 'resource') throw new Error('Original deferred resource required')
  const input = { source: page.source, recordId: page.items[0]!.id, partIndex: 0, expectedReference: part.reference }
  expect((await f.client.sessionHistoryResource('private-agent', { ...input, maxBytes: 128 * 1024 })).result).toMatchObject({ status: 'fragment', encoding: 'json-utf8', offsetBytes: 0 })
  expect(await readSessionHistoryTextResource(part, 0, input, request => f.client.sessionHistoryResource('private-agent', request))).toMatchObject({ kind: 'resource', resourceType: 'image', reference: image.reference })
  const request = { ...input, representation: 'image' as const }
  const response = await f.client.sessionHistoryResource('private-agent', request).catch(error => ({ code: error.code }))
  expect(response).toHaveProperty('result.status', 'read')
  expect(response).toMatchObject({ reference: part.reference, result: { mimeType: 'image/png', byteLength: image.bytes.length, width: image.width, height: image.height } })
  if (!('result' in response) || response.result.status !== 'read') throw new Error('Original raster read required')
  expect(Buffer.from(response.result.dataBase64, 'base64')).toEqual(image.bytes)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}, 30_000)

async function deferred(options: { role?: 'user' | 'assistant'; private?: boolean } = {}) {
  const image = recordedRaster(), role = options.role ?? 'assistant'
  const f = await nativeHistoryFixture('claude', jsonl([{ sessionId: 'native-main', uuid: 'exact-raster', type: role,
    ...(options.private ? { isCompactSummary: true } : {}), message: { role, content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.bytes.toString('base64') } }
    ] } }])); closes.push(f.close)
  const page = await f.client.sessionHistoryPage('private-agent', { limit: 10 }), part = page.items[0]!.contentParts[0]!
  if (part.kind !== 'resource' || !part.content) throw new Error('Original deferred resource required')
  return { ...f, image, part, input: { source: page.source, recordId: page.items[0]!.id, partIndex: 0, expectedReference: part.reference, representation: 'image' as const } }
}

it.each([{ role: 'user' as const, purpose: 'unconfirmed' }, { private: true, purpose: 'private' }])('local raster reading retains $purpose original content without sharing authorization', async options => {
  const f = await deferred(options)
  expect(f.part.contentEligibility).toBe(options.purpose)
  const receipt = await f.client.sessionHistoryResource('private-agent', f.input)
  expect(receipt.result.status).toBe('read')
  if (receipt.result.status !== 'read') throw new Error('Original local raster required')
  expect(Buffer.from(receipt.result.dataBase64, 'base64')).toEqual(f.image.bytes)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}, 30_000)

it('bounds decoded bytes and rejects wrong original identity, forged authority, changed source and cancelled reads', async () => {
  const f = await deferred()
  expect((await f.client.sessionHistoryResource('private-agent', { ...f.input, maxBytes: f.image.bytes.length - 1 })).result).toMatchObject({ status: 'unavailable', code: 'AGENT_SESSION_HISTORY_RESOURCE_TOO_LARGE' })
  for (const patch of [{ source: { ...f.input.source, nativeSessionId: 'foreign' } }, { recordId: 'foreign' }, { partIndex: 1 }, { turnId: 'foreign' }, { expectedReference: (() => { const separator = f.part.reference.lastIndexOf('.'), bytes = Buffer.from(f.part.reference.slice(separator + 1), 'base64url'); bytes[0] = bytes[0]! ^ 1; return f.part.reference.slice(0, separator + 1) + bytes.toString('base64url') })() }])
    await expect(f.client.sessionHistoryResource('private-agent', { ...f.input, ...patch })).rejects.toHaveProperty('code')
  const { readNativeContentResource } = await import('../src/native-history-content.js')
  await expect(readNativeContentResource({ agentSessionId: 'another-agent', source: f.input.source, contentSigningSecret: f.session.hookToken,
    transcriptPath: f.path, workspacePath: f.root, command: 'unused', args: [], env: {}, signal: new AbortController().signal }, f.input)).rejects.toHaveProperty('code', 'AGENT_SESSION_HISTORY_RESOURCE_MISMATCH')
  const cancel = new AbortController(); cancel.abort(new Error('Only this image reader cancelled'))
  await expect(f.client.sessionHistoryResource('private-agent', { ...f.input, signal: cancel.signal })).rejects.toThrow('Only this image reader cancelled')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(f.path, f.before.native.toString().replace('exact-raster', 'other-raster'))
  await expect(f.client.sessionHistoryResource('private-agent', f.input)).rejects.toHaveProperty('code', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')
  expect((await loadAgentSessions(f.store))[0]!.run).toEqual(f.session.run)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}, 30_000)

it('renews only the same signed extent with an exact original Provider record while preserving the outer reference', async () => {
  const f = await deferred(), provider = f.client.providers.get('claude')
  const exact = vi.spyOn(provider, 'readSessionHistoryRecord'), page = vi.spyOn(provider, 'readSessionHistoryPage')
  const current = (await loadAgentSessions(f.store))[0]!
  await f.store.compareAndSwap(current, { ...current, hookToken: 'fresh-original-authority', updatedAt: fixtureEpoch(0, 0, 2) })
  expect((await loadAgentSessions(f.store))[0]!.hookToken).toBe('fresh-original-authority')
  const receipt = await f.client.sessionHistoryResource('private-agent', f.input)
  expect(receipt.reference).toBe(f.part.reference); expect(receipt.result.status).toBe('read')
  expect(exact).toHaveBeenCalledTimes(1); expect(page).not.toHaveBeenCalled()
  if (receipt.result.status !== 'read') throw new Error('Renewed exact raster required')
  expect(Buffer.from(receipt.result.dataBase64, 'base64')).toEqual(f.image.bytes)
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}, 30_000)

it('requires explicit image intent without an offset and rejects a fragment response for that intent', async () => {
  const f = await deferred()
  const { parseSessionHistoryResourceParams, parseSessionHistoryResourceReadResult } = await import('../src/session-history-resource.js')
  const request = { hostId: 'local', agentSessionId: 'private-agent', ...f.input }
  expect(parseSessionHistoryResourceParams(request)).toEqual(request)
  for (const patch of [{ offsetBytes: 0 }, { representation: 'text' }, { representation: null }, { maxBytes: 16 * 1024 * 1024 + 1 }])
    expect(() => parseSessionHistoryResourceParams({ ...request, ...patch })).toThrow()
  const { representation: _representation, ...original } = f.input
  const fragment = await f.client.sessionHistoryResource('private-agent', { ...original, maxBytes: 128 * 1024 })
  expect(fragment.result.status).toBe('fragment')
  expect(parseSessionHistoryResourceReadResult(fragment, 'private-agent', { ...original, maxBytes: 128 * 1024 })).toEqual(fragment)
  expect(() => parseSessionHistoryResourceReadResult(fragment, 'private-agent', f.input)).toThrow()
  const raster = await f.client.sessionHistoryResource('private-agent', f.input)
  expect(parseSessionHistoryResourceReadResult(raster, 'private-agent', f.input).result.status).toBe('read')
  expect(() => parseSessionHistoryResourceReadResult({ ...raster, reference: 'foreign' }, 'private-agent', f.input)).toThrow()
}, 30_000)

it('carries explicit raster intent through the actual RPC, Hosted SDK and both compiled resource commands', async () => {
  const { join } = await import('node:path')
  const { writeFile } = await import('node:fs/promises')
  const { AgentMuxClient } = await import('../src/client.js')
  const { AgentMuxHostExecutorOwner } = await import('../src/executor-owner.js')
  const { AgentMuxControlServer } = await import('../src/public-rpc-server.js')
  const { connectAgentMuxRpc } = await import('../src/public-rpc-client.js')
  const { AgentMuxHostedRuntimeService } = await import('../src/hosted-runtime-service.js')
  const { connectHostedAgentMux } = await import('../src/hosted-client.js')
  const { decodeHostedValue, encodeHostedValue } = await import('../src/hosted-value.js')
  const { objectCliEnvironment, runCompiledObjectCli } = await import('./helpers/object-cli-rpc.js')
  const image = recordedRaster()
  const f = await nativeHistoryFixture('claude', root => jsonl([{ sessionId: 'native-main', uuid: 'public-original-raster', cwd: root, isSidechain: false,
    type: 'assistant', message: { role: 'assistant', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.bytes.toString('base64') } }] } }]),
  { relativePath: 'provider/projects/original/native-main.jsonl' }); closes.push(f.close)
  const executorOwner = new AgentMuxHostExecutorOwner({ path: join(f.root, 'executors.json'), runtimeId: 'raster-native-owner', catalog: () => f.client.providers.catalog() })
  await executorOwner.configure({ executorId: 'original-raster-executor', config: { label: 'Original raster', providerId: 'claude', command: process.execPath, args: [], env: { CLAUDE_CONFIG_DIR: join(f.root, 'provider') }, injectAgentMuxGuide: true } })
  const client = new AgentMuxClient({ store: f.store, hostExecutorOwner: executorOwner }); closes.push(() => client.dispose())
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('Raster read cannot connect Runtime'))
  const identity = { hostId: 'local', buildIdentity: 'raster-fixture', protocolVersion: 1, processId: null, instanceId: 'raster-context-owner', ownership: 'unverified' as const }
  vi.spyOn(client, 'runtimeIdentity').mockReturnValue(identity)
  let owner = 'original-raster-runtime'
  const runtime = new AgentMuxHostedRuntimeService(client, null, () => ({ runtimeId: 'raster-runtime', ownerInstanceId: owner, protocolVersion: 2, processId: process.pid, ctxmux: identity, availability: 'unverified' })); closes.push(() => runtime.dispose())
  const server = new AgentMuxControlServer({ coreClients: () => [{ hostId: 'local', client }], hostedRuntime: () => runtime }, join(f.root, 'raster.sock')); await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const managedPage = await client.sessionHistoryPage('private-agent', { limit: 10 }), managedPart = managedPage.items[0]!.contentParts[0]!
  if (managedPart.kind !== 'resource') throw new Error('Original managed part required')
  const input = { source: managedPage.source, recordId: 'public-original-raster', partIndex: 0, expectedReference: managedPart.reference, representation: 'image' as const }
  const managed = { hostId: 'local', agentSessionId: 'private-agent', ...input }
  const receipt = await rpc.call('agent.history.resource', managed)
  expect(receipt).toMatchObject({ reference: managedPart.reference, result: { status: 'read', byteLength: image.bytes.length, width: image.width, height: image.height } })
  if (receipt.result.status !== 'read') throw new Error('Original RPC raster required')
  expect(Buffer.from(receipt.result.dataBase64, 'base64')).toEqual(image.bytes)
  const catalog = await client.listHostNativeAgentSessions({ executorId: 'original-raster-executor', workspacePath: f.root })
  expect(catalog.sessions).toHaveLength(1)
  const nativeSource = catalog.sessions[0]!.source
  const nativePage = await rpc.call('agent.native.history', { hostId: 'local', executorId: 'original-raster-executor', source: nativeSource, limit: 10 })
  const nativePart = nativePage.items[0]!.contentParts[0]!
  if (nativePart.kind !== 'resource') throw new Error('Original native part required')
  const native = { hostId: 'local', executorId: 'original-raster-executor', nativeSource, source: nativePage.source, recordId: 'public-original-raster', partIndex: 0, expectedReference: nativePart.reference, representation: 'image' as const }
  expect((await rpc.call('agent.native.history.resource', native)).result.status).toBe('read')
  for (const [method, request] of [['history', managed], ['native', native]] as const) {
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'agent', ...(method === 'native' ? ['native', 'history'] : ['history']), 'resource', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(request))
    expect(output.code, output.stderr).toBe(0)
    const result = JSON.parse(output.stdout).result
    expect(result.reference).toBe(request.expectedReference); expect(result.result.status).toBe('read')
    expect(Buffer.from(result.result.dataBase64, 'base64')).toEqual(image.bytes)
    const help = await runCompiledObjectCli(['agent', ...(method === 'native' ? ['native', 'history'] : ['history']), 'resource', '--help'], objectCliEnvironment(f.root))
    expect(help.code).toBe(0); expect(help.stdout).toContain('representation: image'); expect(help.stdout).toContain('offsetBytes')
  }
  const skill = await runCompiledObjectCli(['agent', '--skill'], objectCliEnvironment(f.root))
  expect(skill.code).toBe(0); expect(skill.stdout).toContain('representation: image')
  let projectionCompleted!: () => void
  const initialProjection = new Promise<void>(resolve => { projectionCompleted = resolve }); let corrupt = false
  const port = { call: async (...args: Parameters<typeof rpc.call>) => {
    const pending = rpc.call(...args)
    if (args[0] === 'runtime.invoke' && (args[1] as { invocation?: { method?: string } }).invocation?.method === 'runtimeProjection') void pending.then(() => projectionCompleted(), () => projectionCompleted())
    const response = await pending
    if (corrupt && args[0] === 'runtime.invoke') {
      const value = decodeHostedValue((response as { value: unknown }).value) as Record<string, unknown>
      return { value: encodeHostedValue({ ...value, reference: 'another-original' }) }
    }
    return response
  }, subscribe: rpc.subscribe.bind(rpc) }
  const hosted = await connectHostedAgentMux({ rpc: port as Parameters<typeof connectHostedAgentMux>[0]['rpc'], consumerId: 'raster-reader' }); closes.push(() => hosted.dispose())
  await initialProjection; expect(connect).toHaveBeenCalledTimes(1); connect.mockClear()
  const hostedRead = await hosted.sessionHistoryResource('private-agent', input)
  expect(hostedRead.reference).toBe(input.expectedReference); expect(hostedRead.result.status).toBe('read')
  corrupt = true
  await expect(hosted.sessionHistoryResource('private-agent', input)).rejects.toHaveProperty('code', 'CONTROL_PROTOCOL_ERROR')
  corrupt = false
  const provider = client.providers.get('claude'), record = provider.readSessionHistoryRecord!.bind(provider)
  provider.readSessionHistoryRecord = async context => { const item = await record(context); owner = 'changed-raster-runtime'; return item }
  // Renewal forces the exact original lookup; an owner change during that read is fenced by Hosted.
  const current = (await loadAgentSessions(f.store))[0]!
  await f.store.compareAndSwap(current, { ...current, hookToken: 'renew-public-authority', updatedAt: fixtureEpoch(0, 0, 2) })
  await expect(hosted.sessionHistoryResource('private-agent', input)).rejects.toHaveProperty('code', 'RUNTIME_OWNER_CHANGED')
  expect(connect).not.toHaveBeenCalled()
  expect((await loadAgentSessions(f.store))[0]!.run).toEqual(f.session.run)
  await writeFile(join(f.root, 'public-proof.json'), JSON.stringify({ source: nativePage.source, bytes: image.bytes.length, managedReference: receipt.reference, nativeReference: nativePart.reference }))
}, 60_000)

it('rejects an over-budget signed envelope before accumulating it and leaves the original JSON fragment available', async () => {
  const image = recordedRaster(2600)
  const f = await nativeHistoryFixture('claude', jsonl([{ sessionId: 'native-main', uuid: 'bounded-original-envelope', type: 'assistant', message: { role: 'assistant', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.bytes.toString('base64') } }
  ] } }])); closes.push(f.close)
  const page = await f.client.sessionHistoryPage('private-agent', { limit: 10 }), part = page.items[0]!.contentParts[0]!
  if (part.kind !== 'resource' || !part.content) throw new Error('Original signed envelope required')
  expect(part.content.byteLength).toBeGreaterThan(6 * 4 * 1024 * 1024 + 4)
  const input = { source: page.source, recordId: page.items[0]!.id, partIndex: 0, expectedReference: part.reference }
  const originalRead = nativeSource.nativeRangeBytes; let imagePhase = true
  const reads = vi.spyOn(nativeSource, 'nativeRangeBytes').mockImplementation((...args) => {
    if (imagePhase) throw new Error('An oversized image envelope must not be accumulated')
    return originalRead(...args)
  })
  const result = await f.client.sessionHistoryResource('private-agent', { ...input, representation: 'image', maxBytes: 1 })
  expect(result.result).toMatchObject({ status: 'unavailable', code: 'AGENT_SESSION_HISTORY_RESOURCE_TOO_LARGE' })
  expect(reads).not.toHaveBeenCalled()
  imagePhase = false
  expect((await f.client.sessionHistoryResource('private-agent', { ...input, maxBytes: 128 * 1024 })).result.status).toBe('fragment')
  expect(reads).toHaveBeenCalled()
  for (const control of f.controls) expect(control).not.toHaveBeenCalled()
}, 60_000)
