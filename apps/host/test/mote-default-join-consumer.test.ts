import { stat, writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import type { ConnectionIngressMessage } from '@agentmux/core/connections'
import { connectHostedAgentMux } from '@agentmux/core/hosted'
import { createHostedIngressCorePort } from '../../../packages/connectors/src/core-ingress-port.js'
import { MoteChatStore } from '../../../packages/connectors/src/mote-chat-store.js'
import { moteChatJourneyFixture } from '../../../packages/connectors/test/fixtures/mote-chat-journey.js'
import { createHostConnectionOwner } from '../src/connections.js'

it.each([{ guide: false, pending: false, exited: false }, { guide: true, pending: false, exited: false },
  { guide: false, pending: true, exited: false }, { guide: false, pending: false, exited: true }])(
  'default Host Mote join keeps its original AppConfig Executor and real Provider plan (guide=$guide, pending=$pending, exited=$exited)', async ({ guide, pending, exited }) => {
  const f = await moteChatJourneyFixture(1, 60_000, 'desktop')
  // Keep the qualified resource/configuration fixture; replace its embedding with the real
  // Headless owner and default Host Mote composition, not another Agent or lifecycle owner.
  await f.sdk.dispose(); f.services.close(); await f.client.dispose()
  await writeFile(f.configurationPath, JSON.stringify({ ...f.config, executors: { 'saved-chat': {
    label: 'Original Host chat', providerId: 'claude', command: process.execPath, args: ['--original-host-guide'],
    env: { MOTE_VALUE: 'original-app-config', AGENTMUX_WIKI_DIR: '/not-the-validated-Mote-home' }, injectAgentMuxGuide: guide
  } } }))
  const previous = f.client as unknown as Record<string, any>
  let exitedRunId: string | undefined
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
    inner.kernel.status = async (id: string) => ({ ...await previous.kernel.status(id), acceptedInputBytes: f.run(id).acceptedInputBytes,
      ...(id === exitedRunId ? { state: { type: 'exited', code: 0, signal: null } } : {}) })
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
    if (pending || exited) creation.mockImplementation(async input => {
      const result = await originalCreate(input)
      const saved = (await f.store.readMetadata(input.agentSessionId!))!
      if (exited) {
        expect(saved.creation?.agentMuxContext).toBe('confirmed')
        exitedRunId = saved.run.runId
      }
      if (pending) await f.store.compareAndSwapMetadata(saved, { ...saved, pendingInteraction: { request: {
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
      if (exited) {
        let original: ConnectionIngressMessage | undefined
        await vi.waitFor(async () => {
          original = (await services.ingress!.list({ connectionId: 'original-bot' })).ingresses.find(
            record => record.kind !== 'action' && record.externalMessageId === 'message/default-owner') as ConnectionIngressMessage | undefined
          expect(original?.state).toBe('claimed')
          expect((await services.ingress!.inspect({ ingressId: original!.ingressId })).inputReceipt).toMatchObject({
            status: 'waiting', admission: null, observation: 'rejoin-needed', control: { state: 'enabled', waiting: {
              phase: 'input-environment', reason: 'original-input-unconfirmed', wake: 'explicit-rejoin', failure: { code: 'STALE_AGENT_SESSION' }
            } }
          })
        })
        const session = (await runtime.client.readAgentSession(original!.input!.agentSessionId))!
        expect(session.run).toEqual(original!.input!.expectedRun)
        expect(session.run.runId).toBe(exitedRunId)
        const observedRun = await (runtime.client as unknown as { kernel: { status(id: string): Promise<{ runId: string; state: unknown }> } }).kernel.status(exitedRunId!)
        expect(observedRun).toMatchObject({ runId: original!.input!.expectedRun.runId, state: { type: 'exited', code: 0, signal: null } })
        expect(await f.wire.post(f.message('same-exited-owner'))).toBe(202)
        await vi.waitFor(async () => {
          const records = (await services.ingress!.list({ connectionId: 'original-bot' })).ingresses
          expect(records).toHaveLength(2)
          for (const record of records) {
            expect(record.state).toBe('claimed')
            expect((await services.ingress!.inspect({ ingressId: record.ingressId })).inputReceipt).toMatchObject({
              status: 'waiting', admission: null, control: { state: 'enabled', waiting: { failure: { code: 'STALE_AGENT_SESSION' } } }
            })
          }
        })
        const originalGeneration = new MoteChatStore(services.database!).generationBySession(session.agentSessionId)!
        const rejoin = vi.spyOn(runtime.client, 'rejoinAgentInputWaiting')
        const originalRuntimeSubject = runtime.client.runtimeSubject.bind(runtime.client)
        const runtimeRead = vi.spyOn(runtime.client, 'runtimeSubject')
        const report = await diagnosticClient.call('space.mote.chat.diagnose', { target: f.target })
        if (process.env.T032_FACTS) appendFileSync(process.env.T032_FACTS, JSON.stringify({ phase: 'runtime-diagnosis-observed',
          input: report.incoming!.rows[0]!.input, originalRuntimeState: 'exited', inputWrites: 0,
          createCount: creation.mock.calls.length, diagnosisRejoins: rejoin.mock.calls.length,
          sameRunWaitingRows: report.incoming!.rows.length, runtimeReads: runtimeRead.mock.calls.length }) + '\n')
        expect(report.readiness.state).toBe('ready')
        expect(report.incoming!.rows).toHaveLength(2)
        expect(runtimeRead).toHaveBeenCalledOnce()
        expect(report.incoming!.rows[0]!.input).toMatchObject({ status: 'waiting', controlState: 'enabled', receiptObservation: 'rejoin-needed',
          preparationReason: null, failureCode: 'STALE_AGENT_SESSION', runtime: { target: 'original', state: 'exited', exitCode: 0 } })
        const repeated = await diagnosticClient.call('space.mote.chat.diagnose', { target: f.target })
        expect(repeated.incoming!.rows[0]!.input).toEqual(report.incoming!.rows[0]!.input)
        expect(runtimeRead.mock.calls.map(([target]) => target)).toEqual([
          { kind: 'terminal-run', runId: original!.input!.expectedRun.runId }, { kind: 'terminal-run', runId: original!.input!.expectedRun.runId }
        ])

        const originalReadSession = runtime.client.readAgentSession.bind(runtime.client)
        const metadataRead = vi.spyOn(runtime.client, 'readAgentSession').mockImplementation(async id => {
          const observed = await originalReadSession(id)
          return id === original!.input!.agentSessionId && observed ? { ...observed, run: { runId: 'other-observed-run' } } : observed
        })
        let changed: typeof report
        try {
          changed = await diagnosticClient.call('space.mote.chat.diagnose', { target: f.target })
          expect(changed.incoming!.rows[0]!.input).toMatchObject({ failureCode: 'STALE_AGENT_SESSION',
            runtime: { target: 'changed', state: 'exited', exitCode: 0 } })
          expect(runtimeRead.mock.calls.at(-1)![0]).toEqual({ kind: 'terminal-run', runId: original!.input!.expectedRun.runId })
        } finally { metadataRead.mockRestore() }

        runtimeRead.mockImplementation(async (target, knownRun) => {
          if (target.kind === 'terminal-run' && target.runId === original!.input!.expectedRun.runId) throw new core.AgentMuxError(
            'The controlled original Runtime observation is unavailable.', 'CTXMUX_DISCONNECTED')
          return await originalRuntimeSubject(target, knownRun)
        })
        const unavailable = await diagnosticClient.call('space.mote.chat.diagnose', { target: f.target })
        expect(unavailable.incoming!.rows[0]!.input).toMatchObject({ status: 'waiting', controlState: 'enabled', failureCode: 'STALE_AGENT_SESSION',
          runtime: { target: 'original', state: 'unavailable', exitCode: null } })
        runtimeRead.mockRestore()

        // Reuse this endpoint's real Hosted transport, then isolate the exact read from bootstrap setup.
        const identity = (await diagnosticClient.call('runtime.owner.identity', {})).owner
        const hosted = await connectHostedAgentMux({ rpc: diagnosticClient, expectedRuntimeId: identity.runtimeId,
          forwardRpc: (method, params, context) => diagnosticClient.call(method, params, context) })
        try {
          const semanticConnect = vi.spyOn(runtime.client, 'connect'), inventory = vi.spyOn(runtime.client, 'readAgentSessions')
          const runInventory = vi.spyOn(runtime.client, 'listRuns'), exactRead = vi.spyOn(runtime.client, 'runtimeSubject')
          semanticConnect.mockClear(); inventory.mockClear(); runInventory.mockClear(); exactRead.mockClear()
          const resolve = createHostedIngressCorePort(() => [{ hostId: 'original-execution', client: hosted }])
          const port = resolve('original-execution', identity.runtimeId)!
          const subject = await port.runtimeSubject!({ kind: 'terminal-run', runId: original!.input!.expectedRun.runId })
          expect(subject.run).toMatchObject({ runId: original!.input!.expectedRun.runId, state: 'exited', exitCode: 0 })
          await expect(resolve('original-execution', 'foreign-runtime')!.runtimeSubject!({ kind: 'terminal-run', runId: original!.input!.expectedRun.runId }))
            .rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
          expect(exactRead).toHaveBeenCalledOnce()
          expect(exactRead.mock.calls[0]![0]).toEqual({ kind: 'terminal-run', runId: original!.input!.expectedRun.runId })
          expect(semanticConnect).not.toHaveBeenCalled(); expect(inventory).not.toHaveBeenCalled(); expect(runInventory).not.toHaveBeenCalled()
          if (process.env.T032_FACTS) appendFileSync(process.env.T032_FACTS, JSON.stringify({ phase: 'hosted-original-runtime-read',
            sameOriginalRun: subject.run.runId === original!.input!.expectedRun.runId, state: subject.run.state, exitCode: subject.run.exitCode,
            wrongRuntimeRejected: true, semanticConnects: semanticConnect.mock.calls.length,
            sessionInventories: inventory.mock.calls.length, runInventories: runInventory.mock.calls.length,
            exactRuntimeReads: exactRead.mock.calls.length, inputWrites: 0, rejoins: rejoin.mock.calls.length }) + '\n')
        } finally { await hosted.dispose() }
        expect(f.start).toHaveBeenCalledOnce(); expect(creation).toHaveBeenCalledOnce()
        expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(rejoin).not.toHaveBeenCalled()
        expect(new MoteChatStore(services.database!).generationBySession(session.agentSessionId)).toEqual(originalGeneration)
        expect((await services.ingress!.list({ connectionId: 'original-bot' })).ingresses[0]!.input).toEqual(original!.input)
        if (process.env.T032_FACTS) appendFileSync(process.env.T032_FACTS, JSON.stringify({ phase: 'same-original-run-exited',
          creationContextConfirmed: session.creation?.agentMuxContext === 'confirmed', sameExpectedRun: true, runtimeState: 'exited',
          originalAdmission: null, originalControl: 'enabled', input: report.incoming!.rows[0]!.input,
          changedInput: changed!.incoming!.rows[0]!.input, unavailableInput: unavailable.incoming!.rows[0]!.input,
          generationAndGrantRetained: true, originalInputRetained: true,
          inputWrites: 0, createCount: creation.mock.calls.length, diagnosisRejoins: rejoin.mock.calls.length,
          actualProviderPlan: 'render-then-submit' }) + '\n')
        return
      }
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
