import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../scripts/verify-browser-recovery-restart.mjs', import.meta.url), 'utf8')

// Read the same real factory and continuation as the minimum observer consumer.
// No test-authored cost body, top-level imports/setup, launch or finally is executed.
function actualContinuation() {
  const file = ts.createSourceFile('verify-browser-recovery-restart.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  expect(file.parseDiagnostics).toHaveLength(0)
  const named = (statement: ts.Statement, name: string) => ts.isVariableStatement(statement)
    ? statement.declarationList.declarations.find(node => ts.isIdentifier(node.name) && node.name.text === name) : undefined
  const owners = file.statements.filter((node): node is ts.TryStatement => ts.isTryStatement(node)
    && node.tryBlock.statements.some(statement => Boolean(named(statement, 'scenarioContext'))))
  expect(owners).toHaveLength(1)
  const statements = [...owners[0]!.tryBlock.statements]
  const factories = statements.flatMap(statement => {
    const node = named(statement, 'scenarioContext')
    return node?.initializer && ts.isArrowFunction(node.initializer) ? [node.initializer] : []
  })
  expect(factories).toHaveLength(1)
  const starts = statements.flatMap((statement, index) => named(statement, 'before') ? [index] : [])
  const ends = statements.flatMap((statement, index) => {
    if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) return []
    const { left, right } = statement.expression
    return ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === 'receipt'
      && left.name.text === 'firstExit' && ts.isAwaitExpression(right) && ts.isCallExpression(right.expression)
      && ts.isIdentifier(right.expression.expression) && right.expression.expression.text === 'normalQuit' ? [index] : []
  })
  expect(starts).toHaveLength(1)
  expect(ends).toHaveLength(1)
  expect(ends[0]).toBeGreaterThan(starts[0]! + 1)
  const continuation = statements.slice(starts[0]! + 1, ends[0]! + 1)
  expect(continuation.length).toBeGreaterThan(0)
  expect(continuation.filter(ts.isIfStatement).length).toBeGreaterThan(0)
  return { factory: factories[0]!.getText(file), body: continuation.map(node => node.getText(file)).join('\n') }
}

function fixture() {
  const actual = actualContinuation()
  const first = { cdp: { identity: 'original-renderer' }, main: { identity: 'original-main' } }
  const initial = { surface: { browserId: 'original-browser-a', regionId: 'original-region-a' } }
  const sibling = { browserId: 'explicit-sibling-browser-b', regionId: 'explicit-sibling-region-b' }
  const urls = ['http://127.0.0.1:30001/a', 'http://127.0.0.1:30001/b']
  const receipt: any = { browserOutcome: { initial: { id: 'original-producer-operation' } } }
  const expected = { original: initial.surface }, pages = [{ originalPage: urls[0] }], before = { originalWorkbench: 'before' }
  const order: string[] = []
  const baseline = { outcome: { kind: 'completed' }, result: { identity: 'explicit-readonly-sibling-snapshot' } }
  const runBrowser = vi.fn(async (_browserId: string, _code: string) => { order.push('baseline'); return baseline })
  const stream = { identity: 'same-private-stream-return' }
  const subscribeAgentMuxControl = vi.fn(async (_fields: unknown, _handlers: unknown, _socket: string) => stream)
  const runtimeDirectory = '/tmp/source-cost-no-created-runtime'
  const dependencies = { urls, receipt, localRecoveryKind: null, click: vi.fn(), selectors: vi.fn(), waitFor: vi.fn(), runBrowser,
    phase: 'source', observeNativeFrameReady: vi.fn(), nativePageScript: vi.fn(), resize: vi.fn(),
    requestAgentMuxControl: vi.fn(), subscribeAgentMuxControl, AGENTMUX_CONTROL_SCHEMA_VERSION: 19,
    randomUUID: vi.fn(() => 'one-source-subscribe-request'), join, runtimeDirectory, process: { argv: [] },
    demonstrationCase: false, taskAssetsCase: false, taskDownloadCase: false, overlayCase: false, browserToolsCase: false, structuredCase: false,
    capture: vi.fn(), desktopRoot: 'source-desktop', userData: 'source-user-data', workspacePath: 'source-workspace', repositoryRoot: 'source-root' }
  const originalFactory = new Function(...Object.keys(dependencies), `return (${actual.factory})`)(...Object.values(dependencies)) as
    (probe: typeof first, browserId: string, pageUrl: string) => Record<string, any>
  const scenarioContext = vi.fn(originalFactory)
  const normalQuit = vi.fn(async (_probe: typeof first) => { order.push('quit'); return 'actual-quit-return' })
  const run = (cost: unknown) => {
    const globals = { assert, scenarioContext, cost, outcome: null, first, initial, sibling, urls, receipt, before, expected, pages, runBrowser,
      downloadCase: false, demonstrationCase: false, browserTools: null, startUnfinishedDownload: vi.fn(), demonstration: null, normalQuit }
    return new Function(...Object.keys(globals), `return (async () => {${actual.body}\n})()`)(...Object.values(globals)) as Promise<void>
  }
  return { run, first, initial, sibling, urls, receipt, before, expected, pages, baseline, runBrowser, scenarioContext,
    normalQuit, dependencies, subscribeAgentMuxControl, runtimeDirectory, stream, order }
}

describe('actual canonical cost collector consumer', () => {
  it('awaits one sibling baseline and the collector, preserving exact original owners, socket, handlers and returned measurements', async () => {
    const x = fixture()
    let finishBaseline!: (value: typeof x.baseline) => void, finishCollector!: () => void
    const baselineGate = new Promise<typeof x.baseline>(done => { finishBaseline = done })
    const collectorGate = new Promise<void>(done => { finishCollector = done })
    x.runBrowser.mockImplementation(async () => { x.order.push('baseline'); return baselineGate })
    const measurements = { identity: 'exact-collector-return', samples: [{ original: true }] }
    const fields = { operation: 'browser.subscribe', operationId: x.receipt.browserOutcome.initial.id, afterSequence: 0 }
    const handlers = { onEvent: vi.fn(), onEnd: vi.fn() }
    const collector = vi.fn(async (ctx: Record<string, any>, _options: unknown) => {
      x.order.push('collecting')
      expect(await ctx.subscribeControl(fields, handlers)).toBe(x.stream)
      await collectorGate; x.order.push('collected'); return measurements
    })
    const running = x.run({ collectBrowserCapabilityMeasurements: collector })
    expect(x.runBrowser.mock.calls).toEqual([[x.sibling.browserId, 'return await snapshot({scope:"page",maxNodes:40});']])
    expect(collector).not.toHaveBeenCalled()
    expect(x.normalQuit).not.toHaveBeenCalled()
    expect(x.receipt.capabilityMeasurementBaseline).toBeUndefined()
    finishBaseline(x.baseline)
    await vi.waitFor(() => expect(collector).toHaveBeenCalledTimes(1))
    expect(x.scenarioContext.mock.calls).toEqual([[x.first, x.initial.surface.browserId, x.urls[0]]])
    const [ctx, options] = collector.mock.calls[0]!
    expect(ctx.probe).toBe(x.first)
    expect(ctx.browserId).toBe(x.initial.surface.browserId)
    expect(ctx.pageUrl).toBe(x.urls[0])
    expect(ctx.urls).toBe(x.urls)
    expect(ctx.receipt).toBe(x.receipt)
    expect(ctx.runBrowser).toBe(x.runBrowser)
    expect(options).toEqual({ relatedOperationId: x.receipt.browserOutcome.initial.id, siblingBrowserId: x.sibling.browserId })
    expect(x.subscribeAgentMuxControl.mock.calls).toEqual([[{ schemaVersion: 19, requestId: 'one-source-subscribe-request', ...fields },
      handlers, join(x.runtimeDirectory, 'control.sock')]])
    expect(x.subscribeAgentMuxControl.mock.calls[0]![1]).toBe(handlers)
    expect(x.receipt.capabilityMeasurementBaseline).toBe(x.baseline)
    expect(x.receipt.capabilityMeasurements).toBeUndefined()
    expect(x.normalQuit).not.toHaveBeenCalled()
    finishCollector(); await running
    expect(x.receipt.capabilityMeasurements).toBe(measurements)
    expect(x.normalQuit.mock.calls).toEqual([[x.first]])
    expect(x.order).toEqual(['baseline', 'collecting', 'collected', 'quit'])
    expect(x.runBrowser).toHaveBeenCalledTimes(1)
    expect(x.receipt.firstExit).toBe('actual-quit-return')
  })

  it.each([null, undefined, false])('keeps cost %s absent without collecting or adding baseline work', async cost => {
    const x = fixture(); await x.run(cost)
    expect(x.runBrowser).not.toHaveBeenCalled()
    expect(x.scenarioContext).not.toHaveBeenCalled()
    expect(x.subscribeAgentMuxControl).not.toHaveBeenCalled()
    expect(x.receipt.capabilityMeasurements).toBeUndefined()
    expect(x.receipt.capabilityMeasurementBaseline).toBeUndefined()
    expect(x.normalQuit.mock.calls).toEqual([[x.first]])
  })

  it('rejects the actual failed baseline before collection or ordinary quit', async () => {
    const x = fixture(); x.runBrowser.mockResolvedValue({ ...x.baseline, outcome: { kind: 'failed' } })
    const collector = vi.fn()
    await expect(x.run({ collectBrowserCapabilityMeasurements: collector })).rejects.toThrow()
    expect(x.runBrowser.mock.calls).toEqual([[x.sibling.browserId, 'return await snapshot({scope:"page",maxNodes:40});']])
    expect(collector).not.toHaveBeenCalled()
    expect(x.normalQuit).not.toHaveBeenCalled()
    expect(x.receipt.capabilityMeasurementBaseline).toBeUndefined()
    expect(x.receipt.capabilityMeasurements).toBeUndefined()
  })

  it('retains the completed baseline when the actual collector dependency fails and never manufactures measurement facts', async () => {
    const x = fixture(), failure = new Error('source collector fixture failed')
    const collector = vi.fn(async () => { throw failure })
    await expect(x.run({ collectBrowserCapabilityMeasurements: collector })).rejects.toBe(failure)
    expect(collector).toHaveBeenCalledTimes(1)
    expect(x.runBrowser).toHaveBeenCalledTimes(1)
    expect(x.receipt.capabilityMeasurementBaseline).toBe(x.baseline)
    expect(x.receipt.capabilityMeasurements).toBeUndefined()
    expect(x.normalQuit).not.toHaveBeenCalled()
  })
})
