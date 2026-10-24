import { stat, writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import type { ConnectionIngressMessage } from '@agentmux/core/connections'
import { MoteChatStore } from '../../../packages/connectors/src/mote-chat-store.js'
import { moteChatJourneyFixture } from '../../../packages/connectors/test/fixtures/mote-chat-journey.js'
import { createHostConnectionOwner } from '../src/connections.js'

it.each([{ guide: false, pending: false }, { guide: true, pending: false }, { guide: false, pending: true }])(
  'default Host Mote join keeps its original AppConfig Executor and real Provider plan (guide=$guide, pending=$pending)', async ({ guide, pending }) => {
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
    spatial: new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json')), moteConfigurationPath: f.configurationPath,
    adapters: [{ ...f.wire.adapter, ingress: { ...f.wire.adapter.ingress!, verify: async (...args) => {
      const event = await f.wire.adapter.ingress!.verify(...args)
      if (event.kind === 'action' || JSON.parse(args[1]).nativeKind !== 'direct') throw Error('Expected original signed direct event')
      return { ...event, conversationKind: 'direct' as const }
    } } }]
  })
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function (this: core.AgentMuxClient) {
    const inner = this as unknown as Record<string, any>
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop', 'start']) inner.kernel[name] = previous.kernel[name]
    // The controlled Runtime must report the same accepted byte frontier returned by Input.
    inner.kernel.status = async (id: string) => ({ ...await previous.kernel.status(id), acceptedInputBytes: f.run(id).acceptedInputBytes })
    inner.hookServer.isRunning = previous.hookServer.isRunning; inner.hookServer.createBinding = previous.hookServer.createBinding
    inner.ensureManagedHooks = previous.ensureManagedHooks
    inner.ensureTerminalHandshakeOrDegrade = previous.ensureTerminalHandshakeOrDegrade
    inner.providers.get('claude').discoverNativeSession = previous.providers.get('claude').discoverNativeSession
    // Keep the original Provider payload + Enter plan, rather than the journey's single-phase leaf.
    vi.mocked(previous.providers.get('claude').planPromptInput).mockRestore()
    expect(inner.providers.get('claude').planPromptInput('Original controlled input')).toMatchObject({ kind: 'render-then-submit', submit: '\r' })
    this.probeAgent = previous.probeAgent
  })
  let runtime: Awaited<ReturnType<typeof core.startHeadlessAgentMux>> | undefined
  try {
    runtime = await core.startHeadlessAgentMux({ store: f.store, stateDirectory: f.root, socketPath: join(f.root, 'mote.sock'),
      externalInputAuthority: connection.authority, service: { connections: connection.connections, moteChat: connection.moteChat! } })
    await vi.waitFor(() => expect((runtime!.client as unknown as { connected: boolean }).connected).toBe(true))
    expect((await runtime.client.listHostExecutors()).executors.some(executor => executor.executorId === 'saved-chat')).toBe(false)
    await expect(stat(join(f.root, 'host-executors.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const originalCreate = runtime.client.createAgentWithDelivery.bind(runtime.client)
    const creation = vi.spyOn(runtime.client, 'createAgentWithDelivery')
    if (pending) creation.mockImplementation(async input => {
      const result = await originalCreate(input)
      const saved = (await f.store.readMetadata(input.agentSessionId!))!
      await f.store.compareAndSwapMetadata(saved, { ...saved, pendingInteraction: { request: {
        kind: 'permission', id: 'original-bootstrap-permission', agentSessionId: saved.agentSessionId,
        title: 'The original CLI requires a response', options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }],
        evidence: { source: 'native-hook', observedAt: saved.updatedAt, run: saved.run, hookReceiptId: 'original-bootstrap-hook' }
      } } })
      return result
    })
    await connection.start(runtime)
    await vi.waitFor(() => expect(f.wire.endpoint).toBeDefined())
    expect(await f.wire.post(f.message('default-owner'))).toBe(202)
    const services = await connection.services()
    const diagnosticClient = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: runtime.socketPath } })
    try {
      if (pending) {
        let original: ConnectionIngressMessage | undefined
        await vi.waitFor(async () => {
          original = (await services.ingress!.list({ connectionId: 'original-bot' })).ingresses.find(
            record => record.kind !== 'action' && record.externalMessageId === 'message/default-owner') as ConnectionIngressMessage | undefined
          expect(original?.state).toBe('claimed')
          expect((await services.ingress!.inspect({ ingressId: original!.ingressId })).inputReceipt).toMatchObject({
            status: 'waiting', admission: null, observation: 'rejoin-needed', control: { state: 'enabled', waiting: {
              phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin', failure: { code: 'AGENT_INTERACTION_PENDING' }
            } }
          })
        })
        expect(f.inner.kernel.input).not.toHaveBeenCalled()
        const rejoin = vi.spyOn(runtime.client, 'rejoinAgentInputWaiting')
        const report = await diagnosticClient.call('space.mote.chat.diagnose', { target: f.target })
        const observed = report.incoming!.rows[0]!.input
        if (process.env.T032_FACTS) appendFileSync(process.env.T032_FACTS, JSON.stringify({ phase: 'pending-original', input: observed,
          originalFailureCode: 'AGENT_INTERACTION_PENDING', originalAdmission: null, originalControl: 'enabled',
          inputWrites: vi.mocked(f.inner.kernel.input as () => Promise<unknown>).mock.calls.length, createCount: creation.mock.calls.length,
          diagnosisRejoins: rejoin.mock.calls.length, actualProviderPlan: 'render-then-submit' }) + '\n')
        expect(observed).toMatchObject({ status: 'waiting', observation: 'observed', controlState: 'enabled', receiptObservation: 'rejoin-needed',
          waiting: { phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin' },
          preparationReason: null, failureCode: 'AGENT_INTERACTION_PENDING' })
        const encoded = JSON.stringify(report)
        for (const secret of [f.root, original!.body, original!.actor.userId, original!.ingressId, original!.input!.agentSessionId,
          original!.input!.expectedRun.runId, original!.input!.operationId, original!.input!.messageId,
          'original-bootstrap-permission', 'original-bootstrap-hook', 'The original CLI requires a response']) expect(encoded).not.toContain(secret)
        await diagnosticClient.call('space.mote.chat.diagnose', { target: f.target })
        expect(rejoin).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
        // Only this controlled original owner removes its exact prerequisite and explicitly rejoins.
        const saved = (await f.store.readMetadata(original!.input!.agentSessionId))!
        expect(saved.pendingInteraction?.request.id).toBe('original-bootstrap-permission')
        const next = { ...saved }; delete next.pendingInteraction
        await f.store.compareAndSwapMetadata(saved, next)
        await services.ingress!.rejoin(original!.ingressId)
        try {
          await vi.waitFor(async () => expect((await services.ingress!.inspect({ ingressId: original!.ingressId })).inputReceipt).toMatchObject({
            status: 'terminal-confirmed', control: { state: 'dispatch-authorized' }, admission: { admission: { intent: { plan: { kind: 'render-then-submit' } } } }
          }))
        } finally {
          const receipt = (await services.ingress!.inspect({ ingressId: original!.ingressId })).inputReceipt
          const admission = receipt?.admission?.admission, phases = receipt?.admission?.terminalPromptSubmission
          if (process.env.T032_FACTS) appendFileSync(process.env.T032_FACTS, JSON.stringify({ phase: 'rejoin-observed', status: receipt?.status,
            controlState: receipt?.control.state, receiptObservation: receipt?.observation,
            plan: admission?.intent?.plan.kind, admissionAcknowledged: admission?.acknowledged,
            payloadAcknowledged: phases?.payload.acknowledged, submitAcknowledged: phases?.submit.acknowledged,
            inputWrites: vi.mocked(f.inner.kernel.input as () => Promise<unknown>).mock.calls.length }) + '\n')
        }
        expect((await services.ingress!.list({ connectionId: 'original-bot' })).ingresses[0]!.input).toEqual(original!.input)
        expect(rejoin).toHaveBeenCalledOnce(); expect(creation).toHaveBeenCalledOnce()
        expect((await diagnosticClient.call('space.mote.chat.diagnose', { target: f.target })).incoming!.rows[0]!.input.failureCode).toBeNull()
        if (process.env.T032_FACTS) appendFileSync(process.env.T032_FACTS, JSON.stringify({ phase: 'original-rejoined', sameInputRetained: true,
          createCount: creation.mock.calls.length, explicitRejoins: rejoin.mock.calls.length,
          inputWrites: vi.mocked(f.inner.kernel.input as () => Promise<unknown>).mock.calls.length }) + '\n')
      }
    } finally { await diagnosticClient.dispose() }
    await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(2), { timeout: 10_000 })
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
