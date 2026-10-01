// @vitest-environment happy-dom
// Production Source consumers with private transport/page doubles. No Native/OS/restart claim.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { build } from 'vite'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { AgentMuxControlServer, parseAgentMuxControlRequest, parseAgentMuxControlReceipt, connectAgentMuxRpc } from '../../../packages/core/src/control-host.js'
import { objectCliEnvironment } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { objectCliReceipt } from '../../../packages/core/test/helpers/object-cli-receipt.js'
import { parseBrowserTaskControlResult, assertBrowserTaskControlTarget } from '../../../packages/core/src/browser-task-control.js'
import { agentMuxCommandHelp } from '../../../packages/core/src/agentmux-cli-help.js'
import { executeBrowserTaskControl } from '../src/main/browser-task-control.js'
import { BrowserTaskAssets, type BrowserTaskAssetStore } from '../src/main/browser-task-assets.js'
import type { BrowserTaskAssetDocument, BrowserTaskAssetRun } from '../src/shared/browser-task-assets.js'
vi.mock('electron', () => ({ WebContentsView: class {}, app: { getPath: () => '' } }))
import { BrowserViewManager } from '../src/main/browser-view-manager.js'
import { api } from '../src/renderer/src/lib/api.js'
import { useAppStore } from '../src/renderer/src/store.js'

class MemoryStore implements BrowserTaskAssetStore {
  document: BrowserTaskAssetDocument | null = null
  async load() { return structuredClone(this.document) }
  async save(document: BrowserTaskAssetDocument) { this.document = structuredClone(document) }
}
const browserId = 'original-browser', url = 'https://generic.invalid/form'
async function fixture(checkpoint = false, fill = false) {
  const store = new MemoryStore(); let count = 0, now = 10
  const assets = new BrowserTaskAssets(store, { id: () => `task-${++count}`, now: () => now++ })
  const imported = await assets.importRecording({ id: 'human-recording', browserId, navigationId: 'recorded-nav', url,
    revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
  const edited = await assets.edit(imported.id, imported.revision, { ...imported.draft,
    parameters: fill ? [{ key: 'fresh', label: 'Fresh input', secret: true }] : [], steps: [
    ...(checkpoint ? [{ id: 'approval', kind: 'checkpoint' as const, url, reviewed: true }] : []),
    ...(fill ? [{ id: 'fill', kind: 'fill' as const, url, reviewed: true, parameterKey: 'fresh', target: { role: 'text input', name: 'Field', ordinal: 1, count: 1 } }]
      : [{ id: 'navigation', kind: 'navigate' as const, url, reviewed: true }])
  ] })
  const asset = await assets.saveVersion(edited.id, edited.revision)
  const entry = { id: browserId, humanControl: false, activity: { control: 'agent' }, view: { webContents: { isDestroyed: () => false } } }
  const manager = Object.create(BrowserViewManager.prototype) as BrowserViewManager
  Object.assign(manager, { entries: new Map([[browserId, entry]]), taskAssets: assets, taskExecutions: new Map() })
  const actions = vi.fn(async (_browserId: string, _script: string) => ({ browserId, result: { changed: true }, logs: [], outcome: { kind: 'completed' },
    runOperation: { id: `operation-${now++}`, browserId } }))
  const returnControl = vi.spyOn(manager, 'returnControl').mockImplementation(() => { entry.humanControl = false; entry.activity.control = 'agent'; return {} as never })
  vi.spyOn(manager as any, 'yieldControl').mockImplementation(() => { entry.humanControl = true; entry.activity.control = 'human' })
  vi.spyOn(manager, 'runScript').mockImplementation(actions as never)
  const owner = { getTaskAssets: (id: string) => assets.state(id), getOperation: vi.fn(async () => null),
    runControlledTaskAsset: (input: any) => manager.runControlledTaskAsset(input), stopTaskAsset: (id: string, runId: string) => manager.stopTaskAsset(id, runId) }
  return { assets, asset, store, entry, manager, actions, returnControl, owner }
}
const base = { schemaVersion: 5, requestId: 'source-task-request' } as const
const initial = useAppStore.getState()
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(initial, true) })

describe('actual public task control consumes the original Main task owner', () => {
  it('reads nonempty assets and derives zero-sample reliability without any journal/page work', async () => {
    const f = await fixture()
    const read = await executeBrowserTaskControl({ operation: 'browser.task.assets', browserId }, f.owner, false)
    expect(read).toMatchObject({ operation: 'browser.task.assets', state: { selectedRunId: null, assets: [{ id: f.asset.id }], runs: [] } })
    const result = await executeBrowserTaskControl({ operation: 'browser.task.reliability', browserId, assetId: f.asset.id, version: 1 }, f.owner, false)
    expect(result).toMatchObject({ operation: 'browser.task.reliability', reliability: { passRate: null, samples: [], population: { retainedRuns: 0 } } })
    expect(f.owner.getOperation).not.toHaveBeenCalled(); expect(f.actions).not.toHaveBeenCalled()
  })
  it('deduplicates only exact-version bound IDs; completed script does not become a passed outcome', async () => {
    const f = await fixture(), run = await f.manager.runControlledTaskAsset({ browserId, assetId: f.asset.id, version: 1, parameters: {} })
    expect(run.operationIds).toHaveLength(1)
    const state = await f.assets.state(browserId)
    state.runs.push({ ...run, id: 'other-version', version: 2, operationIds: ['unrelated-operation'] })
    const owner = { ...f.owner, getTaskAssets: async () => state }
    const result = await executeBrowserTaskControl({ operation: 'browser.task.reliability', browserId, assetId: f.asset.id, version: 1 }, owner, true)
    expect(f.owner.getOperation.mock.calls).toEqual([[run.operationIds[0]]])
    expect(result).toMatchObject({ operation: 'browser.task.reliability', reliability: { scriptCompleted: 1, passRate: 0,
      counts: { passed: 0, unavailable: 1 }, samples: [{ runId: run.id, result: 'unavailable' }] } })
  })
  it('read failure preserves original progress and reports unavailable rather than judging the page', async () => {
    const f = await fixture(), run = await f.manager.runControlledTaskAsset({ browserId, assetId: f.asset.id, version: 1, parameters: {} })
    f.owner.getOperation.mockRejectedValue(new Error('Local journal unavailable'))
    const before = await f.assets.state(browserId)
    const result = await executeBrowserTaskControl({ operation: 'browser.task.reliability', browserId, assetId: f.asset.id, version: 1 }, f.owner, false)
    expect(result).toMatchObject({ reliability: { warning: expect.stringContaining('could not be read'), samples: [{ runId: run.id, result: 'unavailable' }] } })
    expect(await f.assets.state(browserId)).toEqual(before); expect(f.actions).toHaveBeenCalledOnce()
  })
  it('Agent cannot approve a pending human checkpoint even after control was separately returned', async () => {
    const f = await fixture(true)
    const first = await f.manager.runTaskAsset({ browserId, assetId: f.asset.id, version: 1, parameters: {} })
    expect(first).toMatchObject({ status: 'waiting-human', nextStep: 1, pendingCheckpointId: 'approval' })
    f.entry.humanControl = false; f.entry.activity.control = 'agent'
    const before = await f.assets.state(browserId); f.returnControl.mockClear()
    await expect(executeBrowserTaskControl({ operation: 'browser.task.run', browserId, assetId: f.asset.id, version: 1, runId: first.id, parameters: {} }, f.owner, true)).rejects.toThrow('waiting for the person')
    expect(await f.assets.state(browserId)).toEqual(before)
    expect(f.actions).not.toHaveBeenCalled(); expect(f.returnControl).not.toHaveBeenCalled()
  })
  it('control does not take input from the person; genuine UI Continue remains the only checkpoint fact source', async () => {
    const f = await fixture(true)
    f.entry.humanControl = true; f.entry.activity.control = 'human'
    await expect(f.manager.runControlledTaskAsset({ browserId, assetId: f.asset.id, version: 1, parameters: {} })).rejects.toThrow('The person has Browser control')
    expect(f.returnControl).not.toHaveBeenCalled(); expect(f.actions).not.toHaveBeenCalled()
    const first = await f.manager.runTaskAsset({ browserId, assetId: f.asset.id, version: 1, parameters: {} })
    const done = await f.manager.runTaskAsset({ browserId, assetId: f.asset.id, version: 1, parameters: {}, runId: first.id })
    expect(done).toMatchObject({ id: first.id, status: 'completed', humanCheckpoints: [{ origin: 'trusted-ui', checkpointId: 'approval', controlBefore: 'human' }] })
    expect(f.actions).toHaveBeenCalledOnce()
  })
  it('disabled automation only refuses execution; read and stop still retain the original run', async () => {
    const f = await fixture(true)
    const first = await f.manager.runTaskAsset({ browserId, assetId: f.asset.id, version: 1, parameters: {} })
    await expect(executeBrowserTaskControl({ operation: 'browser.task.run', browserId, assetId: f.asset.id, version: 1, parameters: {} }, f.owner, false)).rejects.toThrow('disabled')
    expect(await executeBrowserTaskControl({ operation: 'browser.task.stop', browserId, runId: first.id }, f.owner, false)).toMatchObject({ run: { id: first.id, status: 'stopped', nextStep: 1 } })
    expect(f.actions).not.toHaveBeenCalled()
  })
  it('rejects mismatched identities and nonfinite/empty-fabricated reliability populations', () => {
    const result = { operation: 'browser.task.reliability' as const, reliability: { browserId, assetId: 'asset-a', version: 1, selectedRunId: null,
      population: { retainedRuns: 1, terminalRuns: 1, pendingRuns: 0, firstStartedAt: 1, lastUpdatedAt: 2 },
      counts: { passed: 1, 'not-met': 0, unavailable: 0, unknown: 0, failed: 0, stopped: 0, interrupted: 0 },
      scriptCompleted: 1, humanInterventions: 0, passRate: 1, samples: [{ runId: 'run-a', result: 'passed', reason: 'Actual joined facts' }] } }
    expect(parseBrowserTaskControlResult(result.operation, result)).toEqual(result)
    expect(() => parseBrowserTaskControlResult(result.operation, { ...result, reliability: { ...result.reliability, samples: [] } })).toThrow('samples')
    expect(() => parseBrowserTaskControlResult(result.operation, { ...result, reliability: { ...result.reliability, passRate: Number.NaN } })).toThrow('pass rate')
    expect(() => assertBrowserTaskControlTarget({ operation: result.operation, browserId, assetId: 'different-asset', version: 1 }, result as any)).toThrow('another version')
    expect(() => parseAgentMuxControlRequest({ ...base, operation: 'browser.task.run', browserId, assetId: 'asset-a', version: 1, parameters: { key: 'x'.repeat(16_385) } })).toThrow('parameter')
  })
})

let directory: string, runtimeRoot: string, cli: string
beforeAll(async () => {
  await mkdir(resolve('.tmp'), { recursive: true }); directory = await mkdtemp(resolve('.tmp/browser-task-control-source-')); runtimeRoot = await mkdtemp(join(tmpdir(), 'amx-task-control-')); cli = join(directory, 'source-cli.mjs')
  await build({ configFile: false, logLevel: 'silent', plugins: [{ name: 'actual-task-cli-source', enforce: 'pre', transform(source, id) {
    const path = id.split('?')[0]!
    let code = source
    if (process.env.AGENTMUX_BROWSER_TASK_MUTATION === 'cli-drops-fresh-parameters' && path === resolve('packages/core/src/agentmux.ts')) {
      const block = 'invocation.params.parameters = text.trim() ? JSON.parse(text) : {}'
      assert.equal(source.split(block).length - 1, 1, 'Unique actual public CLI parameter forwarding')
      code = source.replace(block, 'invocation.params.parameters = {}')
    }
    if (process.env.AGENTMUX_BROWSER_TASK_LOADED && path.startsWith(resolve('packages/core/src') + '/')) appendFileSync(process.env.AGENTMUX_BROWSER_TASK_LOADED,
      JSON.stringify({ path: path.slice(resolve('.').length + 1), consumer: 'public-source-cli-ssr', sha256: createHash('sha256').update(source).digest('hex'),
        loadedSha256: createHash('sha256').update(code).digest('hex'), ...(code === source ? {} : { mutation: 'cli-drops-fresh-parameters' }) }) + '\n')
    return code === source ? undefined : { code, map: null }
  } }], build: { ssr: true, minify: false, emptyOutDir: false, outDir: directory,
    rollupOptions: { input: resolve('packages/core/src/agentmux.ts'), output: { format: 'es', entryFileNames: 'source-cli.mjs' } } } })
})
afterAll(async () => { if (directory) await rm(directory, { recursive: true }); if (runtimeRoot) await rm(runtimeRoot, { recursive: true }) })
async function cliRun(args: string[], input = '') {
  return await new Promise<{ code: number; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, 'browser', 'task', ...args], { cwd: resolve('.'),
      env: objectCliEnvironment(runtimeRoot), stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Private Source CLI did not finish')) }, 10_000)
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value }); child.stderr.setEncoding('utf8').on('data', value => { stderr += value })
    child.stdin.on('error', () => {}); child.once('error', reject)
    child.once('close', code => { clearTimeout(timer); accept({ code: code ?? -1, stdout, stderr }) }); child.stdin.end(input)
  })
}
it('actual CLI → socket → Store → Main read/stop and checkpoint refusal preserve the user selection', async () => {
  const f = await fixture(true), seen: string[] = []
  const first = await f.manager.runTaskAsset({ browserId, assetId: f.asset.id, version: 1, parameters: {} })
  f.entry.humanControl = false; f.entry.activity.control = 'agent'; f.returnControl.mockClear()
  const forward = vi.spyOn(api.browser, 'controlTask').mockImplementation(request => executeBrowserTaskControl(request, f.owner, true))
  const server = new AgentMuxControlServer({ socketPath: join(runtimeRoot, 'control.sock'), coreClients: () => [], async execute(request) { seen.push(request.operation); return useAppStore.getState().executeControl(request) } })
  const before = useAppStore.getState(); const beforeAssets = await f.assets.state(browserId)
  const focused = document.createElement('textarea'); document.body.appendChild(focused); focused.focus(); focused.value = 'unsent'; focused.setSelectionRange(1, 4)
  await server.start()
  try {
    const assets = await cliRun(['assets', '--browser', browserId]); expect(assets.code, assets.stderr).toBe(0)
    expect(objectCliReceipt(JSON.parse(assets.stdout))).toMatchObject({ operation: 'browser.task.assets', result: { state: { assets: [{ id: f.asset.id }], selectedRunId: first.id } } })
    const reliability = await cliRun(['reliability', '--browser', browserId, '--asset', f.asset.id, '--version', '1']); expect(reliability.code, reliability.stderr).toBe(0)
    expect(objectCliReceipt(JSON.parse(reliability.stdout))).toMatchObject({ result: { reliability: { passRate: null, population: { pendingRuns: 1 } } } })
    const pending = await cliRun(['run', '--browser', browserId, '--asset', f.asset.id, '--version', '1', '--run', first.id], '{}')
    expect(pending.code).toBe(1); expect(JSON.parse(pending.stderr)).toMatchObject({ operation: 'browser.task.run', error: { message: expect.stringContaining('waiting for the person') } })
    expect(await f.assets.state(browserId)).toEqual(beforeAssets); expect(f.actions).not.toHaveBeenCalled(); expect(f.returnControl).not.toHaveBeenCalled()
    const stop = await cliRun(['stop', '--browser', browserId, '--run', first.id]); expect(stop.code, stop.stderr).toBe(0)
    expect(objectCliReceipt(JSON.parse(stop.stdout))).toMatchObject({ result: { run: { id: first.id, status: 'stopped' } } })
    expect(seen).toEqual(['browser.task.assets', 'browser.task.reliability', 'browser.task.run', 'browser.task.stop']); expect(forward).toHaveBeenCalledTimes(4)
    const after = useAppStore.getState(); expect([after.tabs, after.layouts, after.activeWorkspaceId, after.regionCaretFocus, after.mainSurface]).toEqual([before.tabs, before.layouts, before.activeWorkspaceId, before.regionCaretFocus, before.mainSurface])
    expect(document.activeElement).toBe(focused); expect([focused.value, focused.selectionStart, focused.selectionEnd]).toEqual(['unsent', 1, 4])
    expect(agentMuxCommandHelp('browser.task')).toContain('cannot approve'); expect(agentMuxCommandHelp('browser.task.run')).toContain('stdin')
  } finally { await server.stop(); focused.remove() }
})

it('real public client refuses reliability borrowed from a different requested version', async () => {
  const f = await fixture()
  const server = new AgentMuxControlServer({ socketPath: join(runtimeRoot, 'wrong.sock'), coreClients: () => [], async execute(request) {
    const result = await executeBrowserTaskControl(request, f.owner, false)
    if (result.operation !== 'browser.task.reliability') throw new Error('Expected exact reliability read')
    return { ...result, reliability: { ...result.reliability, version: 2 } }
  } })
  await server.start()
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    await expect(client.call('browser.task.reliability', { browserId, assetId: f.asset.id, version: 1 })).rejects.toThrow('another version')
  } finally { await client.dispose(); await server.stop() }
})

it('positive public CLI run passes fresh values into the actual compiled fill without durable secrets or input takeover', async () => {
  const f = await fixture(false, true), input = 'fresh-source-only-secret', writes: unknown[][] = []
  const observed = { scope: { kind: 'page', document: null }, fullObserved: 1, scoped: 1, matched: 1, returned: 1, truncated: false, omittedFrames: [], unlocated: 0,
    work: { axTrees: 1, axNodes: 1, layoutTrees: 0, cdpCommands: 1 } }
  f.actions.mockImplementation(async (id, code) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const result = await new AsyncFunction('pageInfo', 'snapshot', 'fillInput', code)(
      async () => ({ url, navigationId: 'actual-source-navigation' }),
      async () => ({ observation: observed, missingFrames: [], nodes: [{ ref: '@e1', role: 'text input', name: 'Field' }] }),
      async (...args: unknown[]) => { writes.push(args) })
    return { browserId: id, result, logs: [], outcome: { kind: 'completed' }, runOperation: { id: 'positive-cli-operation', browserId: id } }
  })
  vi.spyOn(api.browser, 'controlTask').mockImplementation(request => executeBrowserTaskControl(request, f.owner, true))
  const server = new AgentMuxControlServer({ socketPath: join(runtimeRoot, 'control.sock'), coreClients: () => [], execute: request => useAppStore.getState().executeControl(request) })
  const before = useAppStore.getState(), field = document.createElement('textarea'); field.value = 'person draft'; document.body.append(field); field.focus(); field.setSelectionRange(2, 6)
  await server.start()
  try {
    const output = await cliRun(['run', '--browser', browserId, '--asset', f.asset.id, '--version', '1'], JSON.stringify({ fresh: input }))
    expect(output.code, output.stderr).toBe(0)
    expect(objectCliReceipt(JSON.parse(output.stdout))).toMatchObject({ operation: 'browser.task.run', result: { run: { status: 'completed', operationIds: ['positive-cli-operation'], nextStep: 1 } } })
    expect(writes).toEqual([['@e1', input]]); expect(f.actions).toHaveBeenCalledOnce(); expect(f.returnControl).not.toHaveBeenCalled()
    expect(JSON.stringify(f.store.document)).not.toContain(input); expect(output.stdout + output.stderr).not.toContain(input)
    const after = useAppStore.getState(); expect([after.tabs, after.layouts, after.regionCaretFocus, after.activeWorkspaceId, after.mainSurface]).toEqual([before.tabs, before.layouts, before.regionCaretFocus, before.activeWorkspaceId, before.mainSurface])
    expect(document.activeElement).toBe(field); expect([field.value, field.selectionStart, field.selectionEnd]).toEqual(['person draft', 2, 6])
  } finally { await server.stop(); field.remove() }
})

it('actual public CLI chooses one forward condition arm and binds its fresh fill to the original run', async () => {
  const f = await fixture(false, true), secret = 'branch-cli-one-time-value', writes: unknown[][] = []
  ;(f.entry as any).navigationId = 'actual-branch-cli-navigation'
  const edited = await f.assets.edit(f.asset.id, f.asset.revision, { ...f.asset.draft, steps: [
    { id: 'condition', kind: 'branch', url, reviewed: true, branch: { condition: { kind: 'page-url-is', url }, onTrue: 'fill', onFalse: 'alternative' } },
    { ...f.asset.draft.steps[0]!, nextStepId: null }, { id: 'alternative', kind: 'navigate', url: 'https://generic.invalid/alternative', reviewed: true }
  ] })
  await f.assets.saveVersion(f.asset.id, edited.revision)
  let operation = 0
  f.actions.mockImplementation(async (id, code) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const result = await new AsyncFunction('pageInfo', 'snapshot', 'fillInput', 'gotoUrl', code)(
      async () => ({ url, navigationId: 'actual-branch-cli-navigation' }),
      async () => ({ observation: { scope: { kind: 'page', document: null }, fullObserved: 1, truncated: false, omittedFrames: [] }, missingFrames: [], nodes: [{ ref: '@e1', role: 'text input', name: 'Field' }] }),
      async (...args: unknown[]) => { writes.push(args) }, async () => { throw new Error('The unselected path must not run') })
    return { result, logs: [], outcome: { kind: 'completed' }, runOperation: { id: `branch-cli-operation-${++operation}`, browserId: id } } as any
  })
  vi.spyOn(api.browser, 'controlTask').mockImplementation(request => executeBrowserTaskControl(request, f.owner, true))
  const server = new AgentMuxControlServer({ socketPath: join(runtimeRoot, 'control.sock'), coreClients: () => [], execute: request => useAppStore.getState().executeControl(request) })
  await server.start()
  try {
    const result = await cliRun(['run', '--browser', browserId, '--asset', f.asset.id, '--version', '2'], JSON.stringify({ fresh: secret }))
    expect(result.code, result.stderr).toBe(0)
    expect(objectCliReceipt(JSON.parse(result.stdout))).toMatchObject({ result: { run: { status: 'completed', version: 2,
      branchDecisions: [{ stepId: 'condition', result: 'true', navigationId: 'actual-branch-cli-navigation', nextStepId: 'fill' }],
      stepExecutions: [{ stepId: 'condition', operationId: 'branch-cli-operation-1' }, { stepId: 'fill', operationId: 'branch-cli-operation-2' }] } } })
    expect(writes).toEqual([['@e1', secret]]); expect(f.actions).toHaveBeenCalledTimes(2); expect(f.returnControl).not.toHaveBeenCalled()
    expect(JSON.stringify(f.store.document) + result.stdout + result.stderr).not.toContain(secret)
  } finally { await server.stop() }
})

it('actual Main dispatcher refuses a selected condition action after its document changes across preparation', async () => {
  const f = await fixture(), operation = { id: 'selected-arm-operation', browserId, phase: 'running', operator: { id: 'source-person', name: 'Source person' }, startedAt: 1, url, summary: 'Actual selected arm', steps: [] }
  Object.assign(f.entry, { navigationId: 'old-condition-navigation', activeRun: { operationId: operation.id }, feedback: {
    begin: vi.fn(async () => { (f.entry as any).navigationId = 'new-same-url-navigation'; return 1 }), completeAction: vi.fn(), clear: vi.fn()
  } })
  vi.spyOn(f.manager as any, 'emit').mockImplementation(() => {})
  const nativeNavigation = vi.spyOn(f.manager as any, 'startNavigation').mockResolvedValue(undefined)
  const taskAuthority = vi.spyOn(f.assets, 'isExecutionCurrent').mockReturnValue(true)
  Object.assign(f.manager, { refLedgers: { read: vi.fn(async () => null), write: vi.fn() } })
  const sender = { sendCommand: vi.fn(), frames: new Map() }
  const actual = (f.manager as any).pageCallHandler(f.entry, sender, [], { at: null }, operation, false, new AbortController().signal,
    { cursor: { runId: 'original-selected-run', assetId: f.asset.id, version: 1, browserId, stepId: 'navigation', expectedNavigationId: 'old-condition-navigation' } })
  await expect(actual('gotoUrl', ['https://generic.invalid/next'])).rejects.toThrow('condition document changed')
  expect((f.entry as any).feedback.begin).toHaveBeenCalledOnce(); expect(nativeNavigation).not.toHaveBeenCalled(); expect(sender.sendCommand).not.toHaveBeenCalled()
  expect(taskAuthority).toHaveBeenCalled(); expect(operation.steps).toMatchObject([{ status: 'failed', method: 'gotoUrl' }])
})


it('public task result requires the actual branch operation to be bound to the same executed step', async () => {
  const f = await fixture(), run = await f.manager.runControlledTaskAsset({ browserId, assetId: f.asset.id, version: 1, parameters: {} })
  expect(run.stepExecutions).toEqual([{ stepId: 'navigation', operationId: run.operationIds[0] }])
  const source = { operation: 'browser.task.run' as const, run: { ...run, branchDecisions: [{ stepId: 'another-step', operationId: run.operationIds[0], navigationId: 'real-navigation', result: 'true', nextStepId: null }] } }
  expect(() => parseBrowserTaskControlResult(source.operation, source)).toThrow('not bound to its step')
  expect(() => parseBrowserTaskControlResult(source.operation, { ...source, run: { ...source.run, stepExecutions: [] } })).toThrow('not bound to its step')
})
