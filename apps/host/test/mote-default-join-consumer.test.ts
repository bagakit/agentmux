import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { MoteChatStore } from '../../../packages/connectors/src/mote-chat-store.js'
import { moteChatJourneyFixture } from '../../../packages/connectors/test/fixtures/mote-chat-journey.js'
import { createHostConnectionOwner } from '../src/connections.js'

it.each([false, true])('default Host Mote join reads its original AppConfig-only Executor and freezes guide=%s and the exact wiki directory', async guide => {
  const f = await moteChatJourneyFixture(1, 60_000, 'desktop')
  // Keep the qualified resource/configuration fixture; replace its embedding with the real
  // Headless owner and default Host Mote composition, not another Agent or lifecycle owner.
  await f.sdk.dispose(); f.services.close(); await f.client.dispose()
  await writeFile(f.configurationPath, JSON.stringify({ ...f.config, executors: { 'saved-chat': {
    label: 'Original Host chat', providerId: 'claude', command: process.execPath, args: ['--original-host-guide'],
    env: { MOTE_VALUE: 'original-app-config', AGENTMUX_WIKI_DIR: '/not-the-validated-Mote-home' }, injectAgentMuxGuide: guide
  } } }))
  const previous = f.client as unknown as Record<string, any>
  const connection = createHostConnectionOwner({ directory: join(f.root, 'connectors'),
    encryption: { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async value => Buffer.from(value),
      decryptStringAsync: async value => ({ result: value.toString(), shouldReEncrypt: false }) },
    spatial: new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json')), moteConfigurationPath: f.configurationPath,
    adapters: [{ ...f.wire.adapter, ingress: { ...f.wire.adapter.ingress!, verify: async (...args) => {
      const event = await f.wire.adapter.ingress!.verify(...args)
      if (event.kind === 'action' || JSON.parse(args[1]).nativeKind !== 'direct') throw Error('Expected original signed direct event')
      return { ...event, conversationKind: 'direct' as const }
    } } }]
  })
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as Record<string, any>
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop', 'start']) inner.kernel[name] = previous.kernel[name]
    inner.hookServer.isRunning = previous.hookServer.isRunning; inner.hookServer.createBinding = previous.hookServer.createBinding
    inner.ensureManagedHooks = previous.ensureManagedHooks
    inner.ensureTerminalHandshakeOrDegrade = previous.ensureTerminalHandshakeOrDegrade
    inner.providers.get('claude').discoverNativeSession = previous.providers.get('claude').discoverNativeSession
    inner.providers.get('claude').planPromptInput = previous.providers.get('claude').planPromptInput
    this.probeAgent = previous.probeAgent
  })
  let runtime: Awaited<ReturnType<typeof core.startHeadlessAgentMux>> | undefined
  try {
    runtime = await core.startHeadlessAgentMux({ store: f.store, stateDirectory: f.root, socketPath: join(f.root, 'mote.sock'),
      externalInputAuthority: connection.authority, service: { connections: connection.connections, moteChat: connection.moteChat! } })
    await vi.waitFor(() => expect((runtime!.client as unknown as { connected: boolean }).connected).toBe(true))
    expect((await runtime.client.listHostExecutors()).executors.some(executor => executor.executorId === 'saved-chat')).toBe(false)
    await expect(stat(join(f.root, 'host-executors.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const creation = vi.spyOn(runtime.client, 'createAgentWithDelivery')
    await connection.start(runtime)
    await vi.waitFor(() => expect(f.wire.endpoint).toBeDefined())
    expect(await f.wire.post(f.message('default-owner'))).toBe(202)
    const services = await connection.services()
    await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce(), { timeout: 10_000 })
    expect(creation).toHaveBeenCalledOnce()
    const input = creation.mock.calls[0]![0]
    expect(input).toMatchObject({ executorId: 'saved-chat', injectAgentMuxGuide: guide, args: ['--original-host-guide'],
      env: { MOTE_VALUE: 'original-app-config', AGENTMUX_WIKI_DIR: f.topic.physicalDirectoryPath } })
    expect(f.start).toHaveBeenCalledOnce()
    expect(f.start.mock.calls[0]![0].env?.AGENTMUX_WIKI_DIR).toBe(f.topic.physicalDirectoryPath)
    const store = new MoteChatStore(services.database!), saved = store.generationBySession(input.agentSessionId!)!
    expect(saved.prepared).toEqual({ executionHostId: 'local', input })
    expect(saved.prepared).not.toHaveProperty('executorRevision')
    await writeFile(join(f.topic.physicalDirectoryPath!, 'MOTE.md'), '---\nversion: 1\ndefaults:\n  executorId: changed-after-the-original-create\n---\n')
    expect(await f.wire.post(f.message('same-person-after-settings-edit'))).toBe(202)
    await vi.waitFor(async () => expect((await services.ingress!.list({ connectionId: 'original-bot' })).ingresses.filter(record => record.state === 'claimed')).toHaveLength(2))
    expect(store.generationBySession(input.agentSessionId!)!.prepared).toEqual(saved.prepared)
    expect(f.start).toHaveBeenCalledOnce(); expect(creation).toHaveBeenCalledOnce()
    await expect(stat(join(f.root, 'host-executors.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const sdk = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: runtime.socketPath } })
    try { expect((await sdk.call('space.mote.chat.history', { target: f.target })).generations).toMatchObject([{ agentSessionId: input.agentSessionId }]) }
    finally { await sdk.dispose() }
  } finally {
    connect.mockRestore()
    try { await connection.close() } finally { await runtime?.stop() }
  }
}, 25_000)
