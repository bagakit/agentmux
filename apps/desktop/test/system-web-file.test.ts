import { agentMuxControlTimeoutMs } from '@agentmux/core/control'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { WebFileIngress, registerSystemWebFileEvents } from '../src/main/web-file-ingress'
import { WebUrlIngress } from '../src/main/web-url-ingress'
import { SpatialLinkIngress } from '../src/main/spatial-link-ingress'
import { DesktopControlIpcBridge } from '../src/main/control-ipc-bridge'
import { openSystemFileInSurvey } from '../src/renderer/src/lib/survey-system-file'
import { openSystemUrlInSurvey } from '../src/renderer/src/lib/survey-system-url'
import { createSurveyBrowser } from '../src/renderer/src/lib/survey-browser-creation'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { isSystemWebFilePath } from '../src/shared/system-web-file'
import type { DesktopControlRequest } from '../src/shared/contracts'

// Execute exact production call sites without booting Runtime/Config or a user App.
// These are behavior consumers, not textual-presence assertions; removing a call
// leaves the original event/IPC/control action unconsumed and fails below.
function source(path: string) {
  const original = readFileSync(resolve(path), 'utf8')
  const value = process.env.AGENTMUX_BROWSER_SOURCE_ROOT ? readFileSync(resolve(process.env.AGENTMUX_BROWSER_SOURCE_ROOT, path), 'utf8') : original
  const log = process.env.AGENTMUX_BROWSER_LOADED_LOG
  if (log) appendFileSync(log, JSON.stringify({ file: path, original: createHash('sha256').update(original).digest('hex'), loaded: createHash('sha256').update(value).digest('hex') }) + '\n')
  return ts.createSourceFile(path, value, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
}
function nodes(root: ts.Node, matches: (node: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = []; const walk = (node: ts.Node) => { if (matches(node)) result.push(node); node.forEachChild(walk) }; walk(root); return result
}
function evaluate(code: string, bindings: Record<string, unknown>) {
  const js = ts.transpile(code, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None })
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}
function callArgument(root: ts.SourceFile, receiver: string, argument: number): string {
  const calls = nodes(root, node => ts.isCallExpression(node) && node.expression.getText(root) === receiver) as ts.CallExpression[]
  if (calls.length !== 1) throw new Error(`Expected original single ${receiver} owner`)
  return calls[0]!.arguments[argument]!.getText(root)
}
const roots: string[] = [], bridges: DesktopControlIpcBridge[] = []
afterEach(async () => { for (const bridge of bridges.splice(0)) bridge.dispose(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function webpage(extension = '.html') {
  const root = await mkdtemp(join(tmpdir(), 'amux-os-webfile-')); roots.push(root)
  const path = join(root, `原始 page # 100%${extension}`); await writeFile(path, '<!doctype html><title>Exact original file</title><p>Original webpage bytes</p>'); return path
}
function fixture() {
  const listeners = new Set<() => void>(), original = { kind: 'file', path: '/original/draft.txt', draft: 'Keep original draft' }
  const state: any = {
    config: { workspaces: [{ id: SCRATCH_WORKSPACE_ID }] }, layouts: { [SCRATCH_WORKSPACE_ID]: { activeGroupId: 'scratch-group' } }, tabs: { original: { regions: { original } } },
    mainSurface: 'recall', recallNotebookId: 'original-book', recallNoteId: 'original-note', recallZoneSelection: null, surveyZoneSelection: null,
    createWorkbenchZone: vi.fn(async () => ({ zone: { workspaceId: SCRATCH_WORKSPACE_ID, zoneId: 'exact-zone' } })), setSurveyZoneCollected: vi.fn(() => true),
    openLauncher: vi.fn(() => { state.tabs['new-tab'] = { id: 'new-tab', space: { zoneId: 'exact-zone' }, layout: { activeRegionId: 'new-region' }, regions: { 'new-region': { kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'new-region' } } }; return 'new-tab' }),
    createBrowser: vi.fn(async (_group: string, location: { tabId: string; regionId: string }, url: string, _bookmark: unknown, workspaceId: string) => {
      state.tabs[location.tabId].regions[location.regionId] = { kind: 'browser', browserId: location.regionId, url, workspaceId, profileId: 'original-profile' }
    }),
    setSurveyZoneSelection: vi.fn(value => { state.surveyZoneSelection = value }), setMainSurface: vi.fn(value => { state.mainSurface = value })
  }
  const get = () => state
  state.createSurveyBrowser = (input: Parameters<typeof createSurveyBrowser>[1]) => createSurveyBrowser(get, input)
  const store = source('apps/desktop/src/renderer/src/store.ts')
  const nav = (store.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'fileNavigationSelection'))!
  const dispatch = evaluate(`const fileNavigationSelection = ${nav.getText(store).replace(/^export /u, '') .replace(/^function fileNavigationSelection/u, 'function')}; return ${callArgument(store, 'api.control.onRequest', 0)}`, {
    get, openSystemFileInSurvey, openSystemUrlInSurvey, useAppStore: { subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } }
  }) as (request: DesktopControlRequest, signal: AbortSignal) => Promise<any>
  const app = Object.assign(new EventEmitter(), { whenReady: () => new Promise(() => {}), isPackaged: false })
  const main = source('apps/desktop/src/main/index.ts')
  const start = main.statements.filter(ts.isFunctionDeclaration).find(node => node.name?.text === 'startPrimaryInstance')!
  const registration = start.body!.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(main) === 'registerSystemWebFileEvents')
  const files = evaluate(`${start.body!.statements[0]!.getText(main)}; ${registration?.getText(main) ?? ''}; return webFiles`, {
    SpatialLinkIngress, WebUrlIngress, WebFileIngress, registerSystemWebFileEvents, app, workbenchWindow: undefined, createWindow: vi.fn()
  }) as WebFileIngress
  const issues: string[] = [], replies: unknown[] = []
  const bridge = new DesktopControlIpcBridge({ isAvailable: () => true, sendCancellation: vi.fn(), sendRequest: request => {
    void dispatch(request, new AbortController().signal).then(result => { replies.push(result); bridge.accept({ requestId: request.requestId, ok: true, result }) })
  } }); bridges.push(bridge)
  const ipc = source('apps/desktop/src/main/ipc.ts')
  const readyCalls = nodes(ipc, node => ts.isCallExpression(node) && node.expression.getText(ipc) === 'handleWithEvent' && node.arguments[0]?.getText(ipc) === "'ui:spatialLinksReady'") as ts.CallExpression[]
  if (readyCalls.length !== 1) throw new Error('Original trusted readiness owner missing')
  const ready = evaluate(`return ${readyCalls[0]!.arguments[1]!.getText(ipc)}`, { args: { webFiles: files }, controlBridge: bridge, contents: { send: (_channel: string, message: string) => issues.push(message) } }) as (event: object) => void
  return { state, original, listeners, files, app, issues, replies, ready }
}
async function until(read: () => boolean) { await vi.waitFor(() => expect(read()).toBe(true), { timeout: 3000, interval: 10 }) }

it.each(['.html', '.xhtml'])('original Main open-file → trusted readiness → bridge → Store → original Survey consumer opens exact %s', async extension => {
  const path = await webpage(extension), f = fixture(), event = { preventDefault: vi.fn() }
  f.app.emit('open-file', event, path)
  expect(event.preventDefault).toHaveBeenCalledTimes(1); expect(f.state.createBrowser).not.toHaveBeenCalled()
  f.ready({}); await until(() => f.replies.length === 1)
  expect(f.replies[0]).toMatchObject({ operation: 'browser.openFileFromSystem', state: 'opened', reference: { tabId: 'new-tab', regionId: 'new-region' } })
  expect(f.state.createBrowser).toHaveBeenCalledExactlyOnceWith('scratch-group', { tabId: 'new-tab', regionId: 'new-region' }, pathToFileURL(path).href, undefined, SCRATCH_WORKSPACE_ID, undefined, 'normal')
  expect(f.state.mainSurface).toBe('survey'); expect(f.state.tabs.original.regions.original).toBe(f.original); expect(f.original.draft).toBe('Keep original draft')
  f.ready({}); await new Promise(resolve => setTimeout(resolve, 20)); expect(f.state.createBrowser).toHaveBeenCalledTimes(1); expect(f.issues).toEqual([])
})
it('ready OS file input is consumed; missing file and unsupported inputs preserve original work and exact failures', async () => {
  const path = await webpage(), f = fixture(); f.ready({})
  const missing = path.replace('.html', '-missing.xhtml'); f.app.emit('open-file', { preventDefault() {} }, missing)
  await until(() => f.issues.length > 0); expect(f.issues.join('\n')).toContain(pathToFileURL(missing).href); expect(f.state.createBrowser).not.toHaveBeenCalled()
  for (const input of ['--inspect=0', 'relative.html', path.replace('.html', '.js'), pathToFileURL(path).href]) f.app.emit('open-file', { preventDefault() {} }, input)
  await until(() => f.issues.length === 5); expect(f.state.createBrowser).not.toHaveBeenCalled()
  f.app.emit('open-file', { preventDefault() {} }, path); await until(() => f.replies.length === 1)
  expect(f.state.tabs.original.regions.original).toBe(f.original); expect(f.original.draft).toBe('Keep original draft')
})
it('interrupted dispatched file is not replayed while the next original file remains consumable', async () => {
  const first = await webpage(), second = await webpage('.xhtml'), files = new WebFileIngress(), seen: string[] = [], issues: string[] = []
  files.ready(async (request, signal) => { seen.push(request.path); await new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true })); throw new Error('Original observation cancelled') }, message => issues.push(message))
  files.receive(first); files.receive(second); await until(() => seen.length === 1); files.unavailable()
  files.ready(async request => { seen.push(request.path); return { operation: request.operation, requestId: request.requestId, state: 'unconfirmed', browserId: null, reference: null, message: 'Original Browser unavailable' } }, message => issues.push(message))
  await until(() => seen.length === 2); expect(seen).toEqual([first, second]); expect(issues.join('\n')).toContain(pathToFileURL(first).href)
})
it('invalid file control never becomes a Browser request and HTTP(S) ingress stays exclusive', async () => {
  const path = await webpage(), f = fixture()
  await expect(openSystemFileInSurvey({ get: () => f.state, navigation: () => '', subscribe: () => () => {} }, { operation: 'browser.openFileFromSystem', schemaVersion: 1, requestId: 'exact', path, url: 'https://wrong.example/' } as never, new AbortController().signal)).rejects.toThrow('invalid')
  const web = new WebUrlIngress(), report = vi.fn(), execute = vi.fn(); web.ready(execute, report); web.receive(pathToFileURL(path).href)
  await until(() => report.mock.calls.length === 1); expect(execute).not.toHaveBeenCalled(); expect(f.state.createBrowser).not.toHaveBeenCalled()
  expect(isSystemWebFilePath(path)).toBe(true)
})

it('file preparation failure retains its exact page and later user navigation is not stolen', async () => {
  const path = await webpage(), f = fixture(); f.state.createBrowser.mockRejectedValueOnce(new Error('Original Browser file read failed'))
  f.ready({}); f.app.emit('open-file', { preventDefault() {} }, path); await until(() => f.replies.length === 1)
  expect(f.replies[0]).toMatchObject({ state: 'unconfirmed', reference: { tabId: 'new-tab', regionId: 'new-region' }, message: expect.stringContaining('Original Browser file read failed') })
  expect(f.issues.join('\n')).toContain('amux://region/new-region'); expect(f.state.tabs.original.regions.original).toBe(f.original)
  const second = fixture(); let finish!: () => void
  const attach = second.state.createBrowser.getMockImplementation()!
  second.state.createBrowser.mockImplementationOnce(async (...args: unknown[]) => { await new Promise<void>(resolve => { finish = resolve }); await attach(...args) })
  second.ready({}); second.app.emit('open-file', { preventDefault() {} }, path); await until(() => !!finish)
  second.state.recallNoteId = 'later-user-reading'; for (const listener of second.listeners) listener(); finish()
  await until(() => second.replies.length === 1)
  expect(second.state.setMainSurface).not.toHaveBeenCalled(); expect(second.state.recallNoteId).toBe('later-user-reading'); expect(second.state.tabs.original.regions.original).toBe(second.original)
})
it('file bridge waits the original Browser budget and cancels only that observation', async () => {
  vi.useFakeTimers()
  const sendCancellation = vi.fn(), bridge = new DesktopControlIpcBridge({ isAvailable: () => true, sendRequest: vi.fn(), sendCancellation })
  try {
    let settled = false
    const pending = bridge.execute({ operation: 'browser.openFileFromSystem', requestId: 'original-file-wait', schemaVersion: 1, path: '/original/page.html', url: 'file:///original/page.html' } as never)
      .then(() => { settled = true; return null }, error => { settled = true; return error })
    await vi.advanceTimersByTimeAsync(agentMuxControlTimeoutMs('open.browser') - 1); expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1); expect(await pending).toMatchObject({ code: 'CONTROL_TIMEOUT' }); expect(sendCancellation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: 'original-file-wait' }))
  } finally { bridge.dispose(); vi.useRealTimers() }
})

function rendererReadinessFixture() {
  const main = source('apps/desktop/src/main/index.ts'), ipc = source('apps/desktop/src/main/ipc.ts')
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() })
  const window = { webContents: contents, isDestroyed: () => false }
  const webLinks = new WebUrlIngress(), webFiles = new WebFileIngress(), spatialLinks = new SpatialLinkIngress()
  const spatialUnavailable = vi.spyOn(spatialLinks, 'unavailable')
  const listeners = nodes(main, node => ts.isCallExpression(node) && node.expression.getText(main) === 'window.webContents.on' &&
    node.arguments[0]?.getText(main) === "'render-process-gone'")
  const selectWindow = evaluate(`${listeners.map(node => node.getText(main) + ';').join('\n')} return next => { workbenchWindow = next }`, {
    window, workbenchWindow: window, webLinks, webFiles, spatialLinks
  }) as (next: unknown) => void
  const sent: DesktopControlRequest[] = [], cancelled = vi.fn()
  const bridge = new DesktopControlIpcBridge({ isAvailable: () => !contents.isDestroyed(),
    sendRequest: request => { sent.push(request) }, sendCancellation: cancelled })
  bridges.push(bridge)
  // The real IPC owner subscribes after the Main window readiness listeners.
  contents.on('render-process-gone', () => bridge.dispose())
  const readyCalls = nodes(ipc, node => ts.isCallExpression(node) && node.expression.getText(ipc) === 'handleWithEvent' &&
    node.arguments[0]?.getText(ipc) === "'ui:spatialLinksReady'") as ts.CallExpression[]
  if (readyCalls.length !== 1) throw new Error('Original trusted readiness owner missing')
  const trusted = vi.fn()
  const ready = evaluate(`return ${readyCalls[0]!.arguments[1]!.getText(ipc)}`, {
    args: { webLinks, webFiles }, controlBridge: bridge, contents
  }) as (event: object) => void
  const crash = () => contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 7 })
  const complete = (request: DesktopControlRequest) => bridge.accept({ requestId: request.requestId, ok: true,
    result: { operation: request.operation, requestId: request.requestId, state: 'opened', browserId: 'exact-browser',
      reference: { displayWorkspaceId: 'scratch', groupId: 'group', tabId: 'tab', regionId: 'region' } } as never })
  return { webLinks, webFiles, contents, sent, cancelled, trusted, ready, crash, complete, spatialUnavailable, selectWindow }
}

it('crashed Renderer keeps new URL and file intents queued until original trusted readiness returns', async () => {
  const f = rendererReadinessFixture(), path = await webpage()
  f.ready({}); f.crash()
  expect(f.contents.isDestroyed()).toBe(false)
  f.webLinks.receive('https://example.org/after-crash'); f.webFiles.receive(path)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(f.sent).toEqual([])
  expect(f.spatialUnavailable).toHaveBeenCalledOnce()
  f.ready({}); await until(() => f.sent.length === 2)
  expect(f.sent.map(request => request.operation).sort()).toEqual(['browser.openFileFromSystem', 'browser.openFromSystem'])
  expect(f.sent.map(request => (request as { url: string }).url).sort()).toEqual([pathToFileURL(path).href, 'https://example.org/after-crash'].sort())
  f.sent.forEach(f.complete); f.ready({})
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(f.sent).toHaveLength(2)
})

it('crashed Renderer preserves the next undispatched page and never replays its original in-flight page', async () => {
  const f = rendererReadinessFixture()
  f.ready({}); f.webLinks.receive('https://example.org/original-in-flight')
  await until(() => f.sent.length === 1)
  const original = f.sent[0]!
  f.webLinks.receive('https://example.org/original-next'); f.crash()
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(f.sent).toHaveLength(1)
  expect(f.cancelled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: original.requestId, code: 'CONTROL_UNAVAILABLE' }))
  f.ready({}); await until(() => f.sent.length === 2)
  expect((f.sent[1] as { url: string }).url).toBe('https://example.org/original-next')
  expect(f.sent[1]!.requestId).not.toBe(original.requestId)
  f.complete(f.sent[1]!); f.ready({})
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(f.sent).toHaveLength(2)
  expect(f.contents.send.mock.calls.map(call => String(call[1])).join('\n')).toContain(original.requestId)
})

it('a retired window crash leaves the current window ingress executor available', async () => {
  const f = rendererReadinessFixture(), received: string[] = []
  f.selectWindow({ webContents: { isDestroyed: () => false } })
  f.webLinks.ready(async request => { received.push(request.url); return { operation: request.operation, requestId: request.requestId,
    state: 'opened', browserId: 'current-browser', reference: { displayWorkspaceId: 'scratch', groupId: 'group', tabId: 'current-tab', regionId: 'current-region' } } }, () => {})
  f.crash(); f.webLinks.receive('https://example.org/current-window')
  await until(() => received.length === 1)
  expect(f.spatialUnavailable).not.toHaveBeenCalled()
  expect(received).toEqual(['https://example.org/current-window'])
})
