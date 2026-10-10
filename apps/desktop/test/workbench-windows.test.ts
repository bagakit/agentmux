import { fixtureFileUrl as _historyFixtureFileUrl } from "../../../test/fixture-values.mjs"
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { AppWindowOperation, AppWindowTarget } from '@agentmux/core/control'
vi.mock('electron', () => ({ Menu: {}, webContents: {} }))
import { WorkbenchWindows } from '../src/main/workbench-windows'
import { WorkbenchWindowStore } from '../src/main/workbench-window-store'
import { WORKBENCH_WINDOW_REQUEST } from '../src/shared/workbench-windows'

let nextId = 1
class Contents extends EventEmitter {
  url = _historyFixtureFileUrl("app/index.html")
  mainFrame = { url: this.url }
  isDestroyed = () => false
  getURL = () => this.url
  setBackgroundThrottling = () => {}
  setWindowOpenHandler = vi.fn()
  send = vi.fn()
}
class Window extends EventEmitter {
  id = nextId++
  webContents = new Contents()
  visible = true; focused = false; destroyed = false
  bounds = { x: 10, y: 20, width: 1000, height: 700 }
  isDestroyed = () => this.destroyed
  isVisible = () => this.visible
  isFocused = () => this.focused
  isMinimized = () => false
  isMaximized = () => false
  getBounds = () => ({ ...this.bounds })
  getNormalBounds = () => this.getBounds()
  getBackgroundColor = () => '#101216'
  focus = () => { this.focused = true }
  show = () => { this.visible = true }
  showInactive = () => { this.visible = true }
  hide = () => { this.visible = false }
  restore = () => {}
  maximize = () => {}
  destroy = () => { this.destroyed = true; this.emit('closed') }
  close = () => { let prevented = false; this.emit('close', { preventDefault: () => { prevented = true } }); if (!prevented) this.destroy() }
}
class Store extends WorkbenchWindowStore {
  journalFailure: 'none' | 'pending' | 'finished' = 'none'
  arrangementFailure = false
  override async saveOperation(operation: AppWindowOperation) {
    if (this.journalFailure === 'pending' || this.journalFailure === 'finished' && operation.state !== 'pending') throw new Error('receipt write unavailable')
    await super.saveOperation(operation)
  }
  override async save(state: Parameters<WorkbenchWindowStore['save']>[0]) { if (this.arrangementFailure) throw new Error('arrangement write unavailable'); await super.save(state) }
}
const target: AppWindowTarget = { kind: 'tab', displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab' }
const context = { actor: { kind: 'user' as const, id: 'desktop' } }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn() })
async function fixture(store?: Store) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-window-'))
  const persisted = store ?? new Store(join(directory, 'windows.json'))
  const main = new Window(), children: Window[] = [], tickets: Array<{ url: string; frameName: string }> = []
  const owner = new WorkbenchWindows(main as unknown as BrowserWindow, persisted, () => [{ x: 0, y: 0, width: 1800, height: 1100 }])
  owner.setNativeOwner({ beforeClosing: async () => {} })
  const outcomes: Array<'applied' | 'rejected' | 'unconfirmed'> = []
  const nativeReturns = vi.fn(async () => {})
  owner.setNativeOwner({ beforeClosing: nativeReturns })
  const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame } as never
  main.webContents.send.mockImplementation((channel: string, request: any) => {
    if (channel !== WORKBENCH_WINDOW_REQUEST) return
    queueMicrotask(() => {
      if (request.action === 'open') {
        const ticket = { url: request.url, frameName: request.frameName }; tickets.push(ticket)
        expect(owner.windowOpen(ticket as never, () => {})).toMatchObject({ action: 'allow' })
        expect(owner.windowOpen(ticket as never, () => {})).toMatchObject({ action: 'deny' })
        const child = new Window(); children.push(child); owner.createdWindow(child as unknown as BrowserWindow, ticket)
      }
      owner.accept(event, { requestId: request.requestId, windowId: request.windowId, documentGeneration: request.documentGeneration, outcome: request.action === 'return' ? outcomes.shift() ?? 'applied' : 'applied', message: null })
    })
  })
  await owner.rendererReady(event)
  cleanup.push(async () => { owner.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { owner, store: persisted, main, children, tickets, directory, outcomes, nativeReturns }
}
async function opened(f: Awaited<ReturnType<typeof fixture>>, operationId = 'open') {
  const page = await f.owner.call('app.window.open', { operationId, target }, context)
  expect(page.recordedOperation?.state).toBe('confirmed')
  return { windowId: page.recordedOperation!.windowId!, documentGeneration: page.recordedOperation!.documentGeneration! }
}

describe('original workface native presentation owner', () => {
  it('claims the original operation before disk I/O and refuses changed concurrent intent', async () => {
    const f = await fixture()
    const first = f.owner.call('app.window.open', { operationId: 'same', target }, context)
    await expect(f.owner.call('app.window.open', { operationId: 'same', target: { ...target, tabId: 'other' } }, context)).rejects.toThrow('claimed')
    expect((await first).recordedOperation?.state).toBe('confirmed')
    expect(f.children).toHaveLength(1)
    expect((await f.owner.call('app.window.open', { operationId: 'same', target }, context)).recordedOperation?.input).toEqual({ operationId: 'same', target })
    expect(f.children).toHaveLength(1)
  })
  it('does not start a native effect without its durable original operation intent', async () => {
    const f = await fixture(); f.store.journalFailure = 'pending'
    const page = await f.owner.call('app.window.open', { operationId: 'journal-unavailable', target }, context)
    expect(page.recordedOperation?.state).toBe('rejected'); expect(f.children).toHaveLength(0)
    expect((await f.owner.call('app.window.ls', { operationId: 'journal-unavailable' }, context)).recordedOperation).toEqual(page.recordedOperation)
  })
  it('retains known native facts when the finished receipt cannot be persisted', async () => {
    const f = await fixture(); f.store.journalFailure = 'finished'
    const identity = await opened(f, 'receipt-unconfirmed')
    const read = await f.owner.call('app.window.ls', { operationId: 'receipt-unconfirmed' }, context)
    expect(read.recordedOperation).toMatchObject({ state: 'confirmed', ...identity })
    expect(await f.store.operation('receipt-unconfirmed')).toMatchObject({ state: 'pending' })
    await f.owner.call('app.window.open', { operationId: 'receipt-unconfirmed', target }, context)
    expect(f.children).toHaveLength(1)
  })
  it('persists the closed arrangement before destroying a returned shell', async () => {
    const f = await fixture(), identity = await opened(f)
    f.store.arrangementFailure = true
    const failed = await f.owner.call('app.window.return', { operationId: 'return-unconfirmed', ...identity }, context)
    expect(failed.recordedOperation?.state).toBe('unknown'); expect(f.children[0]!.destroyed).toBe(false)
    expect((await f.store.load()).state.windows).toHaveLength(1)
    f.store.arrangementFailure = false
    const returned = await f.owner.call('app.window.return', { operationId: 'return-confirmed', ...identity }, context)
    expect(returned.recordedOperation?.state).toBe('confirmed'); expect(f.children[0]!.destroyed).toBe(true)
    expect((await f.store.load()).state.windows).toEqual([])
  })
  it('guards one-use shells, original overlap and exact native Browser scope', async () => {
    const f = await fixture(), identity = await opened(f)
    expect(f.owner.windowOpen(f.tickets[0] as never, () => {})).toEqual({ action: 'deny' })
    const overlap = await f.owner.call('app.window.open', { operationId: 'region', target: { ...target, kind: 'region', regionId: 'region' } }, context)
    expect(overlap.recordedOperation).toMatchObject({ state: 'rejected', ...identity }); expect(f.children).toHaveLength(1)
    const occurrence = { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' }
    expect(() => f.owner.presentationWindow(undefined, occurrence)).toThrow('stale')
    expect(f.owner.presentationWindow(identity, occurrence)).toBe(f.children[0])
    expect(() => f.owner.windowForDocument({ ...identity, documentGeneration: 'older' })).toThrow('current')
  })
  it.each(['navigation', 'crash'])('revokes a departed child document before any projection can reuse it: %s', async kind => {
    const f = await fixture(), identity = await opened(f)
    if (kind === 'navigation') { f.children[0]!.webContents.emit('did-finish-load'); f.children[0]!.webContents.emit('did-start-navigation', {}, new URL("?replacement", _historyFixtureFileUrl("app/workbench-window.html")).href, false, true) }
    else f.children[0]!.webContents.emit('render-process-gone')
    expect(() => f.owner.windowForDocument(identity)).toThrow('current')
    await vi.waitFor(() => expect(f.children[0]!.destroyed).toBe(true))
    const reopened = await f.owner.call('app.window.open', { operationId: 'reopen-original-shell', target }, context)
    expect(reopened.recordedOperation?.state).toBe('confirmed'); expect(reopened.recordedOperation?.windowId).toBe(identity.windowId)
    expect(reopened.recordedOperation?.documentGeneration).not.toBe(identity.documentGeneration)
    expect(f.children).toHaveLength(2)
  })
  it.each(['rejected', 'unconfirmed'] as const)('retains a departed original shell until its exact host return is confirmed: %s', async outcome => {
    const f = await fixture(), identity = await opened(f)
    f.outcomes.push(outcome)
    f.children[0]!.webContents.emit('render-process-gone')
    expect(() => f.owner.windowForDocument(identity)).toThrow('current')
    await vi.waitFor(() => expect(f.main.webContents.send.mock.calls.some(call => call[1]?.issue?.includes('old shell and original workface remain'))).toBe(true))
    expect(f.children[0]!.destroyed).toBe(false)
    expect(f.nativeReturns).not.toHaveBeenCalled()
    expect(() => f.owner.presentationWindow(undefined, { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' })).toThrow('stale')
    f.outcomes.push(outcome)
    const stillUnknown = await f.owner.call('app.window.open', { operationId: 'unconfirmed-original-return', target }, context)
    expect(stillUnknown.recordedOperation?.state).toBe('unknown')
    expect(f.children).toHaveLength(1); expect(f.children[0]!.destroyed).toBe(false)
    expect(f.nativeReturns).not.toHaveBeenCalled()
    f.outcomes.push(outcome)
    const retryUnknown = await f.owner.call('app.window.open', { operationId: 'unconfirmed-original-return', target }, context)
    expect(retryUnknown.recordedOperation?.state).toBe('unknown')
    expect(f.children).toHaveLength(1); expect(f.children[0]!.destroyed).toBe(false)
    expect(f.nativeReturns).not.toHaveBeenCalled()
    f.main.close(); expect(f.main.destroyed).toBe(false); expect(f.main.visible).toBe(false)
    const recovered = await f.owner.call('app.window.open', { operationId: 'recover-original-return', target }, context)
    expect(recovered.recordedOperation?.state).toBe('confirmed')
    expect(recovered.recordedOperation?.windowId).toBe(identity.windowId)
    expect(recovered.recordedOperation?.documentGeneration).not.toBe(identity.documentGeneration)
    expect(f.nativeReturns).toHaveBeenCalledExactlyOnceWith(f.children[0])
    expect(f.children[0]!.destroyed).toBe(true); expect(f.children).toHaveLength(2)
  })
  it('reveals the original Main when the last visible child returns after document departure', async () => {
    const f = await fixture(); await opened(f)
    f.main.close(); expect(f.main.visible).toBe(false); expect(f.main.destroyed).toBe(false)
    f.children[0]!.webContents.emit('render-process-gone')
    await vi.waitFor(() => expect(f.children[0]!.destroyed).toBe(true))
    expect(f.main.visible).toBe(true); expect(f.main.destroyed).toBe(false)
  })
  it('restores original window and target identities with a new native document', async () => {
    const f = await fixture(), identity = await opened(f)
    f.children[0]!.bounds = { x: 120, y: 70, width: 800, height: 600 }
    await f.owner.prepareQuit(); f.owner.dispose()
    const next = await fixture(f.store)
    await vi.waitFor(() => expect(next.children).toHaveLength(1))
    const page = await next.owner.call('app.window.ls', {}, context)
    const restored = page.windows.find(window => window.windowId === identity.windowId)!
    expect(restored.target).toEqual(target); expect(restored.documentGeneration).not.toBe(identity.documentGeneration)
    expect(JSON.parse(await readFile(join(f.directory, 'windows.json'), 'utf8')).windows[0].geometry).toMatchObject({ width: 800, height: 600 })
  })
})
