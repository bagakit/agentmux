import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { runOwnerDisposals } from '../src/main/owner-disposal.js'
import { singleFlight } from '../src/main/single-flight.js'
import { reportQuitDisposalFailure } from '../src/main/quit-disposal-failure.js'
import { crashRecordFrom, type CrashRecord } from '../src/main/crash-capture.js'

function source(path: string) {
  return ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}
function declaration(file: ts.SourceFile, name: string): ts.Node {
  const matches: ts.Node[] = []
  function scan(node: ts.Node) {
    if ((ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) && node.name?.getText(file) === name) matches.push(node)
    ts.forEachChild(node, scan)
  }
  scan(file)
  expect(matches, `production declaration ${name} must exist exactly once`).toHaveLength(1)
  return matches[0]!
}
function execute(code: string, dependencies: Record<string, unknown>) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function('dependencies', js)(dependencies)
}
const main = source('../src/main/index.ts')

it('actual Main owner disposal attempts progress, updates, IPC and Runtime exactly once after earlier failures', async () => {
  const order: string[] = []
  const original = new Error('continuous progress final write failed')
  const dependencies = {
    runOwnerDisposals,
    progressLoops: { stop: async () => { order.push('progress'); throw original } },
    rendererUpdates: { dispose: () => { order.push('updates'); throw new Error('watcher close failed') } },
    disposeIpc: async () => { order.push('ipc') },
    runtime: { dispose: async () => { order.push('runtime') }, stop: vi.fn() }
  }
  const dispose = execute(`const { runOwnerDisposals, progressLoops, rendererUpdates, runtime } = dependencies;
    let disposeIpc = dependencies.disposeIpc; let ownerDisposal = null;
    ${declaration(main, 'disposeOwners').getText(main)}; return disposeOwners;`, dependencies) as () => Promise<void>
  const first = dispose(), second = dispose()
  expect(second).toBe(first)
  await expect(first).rejects.toMatchObject({ errors: [
    { message: 'Owner continuous-progress disposal failed', cause: original },
    { message: 'Owner renderer-updates disposal failed', cause: expect.objectContaining({ message: 'watcher close failed' }) }
  ] })
  expect(order).toEqual(['progress', 'updates', 'ipc', 'runtime'])
  expect(dependencies.runtime.stop).not.toHaveBeenCalled()
})

function quitHarness(disposeOwners: () => Promise<void>, overrides: Record<string, unknown> = {}) {
  const records: CrashRecord[] = [], stderr: string[] = []
  const app = { quit: vi.fn(), getVersion: () => 'quit-test-version' }
  const exitAfterFailure = vi.fn()
  const dependencies = { singleFlight, disposeOwners, reportQuitDisposalFailure,
    workbenchWindow: {}, prepareWindowWorkbenchForQuit: vi.fn(async () => {}), reportWorkbenchQuitFailure: vi.fn(),
    crashLog: { appendSync: (record: CrashRecord) => records.push(record) }, app,
    process: { pid: 4242, stderr: { write: (line: string) => stderr.push(line) } }, exitAfterFailure, ...overrides }
  const harness = execute(`const { ${Object.keys(dependencies).join(', ')} } = dependencies; let allowingQuit = false;
    const ${declaration(main, 'prepareQuit').getText(main)};
    return { prepareQuit, allowingQuit: () => allowingQuit };`, dependencies) as { prepareQuit(): Promise<void>; allowingQuit(): boolean }
  return { ...harness, records, stderr, app, exitAfterFailure, dependencies }
}

it('actual Main quit catch records disposal stage and continues the requested quit without startup UI or second cleanup', async () => {
  const original = new Error('browser profile flush EIO')
  const cleanup = vi.fn(async () => runOwnerDisposals([
    { owner: 'browser-profiles', dispose: () => { throw original } }
  ], 'Desktop owner disposal failed'))
  const f = quitHarness(cleanup)
  await f.prepareQuit()
  expect(cleanup).toHaveBeenCalledTimes(1)
  expect(f.exitAfterFailure).not.toHaveBeenCalled()
  expect(f.records).toHaveLength(1)
  expect(f.records[0]).toMatchObject({ kind: 'quit-disposal-failure', phase: 'dispose-owners', pid: 4242, appVersion: 'quit-test-version' })
  expect(f.records[0]!.detail).toContain('browser-profiles')
  expect(f.records[0]!.detail).toContain(original.message)
  expect(f.stderr.join('')).toContain(original.message)
  expect(f.allowingQuit()).toBe(true)
  expect(f.app.quit).toHaveBeenCalledTimes(1)
})

it('actual Main quit remains available if both the local log and stderr fail', async () => {
  const f = quitHarness(async () => { throw new Error('owner cleanup failed') }, {
    crashLog: { appendSync: () => { throw new Error('disk full') } },
    process: { pid: 4242, stderr: { write: () => { throw new Error('closed stderr') } } }
  })
  await f.prepareQuit()
  expect(f.allowingQuit()).toBe(true)
  expect(f.app.quit).toHaveBeenCalledTimes(1)
  expect(f.exitAfterFailure).not.toHaveBeenCalled()
})

it('actual Main quit retains the workbench if its existing save path fails before disposal', async () => {
  const cleanup = vi.fn(async () => {})
  const failedSave = new Error('workbench save unconfirmed')
  const report = vi.fn()
  const f = quitHarness(cleanup, { prepareWindowWorkbenchForQuit: async () => { throw failedSave }, reportWorkbenchQuitFailure: report })
  await f.prepareQuit()
  expect(report).toHaveBeenCalledWith(f.dependencies.workbenchWindow, failedSave)
  expect(cleanup).not.toHaveBeenCalled()
  expect(f.app.quit).not.toHaveBeenCalled()
})

it('actual IPC disposal isolates synchronous sibling failures and still removes every channel', async () => {
  const ipc = source('../src/main/ipc.ts')
  const register = declaration(ipc, 'registerIpc') as ts.FunctionDeclaration
  const statement = register.body!.statements.at(-1)!
  expect(ts.isReturnStatement(statement)).toBe(true)
  const returned = (statement as ts.ReturnStatement).expression!
  expect(ts.isArrowFunction(returned)).toBe(true)
  const calls: string[] = []
  const action = (name: string, fails = false) => () => { calls.push(name); if (fails) throw new Error(`${name} failed`) }
  const deps = { runOwnerDisposals, disposeSpatial: action('spatial', true), disposeNotebook: action('notebook', true),
    disposeToolkitIpc: action('toolkit-ipc'), toolkit: { dispose: action('toolkit') }, args: {
      spatialLinks: { unavailable: action('links') }, window: { webContents: { off: action('metrics-listener') } }
    }, closeMetrics: () => {}, metrics: { dispose: action('metrics') }, CONTROL_RESPONSE_CHANNEL: 'response', acceptControl: () => {},
    ipcMain: { removeListener: action('control-listener'), removeHandler: (channel: string) => calls.push(channel) },
    disposeProgressInput: action('progress-input'), disposeProgressChanges: action('progress-changes'), controlBridge: { dispose: action('bridge') },
    control: { stop: action('control') }, detach: action('detach'), historyObservations: { dispose: action('history', true) },
    releaseResourceObservation: action('resources'), notifier: { dispose: action('notifier') }, browsers: { dispose: action('browsers') },
    nativeChrome: { dispose: action('chrome') }, externalBrowsers: { dispose: action('external') }, browserInputHistory: { flush: action('input-history') },
    browserProfiles: { dispose: action('profiles') }, fileObservations: { dispose: action('file-observations') }, files: { dispose: action('files') },
    channels: ['channel-a', 'channel-b'] }
  const dispose = execute(`const { ${Object.keys(deps).join(', ')} } = dependencies; let acceptingControl = true;
    return ${returned.getText(ipc)};`, deps) as () => Promise<void>
  await expect(dispose()).rejects.toMatchObject({ errors: [
    expect.objectContaining({ message: 'Owner spatial disposal failed' }), expect.objectContaining({ message: 'Owner notebook disposal failed' }),
    expect.objectContaining({ message: 'Owner history-observations disposal failed' })
  ] })
  expect(calls).toEqual(['spatial', 'notebook', 'toolkit-ipc', 'toolkit', 'links', 'metrics-listener', 'metrics', 'control-listener',
    'progress-input', 'progress-changes', 'bridge', 'control', 'detach', 'history', 'resources', 'notifier', 'chrome', 'external', 'browsers',
    'input-history', 'profiles', 'file-observations', 'files', 'channel-a', 'channel-b'])
})

describe('bounded nested local diagnostics', () => {
  it('preserves nested AggregateError and cause, including non-Error failures', () => {
    const error = new AggregateError([new Error('named IPC owner', { cause: new AggregateError([new Error('actual close failed'), 'raw failure'], 'IPC cleanup failed') })], 'Desktop cleanup failed')
    const record = crashRecordFrom({ kind: 'quit-disposal-failure', error, appVersion: 'test', pid: 1 }, 0)
    expect(record.detail).toContain('named IPC owner')
    expect(record.detail).toContain('IPC cleanup failed')
    expect(record.detail).toContain('actual close failed')
    expect(record.detail).toContain('raw failure')
    expect(JSON.parse(JSON.stringify(record)).phase).toBe('dispose-owners')
  })
  it('bounds circular, deep and wide error graphs without losing first original owner failure', () => {
    const original = new Error('first owner failure')
    const cycle = new Error('cycle'); cycle.cause = cycle
    let deep: Error = original
    for (let i = 0; i < 100; i++) deep = new Error('nested', { cause: deep })
    const wide = new AggregateError([original, cycle, deep, ...Array.from({ length: 1000 }, () => new Error('huge' + '中'.repeat(20_000)))], 'Desktop cleanup failed')
    const record = crashRecordFrom({ kind: 'quit-disposal-failure', error: wide, appVersion: 'test', pid: 1 }, 0)
    expect(record.detail).toContain(original.message)
    expect(record.detail).toContain('[circular or repeated error]')
    expect(record.detail).toContain('[error depth truncated]')
    expect(record.detail).toContain('[error nodes truncated]')
    expect(Buffer.byteLength(record.detail!, 'utf8')).toBeLessThanOrEqual(128 * 1024)
    expect(record.detail).not.toContain('�')
  })
})
