import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { AgentMuxControlServer } from '@agentmux/core'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { BrowserTaskAssets, BrowserTaskAssetFileStore } from '../../../src/main/browser-task-assets.js'
import { executeBrowserTaskControl } from '../../../src/main/browser-task-control.js'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store.js'
import { BrowserRefLedgerStore } from '@agentmux/browser/operations'
import { BrowserOperationJournal, BrowserOperationFileStore } from '@agentmux/browser/operations'
import { importTaskRecording } from '../../../test/helpers/import-task-recording.js'
import type { BrowserTaskContent, BrowserTaskStep } from '../../../src/shared/browser-task-assets.js'

const home = process.env.SUBFLOWS_HOME!, out = process.env.SUBFLOWS_OUT!, base = process.env.SUBFLOWS_BASE!
const phase = process.env.SUBFLOWS_PHASE!, node = process.env.SUBFLOWS_NODE!, browserId = 'finite-native-browser'
console.error('subflows-proof: main imported', phase)
assert.ok(basename(home).startsWith('amux-task-subflows-'))
mkdirSync(join(home, 'userdata'), { recursive: true })
app.setPath('userData', join(home, 'userdata')); app.commandLine.appendSwitch('no-proxy-server')
app.on('window-all-closed', () => {})
const receipt: any = { passed: false, phase, pid: process.pid, versions: process.versions, cases: [], cli: [], dialogs: [] }
const assets = new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(home, 'assets.json')))
let window: BrowserWindow | undefined, profiles: BrowserProfileManager | undefined, manager: BrowserViewManager | undefined, control: AgentMuxControlServer | undefined
const pause = (millis: number) => new Promise(done => setTimeout(done, millis))
const contents = () => manager!.nativeOwner(browserId)!.view.webContents
const facts = () => contents().executeJavaScript('finiteTaskFacts()')
const target = (name: string, role = 'button') => ({ role, name, ordinal: 1, count: 1 })
const click = (id: string, name: string): BrowserTaskStep => ({ id, kind: 'click', url: base, target: target(name), reviewed: true })
const fill = (): BrowserTaskStep => ({ id: 'fill', kind: 'fill', url: base, target: target('Item value', 'text input'), parameterKey: 'value', reviewed: true })
const confirm = (): BrowserTaskStep => ({ ...click('confirm', 'Confirm item'), dialog: { type: 'confirm', action: 'accept' } })
const rows = (prefix: string) => [{ id: prefix + '-one', parameters: { value: prefix + ' first fresh value' } }, { id: prefix + '-two', parameters: { value: prefix + ' second fresh value' } }]
const invocation = (items: ReturnType<typeof rows>) => ({ parameters: {}, calls: { each: { parameters: {}, items } } })
async function cli(args: string[], input = '', expectSuccess = true) {
  console.error('subflows-proof: cli', args[0])
  const result = await new Promise<any>((accept, reject) => {
    const child = spawn(node, [join(out, 'cli.mjs'), '--endpoint', 'unix:' + join(home, 'control.sock'), 'browser', 'task', ...args], {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE')),
      stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const deadline = setTimeout(() => { child.kill(); reject(new Error('Private CLI observation did not complete: ' + args[0])) }, 120_000)
    child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
    child.once('error', reject); child.once('close', code => { clearTimeout(deadline); accept({ code, stdout, stderr }) }); child.stdin.end(input)
  })
  receipt.cli.push({ command: args[0], code: result.code })
  if (expectSuccess) assert.equal(result.code, 0, result.stderr + result.stdout)
  else assert.notEqual(result.code, 0)
  const response = JSON.parse(result.stdout || result.stderr)
  return expectSuccess ? response.result : response
}
async function publish(assetId: string, content: BrowserTaskContent) {
  const current = await assets.get(assetId)
  const edited = await cli(['edit', '--browser', browserId, '--asset', assetId, '--expected-revision', String(current!.revision), '--input', '-'], JSON.stringify(content))
  return await cli(['publish', '--browser', browserId, '--asset', assetId, '--expected-revision', String(edited.asset.revision)])
}
async function make(name: string, steps: BrowserTaskStep[], parameters: BrowserTaskContent['parameters'] = []) {
  const source = await importTaskRecording(assets, { id: 'fixture-source-' + name, browserId, navigationId: (await manager!.create(browserId, base)).navigationId,
    url: base, status: 'stopped', revision: 1, startedAt: 1, updatedAt: 2, steps: [] }, name)
  await publish(source.id, { name, url: base, steps, parameters }); return (await assets.get(source.id))!
}
const run = (assetId: string, input: unknown, runId?: string) => cli(['run', '--browser', browserId, '--asset', assetId, '--version', '1',
  ...(runId ? ['--run', runId] : []), '--input', '-'], JSON.stringify(input))
const inspect = (runId?: string) => cli(['inspect', '--browser', browserId, ...(runId ? ['--run', runId] : [])])
async function first() {
  await manager!.returnControl(browserId)
  const child = await make('Fixed child', [fill(), click('submit', 'Submit item'), confirm()], [{ key: 'value', label: 'Item value', secret: false }])
  const parent = await make('Finite each root', [{ id: 'each', kind: 'subflow', url: base, reviewed: true,
    subflow: { target: { kind: 'local', assetId: child.id, version: 1 }, iteration: 'each' } }])
  await publish(child.id, { ...child.draft, steps: [click('new-version', 'Changed version')] })
  const items = rows('fixed'), before = await facts(), completed = (await run(parent.id, invocation(items))).run
  const exact = (await inspect(completed.id)).inspection
  assert.equal(completed.status, 'completed'); assert.equal(exact.rootRunId, completed.id)
  assert.equal(exact.runs.length, 3); assert.equal(exact.operationCount, 6)
  assert.deepEqual(exact.runs.filter((row: any) => row.parent).map((row: any) => row.version), [1, 1])
  const after = await facts()
  assert.deepEqual(after.state.items.slice(before.state.items.length), items.map(item => item.parameters.value))
  assert.equal(after.state.confirmed - before.state.confirmed, 2); assert.equal(after.state.changed, 0)
  for (const item of items) assert.equal((await readFile(join(home, 'assets.json'), 'utf8')).includes(item.parameters.value), false)
  receipt.cases.push({ kind: 'compiled-cli-finite-each-fixed-version', completed, exact, before, after })

  const waitingChild = await make('Checkpoint child', [fill(), click('submit', 'Submit item'), { id: 'person', kind: 'checkpoint', url: base, reviewed: true }, confirm()],
    [{ key: 'value', label: 'Item value', secret: false }])
  const waitingRoot = await make('Checkpoint root', [{ id: 'each', kind: 'subflow', url: base, reviewed: true,
    subflow: { target: { kind: 'local', assetId: waitingChild.id, version: 1 }, iteration: 'each' } }])
  const waitingItems = rows('checkpoint'), input = invocation(waitingItems)
  const firstWait = (await run(waitingRoot.id, input)).run
  assert.equal(firstWait.status, 'waiting-human')
  const secondWait = await manager!.runTaskAsset({ browserId, assetId: waitingRoot.id, version: 1, runId: firstWait.id, ...input })
  assert.equal(secondWait.status, 'waiting-human')
  const waiting = (await inspect(secondWait.id)).inspection, waitingPage = await facts()
  assert.equal(waiting.runs.filter((row: any) => row.parent && row.status === 'completed').length, 1)
  assert.equal(waiting.runs.find((row: any) => row.id === waiting.currentRunId).status, 'waiting-human')
  const refusal = await cli(['run', '--browser', browserId, '--asset', waitingRoot.id, '--version', '1', '--run', secondWait.id, '--input', '-'], JSON.stringify(input), false)
  assert.deepEqual(await facts(), waitingPage)
  assert.deepEqual((await inspect(secondWait.id)).inspection, waiting)
  receipt.cases.push({ kind: 'second-item-checkpoint-keeps-first-completed', waiting, refusal, waitingPage })

  // A native confirmation is applied by Chromium; only its original response is lost.
  await manager!.returnControl(browserId)
  const uncertainChild = await make('Unknown child', [confirm()])
  const uncertainRoot = await make('Unknown root', [{ id: 'each', kind: 'subflow', url: base, reviewed: true,
    subflow: { target: { kind: 'local', assetId: uncertainChild.id, version: 1 }, iteration: 'each' } }])
  const send = contents().debugger.sendCommand.bind(contents().debugger)
  let injected = false
  contents().debugger.sendCommand = async (method: string, params?: any, sessionId?: string) => {
    const result = await send(method, params, sessionId)
    if (!injected && method === 'Page.handleJavaScriptDialog' && params?.accept === true) { injected = true; throw new Error('Private lost native confirmation acknowledgement') }
    return result
  }
  const unknownBefore = await facts()
  const unknown = (await run(uncertainRoot.id, { parameters: {}, calls: { each: { parameters: {}, items: [{ id: 'original', parameters: {} }, { id: 'unsent', parameters: {} }] } } })).run
  const unknownInspection = (await inspect(unknown.id)).inspection, unknownAfter = await facts()
  assert.equal(injected, true); assert.equal(unknown.status, 'failed')
  assert.equal(unknownAfter.state.confirmed - unknownBefore.state.confirmed, 1)
  assert.equal(unknownInspection.runs.length, 2); assert.equal(unknownInspection.operationCount, 1)
  assert.equal(unknown.calls[0].items[1].runId, undefined)
  const unknownLeaf = unknownInspection.runs.find((row: any) => row.parent)
  assert.match(unknownLeaf.warning, /may already have run.*not retried/)
  const originalOperation = await manager!.getOperation(unknownLeaf.operationIds[0])
  assert.ok(originalOperation && originalOperation.browserId === browserId)
  contents().debugger.sendCommand = send
  receipt.cases.push({ kind: 'native-confirm-effect-with-lost-ack-no-replay', unknown, unknownInspection, originalOperation, unknownBefore, unknownAfter })
  // Leave one real child call in flight across this process's exit. Its first
  // fill/submit already changed the real page; a later item must remain unsent.
  const activeChild = await make('In-flight child', [fill(), click('submit', 'Submit item'),
    { id: 'await-page', kind: 'wait', url: base, wait: { kind: 'element-present', target: { role: 'button', name: 'Not present yet' } }, timeoutMs: 25_000, reviewed: true }],
  [{ key: 'value', label: 'Item value', secret: false }])
  const activeRoot = await make('In-flight root', [{ id: 'each', kind: 'subflow', url: base, reviewed: true,
    subflow: { target: { kind: 'local', assetId: activeChild.id, version: 1 }, iteration: 'each' } }])
  void run(activeRoot.id, invocation(rows('inflight'))).catch(() => {})
  let running: any, runningOperation: any
  for (let index = 0; index < 800; index++) {
    const actual = await assets.inspect(browserId)
    if (actual?.runs.some(row => row.assetId === activeRoot.id)) {
      const leaf = actual.runs.find(row => row.parent)
      if (leaf?.status === 'running' && leaf.nextStep === 2 && leaf.operationIds.length === 3) {
        const original = await manager!.getOperation(leaf.operationIds[2]!)
        if (original?.steps.some(step => step.method === 'snapshot' && step.status === 'completed')) { running = actual; runningOperation = original; break }
      }
    }
    await pause(25)
  }
  assert.ok(running, 'A real native wait was dispatched before the original process exits')
  assert.equal(running.runs[0].calls[0].items[1].runId, undefined)
  const durableRunning = JSON.parse(await readFile(join(home, 'assets.json'), 'utf8')).runs.filter((row: any) => running.runs.some((item: any) => row.id === item.id))
  assert.ok(durableRunning.length === 2 && durableRunning.every((row: any) => row.status === 'running'))
  receipt.cases.push({ kind: 'original-child-call-running-at-process-exit', running, runningOperation, page: await facts() })
  const rootInspection = (await inspect(secondWait.id)).inspection
  receipt.retained = { browserId, profileId: (await manager!.create(browserId, base)).profileId, page: await facts(),
    waitingRootId: secondWait.id, waitingAssetId: waitingRoot.id, input, rootInspection,
    unknownInspection, unknownRootId: unknown.id, completedRootId: completed.id, running }
  // Invocation values remain outside durable owner files. The test-only recovery
  // descriptor keeps fresh input solely to drive the explicit second-process Continue.
  await writeFile(join(home, 'retained.json'), JSON.stringify(receipt.retained))
}
async function second(prior: any) {
  const original = { ...prior, page: await facts(), rootInspection: (await inspect(prior.waitingRootId)).inspection,
    unknownInspection: (await inspect(prior.unknownRootId)).inspection }
  receipt.original = original; assert.deepEqual(original, prior)
  await pause(150); assert.deepEqual(await facts(), original.page)
  const recoveredInFlight = (await inspect(prior.running.rootRunId)).inspection
  assert.deepEqual(recoveredInFlight.runs.map((row: any) => row.id), prior.running.runs.map((row: any) => row.id))
  assert.ok(recoveredInFlight.runs.every((row: any) => row.status === 'interrupted'))
  assert.deepEqual(recoveredInFlight.runs.map((row: any) => ({ id: row.id, nextStep: row.nextStep, operationIds: row.operationIds, calls: row.calls, parent: row.parent })),
    prior.running.runs.map((row: any) => ({ id: row.id, nextStep: row.nextStep, operationIds: row.operationIds, calls: row.calls, parent: row.parent })))
  receipt.cases.push({ kind: 'running-original-child-restored-interrupted-with-no-replay', recoveredInFlight, prior: prior.running })
  const beforeContinue = await facts(), oldIds = original.rootInspection.runs.map((row: any) => row.id)
  const continued = await manager!.runTaskAsset({ browserId, assetId: prior.waitingAssetId, version: 1, runId: prior.waitingRootId, ...prior.input })
  assert.equal(continued.status, 'completed')
  const done = (await inspect(prior.waitingRootId)).inspection, afterContinue = await facts()
  assert.deepEqual(done.runs.map((row: any) => row.id), oldIds)
  assert.deepEqual(afterContinue.state.items, beforeContinue.state.items, 'Completed item fill/submit are not replayed')
  assert.equal(afterContinue.state.confirmed - beforeContinue.state.confirmed, 1)
  assert.equal(afterContinue.draft, original.page.draft)
  assert.deepEqual((await inspect(prior.unknownRootId)).inspection, prior.unknownInspection)
  receipt.cases.push({ kind: 'distinct-process-original-binding-and-explicit-continue', done, beforeContinue, afterContinue })
  const stopped = await cli(['stop', '--browser', browserId, '--run', prior.unknownRootId])
  assert.equal(stopped.run.id, prior.unknownRootId)
  assert.deepEqual((await facts()).state, afterContinue.state)
  receipt.cases.push({ kind: 'stop-uncertain-original-root-with-no-replay', stopped })
}
async function main() {
  try {
    await app.whenReady(); app.setActivationPolicy?.('prohibited'); console.error('subflows-proof: create window', phase)
    window = new BrowserWindow({ width: 800, height: 700, show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } })
    await window.loadURL('data:text/html,Private finite task host'); console.error('subflows-proof: host document', phase)
    profiles = new BrowserProfileManager(new BrowserProfileStore(join(home, 'profiles.json'))); await profiles.initialize(); console.error('subflows-proof: profiles initialized', phase)
    manager = new BrowserViewManager(window, profiles, new BrowserRefLedgerStore(join(home, 'refs.json')),
      { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => {} },
      new BrowserOperationJournal(new BrowserOperationFileStore(join(home, 'journal.sqlite'))), undefined, undefined, undefined, assets)
    const prior = phase === 'second' ? JSON.parse(await readFile(join(home, 'retained.json'), 'utf8')) : null
    const created = await manager.create(browserId, base, undefined, prior?.profileId, undefined, 'responsive',
      { agent: { hostId: 'private-fixture', agentSessionId: 'private-unobserved-association' } }); console.error('subflows-proof: Browser created', phase)
    if (prior) assert.equal(created.profileId, prior.profileId)
    manager.setBounds(browserId, { x: 0, y: 0, width: 760, height: 640 }); contents().setBackgroundThrottling(false)
    contents().debugger.on('message', (_event, method, params: any) => {
      if (method === 'Page.javascriptDialogOpening' || method === 'Page.javascriptDialogClosed') receipt.dialogs.push({ method, type: params?.type, result: params?.result })
    })
    for (let index = 0; index < 400 && !(await contents().executeJavaScript('typeof finiteTaskFacts === "function"').catch(() => false)); index++) await pause(25)
    assert.equal(await contents().executeJavaScript('typeof finiteTaskFacts'), 'function')
    control = new AgentMuxControlServer({ socketPath: join(home, 'control.sock'), coreClients: () => [], execute: request => executeBrowserTaskControl(request, manager!, true) })
    await control.start()
    if (phase === 'first') await first(); else await second(prior)
    await contents().session.flushStorageData()
    receipt.passed = true
  } catch (error) {
    receipt.failure = { message: (error as Error).message, stack: (error as Error).stack }
    if (manager) { try { receipt.failure.state = await manager.getTaskAssets(browserId); receipt.failure.page = await facts() } catch {} }
    console.error(error)
  } finally {
    if (phase === 'first' && receipt.passed && receipt.retained?.running) {
      receipt.termination = 'Original process exits with its actual child operation in flight; private process group cleanup belongs to the outer probe.'
      await writeFile(join(out, phase + '.json'), JSON.stringify(receipt, null, 2) + '\n')
      app.exit(0)
      return
    }
    await control?.stop(); manager?.dispose(); await profiles?.dispose(); window?.destroy()
    await writeFile(join(out, phase + '.json'), JSON.stringify(receipt, null, 2) + '\n')
    app.exit(receipt.passed ? 0 : 1)
  }
}
void main()
