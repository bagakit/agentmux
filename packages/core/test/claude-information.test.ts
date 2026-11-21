import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { claudeNativeActivitySource } from '../src/providers/claude-plugin.js'
import { CLAUDE_INFORMATION_EVENT, claudeNativeInformation } from '@agentmux/providers/claude/native-activity'
import { parseAgentInformationSnapshot } from '../src/agent-information.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { activityCertaintyClient } from './fixtures/activity-certainty-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

type Handler = (api: unknown, event: Record<string, unknown>, next: (event: Record<string, unknown>) => unknown) => unknown
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** Native callbacks are controlled; the generated observer, Provider and durable Core are real. */
async function fixture() {
  const h = await activityCertaintyClient('claude-information-original', 'claude')
  const original = h.client as any
  h.run.pid = process.pid
  original.kernel.creationRuntimeIdentity = () => ({ runtimeId: 'information-runtime', instanceId: 'information-instance',
    buildIdentity: 'native-information-fixture', protocolVersion: 1 })
  const handlers = new Map<string, Handler>(), path = join(h.directory, 'register.mjs')
  await writeFile(path, claudeNativeActivitySource())
  const mod = await import(/* @vite-ignore */ pathToFileURL(path).href)
  mod.register((name: string, handler: Handler) => { handlers.set(name, handler); return { catch() {} } })
  const state = { nativeId: 'claude-native-original', model: 'native-current-model', observedAt: fixtureEpoch(2, 0, 123),
    rates: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: new Date(fixtureEpoch(50, 17_445)).toISOString() }],
    modelFailed: false, limitsFailed: false, deliveryFailed: false }
  const payloads: Array<Record<string, any>> = [], delivered: Array<Record<string, any>> = [], errors: unknown[] = []
  const inflight = new Set<Promise<unknown>>()
  const api = {
    env: { get: async (name: string) => ({ AGENTMUX_ENV: '1', AGENTMUX_HOOK_NODE: 'original-node',
      AGENTMUX_HOOK_RUNNER: 'original-hook-runner' } as Record<string, string>)[name] },
    clock: { now: async () => state.observedAt },
    session: { id: async () => state.nativeId,
      model: vi.fn(async () => { if (state.modelFailed) throw new Error('Private model read failed'); return state.model }),
      usage: vi.fn(async (...args: unknown[]) => { expect(args).toEqual([]); if (state.limitsFailed) throw new Error('Private limits read failed')
        return { rateLimits: state.rates, context: { percent: 99 }, cost: { total: 999 }, private: 'never-forward' } }) },
    ui: { log: async () => {} },
    process: { run: vi.fn(async (_argv: string[], input: { stdin: string }) => {
      const payload = JSON.parse(input.stdin)
      if (payload.hook_event_name === 'AgentMuxTurnEnd') return { exitCode: 0, stdout: '{}', stderr: '' }
      payloads.push(payload)
      if (state.deliveryFailed) return { exitCode: 1, stdout: '', stderr: 'unconfirmed' }
      const delivery = h.hook(payload.hook_event_name, `information-mod-observation-${payload.sequence}`, payload)
      inflight.add(delivery)
      try { await delivery; delivered.push(payload) } catch (error) { errors.push(error); throw error }
      finally { inflight.delete(delivery) }
      return { exitCode: 0, stdout: '{}', stderr: '' }
    }) }
  }
  const flush = async () => {
    for (let step = 0; step < 8; step++) { await new Promise(resolve => setImmediate(resolve)); await Promise.allSettled([...inflight]) }
    expect(errors).toEqual([])
  }
  cleanup.push(async () => { await flush(); await h.close() })
  const emit = async (name: string, event: Record<string, unknown> = {}, next?: () => unknown) => {
    const result = { nativeResult: name }
    expect(await handlers.get(name)!(api, event, observed => { expect(observed).toBe(event); return next ? next() : result })).toBe(result)
    await flush()
  }
  const inspect = () => h.client.inspectAgentInformation({ hostId: 'local', agentSessionId: 'claude-information-original', expectedRun: { runId: h.run.runId } })
  return { ...h, state, api, handlers, payloads, delivered, emit, flush, inspect,
    latest: () => delivered.filter(row => row.hook_event_name === CLAUDE_INFORMATION_EVENT).at(-1) }
}

it('the generated native observer reaches public Core information and status with the original main model and quota windows', async () => {
  const h = await fixture()
  await h.emit('session.start')
  const snapshot = (await h.inspect()).snapshot!
  expect(snapshot).toMatchObject({ nativeSessionId: h.state.nativeId, observedAt: h.state.observedAt, sequence: 1,
    model: { id: 'native-current-model', scope: 'session' },
    limits: [{ id: 'five_hour', usedPercent: 23.5, resetsAt: Date.parse(h.state.rates[0]!.resetsAt) }] })
  expect(snapshot.plan).toBeUndefined()
  expect(snapshot.issues).toEqual(expect.arrayContaining([{ field: 'plan', kind: 'unsupported', code: 'CLAUDE_PLAN_UNSUPPORTED', message: expect.any(String) },
    { field: 'configuration', kind: 'unsupported', code: 'CLAUDE_MODEL_CONFIGURATION_UNSUPPORTED', message: expect.any(String) }]))
  expect((await h.client.statusAgent('claude-information-original')).session.nativeInformation).toEqual(snapshot)
  expect(h.client.agentSession('claude-information-original').nativeHandle?.sessionId).toBe(h.state.nativeId)
  expect(JSON.stringify(h.payloads)).not.toMatch(/never-forward|Private model|Private limits|context|cost/u)
  const refresh = await h.inspect()
  expect(refresh.snapshot).toEqual(snapshot)
  expect(refresh.configuration).toBeNull()
  expect(refresh.issue).toBeUndefined()
  expect(h.api.session.usage).toHaveBeenCalledTimes(1)
})

it('the compiled public CLI consumes the actual generated Claude observation through its original Core ControlServer', async () => {
  const candidate = process.env.AMX_INFORMATION_CANDIDATE
  if (!candidate) throw new Error('The Claude public wire proof requires the exact compiled gate candidate.')
  const h = await fixture(); await h.emit('session.start')
  const snapshot = (await h.inspect()).snapshot!, calls = h.api.process.run.mock.calls.length
  await import(/* @vite-ignore */ pathToFileURL(resolve(import.meta.dirname, 'fixtures/agent-information-loader.mjs')).href)
  const { AgentMuxControlServer } = await import(/* @vite-ignore */ pathToFileURL(join(candidate, 'core/dist/public-rpc-server.js')).href)
  const control = new AgentMuxControlServer({ socketPath: join(h.directory, 'information.sock'),
    coreClients: () => [{ hostId: 'local', client: h.client }] })
  cleanup.push(() => control.stop()); await control.start()
  const env = objectCliEnvironment(h.directory, { HOME: h.directory,
    NODE_OPTIONS: '--import=' + pathToFileURL(resolve(import.meta.dirname, 'fixtures/agent-information-loader.mjs')).href,
    AGENTMUX_TEST_OBJECT_CLI: join(candidate, 'core/bin/amux') })
  const cli = async (args: string[]) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + control.path, ...args], env)
    expect(result.code, result.stderr + result.stdout).toBe(0)
    return JSON.parse(result.stdout).result
  }
  const information = await cli(['agent', 'information', 'inspect', '--host', 'local', '--session', 'claude-information-original', '--run', h.run.runId])
  expect(information.snapshot).toEqual(snapshot)
  expect(information.configuration).toBeNull()
  const inspected = await cli(['agent', 'inspect', '--session', 'claude-information-original'])
  expect(inspected.status.session.nativeInformation).toEqual(snapshot)
  expect(h.api.process.run).toHaveBeenCalledTimes(calls)
})

it('measure reuses native quota data and unchanged main turns launch no extra information Hook process', async () => {
  const h = await fixture(); await h.emit('session.start')
  const original = h.latest()!
  h.state.observedAt += 1000
  await h.emit('turn.start', { turnId: 'main-original' })
  expect(h.delivered.filter(row => row.hook_event_name === CLAUDE_INFORMATION_EVENT)).toHaveLength(1)
  expect((await h.inspect()).snapshot!.observedAt).toBe(original.observedAt)
  h.state.model = 'actual-new-model'
  await h.emit('session.measure', { rateLimits: [{ kind: 'spend_limit', percentUsed: 125.5 }], changed: ['rateLimits'] })
  const snapshot = (await h.inspect()).snapshot!
  expect(snapshot).toMatchObject({ observedAt: h.state.observedAt, model: { id: 'actual-new-model' },
    limits: [{ id: 'spend_limit', usedPercent: 125.5 }] })
  expect(h.api.session.usage).toHaveBeenCalledTimes(2)
  const count = h.api.session.model.mock.calls.length
  await h.emit('turn.start', { turnId: 'child-turn', agentId: 'native-child' })
  expect(h.api.session.model).toHaveBeenCalledTimes(count)
})

it('a completed native model command is observed without issuing any command or reading its output text', async () => {
  const h = await fixture(); await h.emit('session.start')
  const event = { command: 'model', args: 'private-native-selection', origin: { kind: 'composer' } }
  const result = { text: 'Misleading display model', ref: 'native-command' }
  expect(await h.handlers.get('command.run')!(h.api, event, native => { expect(native).toBe(event)
    h.state.model = 'native-selected-model'; h.state.observedAt += 1; return result })).toBe(result)
  await h.flush()
  expect((await h.inspect()).snapshot!.model!.id).toBe('native-selected-model')
  expect(JSON.stringify(h.payloads)).not.toContain('private-native-selection')
  expect(JSON.stringify(h.payloads)).not.toContain('Misleading display model')
})

it('native partial reader failures preserve the independently confirmed model or limits without private errors', async () => {
  const h = await fixture(); h.state.limitsFailed = true
  await h.emit('session.start')
  expect((await h.inspect()).snapshot).toMatchObject({ model: { id: h.state.model }, issues: expect.arrayContaining([
    expect.objectContaining({ field: 'limits', kind: 'unavailable' })]) })
  h.state.limitsFailed = false; h.state.modelFailed = true; h.state.observedAt += 1
  await h.emit('session.measure', { rateLimits: [], changed: ['rateLimits'] })
  const snapshot = (await h.inspect()).snapshot!
  expect(snapshot.model).toBeUndefined(); expect(snapshot.limits).toEqual([])
  expect(snapshot.issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'model', kind: 'unavailable' }),
    expect.objectContaining({ field: 'limits', kind: 'unconfirmed' })]))
  expect(JSON.stringify(snapshot)).not.toContain('Private')
})

it('foreign child and old-sequence information cannot replace an accepted main observation', async () => {
  const h = await fixture(); await h.emit('session.start')
  const old = h.latest()!
  h.state.model = 'new-native-model'; h.state.observedAt += 1
  await h.emit('session.measure', { rateLimits: h.state.rates, changed: ['context'] })
  const accepted = (await h.inspect()).snapshot!
  await h.hook(CLAUDE_INFORMATION_EVENT, 'late-information-original', { ...old, observedAt: accepted.observedAt + 100 })
  await h.hook(CLAUDE_INFORMATION_EVENT, 'child-information-original', { ...h.latest(), agent_id: 'child', model: 'foreign-child-model', sequence: 100 })
  await h.hook(CLAUDE_INFORMATION_EVENT, 'foreign-information-original', { ...h.latest(), session_id: 'foreign-native', sequence: 101 })
  expect((await h.inspect()).snapshot).toEqual(accepted)
})

it('a new Core owner recovers the original native sample from its existing FileStore without refreshing its clock', async () => {
  const h = await fixture(); await h.emit('session.start')
  const original = (await h.inspect()).snapshot!
  const calls = h.api.process.run.mock.calls.length
  await h.client.dispose()
  const reopened = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(h.directory, 'agent-sessions.json')) })
  cleanup.push(() => reopened.dispose())
  const owner = reopened as any
  await owner.registry.load('local'); owner.connected = true
  owner.kernel.isConnected = () => true
  owner.kernel.creationRuntimeIdentity = () => ({ runtimeId: 'information-runtime', instanceId: 'reopened-information-instance',
    buildIdentity: 'native-information-fixture', protocolVersion: 1 })
  owner.kernel.status = async () => structuredClone(h.run)
  const information = await reopened.inspectAgentInformation({ hostId: 'local', agentSessionId: 'claude-information-original', expectedRun: { runId: h.run.runId } })
  expect(information.snapshot).toMatchObject({ nativeSessionId: original.nativeSessionId, sourceId: original.sourceId,
    sequence: original.sequence, observedAt: original.observedAt, model: original.model, limits: original.limits })
  expect((await reopened.statusAgent('claude-information-original')).session.nativeInformation).toEqual(information.snapshot)
  expect(h.api.process.run).toHaveBeenCalledTimes(calls)
})

it.each([false, true])('a same-source delivery gap retains its original sample time and can converge with changed=%s', async changed => {
  const h = await fixture(); await h.emit('session.start')
  const original = (await h.inspect()).snapshot!
  h.state.deliveryFailed = true; if (changed) h.state.model = 'pending-model'; h.state.observedAt += 100
  await h.emit('turn.start', { turnId: 'unconfirmed-delivery-turn' })
  h.state.deliveryFailed = false
  await h.emit('session.measure', { rateLimits: h.state.rates, changed: ['context'] })
  const gap = await h.inspect()
  expect(gap.snapshot).toMatchObject({ nativeSessionId: original.nativeSessionId, sourceId: original.sourceId,
    sequence: original.sequence, observedAt: original.observedAt, model: original.model, limits: original.limits })
  expect(gap.snapshot!.issues).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'unconfirmed' })]))
  await h.emit('turn.start', { turnId: 'next-original-turn' })
  expect((await h.inspect()).snapshot).toMatchObject({ observedAt: h.state.observedAt, model: { id: h.state.model } })
})

it.each([
  { agentId: 'child' }, { agent_id: 'child' }, { sequence: 0 }, { sequence: 1.5 }, { sourceId: '' }, { observedAt: NaN }
])('the native information adapter refuses an unconfirmed subject or source (%j)', fields => {
  expect(claudeNativeInformation(CLAUDE_INFORMATION_EVENT, { session_id: 'original-native', sourceId: 'source', sequence: 1,
    observedAt: fixtureEpoch(2, 0, 123), model: 'original-model', rateLimits: [], ...fields })).toBeUndefined()
})

it('malformed or duplicate native quota windows never become a fabricated balance', () => {
  const payload = { session_id: 'original-native', sourceId: 'source', sequence: 1, observedAt: fixtureEpoch(2, 0, 123), model: 'original-model' }
  for (const rateLimits of [[{ kind: 'weekly', percentUsed: -1 }], [{ kind: 'weekly', percentUsed: 1, resetsAt: 'invalid' }],
    [{ kind: 'weekly', percentUsed: 1 }, { kind: 'weekly', percentUsed: 2 }]]) {
    const snapshot = parseAgentInformationSnapshot(claudeNativeInformation(CLAUDE_INFORMATION_EVENT, { ...payload, rateLimits }))
    expect(snapshot.model!.id).toBe('original-model'); expect(snapshot.limits).toBeUndefined()
    expect(snapshot.issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'limits', kind: 'unconfirmed' })]))
  }
})

it('the actual installed Claude validates the complete generated observer without opening a Session', async () => {
  const h = await fixture(), plugin = join(h.directory, 'validated-plugin')
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true }); await mkdir(join(plugin, 'hooks'))
  const source = claudeNativeActivitySource()
  await writeFile(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'agentmux-native-information', version: '1.0.0', description: 'Native information observer validation.' }))
  await writeFile(join(plugin, 'hooks/hooks.json'), JSON.stringify({ modules: ['./register.js'] }))
  await writeFile(join(plugin, 'hooks/register.js'), source)
  const env = { PATH: process.env.PATH, HOME: h.directory, CLAUDE_CONFIG_DIR: join(h.directory, 'private-config'), LANG: 'C' }
  const version = execFileSync('claude', ['--version'], { encoding: 'utf8', env, timeout: 15000 }).trim()
  const report = JSON.parse(execFileSync('claude', ['plugin', 'validate', '--json', plugin], { encoding: 'utf8', env, timeout: 15000 }))
  expect(report.success).toBe(true)
  console.info('Installed native Claude validation:', JSON.stringify({ version, moduleSHA256: createHash('sha256').update(source).digest('hex'),
    success: report.success, scope: 'Static plugin validation only; callback fixtures execute separately, without model requests.' }))
})
