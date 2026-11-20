import { afterEach, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'

const cleanup: CrossHostCleanup = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('collects the exact Ticket, admits independent review and prompts exact Run release only after a new pass', async () => {
  const host = await crossHostOwner(cleanup, 'workflow-review', ['supervisor', 'worker', 'reviewer'])
  const config = JSON.parse(await readFile(host.configurationPath, 'utf8'))
  await writeFile(host.configurationPath, JSON.stringify({ ...config, goals: { workflow: {
    template: 'execution-review', reviewerHostId: 'local', reviewerSessionId: 'reviewer', reviewerRuntimeId: host.identity.runtimeId
  } } }))
  const goalId = (await host.call('supervisor', ['goal', 'create', '--title', 'Verify delivered artifact', '--status', 'in_progress',
    '--assignees', '["supervisor","worker"]', '--supervisor', 'supervisor', '--risk', 'low', '--confirm', 'user', '--operation-id', 'create-workflow-goal'])).goal.id
  await host.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify({
    summary: 'Independently check the artifact', criteria: [{ id: 'artifact', text: 'The artifact has the required bytes' }], openQuestions: []
  })])
  const nodes = ['delivery', 'followup', 'parallel'].map(id => ({ id, title: id, outcome: 'Complete ' + id, dependsOn: id === 'followup' ? ['delivery'] : [],
    check: 'cat artifact.txt', criterionIds: ['artifact'], executor: { hostId: 'local', agentSessionId: 'worker' } }))
  const published = await host.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'],
    { goalId, revision: { operationId: 'workflow-plan', expectedRevision: 0, alignmentRevision: 1, nodes } })
  const nodeId = published.plan.nodes[0].id, delegationOperationId = 'workflow-delegate-delivery'
  const parallelOperation = 'workflow-delegate-parallel'
  for (const [name, index] of [['delivery', 0], ['parallel', 2]] as const) {
    await host.call('supervisor', ['goal', 'delegate', '--input', '-'], { goalId, intent: {
      operationId: 'workflow-delegate-' + name, sourceMessageId: 'workflow-source-' + name, threadId: 'workflow-thread-' + name, hostId: 'local',
      ownerAgentSessionId: 'supervisor', ownerRunId: 'run-supervisor', workerAgentSessionId: 'worker', workerRunId: 'run-worker',
      text: 'Write the specified bytes to artifact.txt', alignmentRevision: 1, criterionIds: ['artifact'], planNodeId: published.plan.nodes[index].id
    } })
  }
  await writeFile(join(host.original.root, 'artifact.txt'), 'original artifact\n')
  for (const name of ['delivery', 'parallel']) await host.call('worker', ['goal', 'report', '--input', '-'], { goalId, operationId: 'workflow-delegate-' + name, report: {
    operationId: 'workflow-report-' + name, replyMessageId: 'workflow-reply-' + name, authorAgentSessionId: 'worker',
    grounding: { alignmentRevision: 1, summary: 'Original artifact', checks: [{ criterionId: 'artifact', outcome: 'met', note: '', evidence: ['artifact.txt:1'] }] }
  } })

  const reviewer = (await host.original.store.readMetadata('reviewer'))!, observedAt = Date.now()
  await host.original.store.compareAndSwapMetadata(reviewer, { ...reviewer, updatedAt: observedAt, semanticStatus: {
    state: 'done', source: 'native-hook', observedAt, stateEnteredAt: observedAt, nativeTurnId: 'reviewer-ready'
  } })
  const core = host.client()
  await (core as unknown as { registry: { load(host: string): Promise<void> } }).registry.load('local')
  vi.spyOn((core as unknown as { screenEvidence: { wait(): Promise<number> } }).screenEvidence, 'wait').mockResolvedValue(0)
  const submit = core.submitAgentPrompt.bind(core)
  let releaseFirst!: () => void, firstOperation: string | undefined
  const holdFirst = new Promise<void>(resolve => { releaseFirst = resolve })
  cleanup.push(releaseFirst)
  const submission = vi.spyOn(core, 'submitAgentPrompt').mockImplementation(async (...args) => {
    if (!firstOperation && args[0].operationId?.startsWith('goal-workflow-review-')) {
      firstOperation = args[0].operationId
      await holdFirst
    }
    const result = await submit(...args)
    if (firstOperation && args[0].operationId === firstOperation) throw Error('The Host lost this acknowledged Core response')
    return result
  })
  const collect = (name = 'delivery') => host.call('supervisor', ['goal', 'collect', '--input', '-'], { goalId, operationId: 'workflow-delegate-' + name,
    collection: { operationId: 'workflow-collect-' + name, replyMessageId: 'workflow-reply-' + name } })
  const collected = await collect('delivery')
  const armed = collected.delegations[0].collection.workflowReview
  const deliveryHash = collected.delegations[0].report.delivery.hash
  expect(armed).toMatchObject({ deliveryHash, reviewer: { hostId: 'local', runtimeId: host.identity.runtimeId, agentSessionId: 'reviewer' } })
  const read = () => host.rpc.call('goal.delegations', { goalId })
  await vi.waitFor(() => expect(firstOperation).toBe(armed.operationId), { timeout: 5_000, interval: 100 })
  try {
    const parallel = await collect('parallel')
    expect(parallel.delegations[1].collection.workflowReview).toBeDefined()
    expect(parallel.delegations[1].collection.workflowReview.input?.attemptedAt).toBeUndefined()
    expect((await read()).observations?.find(item => item.operationId === parallelOperation)?.workflowReview?.state).toBe('prepared')
    expect(submission.mock.calls.filter(([request]) => request.operationId?.startsWith('goal-workflow-review-'))).toHaveLength(1)
  } finally { releaseFirst() }
  await vi.waitFor(async () => {
    const status = (await read()).observations?.find(row => row.operationId === delegationOperationId)?.workflowReview
    expect(status?.state, status?.reason).toBe('confirmed')
  }, { timeout: 5_000, interval: 100 })
  const inputKey = { kind: 'prompt' as const, agentSessionId: 'reviewer', expectedRun: { runId: 'run-reviewer' }, submissionId: armed.operationId }
  const receipt = await core.inspectAgentPromptSubmission(inputKey)
  expect(receipt?.admission).toMatchObject({ acknowledged: true, inputKey })
  expect(receipt?.admission?.intent?.message?.authorHuman).toBeUndefined()
  expect(receipt?.admission?.intent?.message?.authorAgentSessionId).toBeUndefined()
  expect(JSON.parse(receipt!.admission!.intent!.message!.systemContext!)).toMatchObject({
    goalId, nodeId, deliveryHash, delegationOperationId, reviewOperationId: armed.operationId + '-verdict'
  })
  expect((await read()).planState?.nodes[1]?.state).toBe('waiting')
  expect((await collect()).delegations[0].collection.workflowReview.operationId).toBe(armed.operationId)
  expect(submission.mock.calls.filter(([request]) => request.operationId === armed.operationId)).toHaveLength(1)
  const next = (await host.original.store.readMetadata('reviewer'))!, readyAt = Date.now()
  await host.original.store.compareAndSwapMetadata(next, { ...next, updatedAt: readyAt, semanticStatus: {
    state: 'done', source: 'native-hook', observedAt: readyAt, stateEnteredAt: readyAt, nativeTurnId: 'reviewer-next-turn-ready'
  } })
  await (core as unknown as { registry: { load(host: string): Promise<void> } }).registry.load('local')
  const { publisher } = core as unknown as { publisher: { publish(event: import('@agentmux/core').AgentMuxClientEvent): void } }
  publisher.publish({ type: 'agent-session', session: core.agentSession('reviewer') })
  await vi.waitFor(async () => {
    const status = (await read()).observations?.find(row => row.operationId === parallelOperation)?.workflowReview
    expect(status?.state, status?.reason).toBe('confirmed')
  }, { timeout: 5_000, interval: 100 })
  await host.stop(); await host.start()
  expect((await read()).observations?.[0]?.workflowReview?.state).toBe('confirmed')
  const checked = await promisify(execFile)('cat', ['artifact.txt'], { cwd: host.original.root })
  const review = { operationId: armed.operationId + '-verdict', nodeId, delegationOperationId, deliveryHash, verdict: 'pass',
    check: { command: 'cat artifact.txt', result: checked.stdout, evidence: ['artifact.txt:1'] }, note: '' }
  const selfReview = await host.cli('worker', ['goal', 'plan', 'review', '--input', '-'], { goalId, review })
  expect(selfReview.stderr).toContain('cannot review its own work')
  expect(selfReview.stdout).not.toContain('<amux>')
  const reviewArgs = ['goal', 'plan', 'review', '--input', '-']
  const accepted = await host.cli('reviewer', reviewArgs, { goalId, review })
  expect(accepted.code, accepted.stderr).toBe(0)
  const reviewed = JSON.parse(accepted.stdout)
  expect(reviewed.result.passRecorded).toBe(true)
  const savedReview = reviewed.result.plan.reviews[0]
  expect(savedReview).toMatchObject({ reviewer: { id: 'reviewer', runtimeId: host.identity.runtimeId }, completion: { hash: expect.any(String) } })
  const fingerprint = (await host.client().agentCreationAuthority()).fingerprint
  const verified = await host.cli(null, ['goal', 'plan', 'verify', '--input', '-', '--goal', goalId, '--hash', savedReview.completion.hash,
    '--fingerprint', fingerprint], savedReview.completion)
  expect(verified.code, verified.stderr).toBe(0)
  expect(reviewed.guidance).toMatch(/^<amux>\n[\s\S]+\n<\/amux>$/u)
  expect(reviewed.guidance.match(/<amux>/gu)).toHaveLength(1)
  expect(reviewed.guidance).toContain(`Goal "${goalId}", Ticket "${nodeId}", attempt "${delegationOperationId}"`)
  expect(reviewed.guidance).toContain(`Session "worker", Run "run-worker", Host "local", Runtime "${host.identity.runtimeId}"`)
  expect(reviewed.guidance).not.toMatch(/\bamux agent stop\b(?! inspect\b)/u)
  expect(reviewed.guidance).toContain('As the independent reviewer, read the original Goal for its current Supervisor and pass them this receipt. Keep your review role.')
  expect(reviewed.guidance).toContain('verify the exact attempt, report collection and remaining work')
  expect(reviewed.guidance).toContain('Assign the next ready Ticket when appropriate')
  expect(reviewed.guidance).toContain('ask the original executor to use amux goal closeout for this exact attempt and Run')
  expect(reviewed.guidance).toContain('Keep the original Run and operation if any check or receipt is unknown')
  expect(reviewed.guidance).toContain('Only an authorized person or device can read the exact Stop receipt with amux agent stop inspect')
  expect((await read()).planState?.nodes[1]?.state).toBe('ready')
  const repeated = await host.cli('reviewer', reviewArgs, { goalId, review })
  expect(repeated.code, repeated.stderr).toBe(0)
  expect(JSON.parse(repeated.stdout)).not.toHaveProperty('guidance')
  const planned = await host.cli('supervisor', ['goal', 'plan', '--goal', goalId])
  expect(planned.code, planned.stderr).toBe(0)
  expect(JSON.parse(planned.stdout)).not.toHaveProperty('guidance')
  const changes = await host.cli('reviewer', reviewArgs, { goalId, review: { ...review,
    operationId: 'request-changes-on-parallel', nodeId: published.plan.nodes[2].id, delegationOperationId: parallelOperation,
    deliveryHash: (await read()).delegations[1]!.report!.delivery!.hash, verdict: 'changes', note: 'Explain the parallel result.' } })
  expect(changes.code, changes.stderr).toBe(0)
  expect(JSON.parse(changes.stdout)).not.toHaveProperty('guidance')
  const skill = await host.cli('supervisor', ['goal', '--skill'])
  expect(skill.code, skill.stderr).toBe(0)
  const management = skill.stdout.split('## Management responsibilities\n')[1]?.split('\n## ')[0]
  expect(management).not.toMatch(/\bamux agent stop\b(?! inspect\b)/u)
  expect(management).toContain('find the current Supervisor. Pass them the original receipt and keep your review role')
  expect(management).toMatch(/verify the\s+current attempt and the collection of its original report/u)
  expect(management).toMatch(/Assign the next\s+ready Ticket when appropriate/u)
  expect(management).toMatch(/give the original executor the exact Goal, attempt and Run for `amux goal closeout`/u)
  expect(management).toContain('Keep the original Run and operation if any check or receipt is unknown')
  expect(management).toMatch(/Only an authorized\s+person or device can read the exact Stop receipt with\s+`amux agent stop inspect/u)
  expect(host.native.prepareStop).not.toHaveBeenCalled()
  expect(host.native.stop).not.toHaveBeenCalled()
}, 90_000)
