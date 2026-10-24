import { afterEach, expect, it, vi } from 'vitest'
import ts from 'typescript'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import mainSource from '../src/main/ipc.ts?raw'
import appSource from '../src/renderer/src/App.tsx?raw'

const bridge = vi.hoisted(() => {
  vi.stubGlobal('window', {})
  return { api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), listeners: new Map<string, Set<(...args: unknown[]) => void>>() }
})
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_key: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke,
    on: (channel: string, listener: (...args: unknown[]) => void) => { const set = bridge.listeners.get(channel) ?? new Set(); set.add(listener); bridge.listeners.set(channel, set) },
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => bridge.listeners.get(channel)?.delete(listener) },
  webFrame: { getZoomFactor: () => 1 }
}))
import '../src/preload/index'
import { registerScreenshotShortcut } from '../src/main/screenshot-shortcut'
import { SCREENSHOT_SHORTCUT_ACCELERATOR } from '../src/shared/screenshot-shortcut'
import { releaseScreenshotTarget, runScreenshotShortcut, selectScreenshotTarget } from '../src/renderer/src/lib/screenshot-shortcut-target'
import { assertSenderTrusted, senderTrust } from '../src/main/ipc-sender-trust'

const selected: Array<{ capture(): Promise<void> }> = []
afterEach(() => { for (const target of selected.splice(0)) releaseScreenshotTarget(target); bridge.listeners.clear(); bridge.invoke.mockReset() })
function nodes(source: string, name: string) {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, name.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const all: ts.Node[] = []
  function walk(node: ts.Node) { all.push(node); ts.forEachChild(node, walk) }
  walk(file)
  return { file, all }
}
const transpile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText

/** Execute the actual changed Main statements with Electron transport ports, not a handwritten route. */
function mainFixture() {
  const source = nodes(mainSource, 'ipc.ts')
  const registrations = source.all.filter((node): node is ts.VariableStatement => ts.isVariableStatement(node) && node.declarationList.declarations.some(item =>
    item.initializer && ts.isCallExpression(item.initializer) && item.initializer.expression.getText(source.file) === 'registerScreenshotShortcut'))
  expect(registrations).toHaveLength(1)
  const statusHandlers = source.all.filter((node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(source.file) === 'handleWithEvent' &&
    ts.isStringLiteral(node.arguments[0]!) && node.arguments[0]!.text === 'ui:screenshotShortcutStatus')
  expect(statusHandlers).toHaveLength(1)
  const disposals = source.all.filter((node): node is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(node) && node.properties.some(property =>
    ts.isPropertyAssignment(property) && property.name.getText(source.file) === 'owner' && ts.isStringLiteral(property.initializer) && property.initializer.text === 'screenshot-shortcut'))
  expect(disposals).toHaveLength(1)
  const register = vi.fn((_key: string, _callback: () => void) => true), unregister = vi.fn()
  const trusted = {}, handlers = new Map<string, (...args: any[]) => unknown>()
  let destroyed = false
  const send = vi.fn((channel: string, ...args: unknown[]) => { for (const listener of bridge.listeners.get(channel) ?? []) listener({}, ...args) })
  const code = transpile(registrations[0]!.getText(source.file) + '\n' + statusHandlers[0]!.getText(source.file))
  const original = new Function('registerScreenshotShortcut', 'process', 'globalShortcut', 'contents', 'handleWithEvent', 'requireTrustedSender',
    code + '\nreturn { owner: screenshotShortcut, disposeEntry: ' + transpile('(' + disposals[0]!.getText(source.file) + ')').replace(/;\s*$/, '') + ' }')(
    registerScreenshotShortcut, { platform: 'darwin' }, { register, unregister }, { isDestroyed: () => destroyed, send },
    (channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler),
    (channel: string, event: { sender: unknown }) => assertSenderTrusted(senderTrust(channel as never, event.sender, trusted))
  ) as { owner: ReturnType<typeof registerScreenshotShortcut>; disposeEntry: { dispose(): void } }
  bridge.invoke.mockImplementation((channel: string) => Promise.resolve(handlers.get(channel)!({ sender: trusted })))
  return { ...original, register, unregister, send, handlers, markDestroyed: () => { destroyed = true } }
}

/** Run the actual App effect; the rest of the App is outside this input transport slice. */
function listenFromApp(reportError: ReturnType<typeof vi.fn>, focus = vi.fn()) {
  const source = nodes(appSource, 'App.tsx')
  const effects = source.all.filter((node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(source.file) === 'useEffect' &&
    node.arguments[0]?.getText(source.file).includes('api.ui.onScreenshotShortcut'))
  expect(effects).toHaveLength(1)
  let dispose: (() => void) | undefined
  new Function('useEffect', 'api', 'runScreenshotShortcut', 'useAppStore', 'focusWorkbenchWindow', 'workbenchDocumentIdentity', 'document',
    transpile(effects[0]!.getText(source.file)))(
    (effect: () => (() => void)) => { dispose = effect() }, { ui: bridge.api!.ui }, runScreenshotShortcut,
    { getState: () => ({ reportError }) }, focus, () => ({ windowId: 'wrong-main', documentGeneration: 'wrong-generation' }), {}
  )
  return { dispose: () => dispose?.(), focus }
}

it('the original Main callback crosses actual preload and single App listener to the selected Composer exactly once', async () => {
  const main = mainFixture(), reportError = vi.fn(), app = listenFromApp(reportError)
  const original = { capture: vi.fn(async () => {}) }; selected.push(original); selectScreenshotTarget(original)
  expect(main.register).toHaveBeenCalledExactlyOnceWith(SCREENSHOT_SHORTCUT_ACCELERATOR, expect.any(Function))
  expect(bridge.listeners.get('ui:screenshotShortcut')?.size).toBe(1)
  main.register.mock.calls[0]![1]()
  await vi.waitFor(() => expect(original.capture).toHaveBeenCalledOnce())
  expect(main.send).toHaveBeenCalledExactlyOnceWith('ui:screenshotShortcut')
  expect(reportError).not.toHaveBeenCalled(); expect(app.focus).not.toHaveBeenCalled()
  expect(await bridge.api!.ui.screenshotShortcutStatus()).toMatchObject({ state: 'registered', accelerator: SCREENSHOT_SHORTCUT_ACCELERATOR })
  expect(() => main.handlers.get('ui:screenshotShortcutStatus')!({ sender: {} })).toThrow('Untrusted')
  app.dispose()
  expect(bridge.listeners.get('ui:screenshotShortcut')?.size).toBe(0)
  main.register.mock.calls[0]![1]()
  await Promise.resolve()
  expect(original.capture).toHaveBeenCalledOnce()
  main.disposeEntry.dispose()
  expect(main.unregister).toHaveBeenCalledExactlyOnceWith(SCREENSHOT_SHORTCUT_ACCELERATOR)
})

it('the original Main callback never sends to a destroyed Root Renderer', () => {
  const main = mainFixture()
  main.markDestroyed()
  main.register.mock.calls[0]![1]()
  expect(main.send).not.toHaveBeenCalled()
  main.disposeEntry.dispose()
})

it('the original App listener reports the same failure without a fallback focus or replay', async () => {
  const main = mainFixture(), reportError = vi.fn(), app = listenFromApp(reportError)
  const error = new Error('Original capture result is unknown')
  const original = { capture: vi.fn(async () => { throw error }) }; selected.push(original); selectScreenshotTarget(original)
  main.register.mock.calls[0]![1]()
  await vi.waitFor(() => expect(reportError).toHaveBeenCalledExactlyOnceWith(error))
  expect(original.capture).toHaveBeenCalledOnce(); expect(app.focus).not.toHaveBeenCalled()
  app.dispose(); main.disposeEntry.dispose()
})
