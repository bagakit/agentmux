// @vitest-environment happy-dom
import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rpcControlRequest } from '../../../packages/core/src/rpc-business-codec.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc'
import { injectedContextCore } from './helpers/injected-context-core'
import { openHostGoalTransport } from './helpers/host-goal-transport'
import { useAppStore } from '../src/renderer/src/store'
import type { AppConfig } from '../src/shared/contracts'

const initial = useAppStore.getState()
let root: string, core: Awaited<ReturnType<typeof injectedContextCore>>, host: Awaited<ReturnType<typeof openHostGoalTransport>>
let session: Awaited<ReturnType<typeof core.core.createAgent>>
const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private Host' }], workspaces: [], executors: {} } as unknown as AppConfig
const retained = { draft: 'My healthy unsent draft', queue: [{ operationId: 'manual-original', text: 'My queued manual input', origin: 'manual' }] }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'goal-confirmed-input-'))
  const asset = process.env.AGENTMUX_PRIVATE_LISTENER_ASSET
  core = await injectedContextCore(root)
  if (asset) vi.stubEnv('AGENTMUX_PRIVATE_LISTENER_ASSET', asset)
  vi.spyOn((core.core as unknown as { screenEvidence: { wait(): Promise<number> } }).screenEvidence, 'wait').mockResolvedValue(0)
  session = await core.core.createAgent({ agentSessionId: 'original-worker', providerId: 'codex', executorId: 'private', workspacePath: root,
    createOperationId: 'fixture-original-worker', injectAgentMuxGuide: false })
  host = await openHostGoalTransport({ config, runtime: () => ({ client: core.core }) as never })
  await seedStoredDemand(host.demands, { id: 'original-goal', title: 'Original task', description: 'Original exact input', assigneeSessionIds: [session.agentSessionId], supervisorSessionId: session.agentSessionId })
  await host.demands.proposeAlignment('original-goal', { summary: 'Original work', criteria: [{ id: 'original', text: 'Original result' }], openQuestions: [] })
  await host.demands.confirmAlignment('original-goal', 1)
  useAppStore.setState({ config, demands: {}, sessions: [], agentComposerDrafts: { 'original-worker': retained.draft },
    agentSteerQueues: { 'original-worker': structuredClone(retained.queue) as never } })
})
afterEach(async () => {
  try { await host?.dispose(() => core.dispose()) } finally { await rm(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); useAppStore.setState(initial, true) }
})
async function cli(method: 'start' | 'inspect', input: { goalId: string; sessionId?: string; operationId?: string; dispatchOperationId?: string; continuation?: { intervalMs: number; alignmentRevision: number } }) {
  const flags = ['--goal', input.goalId, ...(input.sessionId ? ['--session', input.sessionId] : []),
    ...(input.operationId ? ['--operation-id', input.operationId] : []), ...(input.dispatchOperationId ? ['--dispatch-operation', input.dispatchOperationId] : []),
    ...(input.continuation ? ['--continue-ms', String(input.continuation.intervalMs), '--alignment-revision', String(input.continuation.alignmentRevision)] : [])]
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, ['--experimental-transform-types', '--import', resolve('apps/host/test/goal-cross-host-node-loader.mjs'),
      resolve('packages/core/bin/amux'), '--endpoint', 'unix:' + join(host.directory, 'rpc.sock'), 'goal', method, ...flags], {
      env: objectCliEnvironment(root, process.env.GOAL_PLAN_DISCOVERY_CLI_LOADED ? { GOAL_CROSS_HOST_LOADED: process.env.GOAL_PLAN_DISCOVERY_CLI_LOADED } : {}), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', bytes => stdout += bytes); child.stderr.setEncoding('utf8').on('data', bytes => stderr += bytes)
    child.once('error', reject); child.once('close', code => accept({ code, stdout, stderr })); child.stdin.end(JSON.stringify(input))
  })
  expect(result.code, result.stderr || result.stdout).toBe(0)
  const envelope = JSON.parse(result.stdout); expect(envelope.ok).toBe(true); return envelope.result
}
async function unchanged(writes: string[], operationId: string) {
  expect(core.writes).toEqual(writes)
  expect(useAppStore.getState().agentComposerDrafts['original-worker']).toBe(retained.draft)
  expect(useAppStore.getState().agentSteerQueues['original-worker']).toEqual(retained.queue)
  expect((await core.core.readAgentSession(session.agentSessionId))!.run).toEqual(session.run)
  expect(core.stop).not.toHaveBeenCalled()
  expect((await host.demands.get('original-goal'))!.dispatches).toHaveLength(1)
  expect((await host.demands.get('original-goal'))!.dispatches![0]).toMatchObject({ operationId, runId: session.run.runId, agentSessionId: session.agentSessionId })
}
for (const execution of ['finite', 'continue'] as const) it(`the actual public ${execution} Start confirms one original Core input and a replay preserves manual drafts, queues and Run`, async () => {
  const operationId = 'original-' + execution, input = { goalId: 'original-goal', sessionId: session.agentSessionId, operationId,
    ...(execution === 'continue' ? { continuation: { intervalMs: 60_000, alignmentRevision: 1 } } : {}) }
  await cli('start', input)
  const writes = [...core.writes]; expect(writes.length).toBeGreaterThan(0)
  expect(await host.demands.inspectDispatch('original-goal', operationId)).toMatchObject({ stage: 'confirmed', receipt: { kind: 'core-prompt', itemId: 'prompt:' + operationId } })
  await useAppStore.getState().executeControl(rpcControlRequest('goal.start', input))
  await unchanged(writes, operationId)
})

for (const variant of ['missing', 'inspect-failed', 'still-unknown', 'different-operation', 'different-goal', 'wrong-run'] as const)
  it(`the public dispatch reader retains the original unknown input for ${variant} without submission`, async () => {
    const operationId = 'original-unknown', prompt = 'Original exact input'
    await host.demands.prepareDispatch('original-goal', { operationId, prompt, hostId: 'local', agentSessionId: session.agentSessionId,
      runId: session.run.runId, execution: 'finite' })
    await host.demands.recordDispatchPhase('original-goal', operationId, { stage: 'unknown', issue: 'Original transport observation unavailable' })
    if (variant === 'inspect-failed') vi.spyOn(core.core, 'sessionTimeline').mockRejectedValueOnce(new Error('Original timeline observation unavailable'))
    if (variant === 'different-operation' || variant === 'different-goal') {
      await seedStoredDemand(host.demands, { id: 'other-goal', title: 'Other task', description: 'Original exact input', assigneeSessionIds: [session.agentSessionId] })
      await host.rpc.call('goal.start', { goalId: variant === 'different-goal' ? 'other-goal' : 'original-goal', sessionId: session.agentSessionId, operationId: 'another-start' })
    }
    const writes = [...core.writes]
    if (variant === 'wrong-run') {
      const status = await core.core.statusAgent(session.agentSessionId)
      vi.spyOn(core.core, 'statusAgent').mockResolvedValueOnce({ ...status, session: { ...status.session, run: { runId: 'another-observed-run' } } })
      await expect(host.rpc.call('goal.start', { goalId: 'original-goal', sessionId: session.agentSessionId, operationId })).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
    } else await expect(host.rpc.call('goal.inspect', { goalId: 'original-goal', dispatchOperationId: variant === 'missing' ? 'missing-start' : operationId })).rejects.toThrow()
    expect(await host.demands.inspectDispatch('original-goal', operationId)).toMatchObject({ stage: 'unknown', runId: session.run.runId, operationId, prompt })
    // Other operations may coexist; inspect must retain the selected one exactly.
    expect(core.writes).toEqual(writes); expect(core.stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentComposerDrafts['original-worker']).toBe(retained.draft)
    expect(useAppStore.getState().agentSteerQueues['original-worker']).toEqual(retained.queue)
    expect((await core.core.readAgentSession(session.agentSessionId))!.run).toEqual(session.run)
  })

it('only the exact original Core prompt receipt confirms a selected prepared Goal dispatch', async () => {
  const operationId = 'original-selected', prompt = 'Original selected task'
  await host.demands.prepareDispatch('original-goal', { operationId, prompt, hostId: 'local', agentSessionId: session.agentSessionId, runId: session.run.runId, execution: 'finite' })
  await expect(host.rpc.call('goal.inspect', { goalId: 'original-goal', dispatchOperationId: operationId })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  const writes = [...core.writes]
  await core.core.submitAgentPrompt({ agentSessionId: session.agentSessionId, prompt, operationId, expectedRun: session.run, afterSubmissionId: null })
  expect(core.writes.length).toBeGreaterThan(writes.length)
  const accepted = [...core.writes], result = await cli('inspect', { goalId: 'original-goal', dispatchOperationId: operationId })
  expect(result.goal.dispatches).toMatchObject([{ operationId, stage: 'confirmed', receipt: { itemId: 'prompt:' + operationId } }])
  await unchanged(accepted, operationId)
})

it('the public Start refuses an operation belonging to another Goal without input or relationship changes', async () => {
  const operationId = 'original-owned-start'
  await host.rpc.call('goal.start', { goalId: 'original-goal', sessionId: session.agentSessionId, operationId })
  await seedStoredDemand(host.demands, { id: 'other-goal', title: 'Other task', description: 'Original exact input', assigneeSessionIds: [session.agentSessionId] })
  const before = await host.demands.snapshot(), writes = [...core.writes]
  await expect(host.rpc.call('goal.start', { goalId: 'other-goal', sessionId: session.agentSessionId, operationId })).rejects.toThrow()
  expect(await host.demands.snapshot()).toEqual(before)
  await unchanged(writes, operationId)
})
