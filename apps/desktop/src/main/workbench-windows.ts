import { mintObjectId, mintCapabilityToken } from '@agentmux/core/object-id'
import { installTextEditContextMenu } from './text-edit-context-menu.js'

import type { BrowserWindow, HandlerDetails, IpcMainEvent, IpcMainInvokeEvent, WebContents, WebFrameMain, WindowOpenHandlerResponse } from 'electron'
import {
  parseAppWindowParams, type AgentMuxRpcWindowsOwner, type AppWindowActor, type AppWindowCallContext,
  type AppWindowDescriptor, type AppWindowMethod, type AppWindowOperation, type AppWindowPage,
  type AppWindowParamsMap, type AppWindowResultMap, type AppWindowTarget, type AppWindowWriteMethod
} from '@agentmux/core/control'
import { WORKBENCH_WINDOW_CHANGED, WORKBENCH_WINDOW_REQUEST, type WorkbenchWindowDocument,
  type WorkbenchWindowRequest, type WorkbenchWindowResponse } from '../shared/workbench-windows.js'
import { clampGeometryToVisibleArea, geometryFromWindowState, type VisibleArea, type WindowGeometry } from './window-geometry.js'
import { WorkbenchWindowStore, type StoredWorkbenchWindow } from './workbench-window-store.js'
import { windowOpenOutcome } from './window-security.js'

type ManagedWindow = StoredWorkbenchWindow & {
  generation: string
  native: BrowserWindow | null
  phase: 'pending' | 'visible' | 'returning' | 'unknown'
  ticket: { url: string; frameName: string; admitted: boolean } | null
  durable: boolean
  retiredNative?: BrowserWindow
  retiredGeneration?: string
}
type RendererPending = {
  request: WorkbenchWindowRequest
  resolve(response: WorkbenchWindowResponse): void
  observed: boolean
  timer: ReturnType<typeof setTimeout>
  late?: (response: WorkbenchWindowResponse) => void | Promise<void>
}
export type WorkbenchNativeWindowOwner = {
  /** Original native pages leave this exact shell before it can be destroyed. */
  beforeClosing(window: BrowserWindow): Promise<void>
  /** True when this exact shell's original content owns the close request. */
  requestClose?(window: BrowserWindow): boolean
  /** Native content may carry its original requested window size. */
  windowSize?(target: AppWindowTarget): Promise<{ width: number; height: number } | null>
}
const actorEqual = (a: AppWindowActor, b: AppWindowActor) => a.kind === b.kind && a.id === b.id
const targetKey = (target: AppWindowTarget) => JSON.stringify(target)
export function windowContainsOccurrence(target: AppWindowTarget, occurrence: {
  displayWorkspaceId: string; groupId: string; tabId: string; regionId: string
}): boolean {
  return target.displayWorkspaceId === occurrence.displayWorkspaceId && target.groupId === occurrence.groupId &&
    target.tabId === occurrence.tabId && (target.kind === 'tab' || target.regionId === occurrence.regionId)
}

/** One Main presentation owner. Its children contain no second application or runtime. */
export class WorkbenchWindows implements AgentMuxRpcWindowsOwner {
  private mainId: string = mintObjectId()
  private mainGeneration: string = mintObjectId()
  private rendererAvailable = false
  private storageWritable = true
  private issue: string | null = null
  private focusIssue: WorkbenchWindowDocument | null = null
  private quitting = false
  private disposed = false
  private readonly windows = new Map<string, ManagedWindow>()
  private readonly byTarget = new Map<string, ManagedWindow>()
  private readonly operations = new Map<string, AppWindowOperation>()
  private readonly claims = new Map<string, { method: AppWindowMethod; input: unknown; actor: AppWindowActor; result: Promise<AppWindowPage> }>()
  private readonly pending = new Map<string, RendererPending>()
  private readonly mayClose = new Set<number>()
  private readonly childDepartures = new Map<string, Promise<void>>()
  private nativeOwner: WorkbenchNativeWindowOwner | null = null
  private navigationCleanup: Promise<void> = Promise.resolve()
  private readonly ready: Promise<void>

  constructor(private readonly main: BrowserWindow, private readonly store: WorkbenchWindowStore,
    private readonly visibleAreas: () => readonly VisibleArea[]) {
    this.ready = store.load().then(loaded => {
      this.mainId = loaded.state.mainWindowId
      this.storageWritable = loaded.writable
      this.issue = loaded.issue
      for (const record of loaded.state.windows) this.retain({ ...record, generation: mintObjectId(), native: null,
        phase: 'pending', ticket: null, durable: true })
    })
    main.on('close', event => {
      if (!this.quitting && [...this.windows.values()].some(record => [record.native, record.retiredNative].some(native => native && !native.isDestroyed()))) {
        event.preventDefault()
        main.hide()
      }
    })
    main.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.departRenderer()
    })
    main.webContents.on('render-process-gone', () => this.departRenderer())
    main.on('focus', () => { this.confirmFocus({ windowId: this.mainId, documentGeneration: this.mainGeneration }, main); this.changed() })
    for (const event of ['blur', 'show', 'hide', 'minimize', 'restore', 'resize', 'move'] as const) (main.on as (event: string, listener: () => void) => BrowserWindow)(event, () => this.changed())
  }

  setNativeOwner(owner: WorkbenchNativeWindowOwner): () => void {
    this.nativeOwner = owner
    return () => { if (this.nativeOwner === owner) this.nativeOwner = null }
  }

  call<M extends AppWindowMethod>(method: M, raw: AppWindowParamsMap[M], context: AppWindowCallContext): Promise<AppWindowResultMap[M]> {
    const input = parseAppWindowParams(method, raw)
    if (method === 'app.window.ls') return this.execute(method, input, context)
    const id = (input as AppWindowParamsMap[AppWindowWriteMethod]).operationId
    const claim = this.claims.get(id)
    if (claim) {
      if (claim.method !== method || JSON.stringify(claim.input) !== JSON.stringify(input) || !actorEqual(claim.actor, context.actor)) {
        return Promise.reject(new Error('This original operation is already claimed by another window intent or actor.'))
      }
      return claim.result
    }
    const result = this.execute(method, input, context).finally(() => this.claims.delete(id))
    this.claims.set(id, { method, input, actor: { ...context.actor }, result })
    return result
  }

  private async execute<M extends AppWindowMethod>(method: M, raw: AppWindowParamsMap[M], context: AppWindowCallContext): Promise<AppWindowResultMap[M]> {
    await this.ready
    const input = parseAppWindowParams(method, raw)
    if (method === 'app.window.ls') {
      const operationId = (input as AppWindowParamsMap['app.window.ls']).operationId
      return this.page(operationId ? await this.readOperation(operationId) : null)
    }
    await context.assertCurrent?.()
    const writeMethod = method as AppWindowWriteMethod, write = input as AppWindowParamsMap[AppWindowWriteMethod]
    const existing = await this.readOperation(write.operationId)
    if (existing) {
      if (existing.method !== method || JSON.stringify(existing.input) !== JSON.stringify(input) || !actorEqual(existing.actor, context.actor)) {
        throw new Error('This operation already records another original window intent or actor. Reconcile its original receipt; original work remains.')
      }
      if (existing.state === 'unknown' || existing.state === 'pending') {
        const record = existing.windowId ? this.windows.get(existing.windowId) : null
        if (record && existing.method === 'app.window.open' && JSON.stringify(record.target) === JSON.stringify(existing.input.target)) {
          if (record.native && !record.native.isDestroyed() && record.phase === 'visible') {
            existing.documentGeneration = record.generation
            return this.finish(existing, 'confirmed', null)
          }
          // An explicit retry of the SAME intent may proceed only where Main
          // knows native creation has not started. An unknown ticket is never replayed.
          if (!record.native && !record.ticket && record.phase === 'unknown' && this.rendererAvailable) return this.open(existing, existing.input.target, context)
        }
        if (record?.native && existing.method === 'app.window.return' && existing.input.documentGeneration === record.generation && record.phase === 'unknown') return this.returnWindow(record, existing)
      }
      return this.page(existing)
    }
    const operation = { method: writeMethod, input: structuredClone(write), actor: { ...context.actor },
      state: 'pending', windowId: null, documentGeneration: null, message: null } as AppWindowOperation
    this.operations.set(write.operationId, operation)
    if (!await this.persistOperation(operation)) return this.finish(operation, 'rejected', 'The original operation intent could not be persisted. No native window action was started. Original work remains.')
    if (context.signal?.aborted || this.disposed || !this.rendererAvailable) {
      return this.finish(operation, 'rejected', 'The original interface is not ready for this presentation action. Original workfaces and Agents remain.')
    }
    if (method === 'app.window.open') return this.open(operation, (input as AppWindowParamsMap['app.window.open']).target, context)
    const requested = input as AppWindowParamsMap['app.window.focus']
    if (requested.windowId === this.mainId) {
      if (requested.documentGeneration !== this.mainGeneration || method === 'app.window.return') {
        return this.finish(operation, 'rejected', 'The exact original window document is unavailable for this action.')
      }
      operation.windowId = this.mainId; operation.documentGeneration = this.mainGeneration
      this.focusNative(this.main)
      return this.finish(operation, this.main.isFocused() ? 'confirmed' : 'unknown', this.main.isFocused() ? null : 'Native focus has not been confirmed. Original input remains available.')
    }
    const record = this.windows.get(requested.windowId)
    operation.windowId = requested.windowId; operation.documentGeneration = requested.documentGeneration
    if (!record || record.generation !== requested.documentGeneration || !record.native || record.native.isDestroyed()) {
      return this.finish(operation, 'rejected', 'This exact native window document is no longer current. Original workfaces and Agents remain.')
    }
    if (method === 'app.window.return') return this.returnWindow(record, operation)
    this.focusNative(record.native)
    const response = await this.request(record, { action: 'focus' })
    return this.finish(operation, response.outcome === 'applied' && record.native?.isFocused() ? 'confirmed' : 'unknown', response.message)
  }

  /** Only the original privileged Renderer may mint its fixed empty shell. */
  windowOpen(details: HandlerDetails, openExternal: (url: string) => void): WindowOpenHandlerResponse {
    const record = [...this.windows.values()].find(record => record.ticket?.url === details.url && record.ticket.frameName === details.frameName)
    if (!record) {
      const shell = new URL('./workbench-window.html', this.main.webContents.getURL())
      try { const requested = new URL(details.url); if (requested.origin === shell.origin && requested.pathname === shell.pathname) return { action: 'deny' } } catch {}
      return windowOpenOutcome(details.url, openExternal)
    }
    if (record.native || record.ticket!.admitted || this.disposed || this.quitting) return { action: 'deny' }
    record.ticket!.admitted = true
    const geometry = clampGeometryToVisibleArea(record.geometry, this.visibleAreas())
    return { action: 'allow', overrideBrowserWindowOptions: { ...(geometry.x === undefined ? {} : { x: geometry.x }), ...(geometry.y === undefined ? {} : { y: geometry.y }), width: geometry.width, height: geometry.height, minWidth: 420, minHeight: 300,
      show: false, titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      backgroundColor: this.main.getBackgroundColor(),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, preload: undefined } as unknown as Electron.WebPreferences } }
  }

  createdWindow(window: BrowserWindow, details: { url: string; frameName: string }): void {
    const record = [...this.windows.values()].find(record => record.ticket?.url === details.url && record.ticket.frameName === details.frameName)
    if (!record || !record.ticket?.admitted || record.native || this.disposed) { window.destroy(); return }
    record.native = window
    installTextEditContextMenu(window.webContents, window, { isCurrent: () => record.native === window && this.windows.get(record.windowId) === record })
    record.ticket = null
    const generation = record.generation
    let initialNavigation = true
    window.webContents.once('did-finish-load', () => { initialNavigation = false })
    window.webContents.on('did-start-navigation', (_event, url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace && !(initialNavigation && url === details.url)) this.departChild(record, window, generation)
    })
    window.webContents.on('render-process-gone', () => this.departChild(record, window, generation))
    window.webContents.setBackgroundThrottling(false)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const guard = (event: { preventDefault(): void }, url: string) => { if (url !== details.url) event.preventDefault() }
    window.webContents.on('will-navigate', guard)
    window.webContents.on('will-redirect', guard)
    window.on('close', event => {
      if (this.quitting || this.mayClose.has(window.id)) return
      event.preventDefault()
      if (record.target.kind === 'region' && this.nativeOwner?.requestClose?.(window)) return
      void this.call('app.window.return', { operationId: mintObjectId(), windowId: record.windowId, documentGeneration: record.generation },
        { actor: { kind: 'user', id: 'desktop' } }).catch(error => this.warn(String(error)))
    })
    window.on('closed', () => {
      if (record.native === window && this.windows.get(record.windowId) === record && !this.mayClose.has(window.id)) this.departChild(record, window, generation)
      this.mayClose.delete(window.id)
    })
    window.on('focus', () => { this.confirmFocus({ windowId: record.windowId, documentGeneration: generation }, window); this.changed() })
    for (const event of ['blur', 'show', 'hide', 'minimize', 'restore'] as const) (window.on as (event: string, listener: () => void) => BrowserWindow)(event, () => this.changed())
    let geometrySave: ReturnType<typeof setTimeout> | undefined
    const resized = () => {
      if (window.isDestroyed()) return
      record.geometry = this.geometry(window)
      clearTimeout(geometrySave)
      geometrySave = setTimeout(() => { void this.persistWindows() }, 150)
      this.changed()
    }
    window.on('move', resized); window.on('resize', resized)
    window.once('closed', () => clearTimeout(geometrySave))
    if (record.geometry.maximized) window.maximize()
    this.changed()
  }

  async rendererReady(event: IpcMainInvokeEvent): Promise<{ windowId: string; documentGeneration: string }> {
    this.assertSender(event.sender, event.senderFrame)
    await this.ready
    await this.navigationCleanup
    this.rendererAvailable = true
    for (const record of this.windows.values()) if (record.durable && !record.native && !record.retiredNative) {
      void this.launch(record, false).catch(error => { record.phase = 'unknown'; this.warn(String(error)) })
    }
    this.changed()
    return { windowId: this.mainId, documentGeneration: this.mainGeneration }
  }

  accept(event: IpcMainEvent, value: WorkbenchWindowResponse): void {
    this.assertSender(event.sender, event.senderFrame)
    if (!value || typeof value.requestId !== 'string') return
    const pending = this.pending.get(value.requestId)
    if (!pending || value.windowId !== pending.request.windowId || value.documentGeneration !== pending.request.documentGeneration ||
        !['applied', 'rejected', 'unconfirmed'].includes(value.outcome) || value.message !== null && typeof value.message !== 'string') return
    this.pending.delete(value.requestId)
    clearTimeout(pending.timer)
    if (pending.observed) pending.resolve(value)
    else void pending.late?.(value)
  }

  /** The Root sender remains unique; this resolves the exact current native host. */
  presentationWindow(document: WorkbenchWindowDocument | undefined, occurrence: {
    displayWorkspaceId: string; groupId: string; tabId: string; regionId: string
  }): BrowserWindow {
    if (!document || document.windowId === this.mainId && document.documentGeneration === this.mainGeneration) {
      if (this.windowForOccurrence(occurrence) !== this.main) throw new Error('This original occurrence has moved to its recorded native window. The previous Main presentation is stale; its healthy Browser remains.')
      return this.main
    }
    const record = this.windows.get(document.windowId)
    if (!record?.native || record.native.isDestroyed() || record.generation !== document.documentGeneration ||
        record.phase === 'returning' || !windowContainsOccurrence(record.target, occurrence)) {
      throw new Error('This exact native presentation document no longer owns that original occurrence. Original Browser work remains.')
    }
    return record.native
  }

  windowForOccurrence(occurrence: { displayWorkspaceId: string; groupId: string; tabId: string; regionId: string }): BrowserWindow {
    const region = this.byTarget.get(targetKey({ kind: 'region', ...occurrence }))
    const tab = this.byTarget.get(targetKey({ kind: 'tab', displayWorkspaceId: occurrence.displayWorkspaceId, groupId: occurrence.groupId, tabId: occurrence.tabId }))
    for (const record of [region, tab]) {
      const native = record?.native ?? record?.retiredNative
      if (native && !native.isDestroyed() && record?.phase !== 'returning') return native
    }
    return this.main
  }

  windowForDocument(scope?: WorkbenchWindowDocument): BrowserWindow {
    if (!scope) return this.main
    if (scope.windowId === this.mainId && scope.documentGeneration === this.mainGeneration && !this.main.isDestroyed()) return this.main
    const record = this.windows.get(scope.windowId)
    if (!record?.native || record.native.isDestroyed() || record.generation !== scope.documentGeneration) throw new Error('The exact original native window document is no longer current. Original work remains.')
    return record.native
  }
  focusDocument(scope: WorkbenchWindowDocument): boolean {
    const native = this.windowForDocument(scope)
    this.focusNative(native)
    const confirmed = native.isFocused()
    if (!confirmed) this.warn('Native workface focus has not been confirmed. Original content and input remain; focus its recorded window directly.', scope)
    else if (this.confirmFocus(scope, native)) this.changed()
    return confirmed
  }

  documentForWindow(window: BrowserWindow): WorkbenchWindowDocument | null {
    if (window === this.main) return { windowId: this.mainId, documentGeneration: this.mainGeneration }
    for (const record of this.windows.values()) if (record.native === window) return { windowId: record.windowId, documentGeneration: record.generation }
    return null
  }

  async prepareQuit(): Promise<void> {
    this.quitting = true
    for (const record of this.windows.values()) if (record.native && !record.native.isDestroyed()) record.geometry = this.geometry(record.native)
    await this.persistWindows()
    await this.store.flush().catch(error => this.warn(String(error)))
  }

  dispose(): void {
    this.disposed = true
    this.rendererAvailable = false
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); if (pending.observed) pending.resolve({
      requestId: pending.request.requestId, windowId: pending.request.windowId, documentGeneration: pending.request.documentGeneration,
      outcome: 'unconfirmed', message: 'The original interface observation ended. Original work remains.' }) }
    this.pending.clear()
  }

  private async open(operation: AppWindowOperation, target: AppWindowTarget, context: AppWindowCallContext): Promise<AppWindowPage> {
    const focus = operation.method === 'app.window.open' && operation.input.focus !== false
    let nativeSize: { width: number; height: number } | null | undefined
    try { nativeSize = await this.nativeOwner?.windowSize?.(target) }
    catch (error) { this.warn(`The original page remains usable; its requested window size could not be read. Inspect its window arrangement to retry. ${String(error)}`) }
    // The size lookup can yield. Check ownership only afterwards so concurrent
    // intents cannot both reserve this original Tab or an overlapping Region.
    const existing = this.byTarget.get(targetKey(target))
    if (existing) {
      operation.windowId = existing.windowId; operation.documentGeneration = existing.native ? existing.generation : null
      if (existing.native && existing.phase === 'visible') {
        if (focus) this.focusNative(existing.native)
        else existing.native.showInactive()
        return this.finish(operation, 'confirmed', null)
      }
      if (!existing.native && !existing.ticket && existing.phase === 'unknown') {
        await this.childDepartures.get(existing.windowId)
        if (existing.retiredNative) {
          existing.phase = 'returning'
          const returned = await this.request({ ...existing, generation: existing.retiredGeneration! }, { action: 'return' })
          if (returned.outcome !== 'applied') { existing.phase = 'unknown'; return this.finish(operation, 'unknown', 'Returning the original workface is unconfirmed. Its old shell and original content are retained; retry this exact target after the interface can acknowledge the return.') }
          try { await this.returnNative(existing.retiredNative); if (!existing.retiredNative.isDestroyed()) { this.mayClose.add(existing.retiredNative.id); existing.retiredNative.destroy() }; delete existing.retiredNative; delete existing.retiredGeneration; existing.phase = 'unknown' }
          catch (error) { existing.phase = 'unknown'; return this.finish(operation, 'unknown', 'The original native shell cleanup is unconfirmed. Original work remains. ' + String(error)) }
        }
        const prepared = await this.request(existing, { action: 'prepare' })
        if (prepared.outcome !== 'applied') return this.finish(operation, prepared.outcome === 'rejected' ? 'rejected' : 'unknown', prepared.message)
        await context.assertCurrent?.()
        if (context.signal?.aborted) return this.finish(operation, 'rejected', 'The original caller ended before the shell was reopened. Original work remains.')
        if (!await this.persistWindows()) return this.finish(operation, 'unknown', 'Window arrangement persistence is unconfirmed. Original content remains in its recovered host.')
        const response = await this.launch(existing, focus)
        operation.documentGeneration = existing.native ? existing.generation : null
        if (response.outcome === 'rejected' && !existing.native && (existing as ManagedWindow).ticket?.admitted === false) existing.ticket = null
        return this.finish(operation, response.outcome === 'applied' && existing.native ? 'confirmed' : 'unknown', response.message)
      }
      return this.finish(operation, 'unknown', 'This original workface already has a pending or unconfirmed window. Reconcile its original window; no duplicate was opened.')
    }
    const overlap = [...this.windows.values()].find(record => record.target.tabId === target.tabId &&
      (record.target.kind === 'tab' || target.kind === 'tab' || record.target.regionId === target.regionId))
    if (overlap) {
      operation.windowId = overlap.windowId; operation.documentGeneration = overlap.native ? overlap.generation : null
      return this.finish(operation, 'rejected', 'This original Tab or one of its Regions is already in the recorded window. Return it before moving the overlapping original workface.')
    }
    const bounds = this.main.getNormalBounds()
    const record: ManagedWindow = { windowId: mintObjectId(), generation: mintObjectId(), target, native: null, phase: 'pending', ticket: null,
      durable: false, geometry: clampGeometryToVisibleArea({ x: bounds.x + 40, y: bounds.y + 40,
        width: nativeSize?.width ?? Math.max(640, Math.min(1120, bounds.width)), height: nativeSize?.height ?? Math.max(480, Math.min(820, bounds.height)), maximized: false }, this.visibleAreas()) }
    this.retain(record)
    operation.windowId = record.windowId
    const prepared = await this.request(record, { action: 'prepare' })
    if (prepared.outcome !== 'applied') {
      this.remove(record)
      return this.finish(operation, prepared.outcome === 'rejected' ? 'rejected' : 'unknown', prepared.message)
    }
    try { await context.assertCurrent?.(); if (context.signal?.aborted) throw new Error('The original caller ended before window creation.') }
    catch (error) { this.remove(record); return this.finish(operation, 'rejected', String(error)) }
    record.durable = true
    if (!await this.persistWindows()) { record.phase = 'unknown'; return this.finish(operation, 'unknown', 'The original window arrangement could not be persisted. No native window was created; inspect the same operation to reconcile.') }
    const response = await this.launch(record, focus, async late => {
      if (late.outcome === 'applied' && this.windows.get(record.windowId) === record && record.native && !record.native.isDestroyed()) {
        record.phase = 'visible'; operation.documentGeneration = record.generation
        await this.finish(operation, 'confirmed', null)
      }
    })
    operation.documentGeneration = record.native ? record.generation : null
    if (response.outcome === 'applied' && record.native && !record.native.isDestroyed()) return this.finish(operation, 'confirmed', response.message)
    if (response.outcome === 'rejected' && !record.native) { this.remove(record); await this.persistWindows() }
    return this.finish(operation, response.outcome === 'rejected' && !record.native ? 'rejected' : 'unknown', response.message)
  }

  private async launch(record: ManagedWindow, focus: boolean, late?: RendererPending['late']): Promise<WorkbenchWindowResponse> {
    const generation = record.generation
    const url = new URL('./workbench-window.html', this.main.webContents.getURL())
    url.searchParams.set('window', record.windowId); url.searchParams.set('document', record.generation); url.searchParams.set('ticket', mintCapabilityToken())
    record.ticket = { url: url.href, frameName: 'workbench-window-' + mintCapabilityToken(), admitted: false }
    const response = await this.request(record, { action: 'open', url: record.ticket.url, frameName: record.ticket.frameName }, async response => {
      if (record.generation !== generation || this.windows.get(record.windowId) !== record || !record.native || record.native.isDestroyed()) return
      if (response.outcome === 'applied') { record.phase = 'visible'; record.native.showInactive(); this.changed() }
      await late?.(response)
    })
    if (record.generation !== generation || this.windows.get(record.windowId) !== record) return { ...response, outcome: 'unconfirmed', message: 'The original native document ended before placement confirmation. Original work remains recoverable.' }
    if (response.outcome === 'applied' && record.native && !record.native.isDestroyed()) {
      record.phase = 'visible'
      if (focus) this.focusNative(record.native)
      else record.native.showInactive()
    } else record.phase = 'unknown'
    this.changed()
    return response
  }

  private async returnWindow(record: ManagedWindow, operation: AppWindowOperation): Promise<AppWindowPage> {
    if (record.phase === 'returning') return this.finish(operation, 'unknown', 'This original window is already returning. Reconcile its original operation.')
    for (const [id, pending] of this.pending) if (pending.request.windowId === record.windowId && pending.request.action === 'return' && !pending.observed) { clearTimeout(pending.timer); this.pending.delete(id) }
    record.phase = 'returning'
    const complete = async (response: WorkbenchWindowResponse): Promise<void> => {
      if (response.outcome !== 'applied' || this.windows.get(record.windowId) !== record) return
      try {
        const native = record.native, wasFocused = native?.isFocused() === true
        if (native) await this.returnNative(native)
        if (!await this.persistWindows(record.windowId)) { record.phase = 'unknown'; await this.finish(operation, 'unknown', 'The original content has returned, but the closed window arrangement is not durable. The shell remains available; return it again to reconcile.'); return }
        this.remove(record)
        if (native && !native.isDestroyed()) { this.mayClose.add(native.id); native.close() }
        if (wasFocused || !this.main.isVisible() && ![...this.windows.values()].some(record => record.native?.isVisible())) this.focusNative(this.main)
        await this.finish(operation, 'confirmed', null)
      } catch (error) { record.phase = 'unknown'; await this.finish(operation, 'unknown', String(error)) }
    }
    const response = await this.request(record, { action: 'return' }, complete)
    if (response.outcome === 'applied') await complete(response)
    else { record.phase = 'unknown'; await this.finish(operation, response.outcome === 'rejected' ? 'rejected' : 'unknown', response.message) }
    return this.page(operation)
  }

  private request(record: ManagedWindow, action: { action: 'prepare' | 'return' | 'focus' } | { action: 'open'; url: string; frameName: string }, late?: RendererPending['late']): Promise<WorkbenchWindowResponse> {
    const request = { requestId: mintObjectId(), windowId: record.windowId, documentGeneration: record.generation, target: record.target, ...action } as WorkbenchWindowRequest
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(request.requestId)
        if (pending) { pending.observed = false; if (!pending.late) this.pending.delete(request.requestId) }
        resolve({ requestId: request.requestId, windowId: record.windowId, documentGeneration: record.generation,
          outcome: 'unconfirmed', message: 'The original interface has not confirmed this exact presentation action. Original work remains; reconcile the same operation.' })
      }, 15_000)
      this.pending.set(request.requestId, { request, resolve, observed: true, timer, ...(late ? { late } : {}) })
      if (!this.main.isDestroyed() && !this.main.webContents.isDestroyed()) this.main.webContents.send(WORKBENCH_WINDOW_REQUEST, request)
    })
  }

  private departChild(record: ManagedWindow, native: BrowserWindow, generation: string): void {
    if (this.quitting || this.disposed || this.windows.get(record.windowId) !== record || record.native !== native || record.generation !== generation || this.mayClose.has(native.id)) return
    if (!native.isDestroyed()) record.geometry = this.geometry(native)
    record.retiredNative = native; record.retiredGeneration = generation; record.native = null; record.generation = mintObjectId(); record.phase = 'unknown'; record.ticket = null
    this.warn('The original workface window document ended. Its Session and Run remain; the original content is returning to the main workbench. Open the same original target to restore this window.')
    const departed = { ...record, generation, phase: 'returning' as const }
    const cleanup = (async () => {
      if (this.rendererAvailable) {
        record.phase = 'returning'
        const returned = await this.request(departed, { action: 'return' })
        if (returned.outcome !== 'applied') { record.phase = 'unknown'; this.warn('Returning the original workface after its native document ended is unconfirmed. The old shell and original workface remain; open this same exact target to retry its original return.'); return }
      }
      try {
        await this.returnNative(native)
        const wasFocused = !native.isDestroyed() && native.isFocused()
        if (!native.isDestroyed()) { this.mayClose.add(native.id); native.destroy() }
        if (wasFocused || !this.main.isVisible() && ![...this.windows.values()].some(record => record.native?.isVisible() && !record.native.isMinimized())) this.focusNative(this.main)
        if (record.retiredNative === native) { delete record.retiredNative; delete record.retiredGeneration }
      } catch (error) { this.warn(String(error)) }
      record.phase = 'unknown'
      await this.persistWindows()
    })().finally(() => { if (this.childDepartures.get(record.windowId) === cleanup) this.childDepartures.delete(record.windowId); this.changed() })
    this.childDepartures.set(record.windowId, cleanup)
  }

  private departRenderer(): void {
    if (!this.rendererAvailable) return
    this.rendererAvailable = false
    this.retireFocus({ windowId: this.mainId, documentGeneration: this.mainGeneration })
    this.mainGeneration = mintObjectId()
    this.navigationCleanup = this.navigationCleanup.then(() => this.rendererDeparted()).then(async () => { await Promise.all(this.childDepartures.values()) })
  }

  private async rendererDeparted(): Promise<void> {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); if (pending.observed) pending.resolve({ requestId: pending.request.requestId,
      windowId: pending.request.windowId, documentGeneration: pending.request.documentGeneration, outcome: 'unconfirmed',
      message: 'The original interface document changed before confirmation. Original work remains.' }) }
    this.pending.clear()
    for (const record of this.windows.values()) {
      const native = record.native ?? record.retiredNative
      if (native && !native.isDestroyed()) {
        record.geometry = this.geometry(native)
        record.phase = 'returning'
        try { await this.returnNative(native); record.native = null; delete record.retiredNative; delete record.retiredGeneration; this.mayClose.add(native.id); native.destroy() }
        catch (error) { record.phase = 'unknown'; this.warn(String(error)); continue }
      }
      this.retireFocus({ windowId: record.windowId, documentGeneration: record.generation })
      record.generation = mintObjectId(); record.ticket = null; record.phase = 'pending'
    }
    this.changed()
  }

  private async returnNative(window: BrowserWindow): Promise<void> {
    if (!this.nativeOwner) throw new Error('The original native Browser handoff owner is unavailable. The shell and original workface are retained.')
    await this.nativeOwner.beforeClosing(window)
  }

  private retain(record: ManagedWindow): void { this.windows.set(record.windowId, record); this.byTarget.set(targetKey(record.target), record) }
  private remove(record: ManagedWindow): void {
    this.retireFocus({ windowId: record.windowId, documentGeneration: record.generation })
    this.windows.delete(record.windowId); this.byTarget.delete(targetKey(record.target))
    for (const [id, pending] of this.pending) if (pending.request.windowId === record.windowId) {
      clearTimeout(pending.timer); this.pending.delete(id)
      if (pending.observed) pending.resolve({ requestId: id, windowId: record.windowId, documentGeneration: pending.request.documentGeneration,
        outcome: 'unconfirmed', message: 'The original window has returned; inspect its original operation receipt.' })
    }
    this.changed()
  }
  private focusNative(window: BrowserWindow): void { if (window.isMinimized()) window.restore(); window.show(); window.focus() }
  private geometry(window: BrowserWindow): WindowGeometry { return geometryFromWindowState({ bounds: window.getBounds(), normalBounds: window.getNormalBounds(), maximized: window.isMaximized() }) }
  private descriptors(): AppWindowDescriptor[] {
    const main: AppWindowDescriptor = { windowId: this.mainId, documentGeneration: this.mainGeneration, target: null,
      presentation: this.main.isDestroyed() ? 'unknown' : !this.rendererAvailable ? 'pending' : this.main.isVisible() && !this.main.isMinimized() ? 'visible' : 'hidden',
      bounds: this.main.isDestroyed() ? null : this.main.getBounds(), focused: this.main.isDestroyed() ? null : this.main.isFocused() }
    return [main, ...[...this.windows.values()].map((record): AppWindowDescriptor => {
      const native = record.native && !record.native.isDestroyed() ? record.native : null
      return { windowId: record.windowId, documentGeneration: native ? record.generation : null, target: record.target,
        presentation: native && record.phase === 'visible' ? native.isVisible() && !native.isMinimized() ? 'visible' : 'hidden' : record.phase === 'pending' ? 'pending' : 'unknown',
        bounds: native?.getBounds() ?? null, focused: native?.isFocused() ?? null }
    })]
  }
  private page(operation: AppWindowOperation | null): AppWindowPage { return { windows: this.descriptors(), recordedOperation: operation ? structuredClone(operation) : null } }
  private async readOperation(id: string): Promise<AppWindowOperation | null> { return this.operations.get(id) ?? await this.store.operation(id) }
  private async finish(operation: AppWindowOperation, state: AppWindowOperation['state'], message: string | null): Promise<AppWindowPage> {
    operation.state = state; operation.message = message
    const persisted = await this.persistOperation(operation); this.changed()
    if (persisted) this.operations.delete(operation.input.operationId)
    return this.page(operation)
  }
  private async persistOperation(operation: AppWindowOperation): Promise<boolean> {
    try { await this.store.saveOperation(operation); return true }
    catch (error) { operation.message = `Window receipt persistence is unconfirmed. Original work remains. ${String(error)}`; this.warn(operation.message); return false }
  }
  private async persistWindows(excludeWindowId?: string): Promise<boolean> {
    if (!this.storageWritable) { this.changed(); return false }
    try { await this.store.save({ mainWindowId: this.mainId, windows: [...this.windows.values()].filter(record => record.durable && record.windowId !== excludeWindowId).map(({ windowId, target, geometry }) => ({ windowId, target, geometry })) }); return true }
    catch (error) { this.warn(`Window arrangement persistence is unconfirmed. Original work remains. ${String(error)}`); return false }
  }
  private confirmFocus(scope: WorkbenchWindowDocument, native: BrowserWindow): boolean {
    if (!this.focusIssue || this.focusIssue.windowId !== scope.windowId || this.focusIssue.documentGeneration !== scope.documentGeneration || native.isDestroyed() || !native.isFocused()) return false
    const current = native === this.main ? scope.windowId === this.mainId && scope.documentGeneration === this.mainGeneration
      : this.windows.get(scope.windowId)?.native === native && this.windows.get(scope.windowId)?.generation === scope.documentGeneration
    if (!current) return false
    return this.retireFocus(scope)
  }
  private retireFocus(scope: WorkbenchWindowDocument): boolean {
    const cause = this.focusIssue
    if (!cause || cause.windowId !== scope.windowId || cause.documentGeneration !== scope.documentGeneration) return false
    this.focusIssue = null; this.issue = null
    return true
  }
  private warn(issue: string, focus?: WorkbenchWindowDocument): void { this.issue = issue; this.focusIssue = focus ? { ...focus } : null; this.changed() }
  private changed(): void {
    if (!this.disposed && this.rendererAvailable && !this.main.isDestroyed() && !this.main.webContents.isDestroyed()) {
      try { this.main.webContents.send(WORKBENCH_WINDOW_CHANGED, { windows: this.descriptors(), issue: this.issue }) }
      catch { this.focusIssue = null; this.issue = 'The original interface document changed before the window observation arrived. Original workfaces and Agents remain.' }
    }
  }
  private assertSender(sender: WebContents, frame: WebFrameMain | null): void {
    if (sender !== this.main.webContents || frame !== sender.mainFrame || frame.url !== sender.getURL()) {
      throw new Error('Only the original current interface document owns this presentation action.')
    }
  }
}
