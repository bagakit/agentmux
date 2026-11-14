import { afterEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { createMoteConversationStartFixture } from './helpers/mote-conversation-start-fixture.js'
import { moteQuickBaseline } from '../../../packages/core/src/mote/preferences.js'
import { moteMainBaseline, spatialAgentOpenRecord } from '../../../packages/core/src/spatial-agent-open-contract.js'
import { parseMoteMainRolloverDecision } from '../../../packages/core/src/mote/main-period.js'
import { runSourceObjectCli } from '../../../packages/core/test/helpers/source-object-cli.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { AgentMuxError } from '../../../packages/core/src/errors.js'

// Keep the real private control endpoint on this source candidate, without
// borrowing a concurrently rebuilt listener asset.
vi.mock('node:child_process', async importOriginal => {
  const native = await importOriginal<typeof import('node:child_process')>()
  return { ...native, fork: (path: string | URL, args: string[], options: import('node:child_process').ForkOptions) => {
    const listener = String(path).endsWith('/dist/control-endpoint-listener-worker.js')
    return native.fork(listener ? new URL('../../../packages/core/src/control-endpoint-listener-worker.ts', import.meta.url) : path, args,
      { ...options, execArgv: listener ? ['--experimental-transform-types'] : options.execArgv })
  } }
})
const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function facts(value: unknown) { if (process.env.MOTE_POLICY_FACTS) await appendFile(process.env.MOTE_POLICY_FACTS, JSON.stringify(value) + '\n') }
async function fixture(policy: 'idle' | 'keep-current' | 'unconfigured' = 'idle') {
  const f = await createMoteConversationStartFixture({ providerId: 'claude' }); closes.push(f.close)
  await facts({ scenario: 'private-root', root: f.h.root })
  await f.start('original-main'); await f.settledSetup('original-main')
  const main = await f.main.readCurrentMoteMain(f.target), session = (await f.h.client.readAgentSession(main.current!.sessionId))!
  async function savePolicy(value: typeof policy, id = 'saved-policy') {
    const read = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target }), baseline = moteQuickBaseline(read)!
    const { conversationRollover: _policy, ...values } = baseline.defaults
    const saved = await f.rpc.call('space.mote.preferences.save', { kind: 'quick', target: f.target, operationId: id, baseline,
      values: { ...values, ...(value === 'unconfigured' ? {} : { conversationRollover: value === 'idle' ? { kind: 'idle' as const, idleMs: 86400000 } : { kind: 'keep-current' as const } }) },
      destination: { kind: 'occurrence', displayWorkspaceId: main.current!.displayWorkspaceId, groupId: main.current!.groupId, tabId: main.current!.tabId, regionId: main.current!.regionId } })
    expect(['saved', 'unchanged'], saved.message ?? '').toContain(saved.status)
  }
  await savePolicy(policy)
  const query = (id: string) => ({ target: f.target, expectedRoleRevision: main.roleRevision!, input: {
    agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: id, prompt: 'A separately new explicit question: ' + id,
    admissionIntent: { kind: 'manual-actor' as const }, execution: 'immediate' as const }, recovery: { operationId: 'recover-' + id } })
  // The previous Query really crossed the original input owner and lost its ACK.
  const old = query('old-unknown-query'), input = f.h.inner.kernel.input
  f.h.inner.kernel.input = vi.fn(async (...args: any[]) => { await input(...args); throw new AgentMuxError('Controlled original ACK gap', 'CTXMUX_INPUT_UNKNOWN', undefined, { disposition: 'unknown', confirmedInputBytes: null }) })
  const { recovery: _recovery, ...oldSubmit } = old
  await f.rpc.call('space.mote.dialogue.input.submit', oldSubmit)
  let original = await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: old.input.operationId })
  await vi.waitFor(async () => { original = await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: old.input.operationId }); expect(original.input?.status).toBe('unknown') })
  f.h.inner.kernel.input = input
  const before = (await f.h.store.readMetadata(session.agentSessionId))!
  const { nativeHandle: _native, nativeBinding: _binding, nativeSourceObservation: _source, nativeConfirmation: _confirmation, observedNativeHandle: _observed, nativeTurnEnds: _ends, nativeInteractionEnds: _interactions, nativeSubagents: _subagents, currentActivity: _activity, recoveryActivity: _recoveryActivity, ...withoutNative } = before
  await f.h.store.compareAndSwapMetadata(before, withoutNative); await f.h.inner.registry.load('local')
  let ended = true
  const status = f.h.inner.kernel.status
  f.h.inner.kernel.status = vi.fn(async (id: string) => id === session.run.runId && ended
    ? { ...await status(id), state: { type: 'exited', code: 0, signal: null }, acceptedInputBytes: null } : await status(id))
  const entry = { target: f.target, expectedRoleRevision: main.roleRevision!, reference: main.current!, expectedRun: session.run, operationId: 'original-unavailable-entry' }
  const source = await f.rpc.call('space.mote.dialogue.recovery.ensure', entry)
  expect(source.operation).toMatchObject({ kind: 'unavailable', reason: 'native-handle-unavailable', previousRun: session.run, evidence: { kind: 'run-ended' } })
  const cli = (args: string[], value?: unknown, managed = false) => runSourceObjectCli(['--endpoint', 'unix:' + f.server.path, ...args], objectCliEnvironment(f.h.root, managed ? {
    AGENTMUX_AGENT_SESSION_ID: 'source', AGENTMUX_AGENT_CAPABILITY: f.h.capability
  } : {}), value === undefined ? '' : JSON.stringify(value), 30000, new URL('./fixtures/mote-continuity-rollover-loader.mjs', import.meta.url))
  const open = async (decision: import('../../../packages/core/src/mote/main-period.js').MoteMainRolloverDecision, request: ReturnType<typeof query>, frozenBaseline?: ReturnType<typeof moteMainBaseline>) => {
    const read = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target })
    return f.rpc.call('agent.open', { operationId: decision.creationOperationId, content: { kind: 'new-agent', executorId: 'saved' }, destination: { spaceId: f.target.spaceId, zoneId: f.target.zoneId, newTab: true }, focus: false,
      moteMain: { target: f.target, baseline: frozenBaseline ?? moteMainBaseline(moteQuickBaseline(read)!), expectedRoleRevision: decision.expectedRoleRevision,
        sourceOperationId: decision.creationOperationId + ':source', bindOperationId: decision.creationOperationId + ':bind', handover: true, rollover: decision,
        deferredInput: { operationId: request.input.operationId, prompt: request.input.prompt } } })
  }
  return { ...f, mainSnapshot: main, session, source: source.operation!, entry, query, old: oldSubmit, original, savePolicy, cli, open, setEnded: (value: boolean) => { ended = value } }
}

it('the exact unavailable owner gives only a new Query one automatic decision and public CLI setup binds it without replaying the old unknown Query', async () => {
  const f = await fixture(), query = f.query('new-after-unavailable'), starts = f.h.started.length, writes = f.h.inner.kernel.input.mock.calls.length
  await f.rpc.call('space.mote.dialogue.read', { target: f.target }); await f.rpc.call('space.mote.dialogue.recovery.inspect', f.entry)
  expect(f.h.started).toHaveLength(starts); expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(writes)
  const cli = await f.cli(['space', 'mote', 'dialogue', 'input', 'submit', '--input', '-'], query)
  expect(cli.code, cli.stderr || cli.stdout).toBe(0)
  const due = JSON.parse(cli.stdout).result
  expect(due.disposition, JSON.stringify(due)).toBe('rollover-required')
  expect(due.route).toBeNull(); expect(due.recovery).toBeUndefined()
  const decision = due.rollover.decision
  expect(decision).toMatchObject({ queryInputKey: { kind: 'prompt', agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: query.input.operationId },
    policy: { kind: 'continuity-unavailable', idleMs: 86400000 }, continuity: { operationId: f.source.operationId, previousRun: f.session.run, reason: 'native-handle-unavailable', evidence: f.source.evidence } })
  expect(parseMoteMainRolloverDecision(decision)).toEqual(decision)
  expect((await f.rpc.call('space.mote.dialogue.input.submit', query)).rollover?.decision?.creationOperationId).toBe(decision.creationOperationId)
  expect(await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: query.input.operationId })).toEqual({ route: null, record: null, input: null })
  expect(f.h.started).toHaveLength(starts); expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(writes)
  const ensure = vi.spyOn(f.h.client, 'ensureAgentContinuity').mockRejectedValue(new Error('No recovery is needed for the separate new period'))
  vi.spyOn(f.h.client, 'sessionHistorySources').mockRejectedValue(new Error('Original history unavailable'))
  const created = await f.open(decision, query)
  expect(created.outcome).toBe('opened')
  const setup = await f.cli(['space', 'mote', 'dialogue', 'setup', 'advance', '--input', '-'], { target: f.target, creation: { hostId: 'local', operationId: decision.creationOperationId } })
  expect(setup.code, setup.stderr || setup.stdout).toBe(0)
  const bound = await f.settledSetup(decision.creationOperationId)
  expect(bound.binding, bound.issue ?? '').toBe('confirmed'); expect(bound.reference?.sessionId).not.toBe(f.session.agentSessionId)
  expect(bound.deferredInput?.route?.key.submissionId).toBe(query.input.operationId)
  expect(bound.record?.moteMainFollowUps?.handoverInputKey?.submissionId).not.toBe(f.old.input.operationId)
  expect(ensure).not.toHaveBeenCalled()
  expect(await f.rpc.call('space.mote.dialogue.input.submit', f.old)).toEqual(f.original)
  const after = f.h.inner.kernel.input.mock.calls.length
  await f.setup(decision.creationOperationId); expect(f.h.inner.kernel.input).toHaveBeenCalledTimes(after)
  expect(f.h.started).toHaveLength(starts + 1); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
  expect((await f.h.client.readAgentSession(f.session.agentSessionId))?.continuityOperations?.[f.entry.operationId]).toEqual(f.source)
  expect(spatialAgentOpenRecord((await f.spatial.read())!.graph, decision.creationOperationId)?.moteMain?.deferredInput?.operationId).toBe(query.input.operationId)
  await facts({ scenario: 'public-unavailable-rollover', root: f.h.root, source: f.source, due, bound, oldBefore: f.original, oldAfter: await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: f.old.input.operationId }), startsBefore: starts, startsAfter: f.h.started.length, writesBefore: writes, writesAfter: after })
})

it.each(['keep-current', 'unconfigured'] as const)('%s never turns unavailable into automatic replacement', async policy => {
  const f = await fixture(policy), query = f.query('new-with-' + policy), starts = f.h.started.length
  const result = await f.rpc.call('space.mote.dialogue.input.submit', query)
  expect(result.disposition).toBeUndefined(); expect(result.rollover?.status).toBe('keep-current')
  expect(result.route?.reference).toEqual(f.mainSnapshot.current)
  expect(f.h.started).toHaveLength(starts); expect((await f.main.readCurrentMoteMain(f.target)).current).toEqual(f.mainSnapshot.current)
  expect(await f.rpc.call('space.mote.dialogue.input.submit', f.old)).toEqual(f.original)
})

it.each(['run-unknown', 'other-receipt', 'other-role', 'provider-unavailable', 'unknown-start', 'fresh-running', 'fresh-native', 'fresh-status-gap'] as const)(
  '%s cannot authorize an unavailable decision from stale or uncertain evidence', async variant => {
    const f = await fixture(), starts = f.h.started.length, query = f.query('new-with-' + variant)
    if (variant === 'fresh-running') {
      const status = f.h.client.statusAgent.bind(f.h.client)
      vi.spyOn(f.h.client, 'statusAgent').mockImplementation(async id => {
        const result = await status(id)
        return id !== f.session.agentSessionId ? result : { ...result, run: { ...result.run, state: 'running' as const } }
      })
    } else if (variant === 'fresh-native' || variant === 'fresh-status-gap') {
      const status = f.h.client.statusAgent.bind(f.h.client)
      vi.spyOn(f.h.client, 'statusAgent').mockImplementation(async id => {
        if (id === f.session.agentSessionId && variant === 'fresh-status-gap') throw new Error('Original Runtime observation unavailable')
        const result = await status(id)
        return id !== f.session.agentSessionId ? result : { ...result, session: { ...result.session,
          nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'later-original-native-source' } } }
      })
    } else {
      const read = f.h.client.readAgentSession.bind(f.h.client)
      vi.spyOn(f.h.client, 'readAgentSession').mockImplementation(async id => {
        const original = await read(id)
        if (!original || id !== f.session.agentSessionId) return original
        const value = structuredClone(original), source = value.continuity!
        if (variant === 'run-unknown') source.evidence = { kind: 'run-unknown', observedAt: source.observedAt, message: 'Unknown original Run' }
        if (variant === 'other-receipt') source.operationId = 'another-original-operation'
        if (variant === 'other-role') source.moteMainEntry!.expectedRoleRevision = 'another-role'
        if (variant === 'provider-unavailable') source.reason = 'provider-unavailable'
        if (variant !== 'other-receipt') value.continuityOperations![source.operationId] = source
        if (variant === 'unknown-start') value.continuityOperations!['original-unknown-start'] = { ...source, operationId: 'original-unknown-start', kind: 'starting', reason: 'operation-unconfirmed' }
        return value
      })
      if (variant === 'unknown-start') {
        const status = f.h.client.statusAgent.bind(f.h.client)
        vi.spyOn(f.h.client, 'statusAgent').mockImplementation(async id => {
          const result = await status(id)
          return id !== f.session.agentSessionId ? result : { ...result, session: { ...result.session, continuityOperations: { ...result.session.continuityOperations,
            'original-unknown-start': { ...f.source, operationId: 'original-unknown-start', kind: 'starting' as const, reason: 'operation-unconfirmed' } } } }
        })
      }
    }
    // Core may retain/decline this new original recovery input. Neither is
    // permission to appoint a replacement or to reuse the old unknown Query.
    const result = await f.rpc.call('space.mote.dialogue.input.submit', query).catch(cause => ({ issue: cause }))
    expect('disposition' in result ? result.disposition : undefined).toBeUndefined()
    expect(f.h.started).toHaveLength(starts); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
    expect((await f.main.readCurrentMoteMain(f.target)).current).toEqual(f.mainSnapshot.current)
    const old = await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: f.old.input.operationId })
    expect(old).toEqual(f.original)
  })

it.each(['policy', 'role', 'running', 'native', 'query-claimed'] as const)('creation rejects a decision after the original %s changes', async variant => {
  const f = await fixture(), query = f.query('new-before-' + variant), due = await f.rpc.call('space.mote.dialogue.input.submit', query)
  expect(due.disposition).toBe('rollover-required')
  const decision = due.rollover!.decision!, starts = f.h.started.length
  const frozen = moteMainBaseline(moteQuickBaseline(await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target }))!)
  if (variant === 'policy') await f.savePolicy('keep-current', 'later-policy')
  else if (variant === 'role') {
    const read = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target }), baseline = moteQuickBaseline(read)!
    const { conversation: _conversation, ...values } = baseline.defaults
    expect((await f.rpc.call('space.mote.preferences.save', { kind: 'quick', target: f.target, operationId: 'later-role', baseline, values,
      destination: { kind: 'occurrence', displayWorkspaceId: f.mainSnapshot.current!.displayWorkspaceId, groupId: f.mainSnapshot.current!.groupId, tabId: f.mainSnapshot.current!.tabId, regionId: f.mainSnapshot.current!.regionId } })).status).toBe('saved')
  } else if (variant === 'running') f.setEnded(false)
  else if (variant === 'native') {
    const status = f.h.client.statusAgent.bind(f.h.client)
    vi.spyOn(f.h.client, 'statusAgent').mockImplementation(async id => {
      const result = await status(id)
      return id !== f.session.agentSessionId ? result : { ...result, session: { ...result.session,
        nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'native-appeared-before-creation' } } }
    })
  } else {
    f.setEnded(false)
    await f.h.client.submitAgentPrompt({ ...query.input, authorHuman: true })
    f.setEnded(true)
    expect(await f.h.client.inspectAgentInput({ key: decision.queryInputKey! })).not.toBeNull()
  }
  await expect(f.open(decision, query, frozen)).rejects.toMatchObject({ code: variant === 'query-claimed' ? 'MOTE_MAIN_INPUT_PREEXISTING' : 'MOTE_MAIN_CHANGED' })
  expect(f.h.started).toHaveLength(starts); expect(f.h.inner.kernel.stop).not.toHaveBeenCalled()
  expect(await f.rpc.call('space.mote.dialogue.input.inspect', { target: f.target, operationId: f.old.input.operationId })).toEqual(f.original)
})

it('strict public decision and person creation keep source and caller authority exact', async () => {
  const f = await fixture(), query = f.query('strict-new-query'), due = await f.rpc.call('space.mote.dialogue.input.submit', query)
  expect(due.disposition).toBe('rollover-required')
  const decision = due.rollover!.decision!
  for (const change of [
    { continuity: { ...decision.policy.kind === 'continuity-unavailable' ? decision.continuity : {}, reason: 'provider-unavailable' } },
    { activity: { sourceId: 'display-only' } },
    { policy: { kind: 'continuity-unavailable', idleMs: 0 } },
    { queryInputKey: undefined },
    { continuity: { ...decision.policy.kind === 'continuity-unavailable' ? decision.continuity : {}, previousRun: { runId: 'another-run' } } },
    { continuity: { ...decision.policy.kind === 'continuity-unavailable' ? decision.continuity : {}, evidence: { kind: 'run-unknown', observedAt: 1 } } }
  ]) for (const code of ['CONTROL_PROTOCOL_ERROR', 'INVALID_CLI_ARGUMENT'] as const)
    expect(() => parseMoteMainRolloverDecision({ ...decision, ...change }, code)).toThrow(expect.objectContaining({ code }))
  const read = await f.rpc.call('space.mote.preferences.read', { kind: 'quick', target: f.target })
  const intent = { target: f.target, baseline: moteMainBaseline(moteQuickBaseline(read)!), expectedRoleRevision: decision.expectedRoleRevision,
    sourceOperationId: decision.creationOperationId + ':source', bindOperationId: decision.creationOperationId + ':bind', handover: true,
    rollover: decision, deferredInput: { operationId: query.input.operationId, prompt: query.input.prompt } }
  const starts = f.h.started.length, denied = await f.cli(['agent', 'open', '--executor', 'saved', '--space', f.target.spaceId, '--zone', f.target.zoneId,
    '--new-tab', '--operation-id', decision.creationOperationId, '--mote-main', '-'], intent, true)
  expect(denied.code).not.toBe(0); expect(denied.stdout + denied.stderr).toContain('CONTROL_PERMISSION_DENIED')
  expect(f.h.started).toHaveLength(starts)
  const help = await f.cli(['space', 'mote', 'dialogue', 'input', 'submit', '--help'])
  expect(help.code).toBe(0); expect(help.stdout).toContain('continuity-unavailable'); expect(help.stdout).toContain('Keep-current/unconfigured')
})

it('a source Host clock ahead does not invalidate the exact unavailable receipt or creation revalidation', async () => {
  const f = await fixture(), sourceTime = Date.now() + 60000, read = f.h.client.readAgentSession.bind(f.h.client), status = f.h.client.statusAgent.bind(f.h.client)
  function sourceClock<S extends import('../../../packages/core/src/types.js').AgentMuxAgentSession>(original: S): S {
    const value = structuredClone(original)
    if (value.agentSessionId === f.session.agentSessionId && value.continuity?.operationId === f.source.operationId) {
      value.continuity.evidence = { ...f.source.evidence, observedAt: sourceTime }
      value.continuityOperations![f.source.operationId] = value.continuity
    }
    return value
  }
  vi.spyOn(f.h.client, 'readAgentSession').mockImplementation(async id => { const value = await read(id); return value && sourceClock(value) })
  vi.spyOn(f.h.client, 'statusAgent').mockImplementation(async id => { const value = await status(id); return { ...value, session: sourceClock(value.session) } })
  const query = f.query('new-from-ahead-clock'), due = await f.rpc.call('space.mote.dialogue.input.submit', query)
  expect(due.disposition).toBe('rollover-required')
  const decision = due.rollover!.decision!
  expect(decision.policy.kind).toBe('continuity-unavailable')
  if (decision.policy.kind !== 'continuity-unavailable') throw Error('Expected exact unavailable source')
  expect(decision.continuity.evidence.observedAt).toBe(sourceTime); expect(decision.evaluatedAt).toBeLessThan(sourceTime)
  expect(parseMoteMainRolloverDecision(decision)).toEqual(decision)
  expect((await f.open(decision, query)).outcome).toBe('opened')
  const bound = await f.settledSetup(decision.creationOperationId)
  expect(bound.binding, bound.issue ?? '').toBe('confirmed'); expect(bound.deferredInput?.route?.key.submissionId).toBe(query.input.operationId)
  expect(await f.rpc.call('space.mote.dialogue.input.submit', f.old)).toEqual(f.original)
  await facts({ scenario: 'source-clock-domain', sourceTime, decision, binding: bound.binding, reference: bound.reference })
})
