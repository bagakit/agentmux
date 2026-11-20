import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { AgentMuxControlServer } from '@agentmux/core'
import { connectBrowserSdk } from '@agentmux/core/browser-sdk'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { BrowserTaskAssets, BrowserTaskAssetFileStore } from '../../../src/main/browser-task-assets.js'
import { executeBrowserTaskControl } from '../../../src/main/browser-task-control.js'
import { registerBrowserTaskParallelIpc } from '../../../src/main/browser-task-parallel-ipc.js'
import { projectBrowserControlEvent, projectBrowserControlOperation } from '../../../src/main/browser-completion-control.js'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store.js'
import { BrowserRefLedgerStore } from '@agentmux/browser/operations'
import { BrowserOperationJournal, BrowserOperationFileStore } from '@agentmux/browser/operations'
import { importTaskRecording } from '../../../test/helpers/import-task-recording.js'
import type { BrowserTaskStep } from '../../../src/shared/browser-task-assets.js'

const home = process.env.TASK_PARALLEL_HOME!, out = process.env.TASK_PARALLEL_OUT!, base = process.env.TASK_PARALLEL_BASE!
const phase = process.env.TASK_PARALLEL_PHASE!, node = process.env.TASK_PARALLEL_NODE!, source = 'orchestration-library'
const receipt: any = { passed: false, phase, pid: process.pid, cases: [], cli: [], dialogs: [] }
const assets = new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(home, 'assets.json')))
const journal = new BrowserOperationJournal(new BrowserOperationFileStore(join(home, 'journal.sqlite')), { maxEvents: 4 })
let window: BrowserWindow, profiles: BrowserProfileManager, manager: BrowserViewManager, control: AgentMuxControlServer
const pause = (ms: number) => new Promise(done => setTimeout(done, ms)), authorize = async () => {}
const wc = (id: string) => manager.nativeOwner(id)!.view.webContents
async function until<T>(read: () => Promise<T | false | null | undefined>, label: string): Promise<T> {
  const end = Date.now() + 25_000
  while (Date.now() < end) { const value = await read(); if (value) return value; await pause(30) }
  throw new Error('Original native fact did not settle: ' + label)
}
async function cli(args: string[], input?: unknown) {
  const result = await new Promise<any>((accept, reject) => {
    const child = spawn(node, [join(out, 'cli.mjs'), '--endpoint', 'unix:' + join(home, 'control.sock'), 'browser', 'task', ...args], {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE')), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(Error('Native CLI deadline: ' + args[0])) }, 90_000)
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); accept({ code, stdout, stderr }) }); child.stdin.end(input === undefined ? '' : JSON.stringify(input))
  })
  receipt.cli.push({ command: args[0], code: result.code }); assert.equal(result.code, 0, result.stderr + result.stdout)
  return JSON.parse(result.stdout).result
}
const inspect = async (operationId: string, continuationId?: string) => (await cli(['parallel-inspect', '--browser', source, '--operation-id', operationId, ...(continuationId ? ['--continuation-id', continuationId] : [])])).inspection
const read = (operationId: string) => manager.inspectTaskParallel(source, operationId, undefined, 64)
const run = (assetId: string, operationId: string, targets: any[]) => cli(['parallel', '--browser', source, '--asset', assetId, '--version', '1', '--input', '-'], { operationId, targets })
const target = (id: string, profileId: string) => ({ id, browserId: id, profileId, parameters: { value: 'private synthetic start' } })
const semantic = (name: string, role = 'button') => ({ role, name, ordinal: 1, count: 1 })
const fill = (id: string): BrowserTaskStep => ({ id, kind: 'fill', url: base, target: semantic('Item value', 'text input'), parameterKey: 'value', reviewed: true })
const submit = (id: string): BrowserTaskStep => ({ id, kind: 'click', url: base, target: semantic('Submit item'), reviewed: true })
const wait: BrowserTaskStep = { id: 'original-wait', kind: 'wait', url: base, wait: { kind: 'element-present', target: { role: 'button', name: 'Gate opened' } }, timeoutMs: 25_000, reviewed: true }
async function make(id: string, steps: BrowserTaskStep[]) {
  const imported = await importTaskRecording(assets, { id, browserId: source, navigationId: 'original-definition', url: base, status: 'stopped', revision: 1, startedAt: 1, updatedAt: 2, steps: [] })
  const edit = await assets.edit(imported.id, imported.revision, { ...imported.draft, name: id, parameters: [{ key: 'value', label: 'Item value', secret: true }], steps })
  return assets.saveVersion(edit.id, edit.revision)
}
const facts = (id: string) => wc(id).executeJavaScript('parallelProof.facts()')
async function mount(assetId: string, operationId: string) {
  const state = await assets.state(source), current = (await read(operationId))!.run, asset = state.assets.find(asset => asset.id === assetId)!
  await window.webContents.executeJavaScript(`taskOrchestrationNative.setOriginal(${JSON.stringify({ asset, assets: state.assets, version: asset.versions.at(-1)!.version, current })})`)
  await until(async () => window.webContents.executeJavaScript(`Boolean(document.querySelector('.browser-task-parallel'))`), 'actual production Parallel component')
  await click('.browser-task-parallel > summary')
}
async function click(selector: string) {
  const point = await until(async () => window.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}:null})()`), 'real native input target ' + selector)
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point }); window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point }); window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point }); await pause(50)
}
async function first(targets: any[]) {
  const original = await make('original human review', [fill('completed-fill'), submit('completed-submit'), { id: 'person-review', kind: 'checkpoint', url: base, reviewed: true }, fill('remaining-fill'), submit('remaining-submit'), wait])
  // Stop reaches the original preparing lease before a Run exists. A late real native
  // preparation response must neither dispatch a page action nor steal human input.
  let release!: () => void, preparing = false
  const gate = new Promise<void>(done => { release = done })
  manager.prepareTaskTarget = async id => { if (id === targets[0].browserId) { preparing = true; await gate } }
  manager.takeControl(targets[0].browserId)
  await run(original.id, 'stop-preparation', [target(targets[0].browserId, targets[0].profileId), target(targets[1].browserId, targets[1].profileId)])
  await until(async () => preparing, 'original target preparation')
  await cli(['parallel-stop', '--browser', source, '--operation-id', 'stop-preparation']); release(); delete manager.prepareTaskTarget
  await until(async () => { const value = await read('stop-preparation'); return value?.run.status === 'stopped' && value.targets.every(row => row.phase === 'stopped') ? value : null }, 'original preparation stopped')
  assert.equal(manager.target(targets[0].browserId)!.control?.owner, 'human')
  assert.equal((await facts(targets[0].browserId)).state.items.length, 0)
  receipt.cases.push({ kind: 'compiled-cli-stop-original-preparation-and-queue', stopped: await inspect('stop-preparation') })
  await manager.returnControl(targets[0].browserId)
  await run(original.id, 'human-group', [target(targets[0].browserId, targets[0].profileId)])
  const waiting = await until(async () => { const value = await read('human-group'); return value?.targets[0]?.continuationRevision && value.targets[0]!.run?.status === 'waiting-human' ? value : null }, 'original human checkpoint')
  const originalRun = waiting.targets[0]!.run!.id
  const refused = await cli(['parallel-continue', '--browser', source, '--operation-id', 'human-group', '--target', targets[0].browserId, '--input', '-'], { continuationId: 'public-cannot-approve', expectedRevision: waiting.targets[0]!.continuationRevision, parameters: { value: 'public not approval' } })
  assert.equal(refused.continuation.admission, 'refused'); assert.equal((await facts(targets[0].browserId)).state.items.length, 1)
  // Editor v2 cannot replace the running operation's v1. Native pointer events pass
  // through the production component/API/full preload/the same Main IPC registrar.
  const edit = await assets.edit(original.id, original.revision, { ...original.draft, steps: [{ id: 'new-version', kind: 'click', url: base, target: semantic('Changed version'), reviewed: true }] })
  await assets.saveVersion(edit.id, edit.revision)
  await mount(original.id, 'human-group')
  await click(`[data-parallel-target="${targets[0].browserId}"] .browser-rsi-button--primary`)
  await click(`[data-continue-target="${targets[0].browserId}"] input`)
  window.webContents.insertText('private synthetic remaining')
  await click(`[data-continue-target="${targets[0].browserId}"] footer .browser-rsi-button--primary`)
  const running = await until(async () => { const value = await read('human-group'); if (value?.targets[0]?.run?.status !== 'running' || value.targets[0]!.run.nextStep !== 5) return null; const run = (await assets.inspect(targets[0].browserId, value.targets[0]!.run.id))!.runs[0]!; return run.operationIds.length === 5 && (await manager.getOperation(run.operationIds[4]!))?.steps.some(step => step.method === 'snapshot' && step.status === 'completed') ? value : null }, 'original v1 continued to real native wait')
  assert.equal(running.targets[0]!.run!.id, originalRun); assert.equal(running.run.version, 1)
  const tree = (await assets.inspect(targets[0].browserId, originalRun))!.runs[0]!
  assert.equal(tree.humanCheckpoints?.[0]?.origin, 'trusted-ui'); assert.equal(tree.humanCheckpoints?.[0]?.checkpointId, 'person-review')
  assert.equal((await facts(targets[0].browserId)).state.items.length, 2); assert.equal((await facts(targets[0].browserId)).state.changed, 0)
  // Cancelling an actual public follow reader drops its original journal subscription only.
  const operationId = tree.operationIds.at(-1)!, sdk = await connectBrowserSdk({ endpoint: { transport: 'unix', path: join(home, 'control.sock') } })
  const events: any[] = []; let initial: any
  const subscription = await sdk.follow({ operationId, afterSequence: 0 }, { onInitial: value => { initial = value }, onEvent: event => { events.push(event) } })
  await until(async () => initial && events.length > 0, 'original follow gap and ordered events')
  assert.ok(initial.gap?.droppedThrough > 0); assert.ok(events[0].data.sequence > initial.gap.droppedThrough)
  await subscription.dispose(); await sdk.dispose()
  assert.equal((await read('human-group'))!.targets[0]!.run!.status, 'running')
  assert.ok((await manager.getOperation(operationId))!.phase !== 'stopped')
  receipt.cases.push({ kind: 'actual-trusted-component-continue-v1-original-run-and-reader-cancel', running, tree, follow: { initial, events } })
  await click('.browser-task-parallel__progress > .browser-rsi-button--quiet')
  const stopped = await until(async () => { const value = await read('human-group'); return value?.run.status === 'stopped' && value.targets[0]!.run?.status === 'stopped' ? value : null }, 'production component stops original native operation')
  assert.equal(stopped.targets[0]!.run!.id, originalRun); assert.equal(stopped.targets[0]!.run!.nextStep, 5)
  assert.equal((await facts(targets[0].browserId)).state.items.length, 2)
  const continuation = (assets as any).document.parallel.find((item: any) => item.operationId === 'human-group').continuations[0]
  const confirmed = await inspect('human-group', continuation.id); assert.equal(confirmed.continuation.admission, 'confirmed')
  receipt.cases.push({ kind: 'production-component-stops-only-original-inflight-operation', stopped, continuation })
  // Keep another original Profile wait and same-Profile queue in flight for the second PID.
  const resumable = await make('retained native wait', [fill('fill'), submit('submit'), wait])
  await run(resumable.id, 'restart-group', [target(targets[2].browserId, targets[2].profileId), target(targets[3].browserId, targets[3].profileId)])
  const inflight = await until(async () => { const value = await read('restart-group'); if (value?.targets[0]?.run?.status !== 'running' || value.targets[0]!.run.nextStep !== 2 || value.targets[1]?.phase !== 'queued') return null; const run = (await assets.inspect(targets[2].browserId, value.targets[0]!.run.id))!.runs[0]!; return run.operationIds.length === 3 && (await manager.getOperation(run.operationIds[2]!))?.steps.some(step => step.method === 'snapshot' && step.status === 'completed') ? value : null }, 'native wait and original queue retained')
  const retainedRun = (await assets.inspect(targets[2].browserId, inflight.targets[0]!.run!.id))!.runs[0]!
  await wc(targets[2].browserId).session.cookies.set({ url: base, name: 'original-login', value: 'synthetic-retained-login', expirationDate: Date.now() / 1000 + 3600 })
  await wc(targets[2].browserId).session.cookies.flushStore(); wc(targets[2].browserId).session.flushStorageData()
  receipt.retained = { targets, stopped: await inspect('human-group', continuation.id), inflight: await inspect('restart-group'), originalRun: retainedRun,
    pages: Object.fromEntries(await Promise.all(targets.map(async target => [target.browserId, await facts(target.browserId)]))), continuation }
  await writeFile(join(home, 'retained.json'), JSON.stringify(receipt.retained))
  receipt.cases.push({ kind: 'original-inflight-queue-and-login-at-first-process-exit', inflight })
}
async function second(prior: any) {
  const cold = await inspect('restart-group'), stopped = await inspect('human-group', prior.continuation.id)
  assert.equal(cold.run.status, 'interrupted'); assert.equal(cold.targets[0]!.run.id, prior.originalRun.id)
  assert.equal(cold.targets[0]!.run.nextStep, prior.originalRun.nextStep); assert.equal(cold.targets[0]!.run.status, 'interrupted'); assert.equal(cold.targets[1]!.phase, 'queued'); assert.equal(cold.targets[1]!.run, undefined)
  const original = (await assets.inspect(prior.targets[2]!.browserId, prior.originalRun.id))!.runs[0]!
  assert.deepEqual(original.operationIds, prior.originalRun.operationIds); assert.equal(original.version, prior.originalRun.version); assert.equal(original.executedMillis, prior.originalRun.executedMillis)
  assert.deepEqual(stopped, prior.stopped)
  const oldId = await cli(['parallel-continue', '--browser', source, '--operation-id', 'human-group', '--target', prior.targets[0]!.browserId, '--input', '-'], { continuationId: prior.continuation.id, expectedRevision: prior.continuation.expectedRevision, parameters: { value: 'must never replay' } })
  assert.equal(oldId.continuation.admission, 'confirmed'); assert.equal(oldId.run.status, 'stopped')
  const repeat = await run(cold.run.assetId, 'restart-group', cold.targets.map((target: any) => ({ id: target.id, browserId: target.browserId, profileId: target.profileId, parameters: { value: 'must never dispatch after restart' } })))
  assert.equal(repeat.run.status, 'interrupted')
  await pause(150)
  for (const target of prior.targets) assert.deepEqual(await facts(target.browserId), prior.pages[target.browserId])
  assert.ok((await wc(prior.targets[2]!.browserId).session.cookies.get({ url: base, name: 'original-login' })).length === 1)
  receipt.cases.push({ kind: 'actual-new-pid-original-run-cursor-cost-and-queued-results', cold, original, stopped })
  receipt.cases.push({ kind: 'original-group-and-continuation-ids-never-replay-after-restart', repeat, oldId })
  receipt.original = prior
}
async function main() {
  try {
    await app.whenReady(); app.setActivationPolicy?.('prohibited'); app.on('window-all-closed', () => {})
    window = new BrowserWindow({ width: 820, height: 1000, show: false, webPreferences: { preload: join(out, 'preload.cjs'), sandbox: false, nodeIntegration: false, contextIsolation: true } })
    profiles = new BrowserProfileManager(new BrowserProfileStore(join(home, 'profiles.json'))); await profiles.initialize()
    manager = new BrowserViewManager(window, profiles, new BrowserRefLedgerStore(join(home, 'refs.json')), { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => {} }, journal, undefined, undefined, undefined, assets)
    const prior = phase === 'second' ? JSON.parse(await readFile(join(home, 'retained.json'), 'utf8')) : null
    const a = prior ? null : await profiles.createProfile('Original human Profile'), b = prior ? null : await profiles.createProfile('Independent retained Profile')
    const targets = prior?.targets ?? [{ browserId: 'original-a', profileId: a!.id }, { browserId: 'original-queued-a', profileId: a!.id }, { browserId: 'original-b', profileId: b!.id }, { browserId: 'original-queued-b', profileId: b!.id }]
    for (const target of [{ browserId: source, profileId: profiles.defaultProfileId() }, ...targets]) {
      await manager.create(target.browserId, base, undefined, target.profileId, undefined, 'responsive', { agent: { hostId: 'private-fixture', agentSessionId: 'private-unobserved-association' } })
      manager.setBounds(target.browserId, { x: 830, y: 0, width: 760, height: 640 }); wc(target.browserId).setBackgroundThrottling(false)
      await until(async () => wc(target.browserId).executeJavaScript('typeof parallelProof === "object"').catch(() => false), 'original native target document')
      await wc(target.browserId).executeJavaScript(`parallelProof.configure(${JSON.stringify(target.browserId)},{closed:true})`)
      if (!prior) await manager.returnControl(target.browserId)
    }
    registerBrowserTaskParallelIpc({ browsers: manager, authorize, handle: (channel, listener) => ipcMain.handle(channel, (event, ...args) => { assert.equal(event.sender, window.webContents); return listener(event, ...args as never) }) })
    ipcMain.handle('browser:listTargets', () => ({ targets: manager.targets(), coverage: 'complete' }))
    ipcMain.handle('browser:controlTask', (_event, request) => executeBrowserTaskControl(request, manager, true))
    await window.loadFile(join(out, 'renderer/index.html'))
    await until(async () => window.webContents.executeJavaScript('typeof taskOrchestrationNative === "object"').catch(() => false), 'production Renderer API with full preload')
    control = new AgentMuxControlServer({ socketPath: join(home, 'control.sock'), coreClients: () => [], execute: request => executeBrowserTaskControl(request, manager, true), subscribeBrowserOperation: async (request, deliver) => {
      const subscription = await journal.subscribe(request.operationId, request.afterSequence, event => deliver({ sequence: event.sequence, event: projectBrowserControlEvent(event.event) }))
      queueMicrotask(() => subscription.backlog.forEach(event => deliver({ sequence: event.sequence, event: projectBrowserControlEvent(event.event) })))
      return { runOperation: projectBrowserControlOperation(subscription.operation), gap: subscription.gap, dispose: subscription.dispose }
    } }); await control.start()
    if (phase === 'first') await first(targets); else await second(prior)
    for (const target of targets) wc(target.browserId).session.flushStorageData()
    receipt.passed = true
  } catch (error) { receipt.failure = { message: (error as Error).message, stack: (error as Error).stack }; console.error(error) }
  finally {
    if (phase === 'first' && receipt.passed) { receipt.termination = 'First real process exits with one original native wait and one original queued target.'; await writeFile(join(out, phase + '.json'), JSON.stringify(receipt, null, 2)); app.exit(0); return }
    await control?.stop(); manager?.dispose(); await profiles?.dispose(); window?.destroy()
    await writeFile(join(out, phase + '.json'), JSON.stringify(receipt, null, 2)); app.exit(receipt.passed ? 0 : 1)
  }
}
void main()
