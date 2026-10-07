import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const hash = value => createHash('sha256').update(value).digest('hex')
const identity = value => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
const successful = (value, operation) => {
  assert.equal(value?.ok, true, `The original ${operation} CLI call must have succeeded.`)
  assert.equal(value.operation, operation, 'Recorded command identity must remain exact.')
  return value.result
}

/** Read captured public results; never manufacture observations from display strings. */
export async function readVisualSource(file, repository) {
  const bytes = await readFile(file), source = JSON.parse(bytes)
  assert.equal(source.schema, 'agentmux.goal-responsibility-visual-source.v1')
  assert.ok(identity(source.source?.receiptPath) && /^[a-f0-9]{64}$/u.test(source.source?.receiptSha256 ?? ''),
    'A source-qualified public journey receipt is required.')
  const receiptPath = resolve(dirname(file), source.source.receiptPath)
  const receiptBytes = await readFile(receiptPath)
  assert.equal(hash(receiptBytes), source.source.receiptSha256, 'The original journey receipt changed.')
  const receipt = JSON.parse(receiptBytes)
  assert.equal(receipt.schema, 'agentmux.goal-patrol-product.v1')
  assert.deepEqual(source.snapshots, receipt.proof?.snapshots, 'Visual cuts must be the exact captured public journey cuts.')
  assert.ok(Array.isArray(receipt.proof.cliReceipts) && receipt.proof.cliReceipts.length > 0, 'The original compiled CLI must actually have been called.')
  for (const call of receipt.proof.cliReceipts) {
    assert.ok(Array.isArray(call.args) && typeof call.stdout === 'string' && call.stdout.trim().length > 0)
    assert.deepEqual(JSON.parse(call.stdout), call.receipt, 'The original CLI bytes and recorded receipt must agree.')
    assert.equal(call.receipt.ok, true, 'This source contract requires successful original calls, not an inferred outcome.')
  }
  assert.ok(identity(source.source.boundary), 'The original Native/IPC transport boundary must be stated.')
  assert.ok(/^[a-f0-9]{64}$/u.test(source.source.cliSha256 ?? ''), 'The actual compiled CLI identity is required.')
  assert.equal(source.source.cliSha256, receipt.cliSha256, 'The input and original public receipt must name the same actual CLI bytes.')
  const { parseRpcControlResult } = await import(pathToFileURL(resolve(repository, 'packages/core/dist/rpc-business-codec.js')).href)
  const { parseGoalDelegationParams, parseGoalDelegationResult } = await import(pathToFileURL(resolve(repository, 'packages/core/dist/goal-delegation.js')).href)
  assert.ok(source.config && Array.isArray(source.config.workspaces) && Array.isArray(source.config.hosts) && source.config.executors,
    'The recorded client configuration projection is required.')
  assert.ok(Array.isArray(source.snapshots) && source.snapshots.length >= 3, 'The journey needs nonempty original before/delivery/report cuts.')
  const ids = new Set()
  const snapshots = source.snapshots.map(snapshot => {
    assert.ok(identity(snapshot.id) && !ids.has(snapshot.id), 'Snapshot identities must be unique.')
    ids.add(snapshot.id)
    const inspected = successful(snapshot.inspect, 'goal.inspect')
    assert.ok(identity(inspected?.goal?.id), 'The original Goal must be present.')
    const parsed = parseRpcControlResult('goal.inspect', inspected, { goalId: inspected.goal.id })
    const { parentGoalId, ...originalGoal } = parsed.goal
    const goal = { ...originalGoal, ...(parentGoalId === undefined ? {} : { parentDemandId: parentGoalId }) }
    const delegation = parseGoalDelegationResult(successful(snapshot.delegations, 'goal.delegations'), { goalId: goal.id })
    assert.equal(goal.updatedAt, delegation.goalUpdatedAt, 'Goal and responsibility must be the same recorded cut.')
    assert.ok(delegation.responsibility, 'The recorded cut must contain the original responsibility observation.')
    assert.ok(Array.isArray(snapshot.sessions), 'Recorded client Session projections are required.')
    const sessionIds = new Set()
    for (const session of snapshot.sessions) {
      assert.ok(session.kind === 'agent' && identity(session.id) && !sessionIds.has(session.id), 'Client Agent identities must be exact and unique.')
      sessionIds.add(session.id)
      assert.equal(session.control?.kind, 'agent')
      assert.equal(session.control.agentSessionId, session.id)
      assert.equal(session.control.hostId, session.hostId)
      assert.ok(identity(session.control.run?.runId) && identity(session.workspacePath) && identity(session.providerId))
      assert.ok(session.status && typeof session.status.observedAt === 'number', 'Do not invent a status from an absent client projection.')
    }
    for (const execution of delegation.responsibility.executions) {
      const projected = snapshot.sessions.find(session => session.id === execution.execution.agentSessionId)
      assert.ok(projected, 'Every displayed original execution needs its recorded client projection.')
      assert.equal(projected.hostId, execution.execution.hostId)
      // A later Run can be a real observation. It must not be relabelled as the original execution.
      assert.ok(goal.sessionIds.includes(projected.id), 'Private Mote membership must use the original Goal association.')
    }
    return { id: snapshot.id, goal, delegation, sessions: snapshot.sessions, history: snapshot.history ?? {} }
  })
  const byId = id => {
    const snapshot = snapshots.find(item => item.id === id)
    assert.ok(snapshot, `Unknown original snapshot: ${id}`)
    return snapshot
  }
  const initial = byId(source.journey?.initialSnapshotId), delivered = byId(source.journey?.deliveredSnapshotId), reported = byId(source.journey?.reportedSnapshotId)
  assert.equal(initial.goal.id, delivered.goal.id)
  assert.equal(initial.goal.id, reported.goal.id)
  assert.ok(initial.delegation.responsibility.executions.some(row => row.alert !== null), 'The actual first cut must contain an attention condition.')
  const patrol = source.journey.patrol
  assert.equal(patrol?.method, 'goal.patrol')
  assert.ok(receipt.proof.exchanges.some(call => call.method === patrol.method &&
    JSON.stringify(call.params) === JSON.stringify(patrol.params) && JSON.stringify(call.response) === JSON.stringify(patrol.response)),
  'The replayed click must be an actual original production GUI exchange.')
  const params = parseGoalDelegationParams(patrol.method, patrol.params)
  assert.equal(params.goalId, initial.goal.id)
  const previousReport = initial.delegation.patrols?.at(-1)?.report?.operationId ?? null
  const expectedOperation = 'goal-patrol-request-' + hash(JSON.stringify(['goal-patrol-request', params.goalId, initial.delegation.responsibility.scope, previousReport]))
  assert.equal(params.operationId, expectedOperation, 'The original GUI request must match its production operation identity; do not replay another send.')
  const response = parseGoalDelegationResult(patrol.response, params)
  const businessCut = value => {
    const { observedAt: _readClock, ...responsibility } = value.responsibility
    return { ...value, responsibility }
  }
  assert.ok(delivered.delegation.responsibility.observedAt >= response.responsibility.observedAt,
    'The subsequent original CLI read cannot predate the captured GUI reply.')
  assert.deepEqual(businessCut(response), businessCut(delivered.delegation),
    'The reply and subsequent original CLI read must retain every business/scope/execution fact; each keeps its own observation clock.')
  const savedPatrol = delivered.delegation.patrols?.find(item => item.operationId === params.operationId)
  assert.ok(savedPatrol && !savedPatrol.report, 'Delivery must remain distinct from an inspection report.')
  assert.ok(delivered.delegation.responsibility.executions.some(row => row.alert !== null), 'Delivery alone cannot erase the original attention.')
  const actualReport = reported.delegation.patrols?.find(item => item.operationId === params.operationId)?.report
  assert.ok(actualReport?.applied, 'The report cut must contain an actual applied original inspection.')
  assert.ok(identity(actualReport.summary) && identity(actualReport.nextOwner?.action))
  return { schema: source.schema, sourceSha256: hash(bytes), source: source.source,
    config: source.config, snapshots, journey: { ...source.journey, patrol: { method: patrol.method, params, response } },
    originalReceipt: { path: receiptPath, sha256: hash(receiptBytes), schema: receipt.schema } }
}
