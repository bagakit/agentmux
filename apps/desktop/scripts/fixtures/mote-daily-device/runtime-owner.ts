import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentMuxFileAgentSessionStore, connectAgentMuxRpc, defaultAgentMuxControlSocketPath, loadAgentSessions, mintAgentSessionId, startHeadlessAgentMux } from '@agentmux/core'
import { connectHostedAgentMux, type AgentMuxHostedClient } from '@agentmux/core/hosted'
import { openDemandStore } from '@agentmux/demand'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { connectDesktopAgentMuxHost } from '../../../src/main/desktop-host'
import { ContinuousProgressLoopStore } from '../../../src/main/continuous-progress-loop-store'
import { ContinuousProgressLoopManager } from '../../../src/main/continuous-progress-loop-manager'
import { deliverContinuousProgress } from '../../../src/main/continuous-progress-delivery'
import { goalWorkTarget, inspectGoal, sendGoalOperation } from '../../../../mobile/src/navigation/goal-work'
import { DeviceWorkfaceStore, type MobileGoalOperation } from '../../../../mobile/src/recovery/device-workface'
import type { AppConfig } from '../../../src/shared/contracts'

const root = process.env.DIRECTORY_RUNTIME_PRIVATE_ROOT!, phase = process.env.DIRECTORY_RUNTIME_PHASE!, nativeCli = process.env.DIRECTORY_RUNTIME_NATIVE_CLI!
assert.ok(root && phase && nativeCli)
const workspace = join(root, 'work'), targetPath = join(root, 'target.json'), storagePath = join(root, 'device-storage.json')
// Only the existing owners interpret these bytes. This private synchronous Storage port replaces
// Chromium storage, not DeviceWorkfaceStore or the original Launcher persistence protocol.
const storage = {
  getItem(key: string): string | null { const value = existsSync(storagePath) ? JSON.parse(readFileSync(storagePath, 'utf8')) as Record<string, string> : {}; return value[key] ?? null },
  setItem(key: string, bytes: string): void { const value = existsSync(storagePath) ? JSON.parse(readFileSync(storagePath, 'utf8')) as Record<string, string> : {}; writeFileSync(storagePath, JSON.stringify({ ...value, [key]: bytes })) },
  removeItem(key: string): void { const value = existsSync(storagePath) ? JSON.parse(readFileSync(storagePath, 'utf8')) as Record<string, string> : {}; delete value[key]; writeFileSync(storagePath, JSON.stringify(value)) }
}
Object.defineProperty(globalThis, 'window', { value: { localStorage: storage, addEventListener() {}, removeEventListener() {} }, configurable: true })
const { api } = await import('../../../src/renderer/src/lib/api')
const { useAppStore } = await import('../../../src/renderer/src/store')
const { useLauncherState } = await import('../../../src/renderer/src/lib/launcher-state')
const device = new DeviceWorkfaceStore(() => storage)
const store = new AgentMuxFileAgentSessionStore(join(root, 'state/sessions.json')), goals = openDemandStore({ root: join(root, 'goals') })
const loopStore = new ContinuousProgressLoopStore(join(root, 'loops.json'))
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private Core' }], workspaces: [{ id: 'work', hostId: 'local', path: workspace, name: 'Private work', kind: 'folder' }],
  executors: { proof: { label: 'Original native protocol', providerId: 'codex', command: process.execPath, args: [nativeCli], env: { AGENTMUX_FAKE_READY_MODE: 'before', DIRECTORY_RUNTIME_ORIGINAL_ALIAS: workspace }, injectAgentMuxGuide: false } },
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
let host: Awaited<ReturnType<typeof startHeadlessAgentMux>> | undefined, runtime: RuntimeController | undefined, manager: ContinuousProgressLoopManager | undefined
let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined, client: AgentMuxHostedClient | undefined
let observe: Awaited<ReturnType<NonNullable<typeof host>['client']['observeAgentOutput']>> | undefined, output = '', now = 0
let target: { agentSessionId: string; runId?: string; workspacePath: string }, serial = Promise.resolve(), losePauseAck = phase === 'seed'
const publicCalls: unknown[] = [], controlCalls: unknown[] = []
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 20000; let last: T | undefined
  do { last = await read(); if (accept(last)) return last; await new Promise(resolve => setTimeout(resolve, 25)) } while (Date.now() < deadline)
  throw Object.assign(new Error('Original private device did not confirm ' + label), { observation: last })
}
async function openConsumer() {
  rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: defaultAgentMuxControlSocketPath() } })
  client = await connectHostedAgentMux({ rpc, forwardRpc: async (method, params, context) => {
    const result = await rpc!.call(method, params, context)
    publicCalls.push({ method, params, context, result })
    if (losePauseAck && method === 'goal.continuation-action' && 'action' in params && params.action === 'pause') {
      losePauseAck = false
      throw new Error('Private transport lost the original pause response after the original Manager confirmed it')
    }
    return result
  } })
}
async function facts() {
  const status = await host!.client.statusAgent(target.agentSessionId), saved = (await loadAgentSessions(store)).find(session => session.agentSessionId === target.agentSessionId)
  assert.ok(saved)
  const detail = client ? await inspectGoal(client, 'goal', target.agentSessionId) : null
  return { pid: process.pid, phase, socketPath: defaultAgentMuxControlSocketPath(), owner: host!.ownerIdentity(), hostedOwner: client?.runtimeOwnerIdentity(), target,
    session: { id: saved.agentSessionId, workspacePath: saved.workspacePath, run: saved.run, nativeHandle: saved.nativeHandle },
    run: { runId: status.run.runId, pid: status.run.pid, workspacePath: status.run.workspacePath, state: status.run.state, acceptedInputBytes: status.run.acceptedInputBytes },
    goal: await goals.get('goal'), loop: manager!.list()[0], detail, device: device.snapshot(), launcher: useLauncherState.getState().drafts,
    output, publicCalls: [...publicCalls], controlCalls: [...controlCalls] }
}
async function shutdown(stopRun = false) {
  await client?.dispose(); client = undefined; await rpc?.dispose(); rpc = undefined
  await manager?.stop(); await observe?.close(); observe = undefined
  if (stopRun && host) { const saved = (await loadAgentSessions(store)).find(session => session.agentSessionId === target.agentSessionId); if (saved) { assert.equal(saved.workspacePath, workspace); const status = await host.client.statusAgent(saved.agentSessionId); if (status.run.state === 'running') await host.client.stopAgent(saved.agentSessionId, saved.run) } }
  await runtime?.dispose(); await host?.stop()
}
try {
  await mkdir(workspace, { recursive: true })
  if (phase === 'seed') {
    await writeFile(join(workspace, 'note.md'), '# Original private result\n')
    target = { agentSessionId: mintAgentSessionId(), workspacePath: workspace }; await writeFile(targetPath, JSON.stringify(target))
  } else target = JSON.parse(await readFile(targetPath, 'utf8'))
  host = await startHeadlessAgentMux({ store, stateDirectory: join(root, 'state'), socketPath: defaultAgentMuxControlSocketPath(), service: {
    execute: async request => { const result = await useAppStore.getState().executeControl(request); controlCalls.push({ request, result }); return result }
  } })
  runtime = new RuntimeController(store, connectDesktopAgentMuxHost); runtime.commit(await runtime.prepare(config))
  runtime.setContinuousProgressInputObserver(async () => false) // Node has no active Renderer input; real UI draft fences are separately operated.
  if (phase === 'cleanup') { await shutdown(true); process.stdout.write(JSON.stringify({ passed: true, phase, pid: process.pid }) + '\n'); process.exit(0) }
  if (phase === 'seed') {
    const launch = await runtime.launchAgent({ hostId: 'local', executorId: 'proof', workspacePath: workspace, agentSessionId: target.agentSessionId, createOperationId: 'original-device-agent' }, config)
    assert.equal(launch.created.agentSessionId, target.agentSessionId); target.runId = launch.created.run.runId; await writeFile(targetPath, JSON.stringify(target))
    await goals.create({ id: 'goal', title: 'Original bounded work', description: 'Produce the original useful result.', sessionIds: [target.agentSessionId] })
    await goals.proposeAlignment('goal', { summary: 'Original work', criteria: [{ id: 'real', text: 'A real result exists' }], openQuestions: [] }); await goals.confirmAlignment('goal', 1)
  }
  observe = await host.client.observeAgentOutput(target.agentSessionId, 0, event => { if (event.type === 'terminal-output' && event.run.runId === target.runId) output += event.data })
  await until(() => host!.client.statusAgent(target.agentSessionId), status => status.run.state === 'running' && !!status.session.nativeHandle && status.session.semanticStatus?.state === 'done', 'real native identity/readiness')
  manager = new ContinuousProgressLoopManager(loopStore, (loop, op, isCurrent, signal) => deliverContinuousProgress(runtime!, loop, op, isCurrent, signal), () => now,
    (loop, tick, at, signal) => runtime!.observeContinuousProgress(loop, tick, at, signal),
    { saveFutureIntent: (loop, active, context) => runtime!.saveFutureIntent(loop, active, context), authorizeFutureIntent: (loop, context) => runtime!.authorizeFutureIntent(loop, context) },
    { read: id => goals.get(id), subscribe: listener => goals.subscribe(snapshot => listener(snapshot.demands)), inspectInitial: loop => runtime!.inspectContinuousProgressInitial(loop) })
  await manager.start()
  if (phase === 'seed') {
    const status = await host.client.statusAgent(target.agentSessionId), original = { hostId: 'local', agentSessionId: target.agentSessionId, providerId: 'codex', workspacePath: workspace }
    const loop = await manager.prepareGoal({ ...original, goalId: 'goal', alignmentRevision: 1, intervalMs: 60000, operationId: 'original-device-start', prompt: 'Produce the original useful result.' })
    await manager.submitGoalInitial(original, 'goal', loop.loopId, 'original-device-start', loop.initialDelivery!.prompt, loop.initialDelivery!.condition,
      (isCurrent, signal) => runtime!.submitPrompt({ kind: 'agent', hostId: 'local', agentSessionId: target.agentSessionId, run: status.session.run }, loop.initialDelivery!.prompt, 'original-device-start', loop.initialDelivery!.condition, { isCurrent, signal }))
    await until(() => host!.client.statusAgent(target.agentSessionId), current => current.session.semanticStatus?.state === 'done' && (current.session.semanticStatus.observedAt ?? 0) > (status.session.semanticStatus?.observedAt ?? 0), 'original initial turn completes')
  } else {
    const recovered = await runtime.recoverSession({ kind: 'agent', hostId: 'local', agentSessionId: target.agentSessionId, run: { runId: target.runId! } }, config, undefined, 'device-private-cold-continuity')
    assert.equal(recovered.kind, 'reattachable')
  }
  // Only these existing Main API ports are installed; public requests execute the production Store.
  api.demands.list = () => goals.list()
  api.continuousProgress.goals = async goalId => manager!.listGoals(goalId)
  api.continuousProgress.goalAction = (goalId, loopId, action, revision, op, caller) => {
    if (caller && !caller.capability) throw new Error('Original managed caller capability is unavailable.')
    return manager!.goalAction(goalId, loopId, action, revision, op,
      caller?.capability ? { caller: { agentSessionId: caller.agentSessionId, capability: caller.capability } } : undefined)
  }
  const snapshot = await runtime.snapshot(config); useAppStore.setState({ config, sessions: snapshot.sessions, loading: false })
  await openConsumer()
  if (phase === 'seed') {
    const selection = goalWorkTarget(client!, device, target.agentSessionId, 'goal'); device.selectGoal(selection)
    device.updateNavigation({ selectedSessionId: target.agentSessionId, hostUrl: 'http://localhost', panel: 'conversation' })
    device.updateConversation({ version: 1, drafts: [[target.agentSessionId, 'Original mobile unsent question']], attempts: [], responses: [] })
    assert.equal(useLauncherState.getState().setDraft('original-launcher', 'prompt', 'Original desktop unsent question'), true)
  }
  const listed = await client!.forwardRpc!('goal.ls', { agentSessionId: target.agentSessionId }); assert.ok(listed.goals.some(goal => goal.id === 'goal'))
  process.stdout.write(JSON.stringify({ ready: true, ...await facts() }) + '\n')
  process.on('message', (message: { request: number; action: string }) => { serial = serial.then(async () => {
    let result: unknown
    if (message.action === 'facts') result = await facts()
    else if (message.action === 'pause-lost-ack') {
      const before = await facts(), loop = manager!.list()[0]!; assert.ok(loop.revision)
      const operation: MobileGoalOperation = { ...goalWorkTarget(client!, device, target.agentSessionId, 'goal'), operationId: 'original-device-pause', kind: 'action', loopId: loop.loopId, action: 'pause', expectedRevision: loop.revision }
      device.retainGoalOperation(operation)
      await assert.rejects(() => sendGoalOperation(client!, device, operation, () => true), /lost the original pause response/)
      const after = await facts(); assert.deepEqual(after.device.record.goalWork?.pending, [operation]); assert.equal(after.loop!.status, 'paused')
      assert.equal(after.run.acceptedInputBytes, before.run.acceptedInputBytes, 'Pause never submits Agent input')
      result = { before, after, operation }
    } else if (message.action === 'retry-original') {
      const before = await facts(), operation = device.snapshot().record.goalWork?.pending[0]; assert.ok(operation)
      const resultDetail = await sendGoalOperation(client!, device, operation, () => true), after = await facts()
      assert.deepEqual(after.device.record.goalWork?.pending, []); assert.equal(after.loop!.lastMutation!.operationId, operation.operationId)
      assert.equal(after.run.acceptedInputBytes, before.run.acceptedInputBytes, 'Explicit same-operation retry never duplicates native bytes')
      assert.deepEqual(resultDetail.goal, before.detail!.goal); result = { before, after, operation, resultDetail }
    } else if (message.action === 'input') {
      const before = await facts(), status = await host!.client.statusAgent(target.agentSessionId), label = 'input-' + phase + '-' + message.request
      await runtime!.write({ kind: 'agent', hostId: 'local', agentSessionId: target.agentSessionId, run: status.session.run }, label, 'user')
      await until(async () => output, value => value.includes(label), 'healthy manual input'); result = { before, after: await facts(), label }
    } else if (message.action === 'result') {
      await writeFile(join(workspace, 'result.md'), '# Original private outcome\n')
      await goals.update('goal', { status: 'done' }); const inspected = await inspectGoal(client!, 'goal', target.agentSessionId)
      assert.equal(inspected.goal?.status, 'done'); assert.equal(manager!.list()[0]!.status, 'stopped'); assert.equal((await facts()).run.state, 'running')
      result = { inspected, resultContent: await readFile(join(workspace, 'result.md'), 'utf8'), after: await facts() }
    } else if (message.action === 'detach' || message.action === 'stop') { result = await facts(); await shutdown(message.action === 'stop') }
    else throw new Error('Unsupported private command')
    process.send?.({ request: message.request, result }); if (message.action === 'detach' || message.action === 'stop') process.exit(0)
  }).catch(error => { process.send?.({ request: message.request, error: { message: error.message, stack: error.stack } }) }) })
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
} catch (error) { process.stderr.write(JSON.stringify({ message: (error as Error).message, stack: (error as Error).stack, observation: (error as Error & { observation?: unknown }).observation, output }) + '\n'); await shutdown().catch(() => {}); process.exit(1) }
