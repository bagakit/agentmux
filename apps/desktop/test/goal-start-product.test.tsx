// @vitest-environment happy-dom
import './helpers/current-demand-product'
import { bridge, demands, directory, client, runtime, session, writes, sourceCli, root } from './helpers/current-demand-product'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { isAgentMuxRpcMethod, AGENTMUX_RPC_NATIVE_METHODS } from '../../../packages/core/src/public-rpc'
import { api } from '../src/renderer/src/lib/api'
import { GoalStartResponsibilityOwner } from '../src/main/goal-start-responsibility'

it('original Source CLI finite Start → actual Core prompt receipt → ended original Run → public Goal responsibility → existing Goal proposal remains pending human review', async () => {
  await act(async () => root.render(null))
  expect(isAgentMuxRpcMethod('goal.delegations'), JSON.stringify(Object.keys(AGENTMUX_RPC_NATIVE_METHODS))).toBe(true)
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'start-responsibility.sock'), coreClients: () => [{ hostId: 'local', client }],
    execute: (...args) => bridge.controlOptions.execute(...args), goalDelegations: bridge.controlOptions.goalDelegations })
  await server.start()
  const service = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const owner = new GoalStartResponsibilityOwner(demands, runtime, vi.fn())
  try {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
    const cli = async (args: string[]) => {
      const envelope = JSON.parse((await promisify(execFile)(process.execPath, [sourceCli, '--endpoint', 'unix:' + server.path, ...args], { env: environment, timeout: 15_000 })).stdout)
      expect(envelope.ok).toBe(true); return envelope.result
    }
    const started = await cli(['goal', 'start', '--goal', 'goal', '--session', session.agentSessionId, '--operation-id', 'original-finite-start'])
    const start = (await demands.inspectDispatch('goal', 'original-finite-start'))!
    expect(start).toMatchObject({ execution: 'finite', agentSessionId: session.agentSessionId, runId: session.run.runId, hostId: 'local', stage: 'confirmed', resultBasis: { alignmentRevision: 1, groundingSubmissionId: null } })
    expect(started.goal.dispatches).toEqual([start])
    const input = await client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: start.agentSessionId, expectedRun: { runId: start.runId }, submissionId: start.operationId })
    expect(input!.admission).toMatchObject({ acknowledged: true, submissionId: start.operationId })
    const accepted = [...writes]
    vi.spyOn(runtime, 'observeOriginalRun').mockResolvedValue({ runId: start.runId, state: 'exited' })
    const observed = await owner.observe((await demands.get('goal'))!, start)
    if (process.env.AGENTMUX_GOAL_START_RECEIPT_DIR) {
      await fs.mkdir(process.env.AGENTMUX_GOAL_START_RECEIPT_DIR, { recursive: true })
      await fs.writeFile(join(process.env.AGENTMUX_GOAL_START_RECEIPT_DIR, 'original-input-diagnostic.json'), JSON.stringify({ start, input, observed }, null, 2) + '\n')
    }
    expect(observed).toMatchObject({ input: { state: 'confirmed', proof: { operationId: start.operationId, prompt: start.prompt, agentSessionId: start.agentSessionId, runId: start.runId, acknowledged: true } }, originalRun: { runId: start.runId, state: 'exited' }, responsibility: 'original-worker-continuation' })
    const work = await cli(['goal', 'delegations', '--goal', 'goal'])
    expect(work.dispatches).toEqual([start])
    expect(work.startObservations).toEqual([expect.objectContaining({ operationId: start.operationId, input: expect.objectContaining({ state: 'confirmed' }), originalRun: { runId: start.runId, state: 'exited' }, responsibility: 'original-worker-continuation' })])
    const rendererRead = await api.demands.delegation('goal.delegations', { goalId: 'goal' })
    expect(rendererRead.startObservations).toEqual(work.startObservations)
    await owner.start()
    await vi.waitFor(async () => expect((await owner.observe((await demands.get('goal'))!, start)).unknown).toContain('same ended'))
    expect(writes).toEqual(accepted)
    expect((await demands.get('goal'))!.delegations).toBeUndefined()
    await service.call('goal.update', { goalId: 'goal', patch: { grounding: { alignmentRevision: 1, summary: 'Original Goal result to review', checks: [{ criterionId: 'real', outcome: 'met', evidence: ['evidence/result.log:7'], note: '' }] } } })
    const result = await cli(['goal', 'delegations', '--goal', 'goal'])
    expect(result.grounding.acceptedAt).toBeNull()
    expect(result.startObservations[0]).toMatchObject({ responsibility: 'goal-result-review', goalResult: { association: 'unknown', basis: 'captured', changedSinceStart: true, grounding: { acceptedAt: null } } })
    expect((await demands.get('goal'))!.status).not.toBe('done')
    expect((await client.agentSession(session.agentSessionId)).run).toEqual(session.run)
    expect(writes).toEqual(accepted)
    const receiptDirectory = process.env.AGENTMUX_GOAL_START_RECEIPT_DIR
    if (receiptDirectory) {
      await fs.mkdir(receiptDirectory, { recursive: true })
      await fs.writeFile(join(receiptDirectory, 'original-public-start-product.json'), JSON.stringify({ schema: 'agentmux.original-finite-start-product.v1',
        proofBoundary: 'Actual Source CLI, Unix RPC, registered Main, Renderer preload/store request handler and Core prompt journal; Electron transport and Native byte IO/screen wait are fixture ports, ended Run observation is explicit. Does not claim a live Provider exit, real process recovery or visual qualification.',
        start, actualCoreInput: input, observed, publicWork: work, rendererRead, goalResult: result, nativeWritesUnchangedAfterExit: accepted }, null, 2) + '\n')
    }
  } finally { owner.dispose(); await service.dispose(); await server.stop() }
})
