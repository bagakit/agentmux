import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../scripts/verify-browser-recovery-restart.mjs', import.meta.url), 'utf8')

// Execute bytes from the actual owning canonical continuation, without top-level imports,
// process setup, Electron, Store or a test-authored copy of its outcome branch.
function actualContinuation() {
  const file = ts.createSourceFile('verify-browser-recovery-restart.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const declarations = (statement: ts.Statement) => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []
  const named = (statement: ts.Statement, name: string) => declarations(statement).find(node => ts.isIdentifier(node.name) && node.name.text === name)
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
  // The selected statements include the actual if / await body, then the ordinary quit.
  // After whole-hook deletion the other real statements still execute, and observer count fails.
  expect(continuation.filter(ts.isIfStatement).length).toBeGreaterThan(0)
  return { factory: factories[0]!.getText(file), body: continuation.map(node => node.getText(file)).join('\n') }
}

function fixture() {
  const actual = actualContinuation()
  const first = { cdp: { identity: 'first-cdp' }, main: { identity: 'first-main' } }
  const second = { cdp: { identity: 'second-cdp' }, main: { identity: 'second-main' } }
  const initial = { surface: { browserId: 'original-browser-a', regionId: 'original-region-a' } }
  const sibling = { browserId: 'sibling-browser-b', regionId: 'sibling-region-b' }
  const urls = ['http://127.0.0.1:30001/a', 'http://127.0.0.1:30001/b']
  const receipt: Record<string, unknown> = {}
  const expected = { original: initial.surface }, pages = [{ originalPage: urls[0] }], before = { durableIdentity: 'before-source' }
  const dependencies = { urls, receipt, localRecoveryKind: null, click: vi.fn(), selectors: vi.fn(), waitFor: vi.fn(), runBrowser: vi.fn(),
    phase: 'source', observeNativeFrameReady: vi.fn(), nativePageScript: vi.fn(), resize: vi.fn(),
    requestAgentMuxControl: vi.fn(), subscribeAgentMuxControl: vi.fn(), AGENTMUX_CONTROL_SCHEMA_VERSION: 1, randomUUID: vi.fn(), join,
    runtimeDirectory: '/tmp/source-only-no-created-directory', process: { argv: [] },
    demonstrationCase: false, taskAssetsCase: false, taskDownloadCase: false, overlayCase: false, browserToolsCase: false, structuredCase: false,
    capture: vi.fn(), desktopRoot: 'source-desktop', userData: 'source-user-data', workspacePath: 'source-workspace', repositoryRoot: 'source-root' }
  const originalFactory = new Function(...Object.keys(dependencies), `return (${actual.factory})`)(...Object.values(dependencies)) as
    (probe: typeof first, browserId: string, pageUrl: string) => Record<string, unknown>
  const scenarioContext = vi.fn(originalFactory)
  const order: string[] = []
  const normalQuit = vi.fn(async () => { order.push('quit'); return 'actual-source-quit-return' })
  const startUnfinishedDownload = vi.fn(), demonstration = { startInterruptedDemonstration: vi.fn() }
  const run = (outcome: unknown) => {
    const globals = { scenarioContext, outcome, first, second, initial, sibling, urls, receipt, before, expected, pages,
      downloadCase: false, demonstrationCase: false, browserTools: false, cost: null, startUnfinishedDownload, demonstration, normalQuit }
    return new Function(...Object.keys(globals), `return (async () => {${actual.body}\n})()`)(...Object.values(globals)) as Promise<void>
  }
  return { run, first, initial, urls, receipt, expected, pages, before, scenarioContext, normalQuit, startUnfinishedDownload, demonstration, dependencies, order }
}

describe('actual canonical minimum outcome consumer', () => {
  it('calls the one observer with the actual original context, and awaits it before ordinary quit', async () => {
    const item = fixture()
    let finish!: () => void
    const gate = new Promise<void>(done => { finish = done })
    const observeMinimumBrowserOutcome = vi.fn(async (_context: Record<string, unknown>) => {
      item.order.push('observing'); await gate; item.order.push('observed')
    })
    const running = item.run({ observeMinimumBrowserOutcome })
    await Promise.resolve()
    expect(item.scenarioContext.mock.calls).toEqual([[item.first, item.initial.surface.browserId, item.urls[0]]])
    expect(observeMinimumBrowserOutcome.mock.calls).toHaveLength(1)
    const context = observeMinimumBrowserOutcome.mock.calls[0]![0]
    expect(context.probe).toBe(item.first)
    expect(context.browserId).toBe(item.initial.surface.browserId)
    expect(context.pageUrl).toBe(item.urls[0])
    expect(context.urls).toBe(item.urls)
    expect(context.receipt).toBe(item.receipt)
    expect(context.click).toBe(item.dependencies.click)
    expect(context.resize).toBe(item.dependencies.resize)
    expect(item.normalQuit).not.toHaveBeenCalled()
    finish(); await running
    expect(item.normalQuit.mock.calls).toEqual([[item.first]])
    expect(item.order).toEqual(['observing', 'observed', 'quit'])
    expect(item.receipt.firstUi).toEqual({ expected: item.expected, pages: item.pages, ...item.before })
    expect(item.receipt.firstExit).toBe('actual-source-quit-return')
    expect(item.startUnfinishedDownload).not.toHaveBeenCalled()
    expect(item.demonstration.startInterruptedDemonstration).not.toHaveBeenCalled()
  })

  it.each([null, undefined, false])('does not construct or call an observer for falsy outcome %s', async outcome => {
    const item = fixture()
    await item.run(outcome)
    expect(item.scenarioContext).not.toHaveBeenCalled()
    expect(item.normalQuit.mock.calls).toEqual([[item.first]])
    expect(item.order).toEqual(['quit'])
    expect(item.receipt.firstExit).toBe('actual-source-quit-return')
    expect(item.startUnfinishedDownload).not.toHaveBeenCalled()
    expect(item.demonstration.startInterruptedDemonstration).not.toHaveBeenCalled()
  })
})
