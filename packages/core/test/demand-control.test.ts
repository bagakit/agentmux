import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { openDemandStore, type Demand } from '@agentmux/demand'
import { AgentMuxControlServer, parseAgentMuxControlReceipt, parseAgentMuxControlRequest, requestAgentMuxControl } from '../src/control-host.js'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxControlResult, type AgentMuxDemand } from '../src/control.js'

const base = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'task-request' }

describe('demand control contract', () => {
  it('parses demand create with an auditable decision', () => {
    const request = parseAgentMuxControlRequest({
      ...base, operation: 'demand.create', title: 'Route this request', projectId: 'repo',
      decision: {
        input: 'put this in the repo project', candidates: [{ projectId: 'repo', reason: 'matches workspace context' }],
        selectedProjectId: 'repo', risk: 'low', confirmation: 'user', wikiVersion: 'v1', recordedAt: 10, sourceSessionId: 'session-1'
      }
    })
    expect(request.operation).toBe('demand.create')
    expect('decision' in request && request.decision?.selectedProjectId).toBe('repo')
  })

  it('rejects unknown demand status before it reaches a host', () => {
    expect(() => parseAgentMuxControlRequest({ ...base, operation: 'demand.update', demandId: 'task-1', patch: { status: 'running' } })).toThrow(/Demand status is invalid/)
  })

  it('parses stable JSON demand receipts', () => {
    const receipt = parseAgentMuxControlReceipt({
      ...base, ok: true, operation: 'demand.list', result: { demands: [{ id: 'task-1', title: 'One', description: '', status: 'backlog', priority: 'normal', projectId: null, projectName: null, sessionIds: [], createdAt: 1, updatedAt: 2, source: 'default-topic' }] }
    })
    expect(receipt.ok && 'demands' in receipt.result && receipt.result.demands[0]?.id).toBe('task-1')
  })

  it('parses assignment and handoff as explicit Demand operations', () => {
    const assigned = parseAgentMuxControlRequest({ ...base, operation: 'demand.assign', demandId: 'task-1', projectId: 'repo', assigneeExecutorId: 'agent-a', start: false })
    expect(assigned.operation).toBe('demand.assign')
    expect('start' in assigned && assigned.start).toBe(false)
    const handoff = parseAgentMuxControlRequest({ ...base, operation: 'demand.handoff', demandId: 'task-1', assigneeExecutorId: 'agent-b', sessionId: 'session-b' })
    expect(handoff.operation).toBe('demand.handoff')
    expect('sessionId' in handoff && handoff.sessionId).toBe('session-b')
    const receipt = parseAgentMuxControlReceipt({
      ...base,
      ok: true,
      operation: 'demand.start',
      result: {
        demand: { id: 'task-1', title: 'One', description: '', status: 'in_progress', priority: 'normal', projectId: 'repo', projectName: 'Repo', assigneeExecutorId: 'agent-a', sessionIds: ['session-a'], createdAt: 1, updatedAt: 2, source: 'default-topic' },
        receipt: { demandId: 'task-1', startedAt: 2, sessionId: 'session-a' }
      }
    })
    expect(receipt.ok && 'demand' in receipt.result && receipt.result.demand?.status).toBe('in_progress')
    expect(() => parseAgentMuxControlRequest({ ...base, operation: 'demand.delete', demandId: 'task-1', confirmation: 'no' })).toThrow(/explicit confirmation/)
  })
})

describe('Goal proposals through real Control and agentmux CLI', () => {
  const proposal = { summary: 'Retain the workspace', criteria: [{ id: 'restore', text: 'Tabs remain visible' }], openQuestions: [] }
  const grounding = { alignmentRevision: 1, summary: 'Restart inspected', checks: [{ criterionId: 'restore', outcome: 'met', evidence: ['verification.log:12'], note: '' }] }
  const project = (demand: Demand): AgentMuxDemand => {
    const { executorId, activities: _activities, decisions: _decisions, ...facts } = demand
    return { ...facts, source: 'default-topic', assigneeExecutorId: executorId }
  }

  it('roundtrips nonempty owner proposals, revisions and acknowledgements through the socket and cross-process CLI', async () => {
    const root = await mkdtemp('/tmp/amux-goal-control-')
    const store = openDemandStore({ root: join(root, 'demands') })
    await store.create({ id: 'goal', title: 'Restore', description: 'User request', sessionIds: ['live-session'] })
    const seen: string[] = []
    const server = new AgentMuxControlServer({ async execute(request): Promise<AgentMuxControlResult> {
      seen.push(request.operation)
      if (request.operation === 'demand.update') {
        const { assigneeExecutorId, ...patch } = request.patch
        const receipt = await store.update(request.demandId, { ...patch, ...(assigneeExecutorId === undefined ? {} : { executorId: assigneeExecutorId }) })
        return { operation: request.operation, demand: project(receipt.demand), receipt: { demandId: receipt.demand.id, updatedAt: receipt.demand.updatedAt } }
      }
      if (request.operation === 'demand.show') return { operation: request.operation, demand: project((await store.get(request.demandId))!) }
      if (request.operation === 'demand.list') return { operation: request.operation, demands: (await store.list()).map(project) }
      throw new Error(`Unexpected operation ${request.operation}`)
    } }, join(root, 'control.sock'))
    await server.start()
    const run = async (...args: string[]) => await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [new URL('../bin/agentmux', import.meta.url).pathname, ...args], { cwd: root, env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_ENV: undefined, AGENTMUX_AGENT_SESSION_ID: undefined }, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
      child.once('error', reject); child.once('close', code => resolve({ code: code ?? -1, stdout, stderr }))
    })
    try {
      const update = await run('demand', 'update', '--demand', 'goal', '--alignment', JSON.stringify(proposal))
      expect(update.code, update.stderr).toBe(0)
      expect(JSON.parse(update.stdout).result.demand.alignment).toEqual({ ...proposal, revision: 1, confirmedAt: null })
      await store.confirmAlignment('goal', 1)
      const grounded = await run('demand', 'update', '--demand', 'goal', '--grounding', JSON.stringify(grounding))
      expect(grounded.code, grounded.stderr).toBe(0)
      expect(JSON.parse(grounded.stdout).result.demand.grounding.checks).toEqual(grounding.checks)
      await store.acceptGrounding('goal', 1, (await store.get('goal'))!.grounding!.submissionId)
      const facts = project((await store.get('goal'))!)
      const shown = await requestAgentMuxControl({ ...base, operation: 'demand.show', demandId: 'goal' }, server.path)
      expect(shown.result).toEqual({ demand: facts })
      const listed = await run('demand', 'list')
      expect(listed.code, listed.stderr).toBe(0)
      expect(JSON.parse(listed.stdout).result.demands).toEqual([facts])
      expect(facts.alignment!.criteria).toHaveLength(1)
      expect(facts.grounding!.checks).toHaveLength(1)
      expect(facts.alignment!.confirmedAt).toBeGreaterThan(0)
      expect(facts.grounding!.acceptedAt).toBeGreaterThan(0)
      expect(seen).toEqual(['demand.update', 'demand.update', 'demand.show', 'demand.list'])
      const before = await store.snapshot()
      const forged = await run('demand', 'update', '--demand', 'goal', '--grounding', JSON.stringify({ ...grounding, acceptedAt: 1 }))
      expect(forged.code).toBe(1)
      expect(await store.snapshot()).toEqual(before)
      expect(seen).toHaveLength(4)
    } finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
  }, 30_000)

  it('rejects forged Agent requests and corrupt response Goal facts with the named protocol boundary', () => {
    for (const patch of [{ confirmedAt: 1 }, { acceptedAt: 1 }, { alignment: { ...proposal, revision: 1 } }, { grounding: { ...grounding, submissionId: 'forged' } }]) {
      expect(() => parseAgentMuxControlRequest({ ...base, operation: 'demand.update', demandId: 'goal', patch })).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    }
    const demand = { id: 'goal', title: 'Goal', description: '', status: 'backlog', priority: 'normal', projectId: null, projectName: null, sessionIds: ['live-session'], createdAt: 1, updatedAt: 2, source: 'default-topic' }
    expect(() => parseAgentMuxControlReceipt({ ...base, ok: true, operation: 'demand.list', result: { demands: [{ ...demand, alignment: { ...proposal, revision: 'bad', confirmedAt: null } }] } })).toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  })
})
