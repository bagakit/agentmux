import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { AgentMuxControlServer, AgentMuxError, AgentMuxSpatialStateStore, ConversationLandmarkStore, callPublicGoalControl, connectAgentMuxRpc,
  type AgentMuxHeadlessRuntime, type AgentMuxRpcCallContext, type AgentMuxRpcMethod, type AgentMuxRpcParams, type AgentMuxRpcResult } from '@agentmux/core'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core/control'
import { publicGoalRecord } from '@agentmux/host/goal-projection'
import { readPresentationConfiguration } from '@agentmux/host/presentation-configuration'
import { projectWorkspaces } from '@agentmux/host/workspace-projects'
import { createHostGoals } from '../../../host/src/goals.js'
import { api } from '../../src/renderer/src/lib/api'
import type { AppConfig } from '../../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../../src/shared/scratch-topics'

type GoalRequest = Extract<AgentMuxControlRequest, { operation: `demand.${string}` }>
export type GoalOperation = GoalRequest['operation']
type RequestFor<O extends GoalOperation> = Extract<GoalRequest, { operation: O }>
/** One transport outcome for the next matching renderer request; the Host owner is never replaced. */
export type GoalTransportFault =
  /** Fails before the Host owner is reached; nothing is written. */
  | { kind: 'reject'; error?: Error }
  /** The Host owner commits the write, then its receipt is lost on the way back. */
  | { kind: 'lose-receipt'; error?: Error }
  /** Holds the request before the Host owner is reached until `release()`. */
  | { kind: 'hold-request' }
  /** The Host owner commits the write; its receipt is held until `release()`. */
  | { kind: 'hold-receipt' }
export type GoalTransportGate = {
  /** Resolves when the matching renderer request arrives. */
  reached: Promise<void>
  /** Resolves with the Host owner's committed result (lose-receipt and hold-receipt). */
  committed: Promise<AgentMuxControlResult>
  release(): void
}

/**
 * Renderer `api.goals.execute` and `api.demands.list` go through the same public
 * Goal codec Main uses (`callPublicGoalControl` and `goal.ls` + `publicGoalRecord`)
 * over a real Unix JSON-RPC server to the original Host Goal owner and its durable
 * Demand store. Only Electron IPC is replaced: its error serialization and sender
 * checks are outside this fixture. Native Runtime and Core calls are unavailable
 * unless a test supplies its own ports.
 */
export async function openHostGoalTransport(options: {
  /** Main's published configuration; a function is re-read before every request, the way Main persists it first. */
  config: AppConfig | (() => AppConfig | null)
  runtime?: () => AgentMuxHeadlessRuntime
  coreCall?: <M extends AgentMuxRpcMethod>(hostId: string, method: M, params: AgentMuxRpcParams<M>, context: AgentMuxRpcCallContext) => Promise<AgentMuxRpcResult<M>>
}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'amux-host-goal-'))
  const configurationPath = join(directory, 'configuration.json')
  let written: string | undefined
  const persistConfig = async () => {
    const value = typeof options.config === 'function' ? options.config() : options.config
    if (!value) throw new Error('The test has not published an AppConfig for the Host Goal owner.')
    const bytes = JSON.stringify({ ...value, executors: value.executors ?? {} })
    if (bytes !== written) { await writeFile(configurationPath, bytes); written = bytes }
  }
  await persistConfig()
  const unavailable = () => { throw new AgentMuxError('The original Host is not yet available. Original operations and healthy Agents are retained.', 'CONTROL_UNAVAILABLE') }
  const hostGoals = createHostGoals({ configurationPath, spatial: new AgentMuxSpatialStateStore(join(directory, 'spatial-state.json')),
    runtime: options.runtime ?? unavailable,
    // The same Project projection the original Host composes (apps/host/src/host.ts).
    projects: async () => projectWorkspaces((await readPresentationConfiguration(configurationPath)).workspaces.filter(workspace => workspace.id !== SCRATCH_WORKSPACE_ID))
      .map(project => ({ projectId: project.id, name: project.name })),
    coreCall: options.coreCall ?? (async () => unavailable()) })
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'rpc.sock'), coreClients: () => [],
    spatialState: new AgentMuxSpatialStateStore(join(directory, 'spatial-state.json')), conversationLandmarks: new ConversationLandmarkStore(join(directory, 'landmarks.json')),
    goalControl: hostGoals.execute, goalChanges: hostGoals.goalChanges, goalParticipation: hostGoals.participation })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })

  const requests: GoalRequest[] = []
  const faults: Array<{ operation: GoalOperation; match: (request: GoalRequest) => boolean; fault: GoalTransportFault;
    arrive(): void; commit(result: AgentMuxControlResult): void; fail(error: unknown): void; released: Promise<void>; release(): void }> = []
  const inflight = new Set<Promise<unknown>>()
  const persistent = new Set<{ operation: GoalOperation; error: Error }>()
  const track = <T>(value: Promise<T>): Promise<T> => {
    inflight.add(value); void value.finally(() => inflight.delete(value)).catch(() => {})
    return value
  }
  const owner = async (request: AgentMuxControlRequest) => {
    await persistConfig()
    return await callPublicGoalControl(request, (method, params) => rpc.call(method, params as never))
  }
  const execute = vi.spyOn(api.goals, 'execute').mockImplementation(request => track((async () => {
    requests.push(structuredClone(request) as GoalRequest)
    for (const entry of persistent) if (entry.operation === request.operation) throw entry.error
    const index = faults.findIndex(item => item.operation === request.operation && item.match(request as GoalRequest))
    const gate = index < 0 ? undefined : faults.splice(index, 1)[0]!
    gate?.arrive()
    if (!gate) return await owner(request)
    const { fault } = gate
    if (fault.kind === 'reject') throw fault.error ?? new Error('The Goal request transport failed before the original Host owner received it.')
    if (fault.kind === 'hold-request') await gate.released
    let result: AgentMuxControlResult
    try { result = await owner(request) } catch (error) { gate.fail(error); throw error }
    gate.commit(result)
    if (fault.kind === 'lose-receipt') throw fault.error ?? new Error('The original Host owner committed this Goal request, but its receipt was lost.')
    if (fault.kind === 'hold-receipt') await gate.released
    return result
  })()))
  const list = vi.spyOn(api.demands, 'list').mockImplementation(() => track((async () => {
    await persistConfig()
    return (await rpc.call('goal.ls', { all: true })).goals.map(publicGoalRecord)
  })()))

  return {
    directory, configurationPath, hostGoals,
    /** The Host's original durable Demand store, for seeding and reading committed facts. */
    demands: hostGoals.demands,
    execute, list, rpc,
    /** Every renderer request for an operation, in order, including faulted ones. */
    executed<O extends GoalOperation>(operation: O): RequestFor<O>[] {
      return requests.filter((request): request is RequestFor<O> => request.operation === operation)
    },
    /** The business fields of each request, without its envelope and random request ID. */
    bodies<O extends GoalOperation>(operation: O): Array<Omit<RequestFor<O>, 'schemaVersion' | 'requestId'>> {
      return this.executed(operation).map(({ schemaVersion: _schema, requestId: _id, ...body }) => body as Omit<RequestFor<O>, 'schemaVersion' | 'requestId'>)
    },
    /** Reject every matching request before the owner until the returned release is called. */
    failAll<O extends GoalOperation>(operation: O, error: Error): () => void {
      const entry = { operation, error }
      persistent.add(entry)
      return () => { persistent.delete(entry) }
    },
    /** Forget recorded requests (seeding writes), keeping pending faults. */
    clear() { requests.splice(0) },
    once<O extends GoalOperation>(operation: O, fault: GoalTransportFault, match: (request: RequestFor<O>) => boolean = () => true): GoalTransportGate {
      let arrive!: () => void, commit!: (result: AgentMuxControlResult) => void, fail!: (error: unknown) => void, release!: () => void
      const reached = new Promise<void>(resolve => { arrive = resolve })
      const committed = new Promise<AgentMuxControlResult>((resolve, reject) => { commit = resolve; fail = reject }); void committed.catch(() => {})
      const released = new Promise<void>(resolve => { release = resolve })
      faults.push({ operation, match: match as (request: GoalRequest) => boolean, fault, arrive, commit, fail, released, release })
      return { reached, committed, release }
    },
    /** Await every in-flight renderer request. Release held gates first. */
    async settle() {
      for (let round = 0; round < 8; round++) { await Promise.resolve(); if (!inflight.size) return; await Promise.allSettled([...inflight]) }
    },
    async dispose() {
      for (const gate of faults.splice(0)) gate.release()
      await this.settle()
      const failures: unknown[] = []
      for (const release of [() => rpc.dispose(), () => server.stop(), () => hostGoals.dispose(), () => rm(directory, { recursive: true, force: true })]) {
        try { await release() } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'The Host Goal transport fixture did not dispose cleanly.')
    }
  }
}
export type HostGoalTransport = Awaited<ReturnType<typeof openHostGoalTransport>>
