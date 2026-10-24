import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDemandStore } from '../../demand/src/demand-store.js'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server'
import { AgentMuxRpcService } from '../src/public-rpc-service'
import { connectAgentMuxRpc } from '../src/public-rpc-client'
import { rpcControlRequest, rpcControlResult } from '../src/rpc-business-codec'
import type { AgentMuxControlRequest, AgentMuxControlResult, AgentMuxDemand } from '../src/control'
import { ObjectCliProbe, runCompiledObjectCli, objectCliEnvironment } from './helpers/object-cli-rpc'

const goal: AgentMuxDemand = { id: 'exact-goal', title: 'Original', description: 'User words', status: 'done', priority: 'normal', projectId: null, projectName: null, sessionIds: [], assigneeSessionIds: [], supervisorSessionId: null, participations: [], createdAt: 1, updatedAt: 2, source: 'default-topic', alignment: { revision: 3, summary: 'Current proposal', criteria: [{ id: 'c', text: 'Actual outcome' }], openQuestions: [], confirmedAt: 5 }, grounding: { alignmentRevision: 3, submissionId: 'exact-report', summary: 'Actual result', checks: [{ criterionId: 'c', outcome: 'met', evidence: ['actual.log'], note: '' }], acceptedAt: 7 } }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function original(request: AgentMuxControlRequest): AgentMuxControlResult {
  if (request.operation === 'demand.create') {
    const { alignment: _alignment, grounding: _grounding, ...pending } = goal
    const demand = { ...pending, id: request.demandId ?? 'owner-generated', title: request.title, description: request.description ?? '', status: 'backlog' as const }
    return { operation: request.operation, demand, receipt: { demandId: demand.id, createdAt: demand.createdAt } }
  }
  if (request.operation === 'demand.discuss') return { operation: request.operation, demand: goal, receipt: { demandId: goal.id, requestId: request.requestId, mode: request.mode, tabId: 'original-tab', regionId: 'original-region', hostId: null, agentSessionId: null } }
  if (request.operation === 'demand.confirm') return { operation: request.operation, demand: goal, receipt: { demandId: goal.id, confirmedRevision: 3, confirmedAt: 5 } }
  if (request.operation === 'demand.accept') return { operation: request.operation, demand: goal, receipt: { demandId: goal.id, alignmentRevision: 3, submissionId: 'exact-report', acceptedAt: 7, acceptedWithGaps: false } }
  throw new Error('Unexpected original request ' + request.operation)
}

it.each(['goal.confirm', 'goal.accept'] as const)('%s requires an authenticated human principal before forwarding or execution', async method => {
  const forward = vi.fn(), execute = vi.fn()
  const service = new AgentMuxRpcService({ forwardControl: forward, execute, coreClients: () => [] })
  const input = method === 'goal.confirm' ? { goalId: goal.id, expectedRevision: 3 } : { goalId: goal.id, expectedAlignmentRevision: 3, expectedSubmissionId: 'exact-report', acceptGaps: false, finish: true }
  for (const context of [{}, { principal: { kind: 'user', id: '' } }, { principal: { kind: 'device', id: '  ' } }, { principal: { kind: 'user', id: 'bad\0id' } }, { principal: { kind: 'user', id: {} } }, { principal: { kind: 'agent', id: 'claim' } }, { principal: { kind: 'user', id: 'person' }, caller: { agentSessionId: 'managed', capability: 'agent-token' } }]) {
    await expect(service.call(method, input as any, context as any)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  }
  expect(forward).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled()
  forward.mockResolvedValue({ original: true })
  await service.call(method, input as any, { principal: { kind: 'device', id: 'approved-phone' } })
  expect(forward).toHaveBeenCalledTimes(1)
})

it('strict request codecs reject malformed CAS and never take authority from business fields', async () => {
  for (const revision of [0, -1, 1.5, '3', Infinity]) expect(() => rpcControlRequest('goal.confirm', { goalId: goal.id, expectedRevision: revision })).toThrow()
  for (const params of [{ expectedSubmissionId: '' }, { acceptGaps: 'yes' }, { finish: 'yes' }, { finish: null }, { caller: { kind: 'user' } }]) expect(() => rpcControlRequest('goal.accept', { goalId: goal.id, expectedAlignmentRevision: 3, expectedSubmissionId: 'exact-report', acceptGaps: false, ...params })).toThrow()
  expect(() => rpcControlRequest('goal.discuss', { goalId: goal.id, mode: 'execute' })).toThrow()
})

it('actual Unix CLI discovers and calls the three typed methods with exact business receipts', async () => {
  const root = await mkdtemp(fixturePath("tmp/gack-")), path = join(root, 'owner.sock')
  const execute = vi.fn(async (request: AgentMuxControlRequest) => original(request))
  const owner = new AgentMuxControlServer({ socketPath: path, coreClients: () => [], execute })
  await owner.start(); cleanups.push(async () => { await owner.stop(); await rm(root, { recursive: true, force: true }) })
  const env = objectCliEnvironment(root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + path })
  const help = await runCompiledObjectCli(['--help'], env)
  expect(help.code).toBe(0); expect(help.stdout).toContain('goal')
  const skill = await runCompiledObjectCli(['goal', '--help'], env)
  expect(skill.code).toBe(0); for (const name of ['goal discuss', 'goal confirm', 'goal accept']) expect(skill.stdout).toContain(name); expect(skill.stdout).toContain('authenticated person')
  const cases = [
    ['goal', 'discuss', '--goal', goal.id, '--mode', 'open', '--operation-id', 'open-op'],
    ['goal', 'confirm', '--goal', goal.id, '--revision', '3', '--operation-id', 'confirm-op'],
    ['goal', 'accept', '--goal', goal.id, '--revision', '3', '--submission', 'exact-report', '--operation-id', 'accept-op']
  ]
  const results = []
  for (const args of cases) { const response = await runCompiledObjectCli(args, env); expect(response.code, response.stderr).toBe(0); results.push(JSON.parse(response.stdout)) }
  expect(execute.mock.calls.map(([request]) => request.operation)).toEqual(['demand.discuss', 'demand.confirm', 'demand.accept'])
  expect(execute.mock.calls.map(([request]) => request.requestId)).toEqual(['open-op', 'confirm-op', 'accept-op'])
  expect(results[0]).toMatchObject({ result: { receipt: { goalId: goal.id, operationId: 'open-op', mode: 'open', tabId: 'original-tab', regionId: 'original-region', hostId: null, agentSessionId: null } } })
  expect(JSON.stringify(results)).not.toContain('requestId')
  expect(results[1]).toMatchObject({ result: { receipt: { confirmedRevision: 3, confirmedAt: 5 } } })
  expect(results[2]).toMatchObject({ result: { receipt: { submissionId: 'exact-report', acceptedAt: 7, acceptedWithGaps: false } } })
  const create = await runCompiledObjectCli(['goal', 'create', '--goal', 'held-before-save', '--title', 'Untitled goal', '--risk', 'low', '--confirm', 'user', '--operation-id', 'held-create'], env)
  expect(create.code, create.stderr).toBe(0)
  expect(execute.mock.calls.at(-1)![0]).toMatchObject({ operation: 'demand.create', demandId: 'held-before-save', title: 'Untitled goal' })
  expect(JSON.parse(create.stdout)).toMatchObject({ result: { goal: { id: 'held-before-save' }, receipt: { goalId: 'held-before-save' } } })
}, 15_000)

it.each([
  ['goal.discuss', { goalId: goal.id, mode: 'grill', operationId: 'original-op' }, (r: any) => { r.receipt.operationId = 'another-op' }],
  ['goal.discuss', { goalId: goal.id, mode: 'grill' }, (r: any) => { r.receipt.mode = 'open' }],
  ['goal.discuss', { goalId: goal.id, mode: 'open' }, (r: any) => { delete r.receipt.regionId }],
  ['goal.discuss', { goalId: goal.id, mode: 'open' }, (r: any) => { r.receipt.hostId = 'unrelated-execution-host' }],
  ['goal.confirm', { goalId: goal.id, expectedRevision: 3 }, (r: any) => { r.receipt.confirmedRevision = 4 }],
  ['goal.confirm', { goalId: goal.id, expectedRevision: 3 }, (r: any) => { r.goal.id = 'another-goal' }],
  ['goal.accept', { goalId: goal.id, expectedAlignmentRevision: 3, expectedSubmissionId: 'exact-report', acceptGaps: false, finish: true }, (r: any) => { r.goal.status = 'in_progress' }],
  ['goal.accept', { goalId: goal.id, expectedAlignmentRevision: 3, expectedSubmissionId: 'exact-report', acceptGaps: false }, (r: any) => { r.receipt.submissionId = 'another-result' }],
  ['goal.accept', { goalId: goal.id, expectedAlignmentRevision: 3, expectedSubmissionId: 'exact-report', acceptGaps: false }, (r: any) => { r.goal.grounding.acceptedAt = 9 }]
  , ['goal.create', { goalId: 'held-original', title: 'Untitled goal', risk: 'low', confirmation: 'user' }, (r: any) => { r.goal.id = 'another-original'; r.receipt.goalId = 'another-original' }]
] as const)('actual SDK rejects mismatched owner receipt %s', async (method, params, corrupt) => {
  const fixture = new ObjectCliProbe(async request => {
    const service = new AgentMuxRpcService({ execute: async request => original(request), coreClients: () => [] })
    const result = await service.call(method, request.params as any, { principal: { kind: 'user', id: 'private-human' } })
    const copy = structuredClone(result); corrupt(copy); return copy
  }); await fixture.start(); cleanups.push(() => fixture.stop())
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: fixture.socketPath } }); cleanups.push(() => client.dispose())
  await expect(client.call(method, params as any)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(fixture.requests).toHaveLength(1)
})

it('HTTP without transport authorization cannot invoke either new acknowledgement owner', async () => {
  const root = await mkdtemp(fixturePath("tmp/gack-http-")), execute = vi.fn()
  const server = new AgentMuxControlServer({ socketPath: join(root, 's.sock'), coreClients: () => [], execute, http: { host: '127.0.0.1', port: 0, token: 'approved-human-token' } })
  await server.start(); cleanups.push(async () => { await server.stop(); await rm(root, { recursive: true, force: true }) })
  for (const method of ['goal.confirm', 'goal.accept']) {
    const response = await fetch(`http://127.0.0.1:${server.httpAddress!.port}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'unauthorized', method, params: { goalId: goal.id, expectedRevision: 3 } }) })
    expect(response.status).toBe(401)
  }
  expect(execute).not.toHaveBeenCalled()
})


it('actual CLI and SDK distinguish accepting from finishing through the original durable owner and preserve human authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goal-close-')), socketPath = join(root, 'owner.sock')
  const store = openDemandStore({ root: join(root, 'goals') })
  await store.create({ id: 'finish-goal', title: 'Reviewed outcome', status: 'in_progress', sessionIds: ['original-session'] })
  await store.proposeAlignment('finish-goal', { summary: 'Original agreement', criteria: [{ id: 'c', text: 'Observable result' }], openQuestions: [] })
  await store.confirmAlignment('finish-goal', 1)
  const report = await store.proposeGrounding('finish-goal', { alignmentRevision: 1, summary: 'Observed with a known gap', checks: [{ criterionId: 'c', outcome: 'gap', evidence: ['result.log'], note: 'A reviewed limitation remains.' }] })
  const submission = report.demand.grounding!.submissionId
  const execute = vi.fn(async (request: AgentMuxControlRequest): Promise<AgentMuxControlResult> => {
    if (request.operation !== 'demand.accept') throw new Error('Only original acceptance is expected')
    const result = await store.acceptGrounding(request.demandId, request.expectedAlignmentRevision, request.expectedSubmissionId, request.acceptGaps, request.finish)
    return { operation: request.operation, demand: { ...result.demand, source: 'session' }, receipt: { demandId: result.demand.id,
      alignmentRevision: result.demand.grounding!.alignmentRevision, submissionId: result.demand.grounding!.submissionId,
      acceptedAt: result.demand.grounding!.acceptedAt!, acceptedWithGaps: request.acceptGaps } }
  })
  const server = new AgentMuxControlServer({ socketPath, coreClients: () => [], execute })
  await server.start(); cleanups.push(async () => { await server.stop(); await rm(root, { recursive: true, force: true }) })
  const env = objectCliEnvironment(root, { AGENTMUX_RPC_ENDPOINT: 'unix:' + socketPath })
  const args = ['goal', 'accept', '--goal', 'finish-goal', '--revision', '1', '--submission', submission, '--accept-gaps']
  const help = await runCompiledObjectCli(['goal', 'accept', '--help'], env)
  expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('--finish')
  const before = await store.snapshot()
  const denied = await runCompiledObjectCli([...args, '--finish'], { ...env, AGENTMUX_AGENT_SESSION_ID: 'managed-agent', AGENTMUX_AGENT_CAPABILITY: 'managed-capability' })
  expect(denied.code).not.toBe(0); expect(execute).not.toHaveBeenCalled()
  expect(await store.snapshot()).toEqual(before)
  const accepted = await runCompiledObjectCli(args, env)
  expect(accepted.code, accepted.stderr).toBe(0)
  expect(JSON.parse(accepted.stdout)).toMatchObject({ result: { goal: { status: 'in_progress' }, receipt: { acceptedWithGaps: true } } })
  const first = (await store.get('finish-goal'))!
  const finished = await runCompiledObjectCli([...args, '--finish'], env)
  expect(finished.code, finished.stderr).toBe(0)
  expect(execute.mock.calls.at(-1)![0]).toMatchObject({ operation: 'demand.accept', finish: true, acceptGaps: true })
  expect(JSON.parse(finished.stdout)).toMatchObject({ result: { goal: { status: 'done', grounding: first.grounding }, receipt: { acceptedAt: first.grounding!.acceptedAt, acceptedWithGaps: true } } })
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanups.push(() => client.dispose())
  const repeated = await client.call('goal.accept', { goalId: 'finish-goal', expectedAlignmentRevision: 1, expectedSubmissionId: submission, acceptGaps: true, finish: true })
  const restored = (await openDemandStore({ root: join(root, 'goals') }).get('finish-goal'))!
  expect(repeated.goal).toMatchObject({ status: 'done', sessionIds: ['original-session'], grounding: first.grounding })
  expect(restored.grounding).toEqual(first.grounding)
  expect(restored.activities.filter(activity => activity.kind === 'results-accepted')).toHaveLength(1)
  expect(execute.mock.calls.every(([request]) => request.operation === 'demand.accept')).toBe(true)
}, 30_000)
