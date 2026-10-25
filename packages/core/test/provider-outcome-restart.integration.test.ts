import { afterEach, expect, it } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { recoveryRuntimeFixture } from './helpers/recovery-runtime-fixture.js'
import { until } from './helpers/headless-runtime-fixture.js'

const scopes: Array<Awaited<ReturnType<typeof recoveryRuntimeFixture>>> = []
afterEach(async () => { for (const scope of scopes.splice(0).reverse()) await scope.cleanup() })

it('retains an original failed turn through a real Core owner restart with the same live Runtime Run', async () => {
  const scope = await recoveryRuntimeFixture(); scopes.push(scope)
  const { client } = await scope.connect()
  const original = await client.createAgent({ providerId: 'codex', executorId: 'codex', workspacePath: scope.root,
    commandOverride: resolve(import.meta.dirname, 'fixtures/session-recovery-codex-cli.mjs'),
    createOperationId: 'private-outcome-restart', injectAgentMuxGuide: false,
    env: { AGENTMUX_FAKE_NATIVE_RECORD: '1', AGENTMUX_RECOVERY_INPUT_WITNESS: join(scope.root, 'input.ndjson') } })
  scope.trackRun(original.run.runId)
  const saved = await until(() => client.agentSession(original.agentSessionId), value => Boolean(value.nativeHandle) &&
    value.semanticStatus?.state === 'done', 'original native conversation ready')
  if (saved.nativeHandle?.kind !== 'provider' || !saved.nativeHandle.transcriptPath) throw new Error('Original native file missing')
  const nativeHandle = saved.nativeHandle
  const before = await client.statusAgent(original.agentSessionId)
  scope.trackRun(original.run.runId, before.run.pid)
  const boundary = (type: string, ordinal: number, extra: object = {}) => JSON.stringify({ timestamp: new Date().toISOString(), ordinal,
    type: 'event_msg', payload: { type, turn_id: 'retained-failed-turn', thread_id: nativeHandle.sessionId, ...extra } }) + '\n'
  await appendFile(saved.nativeHandle.transcriptPath, boundary('task_started', 100) + boundary('task_complete', 101, {
    error: { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' } }))
  const failed = await until(() => client.sessionTimeline(original.agentSessionId), value => value.items.some(item => item.turnOutcome?.status === 'failed'), 'typed durable failure')
  const retained = failed.items.find(item => item.turnOutcome?.status === 'failed')!
  const previousOwner = scope.owner
  const nextOwner = await scope.restartOwner()
  expect(nextOwner.ownerInstanceId).not.toBe(previousOwner.ownerInstanceId)
  expect(nextOwner.ctxmux).toEqual(previousOwner.ctxmux)
  const reopened = await scope.connect()
  const after = await reopened.client.statusAgent(original.agentSessionId)
  expect(after.session).toMatchObject({ agentSessionId: original.agentSessionId, run: original.run, nativeHandle: saved.nativeHandle })
  expect(after.run).toMatchObject({ runId: original.run.runId, pid: before.run.pid, state: 'running' })
  const history = await reopened.client.sessionTimeline(original.agentSessionId)
  expect(history.items.filter(item => item.turnOutcome?.status === 'failed')).toEqual([retained])
  expect(retained.turnOutcome).toMatchObject({ status: 'failed', failure: { code: 'AGENT_MODEL_OVERLOADED', nativeTurnId: 'retained-failed-turn' } })
  const nextBoundary = boundary('task_started', 102).replaceAll('retained-failed-turn', 'later-turn')
  await appendFile(saved.nativeHandle.transcriptPath, nextBoundary)
  await until(() => reopened.client.agentSession(original.agentSessionId), value => value.semanticStatus?.nativeTurnId === 'later-turn', 'later native turn')
  expect((await reopened.client.sessionTimeline(original.agentSessionId)).items.filter(item => item.turnOutcome?.status === 'failed')).toEqual([retained])
  expect(reopened.client.agentSession(original.agentSessionId).semanticStatus?.failure).toBeUndefined()
}, 120_000)
