import { createHash } from 'node:crypto'
import { readFile, writeFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import { createWorkspaceLayout } from '../src/spatial-layout.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Private native confirmation cleanup failed')
})

it('a distinct Core consumes the retained exact main receipt on the original weak target and original waiting input', async () => {
  vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', resolve(import.meta.dirname, 'fixtures/native-main-confirmation/owner.mjs'))
  // The existing helper intentionally strips ambient AgentMux authority. These
  // private proof labels carry only mutation/trace selection, never credentials.
  vi.stubEnv('NATIVE_MAIN_PROOF_MUTATION', process.env.AGENTMUX_NATIVE_MAIN_MUTATION ?? '')
  vi.stubEnv('NATIVE_MAIN_PROOF_LOADED', process.env.AGENTMUX_NATIVE_MAIN_LOADED ?? '')
  const h = await headlessFixture({ ownerNodeArgs: ['--loader', resolve(import.meta.dirname, 'fixtures/native-main-confirmation/loader.mjs')] })
  cleanup.push(async () => {
    try {
      const client = await h.client()
      for (const session of await client.readAgentSessions()) await client.stopAgent(session.agentSessionId, session.run)
    } finally { await h.cleanup() }
  })
  let client = await h.client()
  const output = join(h.root, 'original-inputs.ndjson')
  const created = await client.createAgent({ createOperationId: 'original-private-create', providerId: 'private-main-protocol',
    executorId: 'private-main-protocol', workspacePath: h.root, injectAgentMuxGuide: false, commandOverride: process.execPath,
    args: [resolve(import.meta.dirname, 'fixtures/prompt-carrier-terminal.mjs')], env: { AGENTMUX_TEST_INPUT_WITNESS: output } })
  const sid = created.agentSessionId, run = created.run
  const before = await until(async () => {
    try {
      const ready = JSON.parse(await readFile(output + '.ready', 'utf8')) as { pid: number }
      const status = await client.statusAgent(sid)
      return status.run.pid === ready.pid ? status : null
    } catch { return null }
  }, Boolean, 'original controlled PTY process')
  const store = new AgentMuxFileAgentSessionStore(h.env.AGENTMUX_AGENT_SESSION_STORE!)
  const original = (await store.readMetadata(sid))!
  const prompt = 'Original private waiting question'
  const key = { kind: 'prompt' as const, agentSessionId: sid, expectedRun: run, submissionId: 'original-waiting-question' }
  await client.submitAgentPrompt({ agentSessionId: sid, expectedRun: run, operationId: key.submissionId, prompt,
    execution: 'immediate', admissionIntent: { kind: 'session-conversation' }, authorHuman: true })
  await vi.waitFor(async () => {
    const input = await client.inspectAgentInput({ key })
    expect(input?.control.waiting, JSON.stringify(input?.control.waiting)).toMatchObject({ phase: 'service', reason: 'observation-failed',
      failure: { code: 'AGENT_INITIAL_INPUT_UNCONFIRMED' }, observation: { phase: 'native-initialization' },
      initialization: { state: 'unknown', reason: 'inspection-unavailable' } })
  }, { timeout: 5_000 })
  const waiting = await client.inspectAgentInput({ key })
  const stopped = await client.stopAgentInputWaiting({ ref: waiting!.ref, cancelOperationId: 'hold-original-before-core-reopen' })
  expect(stopped.outcome).toBe('stopped-before-dispatch')
  expect(stopped.ref.key).toEqual(key)
  const digest = createHash('sha256').update(h.env.AGENTMUX_RUNTIME_DIRECTORY!).digest()
  const endpoint = `http://127.0.0.1:${40_000 + digest.readUInt16BE(0) % 20_000}/v1/events`
  const response = await fetch(endpoint, { method: 'POST',
    headers: { authorization: 'Bearer ' + original.hookToken, 'content-type': 'application/json' },
    body: JSON.stringify({ receiptId: 'original-main-receipt', eventName: 'main-object-observed', payload: { native_id: 'original-private-native' } }) })
  expect([200, 204], await response.text()).toContain(response.status)
  const confirmed = await until(() => store.readMetadata(sid), value => value?.hookReceipt?.id === 'original-main-receipt', 'authenticated original main receipt')
  expect(confirmed!.hookReceipt).toMatchObject({ agentSessionId: sid, run, providerId: 'private-main-protocol',
    subject: { kind: 'main', nativeSessionId: 'original-private-native' }, decision: { reason: 'no-semantic-rule' } })
  expect(confirmed!.hookReceipt!.lifecycleEvent).toBeUndefined()

  // Reproduce only the already-observed historical weak projection. The main
  // receipt itself came through authenticated HTTP and the original Hook CAS.
  const weak = { ...confirmed!, updatedAt: confirmed!.updatedAt + 1,
    nativeBinding: { ...confirmed!.nativeBinding!, source: 'semantic-resume-target' as const } }
  await store.compareAndSwapMetadata(confirmed!, weak)
  expect((await store.readMetadata(sid))!.nativeBinding).toEqual(weak.nativeBinding)
  // Explicitly stopped observation keeps the original known-unwritten input
  // from being consumed by the producer. No unknown/partial input is retried.
  const terminalInputs = async () => (await readFile(output, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''; throw error
  })).trim().split('\n').filter(Boolean).map(line => (JSON.parse(line) as { text: string }).text)
  const prior = await client.inspectAgentInput({ key })
  expect(prior).toMatchObject({ key, control: { state: 'stopped-before-dispatch' } })
  expect(await terminalInputs()).toEqual([])

  const spatial = new AgentMuxSpatialStateStore(join(h.env.AGENTMUX_STATE_DIRECTORY!, 'spatial-state.json'))
  const workface = await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'original-space', kind: 'folder', name: 'Original private work', hostId: 'local', directoryPath: h.root, projectId: null }],
    zones: [{ zoneId: 'original-zone', workspaceId: 'original-workspace', kind: 'directory', hostId: 'local', directoryPath: h.root, branch: null }],
    bindings: [{ zoneId: 'original-zone', spaceId: 'original-space' }],
    tabs: [{ tabId: 'original-tab', zoneId: 'original-zone', workspaceId: 'original-workspace', name: null, regionIds: ['original-region', 'neighbor-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: sid, runId: run.runId, execution: { hostId: 'local', cwd: h.root } },
      { regionId: 'neighbor-region', tabId: 'original-tab', kind: 'browser', agentSessionId: null, runId: null, execution: null }],
    layouts: { 'original-workspace': createWorkspaceLayout('original-group', ['original-tab']) },
    tabLayouts: { 'original-tab': { root: { type: 'split', direction: 'horizontal', ratio: 0.4,
      first: { type: 'leaf', regionId: 'original-region' }, second: { type: 'leaf', regionId: 'neighbor-region' } }, activeRegionId: 'original-region' } },
    resources: { 'original-tab': { draft: 'Original unsent draft', browserId: 'original-browser' } }
  } })
  const ownerBefore = h.owner, ownerPidBefore = h.ownerProcess.pid
  await client.dispose(); await h.stopOwner()
  const retained = (await store.readMetadata(sid))!
  expect(retained.nativeBinding?.source).toBe('semantic-resume-target')
  expect(retained.hookReceipt).toEqual(confirmed!.hookReceipt)
  await h.restart(); client = await h.client()
  expect(h.ownerProcess.pid).not.toBe(ownerPidBefore)
  expect(h.owner).toMatchObject({ runtimeId: ownerBefore.runtimeId, ctxmux: ownerBefore.ctxmux })
  expect(h.owner.ownerInstanceId).not.toBe(ownerBefore.ownerInstanceId)
  const after = await client.statusAgent(sid)
  expect(after.run).toMatchObject({ runId: run.runId, pid: before!.run.pid, state: 'running' })
  expect(after.session.nativeHandle).toEqual(confirmed!.nativeHandle)
  expect((await store.readMetadata(sid))!.hookReceipt).toEqual(confirmed!.hookReceipt)
  expect(await spatial.read()).toEqual(workface)
  expect(await client.inspectAgentInput({ key })).toEqual(prior)
  const continued = await client.rejoinAgentInputWaiting({ ref: prior!.ref })
  expect(continued.key).toEqual(key)
  expect(continued.ref.waitGeneration).toBe(prior!.ref.waitGeneration + 1)
  await vi.waitFor(async () => expect((await client.inspectAgentInput({ key }))?.status,
    'retained exact main receipt must release the original input after Core reopen').toBe('terminal-confirmed'), { timeout: 5_000 })
  const complete = await client.inspectAgentInput({ key })
  await until(terminalInputs, inputs => inputs.length === 1, 'original input exactly once')
  expect(await terminalInputs()).toEqual([prompt])
  const compiledCli = resolve(await realpath(resolve(import.meta.dirname, '../../../node_modules')), '../packages/core/bin/amux')
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + h.socketPath, 'agent', 'input', 'inspect', '--input', '-'],
    { ...h.env, AGENTMUX_TEST_OBJECT_CLI: compiledCli }, JSON.stringify({ key }))
  expect(cli.code, cli.stderr || cli.stdout).toBe(0)
  expect(JSON.parse(cli.stdout).result.input).toMatchObject({ key, status: 'terminal-confirmed' })
  expect(await terminalInputs()).toEqual([prompt])
  if (process.env.AGENTMUX_NATIVE_MAIN_RESTART_EVIDENCE) await writeFile(process.env.AGENTMUX_NATIVE_MAIN_RESTART_EVIDENCE,
    JSON.stringify({ qualification: 'Controlled native protocol leaf; current Source Core owners and official ctxmux, not a model CLI or live Mote.',
      historicalProjection: 'Only nativeBinding.source restored once through typed CAS before producer exit. Reader has no seed or Hook replay.',
      continuation: 'Cold retained fact plus explicit existing public continue of the original stopped-before-dispatch key; not automatic queue recovery.',
      ownerBefore, ownerAfter: h.owner, ownerPidBefore, ownerPidAfter: h.ownerProcess.pid, before, after, waiting, stopped, prior, continued, complete, key,
      originalReceipt: confirmed!.hookReceipt, workface, workfaceAfter: await spatial.read(), terminalInputs: await terminalInputs(),
      compiledCli: { path: compiledCli, sha256: createHash('sha256').update(await readFile(resolve(compiledCli, '../../dist/agentmux.js'))).digest('hex'),
        qualification: 'Existing compiled CLI forwards the unchanged contract to the current Source Core, not a rebuilt complete Core package.' } }, null, 2))
}, 60_000)
