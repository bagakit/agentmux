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
import { WORKBENCH_WINDOW_REQUEST, WORKBENCH_WINDOW_CHANGED, type WorkbenchWindowSnapshot } from '../src/shared/workbench-windows'

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
  const admissions: Array<{ first: ReturnType<WorkbenchWindows['windowOpen']>; repeated: ReturnType<WorkbenchWindows['windowOpen']> }> = []
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
        admissions.push({ first: owner.windowOpen(ticket as never, () => {}), repeated: owner.windowOpen(ticket as never, () => {}) })
        const child = new Window(); children.push(child); owner.createdWindow(child as unknown as BrowserWindow, ticket)
      }
      owner.accept(event, { requestId: request.requestId, windowId: request.windowId, documentGeneration: request.documentGeneration, outcome: request.action === 'return' ? outcomes.shift() ?? 'applied' : 'applied', message: null })
    })
  })
  await owner.rendererReady(event)
  cleanup.push(async () => { owner.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { owner, store: persisted, main, children, tickets, admissions, directory, outcomes, nativeReturns }
}
async function opened(f: Awaited<ReturnType<typeof fixture>>, operationId = 'open') {
  const page = await f.owner.call('app.window.open', { operationId, target }, context)
  expect(page.recordedOperation?.state).toBe('confirmed')
  expect(page.recordedOperation?.windowId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
  expect(page.recordedOperation?.documentGeneration).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/)
  const ticket = f.tickets.at(-1)!
  expect(new URL(ticket.url).searchParams.get('ticket')).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  expect(ticket.frameName).toMatch(/^workbench-window-[1-9A-HJ-NP-Za-km-z]{32,44}$/)
  return { windowId: page.recordedOperation!.windowId!, documentGeneration: page.recordedOperation!.documentGeneration! }
}
function snapshot(f: Awaited<ReturnType<typeof fixture>>): WorkbenchWindowSnapshot {
  const call = f.main.webContents.send.mock.calls.filter(([channel]) => channel === WORKBENCH_WINDOW_CHANGED).at(-1)
  expect(call).toBeDefined()
  return call![1] as WorkbenchWindowSnapshot
}

describe('original workface native presentation owner', () => {
  it('shows new and existing background shells without changing native input focus; explicit focus remains available', async () => {
    const f = await fixture(); f.main.focused = true
    const input = { operationId: 'background-shell', target, focus: false }
    const page = await f.owner.call('app.window.open', input, context)
    const child = f.children[0]!
    expect(page.recordedOperation).toMatchObject({ state: 'confirmed', input })
    expect(child.visible).toBe(true); expect(child.focused).toBe(false); expect(f.main.focused).toBe(true)
    await f.owner.call('app.window.open', { ...input, operationId: 'same-background-shell' }, context)
    expect(f.children).toHaveLength(1); expect(child.focused).toBe(false)
    await expect(f.owner.call('app.window.open', { ...input, focus: true }, context)).rejects.toThrow('another original window intent')
    await f.owner.call('app.window.focus', { operationId: 'focus-background-shell', windowId: page.recordedOperation!.windowId!,
      documentGeneration: page.recordedOperation!.documentGeneration! }, context)
    expect(child.focused).toBe(true)
    const foreground = await f.owner.call('app.window.open', { operationId: 'explicit-open', target: { ...target, tabId: 'other-tab' } }, context)
    expect(foreground.recordedOperation?.state).toBe('confirmed'); expect(f.children[1]!.focused).toBe(true)
  })
  it('restores durable shells without acquiring focus from the current window', async () => {
    const previous = await fixture(); await opened(previous)
    const restored = await fixture(previous.store)
    await vi.waitFor(() => expect(restored.children).toHaveLength(1))
    await vi.waitFor(async () => expect((await restored.owner.call('app.window.ls', {}, context)).windows.find(window => window.target)?.presentation).toBe('visible'))
    expect(restored.children[0]!.visible).toBe(true); expect(restored.children[0]!.focused).toBe(false)
  })
  it('a late placement confirmation shows the original background shell without taking focus', async () => {
    const f = await fixture(), accept = f.owner.accept.bind(f.owner)
    let delayed: Parameters<WorkbenchWindows['accept']> | undefined
    vi.spyOn(f.owner, 'accept').mockImplementation((event, response) => {
      const request = f.main.webContents.send.mock.calls.find(([channel, value]) => channel === WORKBENCH_WINDOW_REQUEST && value.requestId === response.requestId)?.[1]
      if (request?.action === 'open') delayed = [event, response]
      else accept(event, response)
    })
    vi.useFakeTimers()
    try {
      const opening = f.owner.call('app.window.open', { operationId: 'late-background', target, focus: false }, context)
      await vi.waitFor(() => expect(delayed).toBeDefined())
      await vi.advanceTimersByTimeAsync(15_000)
      expect((await opening).recordedOperation?.state).toBe('unknown')
    }
    finally { vi.useRealTimers() }
    f.main.focused = true
    accept(...delayed!)
    await vi.waitFor(async () => expect((await f.owner.call('app.window.ls', { operationId: 'late-background' }, context)).recordedOperation?.state).toBe('confirmed'))
    expect(f.children).toHaveLength(1); expect(f.children[0]!.visible).toBe(true)
    expect(f.children[0]!.focused).toBe(false); expect(f.main.focused).toBe(true)
  })
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
  it.each([
    { label: 'the same Region', first: { ...target, kind: 'region', regionId: 'region' }, second: { ...target, kind: 'region', regionId: 'region' } },
    { label: 'a Tab followed by its Region', first: target, second: { ...target, kind: 'region', regionId: 'region' } },
    { label: 'a Region followed by its Tab', first: { ...target, kind: 'region', regionId: 'region' }, second: target }
  ] as const)('keeps one native owner when distinct operations concurrently open $label', async ({ first, second }) => {
    const f = await fixture(), sizes: Array<(value: { width: number; height: number }) => void> = []
    f.owner.setNativeOwner({ beforeClosing: f.nativeReturns, windowSize: () => new Promise(resolve => sizes.push(resolve)) })
    const firstOpen = f.owner.call('app.window.open', { operationId: 'first-concurrent-open', target: first }, context)
    const secondOpen = f.owner.call('app.window.open', { operationId: 'second-concurrent-open', target: second }, context)
    await vi.waitFor(() => expect(sizes).toHaveLength(2))
    for (const finish of sizes) finish({ width: 840, height: 620 })
    const [one, two] = await Promise.all([firstOpen, secondOpen])
    // Disk intent persistence can admit either call first. Both must address
    // the same owner; overlap never grants a second native reservation.
    expect([one, two].some(page => page.recordedOperation?.state === 'confirmed')).toBe(true)
    expect(two.recordedOperation?.windowId).toBe(one.recordedOperation?.windowId)
    expect(f.children).toHaveLength(1)
    expect(f.tickets).toHaveLength(1)
    expect((await f.owner.call('app.window.ls', {}, context)).windows.filter(window => window.target)).toHaveLength(1)
    expect((await f.store.load()).state.windows).toHaveLength(1)
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
  it('returns a whole Tab without letting one contained native child own its Close', async () => {
    const f = await fixture(); await opened(f)
    const requestClose = vi.fn(() => true)
    f.owner.setNativeOwner({ beforeClosing: f.nativeReturns, requestClose })
    f.children[0]!.close()
    await vi.waitFor(() => expect(f.children[0]!.destroyed).toBe(true))
    expect(requestClose).not.toHaveBeenCalled()
    expect(f.nativeReturns).toHaveBeenCalledOnce()
  })
  it('lets the original native child own Close of its exact Region shell', async () => {
    const f = await fixture()
    const requestClose = vi.fn(() => true)
    f.owner.setNativeOwner({ beforeClosing: f.nativeReturns, requestClose })
    const page = await f.owner.call('app.window.open', { operationId: 'native-child-region',
      target: { ...target, kind: 'region', regionId: 'native-child' } }, context)
    expect(page.recordedOperation?.state).toBe('confirmed')
    f.children[0]!.close()
    expect(requestClose).toHaveBeenCalledExactlyOnceWith(f.children[0])
    expect(f.children[0]!.destroyed).toBe(false)
    expect(f.nativeReturns).not.toHaveBeenCalled()
  })
  it('guards one-use shells, original overlap and exact native Browser scope', async () => {
    const f = await fixture(), identity = await opened(f)
    expect(f.admissions).toMatchObject([{ first: { action: 'allow' }, repeated: { action: 'deny' } }])
    expect(f.owner.windowOpen(f.tickets[0] as never, () => {})).toEqual({ action: 'deny' })
    const overlap = await f.owner.call('app.window.open', { operationId: 'region', target: { ...target, kind: 'region', regionId: 'region' } }, context)
    expect(overlap.recordedOperation).toMatchObject({ state: 'rejected', ...identity }); expect(f.children).toHaveLength(1)
    const occurrence = { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId: 'region' }
    expect(() => f.owner.presentationWindow(undefined, occurrence)).toThrow('stale')
    expect(f.owner.presentationWindow(identity, occurrence)).toBe(f.children[0])
    expect(() => f.owner.windowForDocument({ ...identity, documentGeneration: 'older' })).toThrow('current')
  })
  it.each(['document action', 'native event'])('clears only the exact recovered native focus issue through its %s', async recovery => {
    const f = await fixture(), identity = await opened(f), native = f.children[0]!
    native.focused = false; native.focus = () => {}
    expect(f.owner.focusDocument(identity)).toBe(false)
    const issue = snapshot(f).issue
    expect(issue).not.toBeNull()
    f.main.focused = true; f.main.emit('focus')
    expect(snapshot(f).issue).toBe(issue)
    native.emit('focus')
    expect(snapshot(f).issue).toBe(issue)
    native.focus = () => { native.focused = true }
    if (recovery === 'document action') expect(f.owner.focusDocument(identity)).toBe(true)
    else { native.focused = true; native.emit('focus') }
    expect(snapshot(f).windows.find(window => window.windowId === identity.windowId)?.focused).toBe(true)
    expect(snapshot(f).issue).toBeNull()
  })
  it('retains an unrelated receipt warning when the original document focus recovers', async () => {
    const f = await fixture(), identity = await opened(f), native = f.children[0]!
    native.focused = false; native.focus = () => {}
    expect(f.owner.focusDocument(identity)).toBe(false)
    f.store.journalFailure = 'pending'
    await f.owner.call('app.window.open', { operationId: 'unpersisted-other-window', target: { ...target, tabId: 'other-tab' } }, context)
    const issue = snapshot(f).issue
    expect(issue).toContain('persistence is unconfirmed')
    native.focused = true; native.emit('focus')
    expect(f.owner.focusDocument(identity)).toBe(true)
    expect(snapshot(f).issue).toBe(issue)
    f.store.journalFailure = 'none'
    expect((await f.owner.call('app.window.return', { operationId: 'return-with-original-receipt-warning', ...identity }, context)).recordedOperation?.state).toBe('confirmed')
    expect(snapshot(f).issue).toBe(issue)
  })
  it('retires only the exact focus cause after its original window has returned', async () => {
    const f = await fixture(), identity = await opened(f), native = f.children[0]!
    native.focused = false; native.focus = () => {}
    expect(f.owner.focusDocument(identity)).toBe(false)
    expect(snapshot(f).issue).not.toBeNull()
    const returned = await f.owner.call('app.window.return', { operationId: 'return-original-focus-cause', ...identity }, context)
    expect(returned.recordedOperation?.state).toBe('confirmed')
    expect(native.destroyed).toBe(true)
    expect(snapshot(f).windows.some(window => window.windowId === identity.windowId)).toBe(false)
    expect(snapshot(f).issue).toBeNull()
  })
  it('retains another original window focus cause when an unrelated window returns', async () => {
    const f = await fixture(), first = await opened(f)
    const other = await f.owner.call('app.window.open', { operationId: 'another-original-window', target: { ...target, tabId: 'other-tab' } }, context)
    const identity = { windowId: other.recordedOperation!.windowId!, documentGeneration: other.recordedOperation!.documentGeneration! }, native = f.children[1]!
    native.focused = false; native.focus = () => {}
    expect(f.owner.focusDocument(identity)).toBe(false)
    const issue = snapshot(f).issue
    expect(issue).not.toBeNull()
    expect((await f.owner.call('app.window.return', { operationId: 'return-unrelated-original-window', ...first }, context)).recordedOperation?.state).toBe('confirmed')
    expect(snapshot(f).issue).toBe(issue)
  })
  it.each(['main', 'child'])('retires the exact %s document focus cause when its original Renderer document retires', async kind => {
    const f = await fixture()
    const descriptor = (await f.owner.call('app.window.ls', {}, context)).windows[0]!
    const original = kind === 'child' ? await opened(f) : { windowId: descriptor.windowId, documentGeneration: descriptor.documentGeneration! }
    const native = kind === 'child' ? f.children[0]! : f.main
    native.focused = false; native.focus = () => {}
    expect(f.owner.focusDocument(original)).toBe(false)
    expect(snapshot(f).issue).not.toBeNull()
    f.main.webContents.emit('did-start-navigation', {}, _historyFixtureFileUrl("app/index.html"), false, true)
    const current = await f.owner.rendererReady({ sender: f.main.webContents, senderFrame: f.main.webContents.mainFrame } as never)
    if (kind === 'child') await vi.waitFor(() => expect(f.children).toHaveLength(2))
    else { expect(current.windowId).toBe(original.windowId); expect(current.documentGeneration).not.toBe(original.documentGeneration) }
    expect(() => f.owner.focusDocument(original)).toThrow('current')
    expect(snapshot(f).issue).toBeNull()
  })
  it('retains an unrelated receipt warning when the original Main document retires', async () => {
    const f = await fixture(), descriptor = (await f.owner.call('app.window.ls', {}, context)).windows[0]!
    f.main.focused = false; f.main.focus = () => {}
    expect(f.owner.focusDocument({ windowId: descriptor.windowId, documentGeneration: descriptor.documentGeneration! })).toBe(false)
    f.store.journalFailure = 'pending'
    await f.owner.call('app.window.open', { operationId: 'unpersisted-window-before-main-reload', target }, context)
    const issue = snapshot(f).issue
    expect(issue).toContain('persistence is unconfirmed')
    f.main.webContents.emit('did-start-navigation', {}, _historyFixtureFileUrl("app/index.html"), false, true)
    await f.owner.rendererReady({ sender: f.main.webContents, senderFrame: f.main.webContents.mainFrame } as never)
    expect(snapshot(f).issue).toBe(issue)
  })
  it('ignores a retired native focus event and stale document when the current focus is unknown', async () => {
    const f = await fixture(), original = await opened(f), retired = f.children[0]!
    retired.webContents.emit('render-process-gone')
    await vi.waitFor(() => expect(retired.destroyed).toBe(true))
    const reopened = await f.owner.call('app.window.open', { operationId: 'reopen-for-current-focus', target }, context)
    const current = { windowId: reopened.recordedOperation!.windowId!, documentGeneration: reopened.recordedOperation!.documentGeneration! }
    expect(current.windowId).toBe(original.windowId); expect(current.documentGeneration).not.toBe(original.documentGeneration)
    const native = f.children[1]!
    native.focused = false; native.focus = () => {}
    expect(f.owner.focusDocument(current)).toBe(false)
    const issue = snapshot(f).issue
    retired.focused = true; retired.emit('focus')
    expect(() => f.owner.focusDocument(original)).toThrow('current')
    expect(snapshot(f).issue).toBe(issue)
    expect(snapshot(f).windows.find(window => window.windowId === current.windowId)?.focused).toBe(false)
  })
  it.each([
    { name: 'whole Tab in another Group', owned: target, requested: { ...target, groupId: 'other-group' } },
    { name: 'same Region in another Group', owned: { ...target, kind: 'region' as const, regionId: 'original-region' }, requested: { ...target, kind: 'region' as const, regionId: 'original-region', groupId: 'other-group' } },
    { name: 'parent Tab in another display Workspace', owned: { ...target, kind: 'region' as const, regionId: 'original-region' }, requested: { ...target, displayWorkspaceId: 'other-display' } }
  ])('locates the already borrowed original entity across occurrences: $name', async ({ owned, requested }) => {
    const f = await fixture()
    const first = await f.owner.call('app.window.open', { operationId: 'first-original-occurrence', target: owned }, context)
    expect(first.recordedOperation?.state).toBe('confirmed')
    const requests = f.main.webContents.send.mock.calls.filter(([channel]) => channel === WORKBENCH_WINDOW_REQUEST).length
    const second = await f.owner.call('app.window.open', { operationId: 'same-entity-other-occurrence', target: requested }, context)
    expect(second.recordedOperation).toMatchObject({ state: 'rejected', input: { operationId: 'same-entity-other-occurrence', target: requested }, windowId: first.recordedOperation!.windowId, documentGeneration: first.recordedOperation!.documentGeneration })
    expect(f.children).toHaveLength(1)
    expect(f.main.webContents.send.mock.calls.filter(([channel]) => channel === WORKBENCH_WINDOW_REQUEST)).toHaveLength(requests)
  })
  it('keeps distinct original Regions independently movable across display occurrences', async () => {
    const f = await fixture()
    for (const [regionId, groupId] of [['first-region', 'group'], ['second-region', 'other-group']]) {
      const page = await f.owner.call('app.window.open', { operationId: regionId!, target: { ...target, kind: 'region', regionId: regionId!, groupId: groupId! } }, context)
      expect(page.recordedOperation?.state).toBe('confirmed')
    }
    expect(f.children).toHaveLength(2)
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
