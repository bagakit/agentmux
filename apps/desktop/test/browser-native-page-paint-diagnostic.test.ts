import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'
import { expect, it } from 'vitest'

const source = readFileSync(process.env.AGENTMUX_NATIVE_PAGE_PAINT_DIAGNOSTIC_SOURCE ?? new URL('../scripts/browser-native-page-paint-diagnostic.mjs', import.meta.url), 'utf8')
const scenario = readFileSync(process.env.AGENTMUX_NATIVE_PAGE_PAINT_SCENARIO_SOURCE ?? new URL('../scripts/browser-overlay-probe-scenario.mjs', import.meta.url), 'utf8')
const recovery = readFileSync(new URL('../scripts/verify-browser-recovery-restart.mjs', import.meta.url), 'utf8')
const start = source.indexOf('export async function observeSingleNativePagePaint(')
const next = source.indexOf('export async function diagnoseNativePagePaint(', start)
assert.ok(start >= 0 && next > start, 'Both actual diagnostic functions must be present')
const observeSource = source.slice(start, next).replace(/^export /, '')
const diagnoseSource = source.slice(next).replace(/^export /, '')
assert.ok(observeSource.includes('wc.invalidate()') && diagnoseSource.includes('ctx.probe.main.evaluate'))
const recoverStart = scenario.indexOf('export async function recoverOverlay(')
assert.ok(recoverStart >= 0, 'The actual ordinary-restart scenario must be present')
const recoverSource = scenario.slice(recoverStart).replace(/^export /, '')
assert.ok(recoverSource.includes('unforcedRestoredFrame') && recoverSource.includes('inputAfterRestart'))

type Mode = 'ready' | 'wrong-pid' | 'wrong-owner' | 'duplicate' | 'loading' | 'hidden' | 'zero' | 'minimized' | 'detached-after-wait' | 'navigated-after-wait' | 'frame-changed-after-wait' | 'invalidate-throws' | 'capture-throws' | 'empty-capture'
function fixture(mode: Mode = 'ready', ownedOutput = false) {
  const originalError = new Error('Original unforced frame gate failed')
  const calls: string[] = [], waits: number[] = [], emitted: string[] = []
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]), files: { path: string; bytes: number[]; flag: string }[] = []
  let currentUrl = 'http://127.0.0.1:12345/a'
  const bounds = { x: 1, y: 74, width: mode === 'zero' ? 0 : 738, height: 833 }
  const frame = { processId: 11, routingId: 22 }
  const wc = {
    id: 2, mainFrame: frame,
    isDestroyed: () => false, getURL: () => currentUrl, getOwnerBrowserWindow: (): object | null => mode === 'wrong-owner' ? null : window,
    isLoading: () => mode === 'loading', getBackgroundThrottling: () => true, getOSProcessId: () => 333,
    invalidate() { calls.push('invalidate'); if (mode === 'invalidate-throws') throw new Error('invalidate refused') },
    async capturePage() { calls.push('capturePage'); if (mode === 'capture-throws') throw new Error('surface still unavailable'); return { isEmpty: () => mode === 'empty-capture', getSize: () => ({ width: 1476, height: 1666 }), toPNG() { calls.push('same-image.toPNG'); return png } } }
  }
  const view = { webContents: wc, getVisible: () => mode !== 'hidden', getBounds: () => ({ ...bounds }) }
  const window = { id: 1, isDestroyed: () => false, contentView: { children: mode === 'duplicate' ? [view, view] : [view] },
    isVisible: () => true, isMinimized: () => mode === 'minimized', isFocused: () => false, getBounds: () => ({ x: 288, y: 131, width: 1480, height: 940 }) }
  const vm = createContext({ join, process: { pid: mode === 'wrong-pid' ? 999 : 123, env: {}, getBuiltinModule: (name: string) => {
    if (name === 'crypto') return { createHash }
    if (name === 'fs') return { writeFileSync(path: string, bytes: Uint8Array, options: { flag: string }) { files.push({ path, bytes: Array.from(bytes), flag: options.flag }) } }
    assert.equal(name, 'module'); return { createRequire: (path: string) => { assert.equal(path, '/private-probe/apps/desktop/package.json'); return (name: string) => { assert.equal(name, 'electron'); return { BrowserWindow: { getAllWindows: () => [window] } } } } }
  } }, setTimeout: (done: () => void, ms: number) => {
    waits.push(ms)
    if (mode === 'detached-after-wait') window.contentView.children = []
    if (mode === 'navigated-after-wait') currentUrl += '#new-navigation'
    if (mode === 'frame-changed-after-wait') frame.routingId++
    done()
  } })
  const observe = runInContext(`(${observeSource})`, vm)
  Object.assign(vm, { observeSingleNativePagePaint: observe })
  const diagnose = runInContext(`(${diagnoseSource})`, vm)
  const receipt: Record<string, any> = { visual: { nativeFramePreflight: { runs: [{ url: currentUrl, attempts: [{ frame: { error: 'surface unavailable' } }] }] } }, overlay: {} }
  if (ownedOutput) receipt.visual.captureDirectory = '/private-probe/fresh-visual'
  const ctx = { desktopRoot: '/private-probe/apps/desktop', pageUrl: currentUrl, receipt,
    probe: { child: { pid: 123 }, main: { async evaluate(expression: string) { new Function(expression); emitted.push(expression); return runInContext(expression, vm) } } },
    async nativeFrameReady() { calls.push('original-gate'); throw originalError }
  }
  Object.assign(vm, { owners: async () => [{ url: ctx.pageUrl, visible: true }], pageOwner: (_ctx: unknown, owners: unknown[]) => owners,
    chromeOwners: runInContext('() => []', vm), assert, diagnoseNativePagePaint: diagnose,
    pageInput: async () => { calls.push('pageInput'); return {} }, screenshotEditor: async () => { calls.push('screenshotEditor'); return {} } })
  const recover = runInContext(`(${recoverSource})`, vm)
  return { ctx, receipt, calls, waits, emitted, files, png, originalError, diagnose: () => diagnose(ctx, originalError),
    recover: (enabled: boolean) => { (vm.process as { env: Record<string, string> }).env = enabled ? { AGENTMUX_NATIVE_PAGE_PAINT_DIAGNOSTIC: '1' } : {}; return recover(ctx) } }
}

it('parses and executes every actual emitted Main expression, with one actuator and one capture on the exact attached owner', async () => {
  const f = fixture(); await f.diagnose()
  expect(f.calls).toEqual(['invalidate', 'capturePage'])
  expect(f.waits).toEqual([1500])
  expect(f.emitted).toHaveLength(1)
  const methods: string[] = []
  const file = ts.createSourceFile('actual-emitted.js', f.emitted[0], ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) methods.push(node.expression.name.text); ts.forEachChild(node, visit) }
  visit(file)
  expect(methods.filter(name => name === 'invalidate')).toEqual(['invalidate'])
  expect(methods.filter(name => name === 'capturePage')).toEqual(['capturePage'])
  expect(methods.filter(name => /^(focus|show|setSize|setBounds|setVisible|setBackgroundThrottling|loadURL|reload|sendInputEvent|beginFrameSubscription)$/.test(name))).toEqual([])
  const d = f.receipt.nativePagePaintDiagnostic
  expect(d.originalPreflight).toEqual({ url: f.ctx.pageUrl, attemptCount: 1, last: { frame: { error: 'surface unavailable' } } })
  expect(d.observation).toMatchObject({ diagnosticOnly: true, invalidateCalls: 1, captureCalls: 1, invalidateReturned: true,
    before: { pid: 123, ownerWindowId: 1, ownerMatches: true, attached: true, loading: false, visible: true, window: { focused: false } },
    afterWait: { ownerWindowId: 1, attached: true }, afterCapture: { ownerWindowId: 1, attached: true }, frame: { empty: false, size: { width: 1476, height: 1666 } } })
  expect(d.diagnosticError).toBeUndefined()
})

it('saves only the same nonempty captured image to the owned fresh directory with its exact hash, without another capture', async () => {
  const f = fixture('ready', true); await f.diagnose()
  expect(f.calls).toEqual(['invalidate', 'capturePage', 'same-image.toPNG']); expect(f.waits).toEqual([1500]); expect(f.emitted).toHaveLength(1)
  const file = '/private-probe/fresh-visual/restarted-native-page-paint-diagnostic.png'
  expect(f.files).toEqual([{ path: file, bytes: Array.from(f.png), flag: 'wx' }])
  expect(f.receipt.nativePagePaintDiagnostic.observation.frame).toEqual({ empty: false, size: { width: 1476, height: 1666 }, file, sha256: createHash('sha256').update(f.png).digest('hex') })
})

it('does not encode or save an empty captured image', async () => {
  const f = fixture('empty-capture', true); await f.diagnose()
  expect(f.calls).toEqual(['invalidate', 'capturePage']); expect(f.files).toEqual([])
  expect(f.receipt.nativePagePaintDiagnostic.observation.frame).toEqual({ empty: true, size: { width: 1476, height: 1666 } })
})

it.each(['wrong-pid', 'wrong-owner', 'duplicate', 'loading', 'hidden', 'zero', 'minimized'] as const)('skips %s before any actuator or capture', async mode => {
  const f = fixture(mode); await f.diagnose()
  expect(f.calls).toEqual([]); expect(f.waits).toEqual([])
  expect(f.emitted).toHaveLength(1)
  expect(f.receipt.nativePagePaintDiagnostic.observation).toMatchObject({ invalidateCalls: 0, captureCalls: 0, skipped: expect.any(String) })
})

it.each(['detached-after-wait', 'navigated-after-wait', 'frame-changed-after-wait'] as const)('does not capture a changed %s after the single invalidate', async mode => {
  const f = fixture(mode); await f.diagnose()
  expect(f.calls).toEqual(['invalidate']); expect(f.waits).toEqual([1500])
  expect(f.receipt.nativePagePaintDiagnostic.observation).toMatchObject({ invalidateCalls: 1, captureCalls: 0, skipped: 'page-owner-layout-or-frame-changed-after-invalidate' })
})

it('records an actuator failure without retry, wait or capture', async () => {
  const f = fixture('invalidate-throws'); await f.diagnose()
  expect(f.calls).toEqual(['invalidate']); expect(f.waits).toEqual([])
  expect(f.receipt.nativePagePaintDiagnostic.observation).toMatchObject({ invalidateCalls: 1, captureCalls: 0, invalidateError: 'Error: invalidate refused', afterInvalidate: { attached: true } })
})

it('leaves the default original recovery failure unchanged and issues no diagnostic action', async () => {
  const f = fixture(); await expect(f.recover(false)).rejects.toBe(f.originalError)
  expect(f.calls).toEqual(['original-gate']); expect(f.emitted).toEqual([]); expect(f.waits).toEqual([])
  expect(f.receipt.nativePagePaintDiagnostic).toBeUndefined()
  expect(f.receipt.overlay.unforcedRestoredFrame).toBeUndefined(); expect(f.receipt.overlay.complete).toBeUndefined()
})

it.each(['ready', 'capture-throws'] as const)('keeps the same original error after opt-in diagnostic %s and never reaches input or editor', async mode => {
  const f = fixture(mode); await expect(f.recover(true)).rejects.toBe(f.originalError)
  expect(f.calls).toEqual(['original-gate', 'invalidate', 'capturePage']); expect(f.waits).toEqual([1500])
  expect(f.receipt.nativePagePaintDiagnostic.originalError).toBe(String(f.originalError))
  expect(f.receipt.overlay.unforcedRestoredFrame).toBeUndefined(); expect(f.receipt.overlay.inputAfterRestart).toBeUndefined(); expect(f.receipt.overlay.complete).toBeUndefined()
})

it('preserves the original recovery error when the diagnostic Main transport fails', async () => {
  const f = fixture()
  f.ctx.probe.main.evaluate = async () => { throw new Error('Private diagnostic transport failed') }
  await expect(f.recover(true)).rejects.toBe(f.originalError)
  expect(f.calls).toEqual(['original-gate']); expect(f.waits).toEqual([]); expect(f.emitted).toEqual([])
  expect(f.receipt.nativePagePaintDiagnostic.diagnosticError).toBe('Error: Private diagnostic transport failed')
  expect(f.receipt.overlay.complete).toBeUndefined()
})

it('includes the actual outside diagnostic consumer and new script in canonical source identity', () => {
  expect(scenario).toContain("import { diagnoseNativePagePaint } from './browser-native-page-paint-diagnostic.mjs'")
  expect(recoverSource).toContain('await diagnoseNativePagePaint(ctx, error)')
  const identityStart = recovery.indexOf('async function identity()'), identityEnd = recovery.indexOf('\nasync function launch(', identityStart)
  expect(identityStart).toBeGreaterThan(-1); expect(identityEnd).toBeGreaterThan(identityStart)
  const identity = recovery.slice(identityStart, identityEnd)
  expect(identity).toContain("'apps/desktop/scripts/browser-native-page-paint-diagnostic.mjs'")
  expect(identity).toContain('digest(bytes)')
})
