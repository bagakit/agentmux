import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { defineRun } from '@ctxmux/sdk'
import { createMoteConversationStartFixture } from './helpers/mote-conversation-start-fixture.js'
import { agentPromptSubmissionOutcome } from '../../../packages/core/src/mote-dialogue.js'
import { moteQuickBaseline } from '../../../packages/core/src/mote-preferences.js'
import { moteMainBaseline } from '../../../packages/core/src/spatial-graph.js'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const f = await createMoteConversationStartFixture({ providerId: 'claude' }); closes.push(f.close)
  await f.start('original-before-recovery', 'Original human Query'); await f.setup('original-before-recovery')
  const main = await f.main.readCurrentMoteMain(f.target), reference = main.current!, session = (await f.h.client.readAgentSession(reference.sessionId))!
  const core = f.h.inner, endedRun = session.run, initialStatus = core.kernel.status
  let offline = false
  core.kernel.status = vi.fn(async (id: string) => {
    const original = await initialStatus(id)
    return id === endedRun.runId || offline ? { ...original, state: { type: 'exited', code: 0, signal: null } } : original
  })
  core.kernel.launchIdentity = ({ program, args }: { program: string; args: string[] }) => ({ program, argsDigest: createHash('sha256').update(JSON.stringify(args)).digest('base64url') })
  core.kernel.prepareStart = ({ program, args, cwd, env }: any) => defineRun(program, { args, cwd, env, initialSize: { cols: 80, rows: 24 } })
  core.kernel.creationRuntimeIdentity = () => ({ runtimeId: 'original-recovery-runtime', instanceId: 'original-recovery-instance', protocolVersion: 18, buildIdentity: 'fixture' })
  core.hookServer.createBinding = (_session: string, _provider: string, bindingId: string) => ({ bindingId, endpoint: { url: 'http://127.0.0.1:0', token: 'token'.padEnd(43, 'T') }, bindRun: async () => {}, close: async () => {} })
  core.kernel.startPrepared = vi.fn(async (request: any, operationKey: string) => core.kernel.start({ ...request, operationKey }))
  core.kernel.inspectPreparedStart = vi.fn(async (_request: any, operationKey: string) => {
    const index = f.h.started.findIndex((value: any) => value.operationKey === operationKey)
    return index < 0 ? null : core.kernel.status('fixture-run-' + index)
  })
  core.kernel.inspectCreation = vi.fn(async (operationKey: string) => {
    const index = f.h.started.findIndex((value: any) => value.operationKey === operationKey)
    return index < 0 ? null : core.kernel.status('fixture-run-' + index)
  })
  const input = { agentSessionId: reference.sessionId, expectedRun: endedRun, operationId: 'original-recovered-query', prompt: 'The original new human Query after recovery', admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const }
  const request = { target: f.target, expectedRoleRevision: main.roleRevision!, input, recovery: { operationId: 'original-recovery-operation' } }
  const recovered = await f.rpc.call('space.mote.dialogue.input.submit', request)
  expect(recovered.recovery?.kind, JSON.stringify(recovered.recovery)).toBe('resumed')
  expect(recovered.recovery?.agentSessionId).toBe(reference.sessionId)
  const key = recovered.recovery!.launchInput!.key!
  expect(key.submissionId).toBe(input.operationId); expect(key.expectedRun).not.toEqual(endedRun)
  expect(agentPromptSubmissionOutcome(recovered.record), JSON.stringify(recovered.record)).toBe('terminal-confirmed')
  const idle = await f.qualifyMainIdle(1)
  const activity = await f.rpc.call('agent.input.inspect', { key, activity: true })
  expect(activity.record?.semanticIdle, JSON.stringify(activity)).toMatchObject({ promptSubmissionId: input.operationId, run: key.expectedRun })
  expect(activity.activity?.state).toBe('idle')
  return { ...f, main: f.main, originalMain: main, reference, session, request, recovered, key, idle,
    setOffline: (value: boolean) => { offline = value },
    query: (id: string) => ({ target: f.target, expectedRoleRevision: idle.snapshot.roleRevision!, input: { agentSessionId: reference.sessionId, expectedRun: key.expectedRun, operationId: id, prompt: 'Later human Query ' + id, admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const } }) }
}

it('recovered human Query produces an exact public rollover decision from its resumed input receipt without another input', async () => {
  const f = await fixture(), writes = f.h.inner.kernel.input.mock.calls.length
  const query = f.query('after-recovery-idle')
  const due = await f.rpc.call('space.mote.dialogue.input.submit', query)
  expect(due.disposition, JSON.stringify(due)).toBe('rollover-required')
  expect(due.route).toBeNull()
  expect(due.rollover?.decision).toMatchObject({ expectedRoleRevision: f.idle.snapshot.roleRevision, reference: f.reference,
    queryOperationId: query.input.operationId, activity: { inputKey: f.key, run: f.key.expectedRun } })
  expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(writes)
  const repeat = await f.rpc.call('space.mote.dialogue.input.submit', query)
  expect(repeat.rollover?.decision?.creationOperationId).toBe(due.rollover?.decision?.creationOperationId)
  expect(f.h.started).toHaveLength(2); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
  const decision = due.rollover!.decision!, preferences = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target })
  const opened = await f.rpc.call('agent.open', { operationId: decision.creationOperationId, content: { kind: 'new-agent', executorId: 'saved' }, destination: { spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false,
    moteMain: { target: f.target, baseline: moteMainBaseline(moteQuickBaseline(preferences)!), expectedRoleRevision: decision.expectedRoleRevision, sourceOperationId: decision.creationOperationId + ':source', bindOperationId: decision.creationOperationId + ':bind', rollover: decision, deferredInput: { operationId: query.input.operationId, prompt: query.input.prompt } } })
  expect(opened.outcome, JSON.stringify(opened.issues)).toBe('opened')
  const settled = await f.setup(decision.creationOperationId)
  expect(settled.binding, settled.issue ?? '').toBe('confirmed')
  expect(settled.deferredInput?.route?.key.submissionId).toBe(query.input.operationId)
  expect(settled.reference?.sessionId).not.toBe(f.reference.sessionId)
  const sent = f.h.inner.kernel.input.mock.calls.length
  await f.setup(decision.creationOperationId)
  expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(sent)
  expect((await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: f.request.input.operationId })).route).toEqual(f.recovered.route)
  expect(f.h.started).toHaveLength(3); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('platform heartbeat after a recovered Query preserves the original human idle clock and exact native source', async () => {
  const f = await fixture(), human = (await f.rpc.call('agent.input.inspect', { key: f.key, activity: true })).record!.semanticIdle!
  await f.h.client.submitAgentPrompt({ agentSessionId: f.reference.sessionId, expectedRun: f.key.expectedRun, operationId: 'recovered-platform-heartbeat', prompt: 'Platform maintenance only', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: false })
  await f.idle.hook('turn.start', 3, 'platform-heartbeat'); await f.idle.hook('turn.complete', 4, 'platform-heartbeat')
  expect((await f.rpc.call('agent.input.inspect', { key: f.key })).record!.semanticIdle).toEqual(human)
  const due = await f.rpc.call('space.mote.dialogue.input.submit', f.query('after-recovered-heartbeat'))
  expect(due.disposition).toBe('rollover-required')
  expect(due.rollover?.decision?.activity).toEqual({ inputKey: f.key, run: human.run, sourceId: human.sourceId, sequence: human.sequence, idleSince: human.observedAt })
  expect(f.h.started).toHaveLength(2); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('an offline recovered Run never becomes idle expiry and the exact pending Query stays with its original Session', async () => {
  const f = await fixture(); f.setOffline(true)
  const query = f.query('after-recovery-offline'), starts = f.h.started.length
  const pending = await f.rpc.call('space.mote.dialogue.input.submit', query)
  expect(pending.rollover?.status).toBe('unconfirmed'); expect(pending.disposition).toBeUndefined()
  expect(pending.route?.reference).toEqual(f.reference); expect(pending.route?.key.expectedRun).toEqual(f.key.expectedRun)
  expect(f.h.started).toHaveLength(starts); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
  expect((await f.main.readCurrentMoteMain(f.target)).current).toEqual(f.reference)
  expect((await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: query.input.operationId })).route).toEqual(pending.route)
}, 45_000)

it.each(['operation', 'session', 'previous-run', 'resumed-run', 'query', 'author', 'unknown-start'] as const)('a %s mismatch in the original recovery receipt cannot authorize rollover or replay', async mismatch => {
  const f = await fixture(), read = f.h.client.readAgentSession.bind(f.h.client)
  vi.spyOn(f.h.client, 'readAgentSession').mockImplementation(async id => {
    const source = await read(id)
    if (id !== f.reference.sessionId || !source) return source
    const copy = structuredClone(source), operation = copy.continuityOperations![f.request.recovery.operationId]!
    if (mismatch === 'operation') operation.operationId = 'another-recovery-operation'
    if (mismatch === 'session') operation.agentSessionId = 'another-original-session'
    if (mismatch === 'previous-run') operation.previousRun = { runId: 'another-previous-run' }
    if (mismatch === 'resumed-run') operation.newRun = { runId: 'another-resumed-run' }
    if (mismatch === 'query') operation.launchInput!.key!.submissionId = 'another-original-query'
    if (mismatch === 'author') operation.launchInput!.input.authorHuman = false
    if (mismatch === 'unknown-start') operation.launchInput!.state = 'unknown'
    return copy
  })
  const query = f.query('query-after-' + mismatch)
  const result = await f.rpc.call('space.mote.dialogue.input.submit', query)
  expect(result.rollover?.status).toBe('unconfirmed'); expect(result.disposition).toBeUndefined()
  expect(result.route?.reference).toEqual(f.reference)
  const count = f.h.inner.kernel.input.mock.calls.length
  expect((await f.rpc.call('space.mote.dialogue.input.submit', query)).route).toEqual(result.route)
  expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(count)
  expect(f.h.started).toHaveLength(2); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it('a restored Query decision is rechecked against the original role and the public CLI inspects the same frozen recovery input', async () => {
  const f = await fixture(), query = f.query('stale-recovered-rollover')
  const due = await f.rpc.call('space.mote.dialogue.input.submit', query), decision = due.rollover!.decision!
  expect(due.disposition).toBe('rollover-required')
  const before = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target }), baseline = moteQuickBaseline(before)!
  // Clearing Main is an explicit role CAS and must invalidate the old decision.
  const { conversation: _conversation, ...rest } = baseline.defaults
  const saved = await f.rpc.call('space.mote.preferences.save', { kind: 'quick', target: f.target, operationId: 'clear-original-recovered-role', baseline,
    values: rest, destination: { kind: 'occurrence', displayWorkspaceId: f.reference.displayWorkspaceId, groupId: f.reference.groupId, tabId: f.reference.tabId, regionId: f.reference.regionId } })
  expect(saved.status).toBe('saved')
  const current = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target })
  await expect(f.rpc.call('agent.open', { operationId: decision.creationOperationId, content: { kind: 'new-agent', executorId: 'saved' }, destination: { spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false,
    moteMain: { target: f.target, baseline: moteMainBaseline(moteQuickBaseline(current)!), expectedRoleRevision: decision.expectedRoleRevision, sourceOperationId: 'stale-restored-source', bindOperationId: 'stale-restored-bind', rollover: decision, deferredInput: { operationId: query.input.operationId, prompt: query.input.prompt } } })).rejects.toMatchObject({ code: 'MOTE_MAIN_CHANGED' })
  const writes = f.h.inner.kernel.input.mock.calls.length
  const result = await runSourceObjectCli(['--endpoint', 'unix:' + f.server.path, 'space', 'mote', 'dialogue', 'input', 'inspect', '--input', '-'], objectCliEnvironment(f.h.root), JSON.stringify({ target: f.target, operationId: f.request.input.operationId }), 30_000,
    new URL('../../../packages/core/test/fixtures/a2a-resumed-inbox/source-loader.mjs', import.meta.url))
  expect(result.code, result.stderr || result.stdout).toBe(0)
  const inspected = JSON.parse(result.stdout).result
  expect(inspected.route).toEqual(f.recovered.route); expect(inspected.recovery.newRun).toEqual(f.key.expectedRun)
  expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(writes); expect(f.h.started).toHaveLength(2)
  expect((await f.main.readCurrentMoteMain(f.target)).current).toBeNull(); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)
