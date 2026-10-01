import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { AgentMuxControlServer, connectAgentMuxRpc, type AgentMuxRpcClient } from '@agentmux/core'
import { BrowserViewManager } from '../../../src/main/browser-view-manager.js'
import { BrowserTaskAssets, BrowserTaskAssetFileStore } from '../../../src/main/browser-task-assets.js'
import { executeBrowserTaskControl } from '../../../src/main/browser-task-control.js'
import { BrowserProfileManager } from '../../../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../../../src/main/browser-profile-store.js'
import { BrowserRefLedgerStore } from '../../../src/main/browser-ref-ledger-store.js'
import { BrowserOperationJournal, BrowserOperationFileStore } from '../../../src/main/browser-operation-journal.js'
import type { BrowserTaskContent, BrowserTaskStep } from '../../../src/shared/browser-task-assets.js'

const root = process.env.AMX_TASK_NATIVE_ROOT!, out = process.env.AMX_TASK_NATIVE_OUT!
const phase = process.env.AMX_TASK_NATIVE_PHASE!, base = process.env.AMX_TASK_NATIVE_BASE!
assert.ok(isAbsolute(root) && basename(root).startsWith('amx-task-bounded-'), 'Only this owned private root may be used')
app.setPath('userData', join(root, 'userdata'))
app.commandLine.appendSwitch('no-proxy-server')
// Only the explicit final exit may end this private probe after its receipt is sealed.
app.on('window-all-closed', () => {})
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const receipt: any = { schema: 'agentmux.browser-task-bounded-private-process.v1', author: '/root/browser_source_closeout', phase, pid: process.pid,
  versions: process.versions, passed: false, cases: [], nativePages: [], publicRequests: [], desktopTabRegionFocusRestore: 'not-tested', healthyCoreRunRestore: 'not-tested',
  boundary: 'Actual production Main task owner and native WCV; fixture asset setup is not a human recording or the complete Desktop Renderer.' }
let window: BrowserWindow | undefined, profiles: BrowserProfileManager | undefined, manager: BrowserViewManager | undefined, server: AgentMuxControlServer | undefined, rpc: AgentMuxRpcClient | undefined
const id = 'private-bounded-task-page', durable = join(root, 'retained.json')
const assets = new BrowserTaskAssets(new BrowserTaskAssetFileStore(join(root, 'assets.json')))
let request = 0
const publicCall = async (value: any) => {
  const { operation, ...params } = value
  receipt.publicRequests.push({ localCallId: `private-task-${phase}-${++request}`, operation, browserId: params.browserId,
    assetId: params.assetId, version: params.version, batchId: params.batchId, runId: params.runId, protocol: 'jsonrpc-2.0' })
  return await rpc!.call(operation, params)
}
const contents = () => manager!.nativeOwner(id)!.view.webContents
const facts = async () => await contents().executeJavaScript('globalThis.privateTaskPageFacts()')
async function page(path: string) {
  await manager!.navigate(id, base + path)
  for (let i = 0; i < 100; i++) {
    if (await contents().executeJavaScript('typeof globalThis.privateTaskPageFacts === "function"').catch(() => false)) {
      const actual = await facts()
      if (actual.url === base + path && contents().getURL() === actual.url) return
    }
    await pause(20)
  }
  throw new Error('The actual generic native fixture did not load')
}
async function capture(label: string) {
  const wc = contents(), before = await facts(), startedAt = Date.now()
  const image = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true })
  const bytes = image.toPNG(), path = join(out, `${phase}-${label}.png`)
  assert.ok(bytes.length > 8 && image.getSize().width > 0)
  await writeFile(path, bytes)
  const row = { label, phase, path, sha256: sha(bytes), bytes: bytes.length, size: image.getSize(), webContentsId: wc.id,
    source: 'original-webcontents-capturePage', startedAt, returnedAt: Date.now(), before, after: await facts(), windowFocused: window!.isFocused() }
  receipt.nativePages.push(row); return row
}
async function make(name: string, steps: BrowserTaskStep[], parameters: BrowserTaskContent['parameters'] = []) {
  const url = contents().getURL(), current = await manager!.create(id, url)
  const imported = await assets.importRecording({ id: `private-setup-${name}`, browserId: id, navigationId: current.navigationId,
    url, status: 'stopped', revision: 1, startedAt: Date.now(), updatedAt: Date.now(), steps: [] }, name)
  const changed = await manager!.saveTaskAssetDraft(id, imported.id, imported.revision, { ...imported.draft, steps, parameters })
  return await manager!.saveTaskAssetVersion(id, changed.id, changed.revision, changed.draft)
}
const click = (stepId: string, name: string, url: string): BrowserTaskStep => ({ id: stepId, kind: 'click', url, reviewed: true,
  target: { role: 'button', name, ordinal: 1, count: 1 }, nextStepId: null })
async function journal(run: any) {
  assert.ok(run.operationIds.length > 0, 'The actual original task operations are nonempty')
  const operations = []
  for (const operationId of run.operationIds) {
    const original = await manager!.getOperation(operationId)
    assert.ok(original && original.browserId === id && original.id === operationId)
    operations.push(original)
  }
  return operations
}
async function batch(path: string, label: string) {
  await page(path); manager!.returnControl(id)
  const url = contents().getURL(), before = await facts()
  const asset = await make(label, [{ id: 'fill', kind: 'fill', url, reviewed: true, parameterKey: 'value',
    target: { role: 'text input', name: 'Item value', ordinal: 1, count: 1 } }, click('submit', 'Submit item', url)],
  [{ key: 'value', label: 'Item value', secret: false }])
  const items = [{ id: `${label}-first`, parameters: { value: `${label}-one` } }, { id: `${label}-second`, parameters: { value: `${label}-two` } }]
  const response: any = await publicCall({ operation: 'browser.task.batch', browserId: id, assetId: asset.id, version: 1, parameters: {}, items })
  const actual = response.batch, state = await manager!.getTaskAssets(id), after = await facts()
  assert.equal(actual.status, 'completed'); assert.equal(actual.nextItem, 2)
  assert.deepEqual(after.state.items.slice(before.state.items.length), items.map(item => item.parameters.value))
  assert.deepEqual(actual.items.map((item: any) => item.id), items.map(item => item.id))
  const runs = actual.items.map((item: any) => state.runs.find(run => run.id === item.runId))
  assert.ok(runs.length === 2 && runs.every((run: any) => run && run.status === 'completed' && run.assetId === asset.id && run.version === 1))
  const operations = []
  for (const run of runs) operations.push(...await journal(run))
  assert.equal(actual.operationCount, operations.length); assert.ok(actual.executedMillis >= 0 && actual.executedMillis <= 120000)
  const stored = await readFile(join(root, 'assets.json'), 'utf8')
  for (const item of items) assert.equal(stored.includes(item.parameters.value), false, 'Invocation values must not enter the durable asset')
  const image = await capture(label)
  receipt.cases.push({ kind: 'batch', label, publicMethod: 'browser.task.batch', response, assetVersion: asset.versions[0], state, before, after, runs, operations, imageLabel: image.label,
    originalWebContentsId: contents().id, currentNavigationId: (await manager!.create(id, url)).navigationId, windowFocused: window!.isFocused() })
}
async function branch(kind: 'page-url-is' | 'element-present', expected: 'true' | 'false' | 'unknown') {
  await page('/form'); manager!.returnControl(id)
  const url = contents().getURL(), before = await facts(), label = `${kind}-${expected}`
  const condition = kind === 'page-url-is' ? { kind, url: expected === 'false' ? base + '/other' : url }
    : { kind, target: { role: 'button', name: expected === 'false' ? 'Absent condition marker' : 'Condition marker' } }
  const sourceUrl = expected === 'unknown' ? base + '/unexpected-document' : url
  const asset = await make(label, [{ id: 'condition', kind: 'branch', url: sourceUrl, reviewed: true,
    branch: { condition, onTrue: 'then', onFalse: 'else' } }, click('then', 'True action', url), click('else', 'False action', url)])
  const response: any = await publicCall({ operation: 'browser.task.run', browserId: id, assetId: asset.id, version: 1, parameters: {} })
  const run = response.run, state = await manager!.getTaskAssets(id), after = await facts()
  assert.equal(run.branchDecisions?.[0]?.result, expected)
  assert.equal(after.state.then - before.state.then, expected === 'true' ? 1 : 0)
  assert.equal(after.state.else - before.state.else, expected === 'false' ? 1 : 0)
  assert.equal(run.status, expected === 'unknown' ? 'ready' : 'completed')
  assert.equal(run.stepExecutions.length, expected === 'unknown' ? 1 : 2)
  const operations = await journal(run), image = await capture(label)
  receipt.cases.push({ kind: 'branch', label, publicMethod: 'browser.task.run', conditionKind: kind, expected, response, assetVersion: asset.versions[0], state, before, after, operations,
    imageLabel: image.label, originalWebContentsId: contents().id, currentNavigationId: (await manager!.create(id, url)).navigationId, windowFocused: window!.isFocused() })
}
async function checkpoint(grouped: boolean) {
  await page('/form'); manager!.returnControl(id)
  const url = contents().getURL(), label = grouped ? 'batch-checkpoint-stop' : 'branch-checkpoint-stop'
  const first = click('first', 'True action', url); delete first.nextStepId
  const asset = await make(label, [first, { id: 'person', kind: 'checkpoint', url, reviewed: true }, click('last', 'False action', url)])
  const input: any = { operation: grouped ? 'browser.task.batch' : 'browser.task.run', browserId: id, assetId: asset.id, version: 1, parameters: {} }
  if (grouped) input.items = [{ id: 'first', parameters: {} }, { id: 'second', parameters: {} }]
  const before = await facts(), started: any = await publicCall(input), original = grouped ? started.batch : started.run
  assert.equal(original.status, 'waiting-human')
  const waiting = await manager!.getTaskAssets(id), waitingPage = await facts()
  let refusal: string | null = null
  try { await publicCall({ ...input, ...(grouped ? { batchId: original.id } : { runId: original.id }) }) } catch (error) { refusal = (error as Error).message }
  assert.ok(refusal); assert.deepEqual(await manager!.getTaskAssets(id), waiting)
  assert.deepEqual((await facts()).state, waitingPage.state)
  const stopped: any = await publicCall(grouped ? { operation: 'browser.task.batch-stop', browserId: id, batchId: original.id }
    : { operation: 'browser.task.stop', browserId: id, runId: original.id })
  const afterState = await manager!.getTaskAssets(id), after = await facts()
  assert.equal((grouped ? stopped.batch : stopped.run).status, 'stopped')
  const actualRun = afterState.runs.find(run => run.id === (grouped ? original.items[0].runId : original.id))!
  assert.equal(actualRun.humanCheckpoints?.length ?? 0, 0)
  assert.equal(after.state.then - before.state.then, 1); assert.equal(after.state.else - before.state.else, 0)
  const operations = await journal(actualRun), image = await capture(label)
  receipt.cases.push({ kind: grouped ? 'batch-checkpoint' : 'branch-checkpoint', label, before, after, started, refusal, waiting, stopped, afterState, operations,
    imageLabel: image.label, originalWebContentsId: contents().id, windowFocused: window!.isFocused() })
}

async function main() {
try {
  await app.whenReady()
  window = new BrowserWindow({ width: 760, height: 640, show: false, title: `Private bounded tasks ${phase}`, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } })
  await window.loadURL('data:text/html,<title>Private task host</title><body>Private original task owner</body>')
  profiles = new BrowserProfileManager(new BrowserProfileStore(join(root, 'profiles.json'))); await profiles.initialize()
  manager = new BrowserViewManager(window, profiles, new BrowserRefLedgerStore(join(root, 'refs.json')),
    { rememberedSchemes: async () => ({}), rememberScheme: async () => {}, openExternal: async () => { throw new Error('External apps are outside this private fixture') } },
    new BrowserOperationJournal(new BrowserOperationFileStore(join(root, 'journal.json'))), undefined, undefined, undefined, assets)
  const prior = phase === 'second' ? JSON.parse(await readFile(durable, 'utf8')) : null
  const created = await manager.create(id, prior?.browser.url ?? base + '/form')
  manager.setBounds(id, { x: 12, y: 12, width: 700, height: 560 })
  contents().setBackgroundThrottling(false)
  for (let i = 0; i < 100 && !(await contents().executeJavaScript('typeof globalThis.privateTaskPageFacts === "function"').catch(() => false)); i++) await pause(20)
  assert.equal(await contents().executeJavaScript('typeof globalThis.privateTaskPageFacts'), 'function')
  receipt.observationCondition = { windowShown: false, windowFocused: window.isFocused(), privateBackgroundThrottling: contents().getBackgroundThrottling(), productDefaultCertified: false }
  server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], execute: input => executeBrowserTaskControl(input, manager!, true) })
  await server.start()
  rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  if (phase === 'first') {
    await batch('/form', 'form-two-items'); await batch('/panel', 'panel-two-items')
    for (const kind of ['page-url-is', 'element-present'] as const) for (const expected of ['true', 'false'] as const) await branch(kind, expected)
    await branch('element-present', 'unknown')
    await checkpoint(false); await checkpoint(true)
    const publicState: any = await publicCall({ operation: 'browser.task.assets', browserId: id })
    receipt.retained = { browser: { id, url: contents().getURL(), profileId: created.profileId }, state: await manager.getTaskAssets(id), publicState: publicState.state, page: await facts() }
    await writeFile(durable, JSON.stringify(receipt.retained))
  } else {
    const before = await publicCall({ operation: 'browser.task.assets', browserId: id }), actualPage = await facts()
    assert.deepEqual((before as any).state, prior.publicState)
    assert.deepEqual(await manager.getTaskAssets(id), prior.state)
    assert.deepEqual(actualPage.state, prior.page.state)
    await pause(250)
    assert.deepEqual((await facts()).state, actualPage.state, 'Ordinary private restart cannot replay any original page action')
    assert.deepEqual(await manager.getTaskAssets(id), prior.state)
    receipt.restored = { browser: { id, url: contents().getURL(), profileId: created.profileId }, state: await manager.getTaskAssets(id), publicState: (before as any).state, page: actualPage, afterIdle: await facts() }
    assert.deepEqual(receipt.restored.browser, prior.browser)
    await capture('restored-original-work')
    receipt.cases.push({ kind: 'ordinary-private-restore', label: 'restored-original-work', before, restored: receipt.restored, expected: prior,
      imageLabel: 'restored-original-work', originalWebContentsId: contents().id, windowFocused: window.isFocused() })
  }
  receipt.privateCasesPassed = true; receipt.phaseCompleted = true; receipt.passed = true
} catch (error) { receipt.failure = { message: (error as Error).message, stack: (error as Error).stack }; receipt.phaseCompleted = false }
finally {
  if (rpc) await rpc.dispose()
  if (server) await server.stop()
  manager?.dispose(); await profiles?.dispose()
  if (window && !window.isDestroyed()) window.destroy()
  await writeFile(join(out, `${phase}-receipt.json`), JSON.stringify(receipt, null, 2) + '\n')
  app.exit(receipt.passed ? 0 : 1)
}
}
void main()
