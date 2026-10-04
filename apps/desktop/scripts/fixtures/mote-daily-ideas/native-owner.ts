import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxFileAgentSessionStore, defaultAgentMuxControlSocketPath, loadAgentSessions, startHeadlessAgentMux } from '@agentmux/core'
import { AgentMuxControlServer } from '../../../../../packages/core/src/public-rpc-server'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { connectDesktopAgentMuxHost } from '../../../src/main/desktop-host'
import { ContinuousProgressLoopManager } from '../../../src/main/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '../../../src/main/continuous-progress-loop-store'
import { deliverContinuousProgress } from '../../../src/main/continuous-progress-delivery'
import type { AppConfig } from '../../../src/shared/contracts'

const state = process.env.AGENTMUX_STATE_DIRECTORY!, runtimeDirectory = process.env.AGENTMUX_RUNTIME_DIRECTORY!
const workspace = process.env.SCHEDULE_PROBE_WORKSPACE!, nativeCli = process.env.SCHEDULE_PROBE_AGENT!
assert.ok(state && runtimeDirectory && workspace && nativeCli)
const store = new AgentMuxFileAgentSessionStore(join(state, 'sessions.json'))
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private original Core' }],
  workspaces: [{ id: 'work', hostId: 'local', path: workspace, name: 'Private work', kind: 'folder' }],
  executors: { proof: { label: 'Original native protocol fixture', providerId: 'codex', command: process.execPath,
    args: [nativeCli], env: { AGENTMUX_FAKE_READY_MODE: 'before' }, injectAgentMuxGuide: false } },
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true,
    viewport: true, saveBookmark: true, more: true } } }
let host: Awaited<ReturnType<typeof startHeadlessAgentMux>> | undefined, runtime: RuntimeController | undefined
let loops: ContinuousProgressLoopManager | undefined, server: AgentMuxControlServer | undefined
let output: Awaited<ReturnType<NonNullable<typeof host>['client']['observeAgentOutput']>> | undefined
let original: { agentSessionId: string; runId: string }, observed = ''
async function shutdown() { await server?.stop(); await loops?.stop(); await output?.close(); await runtime?.dispose(); await host?.stop() }
try {
  host = await startHeadlessAgentMux({ store, stateDirectory: state, socketPath: defaultAgentMuxControlSocketPath() })
  runtime = new RuntimeController(store, connectDesktopAgentMuxHost); runtime.commit(await runtime.prepare(config))
  runtime.setContinuousProgressInputObserver(async () => false) // No private Renderer typing into this Run; actual Calendar input fences have their own owning tests.
  try { original = JSON.parse(await readFile(join(state, 'target.json'), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const launch = await runtime.launchAgent({ hostId: 'local', executorId: 'proof', workspacePath: workspace,
      createOperationId: 'private-original-idea-agent' }, config)
    original = { agentSessionId: launch.created.agentSessionId, runId: launch.created.run.runId }
    await writeFile(join(state, 'target.json'), JSON.stringify(original))
  }
  output = await host.client.observeAgentOutput(original.agentSessionId, 0, event => {
    if (event.type === 'terminal-output' && event.run.runId === original.runId) observed += event.data
  })
  const deadline = Date.now() + 20_000
  let status = await host.client.statusAgent(original.agentSessionId)
  while (status.run.state !== 'running' || !status.session.nativeHandle || status.session.semanticStatus?.state !== 'done') {
    if (Date.now() > deadline) throw new Error('Original native readiness is unconfirmed: ' + JSON.stringify({ status, observed }))
    await new Promise(resolve => setTimeout(resolve, 20)); status = await host.client.statusAgent(original.agentSessionId)
  }
  const target = { hostId: 'local', agentSessionId: original.agentSessionId, providerId: 'codex', workspacePath: workspace }
  loops = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(state, 'loops.json')), async (...args) => {
    const result = await deliverContinuousProgress(runtime!, ...args)
    return process.env.SCHEDULE_PROBE_DROP_RECEIPT === '1' ? 'unknown' : result
  }, () => Number(process.env.SCHEDULE_PROBE_NOW), (loop, tick, at, signal) => runtime!.observeContinuousProgress(loop, tick, at, signal),
  { saveFutureIntent: (loop, active, context) => runtime!.saveFutureIntent(loop, active, context), authorizeFutureIntent: (loop, context) => runtime!.authorizeFutureIntent(loop, context) })
  await loops.start()
  server = new AgentMuxControlServer({ socketPath: join(runtimeDirectory, 'schedule.sock'), schedules: loops,
    coreClients: () => runtime!.rpcClients() })
  await server.start()
  const saved = (await loadAgentSessions(store)).find(session => session.agentSessionId === original.agentSessionId)!
  const borrowed = runtime.rpcClients().find(one => one.hostId === 'local')!.client
  assert.notEqual(borrowed, host.client)
  process.stdout.write(JSON.stringify({ pid: process.pid, target, socketPath: server.path, hostedOwner: host.ownerIdentity(),
    borrowed: borrowed !== host.client, run: saved.run, nativeSessionId: saved.nativeHandle?.kind === 'provider' ? saved.nativeHandle.sessionId : null }) + '\n')
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)) })
  process.on('message', async message => {
    try { if (message === 'check') { await loops!.check(Number(process.env.SCHEDULE_PROBE_NOW)); process.send?.({ checked: true, schedules: loops!.list() }) } }
    catch (error) { process.send?.({ error: (error as Error).stack }) }
  })
} catch (error) { process.stderr.write((error as Error).stack + '\n'); await shutdown().catch(() => {}); process.exit(1) }
