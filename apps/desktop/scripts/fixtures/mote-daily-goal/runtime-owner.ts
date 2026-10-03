import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxFileAgentSessionStore, defaultAgentMuxControlSocketPath, loadAgentSessions, mintAgentSessionId, startHeadlessAgentMux } from '@agentmux/core'
import { openDemandStore } from '@agentmux/demand'
import { RuntimeController } from '../../../src/main/runtime-controller'
import { connectDesktopAgentMuxHost } from '../../../src/main/desktop-host'
import { ContinuousProgressLoopStore } from '../../../src/main/continuous-progress-loop-store'
import { ContinuousProgressLoopManager } from '../../../src/main/continuous-progress-loop-manager'
import { deliverContinuousProgress } from '../../../src/main/continuous-progress-delivery'
import type { AppConfig } from '../../../src/shared/contracts'
const root = process.env.DIRECTORY_RUNTIME_PRIVATE_ROOT!, phase = process.env.DIRECTORY_RUNTIME_PHASE!, nativeCli = process.env.DIRECTORY_RUNTIME_NATIVE_CLI!
assert.ok(root && phase && nativeCli)
const workspace = join(root, 'work'), targetPath = join(root, 'target.json')
const store = new AgentMuxFileAgentSessionStore(join(root, 'state/sessions.json')), goals = openDemandStore({ root: join(root, 'goals') })
const loopStore = new ContinuousProgressLoopStore(join(root, 'loops.json'))
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private Core' }], workspaces: [{ id: 'work', hostId: 'local', path: workspace, name: 'Private work', kind: 'folder' }],
  executors: { proof: { label: 'Original native protocol', providerId: 'codex', command: process.execPath, args: [nativeCli], env: { AGENTMUX_FAKE_READY_MODE: 'before', DIRECTORY_RUNTIME_ORIGINAL_ALIAS: workspace }, injectAgentMuxGuide: false } },
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
let host: Awaited<ReturnType<typeof startHeadlessAgentMux>> | undefined, runtime: RuntimeController | undefined, manager: ContinuousProgressLoopManager | undefined
let observe: Awaited<ReturnType<NonNullable<typeof host>['client']['observeAgentOutput']>> | undefined, output = '', now = 0
let target: { agentSessionId: string; runId?: string; workspacePath: string }, serial = Promise.resolve(), loseTick = phase === 'seed'
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 20000; let last: T | undefined
  do { last = await read(); if (accept(last)) return last; await new Promise(resolve => setTimeout(resolve, 25)) } while (Date.now() < deadline)
  throw Object.assign(new Error('Original private Goal did not confirm ' + label), { observation: last })
}
async function facts() {
  const status = await host!.client.statusAgent(target.agentSessionId), saved = (await loadAgentSessions(store)).find(session => session.agentSessionId === target.agentSessionId)
  assert.ok(saved)
  return { pid: process.pid, phase, owner: host!.ownerIdentity(), target, session: { id: saved.agentSessionId, workspacePath: saved.workspacePath, run: saved.run }, saved: { id: saved.agentSessionId, run: saved.run, workspacePath: saved.workspacePath },
    run: { runId: status.run.runId, pid: status.run.pid, workspacePath: status.run.workspacePath, state: status.run.state, acceptedInputBytes: status.run.acceptedInputBytes },
    goal: await goals.get('goal'), loop: manager!.list()[0], output }
}
async function shutdown(stopRun = false) {
  await manager?.stop(); await observe?.close(); observe = undefined
  if (stopRun && host) { const saved = (await loadAgentSessions(store)).find(session => session.agentSessionId === target.agentSessionId); if (saved) { assert.equal(saved.workspacePath, workspace); const status = await host.client.statusAgent(saved.agentSessionId); if (status.run.state === 'running') await host.client.stopAgent(saved.agentSessionId, saved.run) } }
  await runtime?.dispose(); await host?.stop()
}
try {
  await mkdir(workspace, { recursive: true })
  if (phase === 'seed') {
    await writeFile(join(workspace, 'note.md'), '# Original private Note\n')
    target = { agentSessionId: mintAgentSessionId(), workspacePath: workspace }; await writeFile(targetPath, JSON.stringify(target))
  } else target = JSON.parse(await readFile(targetPath, 'utf8'))
  host = await startHeadlessAgentMux({ store, stateDirectory: join(root, 'state'), socketPath: defaultAgentMuxControlSocketPath() })
  runtime = new RuntimeController(store, connectDesktopAgentMuxHost); runtime.commit(await runtime.prepare(config))
  runtime.setContinuousProgressInputObserver(async () => false) // This private Node graph has no Renderer input; real Composer fences are separately operated.
  if (phase === 'cleanup') { await shutdown(true); process.stdout.write(JSON.stringify({ passed: true, phase, pid: process.pid }) + '\n'); process.exit(0) }
  if (phase === 'seed') {
    const launch = await runtime.launchAgent({ hostId: 'local', executorId: 'proof', workspacePath: workspace, agentSessionId: target.agentSessionId, createOperationId: 'original-goal-agent' }, config)
    assert.equal(launch.created.agentSessionId, target.agentSessionId); target.runId = launch.created.run.runId; await writeFile(targetPath, JSON.stringify(target))
    await goals.create({ id: 'goal', title: 'Original bounded work', description: 'Produce the original useful result.', sessionIds: [target.agentSessionId] })
    await goals.proposeAlignment('goal', { summary: 'Original work', criteria: [{ id: 'real', text: 'A real result exists' }], openQuestions: [] }); await goals.confirmAlignment('goal', 1)
  }
  observe = await host.client.observeAgentOutput(target.agentSessionId, 0, event => { if (event.type === 'terminal-output' && event.run.runId === target.runId) output += event.data })
  await until(() => host!.client.statusAgent(target.agentSessionId), status => status.run.state === 'running' && !!status.session.nativeHandle && status.session.semanticStatus?.state === 'done', 'real native identity/readiness')
  manager = new ContinuousProgressLoopManager(loopStore, async (loop, op, isCurrent, signal) => {
    const result = await deliverContinuousProgress(runtime!, loop, op, isCurrent, signal)
    if (loseTick && result === 'sent') { loseTick = false; throw new Error('Private Host lost its original continuation receipt after Core ACK') }
    return result
  }, () => now, (loop, tick, at, signal) => runtime!.observeContinuousProgress(loop, tick, at, signal),
  { saveFutureIntent: (loop, active, context) => runtime!.saveFutureIntent(loop, active, context), authorizeFutureIntent: (loop, context) => runtime!.authorizeFutureIntent(loop, context) },
  { read: id => goals.get(id), subscribe: listener => goals.subscribe(snapshot => listener(snapshot.demands)), inspectInitial: loop => runtime!.inspectContinuousProgressInitial(loop) })
  await manager.start()
  if (phase === 'seed') {
    const status = await host.client.statusAgent(target.agentSessionId), original = { hostId: 'local', agentSessionId: target.agentSessionId, providerId: 'codex', workspacePath: workspace }
    const loop = await manager.prepareGoal({ ...original, goalId: 'goal', alignmentRevision: 1, intervalMs: 100, operationId: 'original-goal-start', prompt: 'Produce the original useful result.' })
    assert.equal(loop.status, 'paused'); assert.equal((await loopStore.load())[0]!.creationOperationId, 'original-goal-start')
    await manager.submitGoalInitial(original, 'goal', loop.loopId, 'original-goal-start', loop.initialDelivery!.prompt, loop.initialDelivery!.condition,
      (isCurrent, signal) => runtime!.submitPrompt({ kind: 'agent', hostId: 'local', agentSessionId: target.agentSessionId, run: status.session.run }, loop.initialDelivery!.prompt, 'original-goal-start', loop.initialDelivery!.condition, { isCurrent, signal }))
    await until(() => host!.client.statusAgent(target.agentSessionId), current => current.session.semanticStatus?.state === 'done' && (current.session.semanticStatus.observedAt ?? 0) > (status.session.semanticStatus?.observedAt ?? 0), 'original initial turn completes')
  } else {
    const recovered = await runtime.recoverSession({ kind: 'agent', hostId: 'local', agentSessionId: target.agentSessionId, run: { runId: target.runId! } }, config, undefined, 'goal-private-cold-continuity')
    assert.equal(recovered.kind, 'reattachable')
  }
  process.stdout.write(JSON.stringify({ ready: true, ...await facts() }) + '\n')
  process.on('message', (message: { request: number; action: string }) => { serial = serial.then(async () => {
    let result: unknown
    if (message.action === 'facts') result = await facts()
    else if (message.action === 'migrate') {
      now = 1000; await manager!.check(now); result = await facts(); assert.equal(manager!.list()[0]!.status, 'paused', JSON.stringify(result)); assert.equal(manager!.list()[0]!.lastOutcome, 'unknown'); assert.ok(manager!.list()[0]!.pendingCompletion)
    } else if (message.action === 'input') {
      const before = await facts()
      if (phase === 'restore') {
        const loop = manager!.list()[0]!; await manager!.goalAction('goal', loop.loopId, 'resume', loop.revision!, 'same-original-retry'); now = 2000; await manager!.check(now)
        const after = await facts(); assert.equal(after.run.acceptedInputBytes, before.run.acceptedInputBytes, 'Cold retry reconciles the exact original Core transaction, with no duplicate bytes')
        await goals.update('goal', { status: 'done' }); assert.equal(manager!.list()[0]!.status, 'stopped'); assert.equal((await facts()).run.state, 'running')
      }
      const status = await host!.client.statusAgent(target.agentSessionId), label = 'input-' + phase + '-' + message.request
      await runtime!.write({ kind: 'agent', hostId: 'local', agentSessionId: target.agentSessionId, run: status.session.run }, label, 'user')
      await until(async () => output, value => value.includes(label), 'healthy manual input')
      result = { before, after: await facts(), label }
    } else if (message.action === 'detach' || message.action === 'stop') { result = await facts(); await shutdown(message.action === 'stop') }
    else throw new Error('Unsupported private command')
    process.send?.({ request: message.request, result }); if (message.action === 'detach' || message.action === 'stop') process.exit(0)
  }).catch(error => { process.send?.({ request: message.request, error: { message: error.message, stack: error.stack } }) }) })
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)))
} catch (error) { process.stderr.write(JSON.stringify({ message: (error as Error).message, stack: (error as Error).stack, observation: (error as Error & { observation?: unknown }).observation, output }) + '\n'); await shutdown().catch(() => {}); process.exit(1) }
