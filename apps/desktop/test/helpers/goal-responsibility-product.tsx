// @vitest-environment happy-dom
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { AgentMuxClient, AgentMuxControlServer, AgentMuxError, AgentMuxFileAgentSessionStore, AgentMuxRpcService,
  connectAgentMuxRpc, hashAgentCapability, issueAgentCapability, observeAgent, type AgentMuxAgentRuntimeStatus,
  type AgentMuxClientEvent, type AgentMuxRun, type AgentMuxStoredAgentSession, type AgentStatus } from '@agentmux/core'
import { demandExecutionReferences, demandResponsibilityScope, openDemandStore, type Demand, type DemandDispatch,
  type DemandProgressInput } from '@agentmux/demand'
import type { GoalDelegationResult } from '@agentmux/core/goal-delegation'
import type { AgentMuxControlRequest } from '@agentmux/core/control'
import { GoalDelegationOwner, type GoalDelegationCorePort } from '../../src/main/goal-delegation-owner'
import { GoalResponsibilityOwner } from '../../src/main/goal-responsibility-owner'
import { GoalPatrolOwner } from '../../src/main/goal-patrol-owner'
import { GoalStartResponsibilityOwner, type GoalStartRuntimePort } from '../../src/main/goal-start-responsibility'
import { RuntimeController } from '../../src/main/runtime-controller'
import { api } from '../../src/renderer/src/lib/api'
import { applyGoalDelegationResult, initializeGoalResponsibilityObservation, refreshGoalDelegations } from '../../src/renderer/src/lib/goal-delegation-work'
import type { DemandRecord } from '../../src/renderer/src/lib/global-demand-board'
import type { AppConfig, SessionSnapshot } from '../../src/shared/contracts'
import { useAppStore } from '../../src/renderer/src/store'

// Node owner verification must never load or download the Electron executable.
// The Runtime method below only consumes its retained Core host lookup.
vi.mock('electron', () => ({ app: {}, nativeImage: {} }))

const execute = promisify(execFile), initial = useAppStore.getState()
const cleanup: Array<() => void | Promise<unknown>> = []
let root: Root, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.spyOn(api.ui, 'openObjectLink').mockResolvedValue(undefined)
  vi.spyOn(api.sessions, 'onEvent').mockReturnValue(() => {})
  useAppStore.setState({ demands: {}, sessions: [], selectedDemandId: null })
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove()
  const failures: unknown[] = []
  for (const release of cleanup.splice(0).reverse()) { try { await release() } catch (error) { failures.push(error) } }
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); useAppStore.setState(initial, true)
  if (failures.length) throw new AggregateError(failures, 'Private responsibility product fixture cleanup failed: ' + failures.map(String).join('; '))
})
async function settle() { await act(async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve() }) }
async function mount(node: ReactNode) {
  await act(async () => root.render(node))
  // Await the mounted consumer's coalesced original I/O in the same React turn.
  await act(async () => { if (useAppStore.getState().demands.goal) await refreshGoalDelegations('goal') })
  await settle()
}
function record(goal: Demand): DemandRecord {
  return { ...goal, priority: goal.priority ?? 'normal', projectId: null, projectName: null, source: 'session', description: goal.description ?? '', sessionIds: goal.sessionIds ?? [] }
}
const semantic = (session: AgentMuxStoredAgentSession, state: AgentStatus['state'], since = Date.now() - 90_000,
  source: AgentStatus['source'] = session.providerId === 'gemini' ? 'acp' : 'native-hook'): AgentMuxAgentRuntimeStatus => {
  const stateFact = { state, source, observedAt: Date.now(), stateEnteredAt: since, currentActivityRevision: 7 }
  return { session: { ...session, semanticStatus: stateFact }, run: { runId: session.run.runId, kind: 'agent', providerId: session.providerId,
    executorId: session.executorId, agentSessionId: session.agentSessionId, workspacePath: session.workspacePath, state: 'running',
    pid: null, cols: 80, rows: 24, observedAt: Date.now(), latestOutputBytes: 0, acceptedInputBytes: 0, nativeService: null },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true,
      replyCorrelation: source === 'acp' ? 'acp-turn-id' : 'native-turn-id' }, observation: observeAgent({ process: 'running', status: stateFact,
      timelineCapability: 'complete-events', awaitingRequest: false, terminalCapabilityUnverified: false }, Date.now()) }
}

const sources = ['packages/demand/src/responsibility.ts', 'packages/demand/src/demand-store.ts', 'packages/core/src/goal-responsibility.ts',
  'packages/core/src/goal-delegation.ts', 'packages/core/src/public-rpc-service.ts', 'packages/core/src/agentmux-cli-commands.ts',
  'apps/desktop/src/main/goal-responsibility-owner.ts', 'apps/desktop/src/main/goal-delegation-owner.ts',
  'apps/desktop/src/renderer/src/lib/goal-delegation-work.ts', 'apps/desktop/src/renderer/src/lib/goal-current-work.ts',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/GoalResponsibilitySummary.tsx']
async function evidence(scenario: string, proof: unknown, slice: 'responsibility' | 'patrol' = 'responsibility') {
  const directory = process.env[slice === 'patrol' ? 'AGENTMUX_GOAL_PATROL_RECEIPT_DIR' : 'AGENTMUX_GOAL_RESPONSIBILITY_RECEIPT_DIR']
  if (!directory) return
  await fs.mkdir(directory, { recursive: true })
  const selected = slice === 'patrol' ? [...sources, 'packages/demand/src/goal-patrol.ts', 'apps/desktop/src/main/goal-patrol-owner.ts',
    'packages/core/src/goal-role-guidance.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/goal-start-responsibility.ts',
    'apps/desktop/src/renderer/src/components/GoalPatrolControl.tsx', 'apps/desktop/test/goal-patrol-product.test.tsx',
    'apps/desktop/test/helpers/goal-responsibility-product.tsx'] : sources
  const source = await Promise.all(selected.map(async file => ({ file, sha256: createHash('sha256').update(await fs.readFile(resolve(file))).digest('hex') })))
  const cli = await fs.readFile(resolve('packages/core/dist/agentmux.js'))
  const boundary = 'Actual compiled CLI and Unix RPC, persisted Core message/dispatch and Demand owners, Main responsibility/start owners, and mounted production Renderer consumers. Native input, native Run/status observations and IPC transport are isolated fixtures. This is not live Native, installed product, Chromium visual or process-restart acceptance.'
  const cliSha256 = createHash('sha256').update(cli).digest('hex'), receiptPath = resolve(directory, `${scenario}.json`)
  const bytes = JSON.stringify({ schema: `agentmux.goal-${slice}-product.v1`, scenario, proofBoundary: boundary, source, cliSha256, proof }, null, 2) + '\n'
  await fs.writeFile(receiptPath, bytes)
  return { receiptPath, receiptSha256: createHash('sha256').update(bytes).digest('hex'), boundary, cliSha256 }
}

async function fixture(options: { patrol?: boolean; alignment?: boolean | 'empty' } = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'goal-responsibility-product-'))
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !['AGENTMUX_GOAL_RESPONSIBILITY_RECEIPT_DIR', 'AGENTMUX_GOAL_PATROL_RECEIPT_DIR'].includes(key)) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(directory, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(directory, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(directory, 'messages.sqlite'))
  const sessions = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json')), credentials = new Map<string, string>()
  const metadata = new Map<string, AgentMuxStoredAgentSession>(), statuses = new Map<string, AgentMuxAgentRuntimeStatus>()
  for (const id of ['owner', 'worker-a', 'worker-b', 'worker-c', 'finite-worker', 'stranger']) {
    const capability = issueAgentCapability(); credentials.set(id, capability)
    const original: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: id, providerId: id === 'worker-c' ? 'gemini' : 'codex', executorId: 'fixture',
      hostId: 'local', workspacePath: directory, run: { runId: id + '-run' }, retiredRuns: [], hookBindingId: 'binding-' + id,
      hookToken: 'fixture-token-' + id, capabilityHash: hashAgentCapability(capability), createdAt: Date.now() - 100_000, updatedAt: Date.now() }
    await sessions.compareAndSwap(null, original); metadata.set(id, original); statuses.set(id, semantic(original, 'working'))
  }
  const client = new AgentMuxClient({ store: sessions })
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Original fixture Host' }],
    executors: { fixture: { label: 'Original fixture executor', providerId: 'codex', command: 'isolated-native', args: [], env: {}, injectAgentMuxGuide: true } },
    workspaces: [{ id: 'original-workspace', hostId: 'local', path: directory, name: 'Original fixture workspace', kind: 'folder' }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const inner = client as unknown as { connected: boolean; kernel: { isConnected(): boolean; stop: unknown }; registry: { load(hostId: string): Promise<void> } }
  inner.connected = true; inner.kernel.isConnected = () => true; await inner.registry.load('local')
  cleanup.push(() => client.dispose()); const stop = vi.fn(); inner.kernel.stop = stop
  const nativeInputs: Array<{ operationId: string; messageId: string; recipient: string; body: string }> = []
  // Only native transport is replaced; authentication, immutable message identity,
  // queue journal, original dispatch and Domain binding are the product owners.
  vi.spyOn(client, 'submitAgentMessage').mockImplementation(async input => {
    nativeInputs.push({ operationId: input.envelope.operationId, messageId: input.envelope.messageId,
      recipient: input.agentSessionId, body: input.envelope.body })
  })
  const demands = openDemandStore({ root: join(directory, 'goals') })
  await demands.create({ id: 'goal', title: 'Original responsibility', description: 'Original human task\nkept verbatim', status: 'in_progress',
    assigneeSessionIds: ['owner', 'worker-a', 'worker-b', 'worker-c', 'finite-worker'], supervisorSessionId: 'owner' })
  if (options.alignment !== false) await demands.proposeAlignment('goal', { summary: 'Original useful result',
    criteria: options.alignment === 'empty' ? [] : [{ id: 'AC', text: 'Original evidence' }], openQuestions: [] })
  const runStates = new Map<string, AgentMuxRun['state']>([...metadata.values()].map(item => [item.run.runId, 'running']))
  const changes = new Set<(ids: string[]) => void>(), nativeEvents = new Set<(hostId: string, event: AgentMuxClientEvent) => void>()
  const changed = (ids: string[]) => { for (const listener of changes) listener(ids) }
  // IPC's event delivery is the isolated transport; subscribers consume exact IDs.
  const domainRelease = demands.subscribe(snapshot => changed(snapshot.demands.map(item => item.id))); cleanup.push(domainRelease)
  const core = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client }] })
  const trace: Array<{ method: string; operationId?: string }> = []
  const port: GoalDelegationCorePort = {
    call: async (hostId, method, params, context) => {
      expect(hostId).toBe('local'); trace.push({ method, ...'operationId' in params && params.operationId ? { operationId: params.operationId as string } : {} })
      return await core.call(method, params, context)
    },
    readDispatch: async (hostId, sourceMessageId) => { expect(hostId).toBe('local'); return { ...await client.readDispatch({ sourceMessageId }), hostId } },
    observeRun: async (hostId, runId) => {
      expect(hostId).toBe('local'); const state = runStates.get(runId)
      if (!state) throw new AgentMuxError('Original isolated Run observation unavailable.', 'RUN_NOT_FOUND')
      return { runId, state }
    }
  }
  const startRuntime = {
    inspectGoalStart: async (start: DemandDispatch) => ({ agentSessionId: start.agentSessionId, run: { runId: start.runId },
      admission: { submissionId: start.operationId, acknowledged: true, inputKey: { kind: 'prompt', agentSessionId: start.agentSessionId,
        expectedRun: { runId: start.runId }, submissionId: start.operationId }, intent: { run: { runId: start.runId }, prompt: start.prompt } } }),
    observeOriginalRun: port.observeRun
  } as GoalStartRuntimePort
  const starts = new GoalStartResponsibilityOwner(demands, startRuntime, changed); cleanup.push(() => starts.dispose())
  let owner: GoalDelegationOwner
  const mainReads = new Set<Promise<GoalDelegationResult>>()
  const patrolState = { inputOccupied: false, routeUnavailable: false, receiptUnavailable: false, loseReceiptAfterSubmit: false, loseBeforeSubmit: false }
  const runtime = {
    observeGoalAgent: async (hostId, id) => { expect(hostId).toBe('local'); const value = statuses.get(id); if (!value) throw new AgentMuxError('Original status unavailable.', 'CONTROL_UNAVAILABLE'); return value },
    resolveGoalAgent: async id => { const value = statuses.get(id); if (!value || options.patrol && patrolState.routeUnavailable) throw new AgentMuxError('Original manager unavailable.', 'CONTROL_UNAVAILABLE'); return { hostId: 'local', status: value } },
    observeCoreEvents: (types, listener) => { const filtered = (host: string, event: AgentMuxClientEvent) => { if (types.includes(event.type)) listener(host, event) }; nativeEvents.add(filtered); return () => nativeEvents.delete(filtered) }
  } satisfies ConstructorParameters<typeof GoalResponsibilityOwner>[1]
  const readAsPerson: ConstructorParameters<typeof GoalResponsibilityOwner>[2] = (goalId, context) => {
    const pending = owner.call('goal.delegations', { goalId }, context, { actor: { kind: 'user', id: 'fixture-user' } })
    mainReads.add(pending); void pending.then(() => mainReads.delete(pending), () => mainReads.delete(pending))
    return pending
  }
  const responsibility = new GoalResponsibilityOwner(demands, runtime, readAsPerson, changed)
  cleanup.push(() => responsibility.dispose())
  const attempts: Array<{ operationId: string; agentSessionId: string; runId: string; note: string }> = []
  const nativeWrites: Array<{ runId: string; data: string; expectedByte: number }> = [], cursors = new Map<string, number>()
  const occupations = new Set<(control: Parameters<ConstructorParameters<typeof GoalPatrolOwner>[1]['submitPrompt']>[0]) => void>()
  let patrol: GoalPatrolOwner | undefined
  async function setNativeState(id: string, state: AgentStatus['state']) {
    const current = (await sessions.readMetadata(id))!, observed = semantic(current, state)
    const next = { ...current, semanticStatus: observed.session.semanticStatus!, updatedAt: Date.now() }
    await sessions.compareAndSwapMetadata(current, next); metadata.set(id, next); statuses.set(id, observed)
    await inner.registry.load('local')
  }
  async function advanceSession(id: string, runId: string) {
    const current = (await sessions.readMetadata(id))!
    const next = { ...current, run: { runId }, retiredRuns: [...current.retiredRuns, current.run], updatedAt: Date.now() }
    await sessions.compareAndSwapMetadata(current, next); metadata.set(id, next); runStates.set(runId, 'running')
    await setNativeState(id, 'done')
  }
  const patrolRuntime: ConstructorParameters<typeof GoalPatrolOwner>[1] = {
    ...runtime,
    resolveGoalAgent: async id => { if (patrolState.routeUnavailable) throw new AgentMuxError('Original manager route is unavailable.', 'CONTROL_UNAVAILABLE'); return await runtime.resolveGoalAgent(id) },
    observeInputOccupation: listener => { occupations.add(listener); return () => occupations.delete(listener) },
    saveGoalAttention: async note => {
      const original = (await sessions.readMetadata(note.supervisorAgentSessionId))!
      if (original.run.runId !== note.supervisorRunId) throw new AgentMuxError('Original target Run changed.', 'STALE_AGENT_SESSION')
      await client.saveAgentFuturePromptIntent({ agentSessionId: original.agentSessionId, intentId: note.intentId, operationId: note.operationId,
        prompt: '', agentMuxNote: note.agentMuxNote, active: true })
    },
    disableGoalAttention: async note => {
      await client.saveAgentFuturePromptIntent({ agentSessionId: note.supervisorAgentSessionId, intentId: note.intentId, operationId: note.operationId,
        prompt: '', agentMuxNote: note.agentMuxNote, active: false })
    },
    inspectGoalAttention: async note => {
      if (patrolState.receiptUnavailable) throw new AgentMuxError('The exact original Core input read is unavailable.', 'CONTROL_UNAVAILABLE')
      return await client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: note.supervisorAgentSessionId,
        expectedRun: { runId: note.supervisorRunId }, submissionId: note.operationId })
    },
    observeContinuousProgress: async (target, tickId, now) => {
      const original = (await sessions.readMetadata(target.agentSessionId))!, observed = statuses.get(target.agentSessionId)!
      const saved = target.futureIntentId ? await client.readAgentFuturePromptIntent(target.agentSessionId, target.futureIntentId) : null
      return { session: { ...original, semanticStatus: observed.session.semanticStatus!,
        ...(target.futureIntentId ? { futurePromptIntents: saved ? { [target.futureIntentId]: saved } : {} } : {}) },
        observation: observed.observation, tickId, now, inputByte: cursors.get(original.run.runId) ?? 0, inputOccupied: patrolState.inputOccupied }
    },
    submitPrompt: async (control, prompt, operationId, condition, automation, _choice, authorHuman, note, sourceChannel) => {
      expect(authorHuman).toBeUndefined(); expect(automation?.isCurrent()).toBe(true)
      if ('admissionIntent' in condition) throw new Error('Patrol fixture requires the original exact conditional input binding')
      const original = (await demands.get('goal'))!.patrols!.flatMap(item => item.attempts).find(item => item.operationId === operationId)!
      expect(original.attemptedAt).toBeGreaterThan(0); expect(note).toBe(original.agentMuxNote)
      attempts.push({ operationId, agentSessionId: control.agentSessionId, runId: control.run.runId, note: note! })
      if (patrolState.loseBeforeSubmit) throw new AgentMuxError('The original Native transport outcome is unknown before this fixture returns.', 'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
      await client.submitAgentPrompt({ agentSessionId: control.agentSessionId, ...condition, operationId, prompt,
        expectedFutureIntent: automation!.futureIntent!, expectedInputByte: automation!.inputByte!, signal: automation!.signal,
        agentMuxNote: note!, ...(sourceChannel ? { sourceChannel } : {}) })
      if (patrolState.loseReceiptAfterSubmit) throw new AgentMuxError('The original Native input receipt was lost after Core committed it.', 'AGENT_PROMPT_INPUT_UNCONFIRMED', 'unknown')
    }
  }
  if (options.patrol) {
    // Original Core admission/future-intent persistence and provider Input remain
    // real. Only ctxmux transport, physical screen and native semantic events
    // are bounded test ports, never a replacement input or receipt journal.
    const boundary = inner as unknown as { kernel: { identity: unknown; list: unknown; status: unknown; input: unknown }; screenEvidence: { wait: () => Promise<number> } }
    const projection = (runId: string) => {
      const original = [...metadata.values()].find(item => item.run.runId === runId || item.retiredRuns.some(run => run.runId === runId))!
      return { runId, lifecycleOperationId: null, program: join(directory, 'isolated-native'), args: [], workspacePath: original.workspacePath, pid: 1234,
        state: runStates.get(runId) === 'exited' ? { type: 'exited', code: 0, signal: null } : { type: 'running' }, cols: 80, rows: 24,
        latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursors.get(runId) ?? 0 }
    }
    boundary.kernel.identity = () => ({ daemonInstanceId: 'isolated-goal-patrol-native', protocolVersion: 18, buildIdentity: 'controlled-native-I/O' })
    boundary.kernel.list = async () => [...runStates.keys()].map(projection)
    boundary.kernel.status = async (runId: string) => projection(runId)
    boundary.kernel.input = async (runId: string, value: { data: string; expectedByte: number }) => {
      const before = cursors.get(runId) ?? 0; expect(value.expectedByte).toBe(before)
      nativeWrites.push({ runId, ...value }); const after = before + Buffer.byteLength(value.data); cursors.set(runId, after)
      return { run: projection(runId), appliedByteRange: { startByte: before, endByte: after } }
    }
    vi.spyOn(boundary.screenEvidence, 'wait').mockResolvedValue(0)
    await setNativeState('owner', 'done'); await setNativeState('finite-worker', 'done')
    patrol = new GoalPatrolOwner(demands, patrolRuntime, readAsPerson, changed)
  }
  const patrolPort: NonNullable<ConstructorParameters<typeof GoalDelegationOwner>[7]> | undefined = options.patrol ? {
    request: (...args) => patrol!.request(...args), continue: (...args) => patrol!.continue(...args),
    report: (...args) => patrol!.report(...args), observe: (...args) => patrol!.observe(...args)
  } : undefined
  owner = new GoalDelegationOwner(demands, { agentCreation: async (_hostId, id) => (await sessions.readMetadata(id))! }, undefined,
    port, undefined, (goal, start) => starts.observe(goal, start), responsibility, patrolPort)
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'rpc.sock'), coreClients: () => [{ hostId: 'local', client }], goalDelegations: owner,
    ...(options.patrol ? { execute: (request: AgentMuxControlRequest) => useAppStore.getState().executeControl(request) } : {}) })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const cliReceipts: unknown[] = [], commandInputs: Array<{ file: string; sha256: string; input: unknown }> = []
  const exchanges: Array<{ method: string; params: unknown; response: GoalDelegationResult }> = []
  const snapshots: Array<{ id: string; inspect: unknown; delegations: unknown; sessions: SessionSnapshot[] }> = []
  let sequence = 0
  async function cli(actor: string, args: string[]) {
    const invoke = async () => {
      try {
        const { stdout } = await execute(process.execPath, [resolve('packages/core/dist/agentmux.js'), '--endpoint', 'unix:' + server.path, ...args], {
          env: { ...process.env, AGENTMUX_AGENT_SESSION_ID: actor, AGENTMUX_AGENT_CAPABILITY: credentials.get(actor)! }, maxBuffer: 4 * 1024 * 1024
        })
        const receipt = JSON.parse(stdout); cliReceipts.push({ actor, args, stdout, receipt }); return receipt
      } catch (error) {
        const failed = error as { code?: number; stderr?: string }
        let failureReceipt: unknown = failed.stderr
        try { failureReceipt = JSON.parse(failed.stderr ?? '') } catch { /* Keep exact non-JSON diagnostic, never a fabricated receipt. */ }
        cliReceipts.push({ actor, args, exitCode: failed.code, failureReceipt }); throw error
      }
    }
    if (!options.patrol) return await invoke()
    let returned: unknown, failure: unknown
    await act(async () => {
      try { returned = await invoke() } catch (error) { failure = error }
      await flushMain()
      if (useAppStore.getState().demands.goal) await refreshGoalDelegations('goal')
    })
    if (failure) throw failure
    return returned as Awaited<ReturnType<typeof invoke>>
  }
  async function action(actor: string, command: 'delegate' | 'progress' | 'report' | 'collect' | 'patrol report', input: unknown) {
    const file = join(directory, `request-${++sequence}.json`), bytes = JSON.stringify(input); await fs.writeFile(file, bytes)
    commandInputs.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), input: structuredClone(input) })
    return await cli(actor, ['goal', ...command.split(' '), '--input', file])
  }
  async function finite() {
    await demands.prepareDispatch('goal', { operationId: 'finite-start', agentSessionId: 'finite-worker', hostId: 'local', runId: 'finite-worker-run', execution: 'finite', prompt: 'Original finite task' })
    await demands.recordDispatchPhase('goal', 'finite-start', { stage: 'confirmed', receipt: { kind: 'core-prompt', itemId: 'prompt:finite-start', createdAt: Date.now() } })
  }
  async function delegate(id: string) {
    return await action('owner', 'delegate', { goalId: 'goal', intent: { operationId: 'delegate-' + id, sourceMessageId: 'source-' + id,
      hostId: 'local', ownerAgentSessionId: 'owner', ownerRunId: 'owner-run', workerAgentSessionId: id, workerRunId: id + '-run', threadId: 'thread-' + id,
      text: 'Original task for ' + id, alignmentRevision: 1, criterionIds: ['AC'] } })
  }
  const read = vi.spyOn(api.demands, 'delegation').mockImplementation(async (method, input) => {
    const response = await rpc.call(method, input)
    exchanges.push({ method, params: structuredClone(input), response: structuredClone(response) })
    return response
  })
  vi.spyOn(api.demands, 'list').mockImplementation(async () => (await demands.snapshot()).demands)
  vi.spyOn(api.demands, 'onChanged').mockImplementation(listener => { changes.add(listener); return () => changes.delete(listener) })
  if (options.patrol) vi.spyOn(api.continuousProgress, 'goals').mockResolvedValue([])
  await responsibility.start()
  await patrol?.start()
  const releaseObservation = initializeGoalResponsibilityObservation()
  cleanup.push(async () => {
    releaseObservation(); responsibility.dispose(); patrol?.dispose()
    if (patrol) await Promise.allSettled([...(patrol as unknown as { flights: Map<string, Promise<void>> }).flights.values()])
    // React consumers and the app-lifetime observer coalesce actual I/O. Drain the
    // final original read before closing its RPC transport and temporary database.
    if (useAppStore.getState().demands.goal) await refreshGoalDelegations('goal')
  })
  async function publish() {
    const scope = demandResponsibilityScope((await demands.get('goal'))!)
    await act(async () => {
      await useAppStore.getState().refreshDemand('goal')
      await vi.waitFor(() => expect(useAppStore.getState().demands.goal!.responsibility?.scope).toBe(scope))
    })
    await settle()
  }
  function emit(id: string) {
    const value = statuses.get(id)!
    for (const listener of nativeEvents) listener('local', { type: 'agent-status', agentSessionId: id,
      state: value.session.semanticStatus!.state, evidence: { source: value.session.semanticStatus!.source, observedAt: Date.now() } } as AgentMuxClientEvent)
  }
  async function flushMain() {
    do { await Promise.resolve(); await Promise.allSettled([...mainReads]); await Promise.resolve() } while (mainReads.size)
  }
  async function restartPatrol() {
    patrol!.dispose(); await Promise.allSettled([...(patrol as unknown as { flights: Map<string, Promise<void>> }).flights.values()])
    patrol = new GoalPatrolOwner(openDemandStore({ root: join(directory, 'goals') }), patrolRuntime, readAsPerson, changed); await patrol.start()
  }
  async function flushPatrol() {
    if (!patrol) return
    const pending = () => (patrol as unknown as { flights: Map<string, Promise<void>> }).flights
    do { await Promise.resolve(); await Promise.allSettled([...pending().values()]); await Promise.resolve() } while (pending().size)
  }
  function emitInput() { for (const listener of nativeEvents) listener('local', { type: 'agent-input', receipt: { ref: { key: {
    kind: 'prompt', agentSessionId: 'owner', expectedRun: metadata.get('owner')!.run, submissionId: 'original-prior-human-input' } } } } as AgentMuxClientEvent) }
  async function capture(id: string) {
    const inspect = await cli('owner', ['goal', 'inspect', '--goal', 'goal'])
    const delegations = await cli('owner', ['goal', 'delegations', '--goal', 'goal'])
    // Client projection for the recorded visual bridge; Native semantics remain
    // the same explicitly isolated source already used by the actual owners.
    const projected: SessionSnapshot[] = [...metadata.values()].map(original => ({ id: original.agentSessionId, kind: 'agent', providerId: original.providerId,
      executorId: original.executorId, hostId: 'local', workspacePath: original.workspacePath, label: original.agentSessionId,
      createdAt: original.createdAt, updatedAt: original.updatedAt, agentSessionUpdatedAt: original.updatedAt, processState: runStates.get(original.run.runId) ?? 'running',
      latestOutputBytes: 0, status: statuses.get(original.agentSessionId)!.session.semanticStatus!, capabilities: statuses.get(original.agentSessionId)!.capabilities,
      control: { kind: 'agent', hostId: 'local', agentSessionId: original.agentSessionId, run: original.run } }))
    const value = { id, inspect, delegations, sessions: structuredClone(projected) }; snapshots.push(value); return value
  }
  async function exportJourney(source: NonNullable<Awaited<ReturnType<typeof evidence>>>, phases: { initialSnapshotId: string; deliveredSnapshotId: string; reportedSnapshotId: string }) {
    const patrol = exchanges.find(item => item.method === 'goal.patrol')
    expect(patrol).toBeDefined()
    const bytes = JSON.stringify({ schema: 'agentmux.goal-responsibility-visual-source.v1', source, config, snapshots,
      journey: { ...phases, patrol }, recordingBoundary: 'Recorded original CLI stdout and exact GUI RPC exchanges. The visual client may replay these immutable responses only; it must not resubmit Native input or fabricate new business receipts. Config and Session snapshots are isolated client projections, not observed live Runtime.' }, null, 2) + '\n'
    const file = join(process.env.AGENTMUX_GOAL_PATROL_RECEIPT_DIR!, 'journey.json'); await fs.writeFile(file, bytes)
    await fs.writeFile(file + '.sha256', createHash('sha256').update(bytes).digest('hex') + '\n')
  }
  async function proof() { return { goal: await demands.get('goal'), trace, cliReceipts, commandInputs, exchanges, snapshots, nativeInputs, attempts, nativeWrites,
    originalPmMetadata: await sessions.readMetadata('owner'), stopCalls: stop.mock.calls.length, dom: container.innerHTML } }
  return { directory, demands, sessions, client, metadata, statuses, runStates, nativeInputs, stop, cli, action, delegate, finite, publish, emit,
    read, proof, rpc, flushMain, patrolState, attempts, nativeWrites, setNativeState, advanceSession, restartPatrol, emitInput, flushPatrol, capture, exportJourney }
}

export { root, container, cleanup, fixture, semantic, record, mount, settle, evidence }
