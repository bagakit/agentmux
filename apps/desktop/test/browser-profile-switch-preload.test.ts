// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxPreloadApi, AgentMuxDesktopApi } from '../src/shared/contracts'
import { BROWSER_PROFILE_RESULT_METHODS, ipcResult, unwrapIpcResultMethods } from '../src/shared/ipc-result'
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (_key: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => '/private/synthetic-profile-switch' }, BrowserWindow: class {} }))
import '../src/preload/index'
import { BrowserViewManager } from '../src/main/browser-view-manager'
afterEach(() => vi.restoreAllMocks())

/** Execute the exact original callback from Main's registration through the real preload. */
function mainHandler(browsers: { switchProfile(id: string, profileId: string): Promise<unknown> }, ensureBrowser: (id: string) => Promise<void>) {
  const source = readFileSync(resolve('apps/desktop/src/main/ipc.ts'), 'utf8')
  const parsed = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true)
  const handlers: string[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'handleWithEvent' &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'browser:switchProfile') handlers.push(node.arguments[1]!.getText(parsed))
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  expect(handlers).toHaveLength(1)
  const compiled = ts.transpileModule(`const handler = ${handlers[0]};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function('ipcResult', 'ensureBrowser', 'browsers', `${compiled};return handler;`)(ipcResult, ensureBrowser, browsers) as (event: unknown, id: string, profileId: string) => Promise<unknown>
}
const renderer = () => unwrapIpcResultMethods(bridge.api!.browser as never, BROWSER_PROFILE_RESULT_METHODS) as AgentMuxDesktopApi['browser']
it('the original Main switch callback, actual preload and Renderer adapter preserve an exact successful Browser snapshot through the wire envelope', async () => {
  const snapshot = { id: 'original-browser', mode: 'normal', profileId: 'exact-target-profile', navigationId: 'actual-main-document' }
  const native = vi.fn(async () => snapshot), ensure = vi.fn(async () => {})
  const handler = mainHandler({ switchProfile: native }, ensure)
  let raw: unknown
  bridge.invoke.mockImplementationOnce(async (channel, id, profileId) => {
    expect(channel).toBe('browser:switchProfile')
    raw = structuredClone(await handler({}, id, profileId))
    return raw
  })
  expect(await renderer().switchProfile(snapshot.id, snapshot.profileId)).toEqual(snapshot)
  expect(raw).toEqual({ ok: true, value: snapshot })
  expect(ensure).toHaveBeenCalledExactlyOnceWith(snapshot.id)
  expect(native).toHaveBeenCalledExactlyOnceWith(snapshot.id, snapshot.profileId)
})
it('the real Main human-input guard code survives the original callback, structured wire copy, actual preload and Renderer adapter', async () => {
  // Exercise the original pre-commit BVM guard with its actual authority fields.
  // No native candidate, Session, task or user Browser is created by this fixture.
  const manager = Object.create(BrowserViewManager.prototype) as BrowserViewManager
  Object.assign(manager, { entries: new Map([['original-browser', { activity: { control: 'agent' }, humanControl: false }]]) })
  const ensure = vi.fn(async () => {}), handler = mainHandler(manager, ensure)
  let raw: unknown
  bridge.invoke.mockImplementationOnce(async (channel, id, profileId) => {
    expect(channel).toBe('browser:switchProfile')
    raw = structuredClone(await handler({}, id, profileId))
    return raw
  })
  await expect(renderer().switchProfile('original-browser', 'exact-target-profile')).rejects.toMatchObject({ code: 'BROWSER_AGENT_CONTROL_ACTIVE' })
  expect(raw).toMatchObject({ ok: false, error: { code: 'BROWSER_AGENT_CONTROL_ACTIVE' } })
  expect(ensure).toHaveBeenCalledExactlyOnceWith('original-browser')
})
