import { appendFile, stat, writeFile } from 'node:fs/promises'
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

it.each([{ guide: false, pending: false, exited: false, recover: null }, { guide: true, pending: false, exited: false, recover: null },
  { guide: false, pending: true, exited: false, recover: null }, { guide: false, pending: false, exited: true, recover: null },
  { guide: false, pending: false, exited: false, recover: 'interrupted' as const },
  { guide: false, pending: false, exited: false, recover: 'exited' as const }])(
  'default Host Mote join keeps its original AppConfig Executor and real Provider plan (guide=$guide, pending=$pending, exited=$exited, recover=$recover)', async ({ guide, pending, exited, recover }) => {
  const f = await moteChatJourneyFixture(recover ? 3 : 1, 60_000, 'desktop')
  const actor = recover ? f.guest : f.creator
  // Keep the qualified resource/configuration fixture; replace its embedding with the real
  // Headless owner and default Host Mote composition, not another Agent or lifecycle owner.
  await f.sdk.dispose(); f.services.close(); await f.client.dispose()
  await writeFile(f.configurationPath, JSON.stringify({ ...f.config, executors: { 'saved-chat': {
    label: 'Original Host chat', providerId: 'claude', command: process.execPath, args: ['--original-host-guide'],
    env: { MOTE_VALUE: 'original-app-config', AGENTMUX_WIKI_DIR: '/not-the-validated-Mote-home' }, injectAgentMuxGuide: guide
  } } }))
  const previous = f.client as unknown as Record<string, any>
  let exitedRunId: string | undefined
  const ended = new Map<string, { type: 'interrupted'; reason: string } | { type: 'exited'; code: number; signal: null }>()
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
    for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop', 'start', 'inspectCreation']) inner.kernel[name] = previous.kernel[name]
    // The controlled Runtime must report the same accepted byte frontier returned by Input.
    inner.kernel.status = async (id: string) => ({ ...await previous.kernel.status(id), acceptedInputBytes: f.run(id).acceptedInputBytes,
      ...(id === exitedRunId ? { state: { type: 'exited', code: 0, signal: null } } : ended.has(id) ? { state: ended.get(id) } : {}) })
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
      if (pending) await f.store.compareAndSwapMetadata(saved, { ...saved, pendingInteraction: { request: {
        kind: 'permission', id: 'original-bootstrap-permission', agentSessionId: saved.agentSessionId,
        title: 'The original CLI requires a response', options: [{ id: 'allow', label: 'Allow once', kind: 'allow-once' }],
        evidence: { source: 'native-hook', observedAt: saved.updatedAt, run: saved.run, hookReceiptId: 'original-bootstrap-hook' }
      } } })
      return result
    })
    const continuity = vi.spyOn(runtime.client, 'ensureAgentContinuity')
    if (exited) {
      // Both messages pass healthy preparation and save their immutable claims before
      // this Runtime leaf exits. New preclaim recovery must not retarget old inputs.
      const submit = runtime.client.submitAgentMessage.bind(runtime.client)
      let arrivals = 0, release!: () => void
      const claimed = new Promise<void>(resolve => { release = resolve })
      vi.spyOn(runtime.client, 'submitAgentMessage').mockImplementation(async (...args) => {
        if (++arrivals === 2) { exitedRunId = args[0].envelope.recipientRunId!; release() }
        await claimed
        return await submit(...args)
      })
    }
    await connection.start(runtime)
    await vi.waitFor(() => expect(f.wire.endpoint).toBeDefined())
    expect(await f.wire.post(f.message('default-owner', actor))).toBe(202)
    if (exited) expect(await f.wire.post(f.message('same-exited-owner'))).toBe(202)
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
    if (recover) {
      const records = async () => (await services.ingress!.list({ connectionId: 'original-bot' })).ingresses as ConnectionIngressMessage[]
      const original = (await records())[0]!, frozenInput = structuredClone(original.input!)
      const session = (await runtime.client.readAgentSession(input.agentSessionId!))!
      if (session.nativeHandle?.kind !== 'provider') throw Error('Missing original native conversation')
      expect(continuity).not.toHaveBeenCalled()
      expect(store.people(f.target.spaceId, '', 10)[0]!.person.used).toBe(1)
      ended.set(session.run.runId, recover === 'interrupted'
        ? { type: 'interrupted', reason: 'controlled original Runtime interruption' }
        : { type: 'exited', code: 0, signal: null })
      let release!: () => void
      const resumeGate = new Promise<void>(resolve => { release = resolve })
      const startNative = f.start.getMockImplementation()!
      f.start.mockImplementationOnce(async launch => { await resumeGate; return await startNative(launch) })
      try {
        expect(await f.wire.post(f.message('recovered-one', actor))).toBe(202)
        expect(await f.wire.post(f.message('recovered-two', actor))).toBe(202)
        await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2))
        await vi.waitFor(async () => {
          const retained = await records()
          expect(retained).toHaveLength(3)
          expect(retained.filter(row => row.state === 'received')).toHaveLength(2)
          expect(retained.filter(row => row.input)).toHaveLength(1)
        })
        expect(continuity).toHaveBeenCalledOnce()
        expect(continuity.mock.calls[0]![0]).toMatchObject({ agentSessionId: session.agentSessionId,
          expectedRun: session.run, trigger: 'input', commandOverride: process.execPath, args: ['--original-host-guide'],
          env: { MOTE_VALUE: 'original-app-config', AGENTMUX_WIKI_DIR: f.topic.physicalDirectoryPath } })
        expect(continuity.mock.calls[0]![0]).not.toHaveProperty('input')
        expect(f.inner.kernel.input).toHaveBeenCalledTimes(2)
      } finally { release() }
      await vi.waitFor(async () => expect((await records()).filter(row => row.state === 'claimed')).toHaveLength(3))
      await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(6), { timeout: 10_000 })
      const resumed = (await runtime.client.readAgentSession(session.agentSessionId))!
      expect(resumed.run).not.toEqual(session.run)
      expect(resumed.nativeHandle).toEqual(session.nativeHandle)
      expect(resumed.continuity).toMatchObject({ kind: 'resumed', previousRun: session.run, newRun: resumed.run, trigger: 'input' })
      const launch = f.start.mock.calls[1]![0]
      expect(launch.args).toContain('--resume')
      expect(launch.args[launch.args.indexOf('--resume') + 1]).toBe(session.nativeHandle!.sessionId)
      expect(launch.args).toContain('--original-host-guide')
      expect(launch.env).toMatchObject({ MOTE_VALUE: 'original-app-config', AGENTMUX_WIKI_DIR: f.topic.physicalDirectoryPath })
      for (const id of ['default-owner', 'recovered-one', 'recovered-two']) expect(JSON.stringify(launch.args)).not.toContain(f.message(id, actor).text)
      const resumedRecords = await records()
      expect(resumedRecords.find(row => row.ingressId === original.ingressId)!.input).toEqual(frozenInput)
      for (const record of resumedRecords.filter(row => row.ingressId !== original.ingressId)) {
        expect(record.input).toMatchObject({ agentSessionId: session.agentSessionId, expectedRun: resumed.run })
        expect((await services.ingress!.inspect({ ingressId: record.ingressId })).inputReceipt).toMatchObject({ status: 'terminal-confirmed' })
      }
      const writes = vi.mocked(f.inner.kernel.input as (...args: any[]) => Promise<unknown>).mock.calls
      expect(writes.filter(([id]) => id === session.run.runId)).toHaveLength(2)
      expect(writes.filter(([id]) => id === resumed.run.runId)).toHaveLength(4)
      expect(store.people(f.target.spaceId, '', 10)[0]!.person.used).toBe(3)
      expect(store.generationBySession(session.agentSessionId)!.generation.generationId).toBe(saved.generation.generationId)
      expect(store.generationBySession(session.agentSessionId)!.prepared).toEqual(saved.prepared)
      expect(await f.wire.post({ ...f.message('recovered-one', actor), deliveryKey: 'redelivery/recovered-one' })).toBe(202)
      expect(store.people(f.target.spaceId, '', 10)[0]!.person.used).toBe(3)
      expect(f.start).toHaveBeenCalledTimes(2); expect(creation).toHaveBeenCalledOnce(); expect(continuity).toHaveBeenCalledOnce()
      const native = resumed.nativeHandle!
      if (native.kind !== 'provider' || !native.transcriptPath) throw Error('Missing original native reply source')
      await appendFile(native.transcriptPath, JSON.stringify({ sessionId: native.sessionId, uuid: 'recovered-native-answer',
        type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reply from the same recovered native conversation' }] } }) + '\n')
      await vi.waitFor(() => expect(f.wire.effects.some(effect => effect.text === 'Reply from the same recovered native conversation')).toBe(true), { timeout: 4_000 })
      if (process.env.T035_FACTS) appendFileSync(process.env.T035_FACTS, JSON.stringify({ phase: 'default-host-recovered-before-claim',
        originalState: recover, sameSession: true, sameNativeConversation: true, sameGeneration: true, originalPreparedRetained: true,
        receivedUntilContinuity: 2, continuityCalls: continuity.mock.calls.length, startCalls: f.start.mock.calls.length,
        originalRunWrites: 2, resumedRunWrites: 4, quotaUsed: 3, originalFrozenInputRetained: true,
        nativeReplyPublished: true, providerPlan: 'render-then-submit' }) + '\n')
      return
    }
    expect(await f.wire.post(f.message('same-person-after-settings-edit'))).toBe(202)
    await vi.waitFor(async () => expect((await services.ingress!.list({ connectionId: 'original-bot' })).ingresses.filter(record => record.state === 'claimed')).toHaveLength(2))
    expect(store.generationBySession(input.agentSessionId!)!.prepared).toEqual(saved.prepared)
    expect(continuity).not.toHaveBeenCalled()
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
