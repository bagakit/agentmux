// Private IO adapter for the mounted production Pane. It never connects to user state or clipboard.
const bridge = (window as any).screenshotNative
const noop = () => () => {}
export const api = {
  files: {
    read: (workspaceId: string, path: string) => bridge.call('filesRead', workspaceId, path),
    write: (workspaceId: string, input: unknown) => bridge.call('filesWrite', workspaceId, input)
  },
  browser: {
    captureScreenshot: (id: string) => bridge.call('captureScreenshot', id),
    setBounds: (id: string, bounds: unknown) => bridge.call('setBounds', id, bounds),
    setAnnotationMarkers: (id: string, navigationId: string, markers: unknown) => bridge.call('setAnnotationMarkers', id, navigationId, markers),
    cancelElementSelection: (id: string) => bridge.call('cancelElementSelection', id),
    onPresentationEvent: noop,
    listInputHistory: async () => ({ entries: [] }),
    release: (id: string) => bridge.call('unexpected-release', id),
    restore: (id: string) => bridge.call('unexpected-restore', id)
  },
  ui: {
    initialTheme: null, getZoomFactor: () => 1,
    publishNativeOverlays: (regions: unknown) => bridge.call('publishNativeOverlays', regions),
    nativeBrowserVisibility: () => bridge.call('nativeBrowserVisibility'),
    onNativeBrowserVisibility: (listener: unknown) => bridge.subscribe('visibility', listener),
    onNativeOverlayWarning: (listener: unknown) => bridge.subscribe('warning', listener),
    onNativeBrowserInput: (listener: unknown) => bridge.subscribe('input', listener),
    writeClipboardImage: async (image: unknown) => {
      const result = await bridge.call('privateClipboard', image)
      ;((window as any).screenshotOutputReads ??= []).push('PNG IPC returned')
      return result
    },
    exportScreenshot: (input: unknown) => bridge.call('exportScreenshot', input),
    pinScreenshot: (input: unknown) => bridge.call('pinScreenshot', input),
    inspectScreenshotPin: (operationId: string) => bridge.call('inspectScreenshotPin', operationId),
    writeClipboardText: async (text: string) => {
      const result = await bridge.call('privateClipboardText', text)
      ;((window as any).screenshotOutputReads ??= []).push('Context IPC returned')
      return result
    }, openExternal: async () => {}
  }
}
const listeners = new Set<(state: any, previous: any) => void>()
export const state: any = {
  config: {
    version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private native fixture' }],
    executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
  },
  toolsOpen: false, browserAnnotationsByBrowserId: {}, browserOpinionDrafts: {}, sessions: [], noticeReadReceipts: {},
  saveBrowserOpinionDraft(browserId: string, draft: any) {
    if (draft.original !== null || draft.text !== '' || draft.pending !== null) throw new Error('Browser opinion editing is outside this private screenshot fixture')
    state.browserOpinionDrafts[browserId] = structuredClone(draft)
    return Promise.resolve()
  },
  applyBrowserEvent() {}, executeControl: async () => ({ operation: 'browser.history', operations: [] }),
  reportError(error: unknown) { (window as any).screenshotErrors.push(String(error)) },
  addBrowserAnnotation() {}, saveBrowserBookmark() {}, openFile() {}, clearRegionCaretFocus() {}
}
export const useAppStore = Object.assign((selector: (value: any) => unknown) => selector(state), {
  getState: () => state,
  setState(patch: unknown) { const previous = { ...state }; Object.assign(state, patch); for (const listener of listeners) listener(state, previous) },
  subscribe(listener: (state: any, previous: any) => void) { listeners.add(listener); return () => listeners.delete(listener) }
})
// These imported functions belong to deferred, unrelated surfaces. Invoking one invalidates
// this bounded fixture instead of pretending that a partial Store implemented it.
export function agentSteerCanEdit() { throw new Error('Agent steering is outside this private screenshot fixture') }
export function agentSteerExecution() { throw new Error('Agent execution is outside this private screenshot fixture') }
export function fileNavigationSelection() { throw new Error('File navigation is outside this private screenshot fixture') }
export function compareAndSwapCapsuleQuestionEditor() { throw new Error('Capsule question edits are outside this private screenshot fixture') }
export function flushCapsuleQuestionEditors() { throw new Error('Capsule question persistence is outside this private screenshot fixture') }
export function retainBrowserAgentIntent() { throw new Error('Browser Agent creation is outside this private screenshot fixture') }
export function retainMailboxNotificationIntent() { throw new Error('Mailbox notification writes are outside this private screenshot fixture') }
export function currentCoreSpatialGraph() { throw new Error('Core graph projection is outside this private screenshot fixture') }
export function staleManualSteerDraftKey() { throw new Error('Agent steering drafts are outside this private screenshot fixture') }
export function checkpointAgentOperations() { throw new Error('Agent checkpoints are outside this private screenshot fixture') }
export function checkpointSpatialWorkbench() { throw new Error('Workbench checkpoints are outside this private screenshot fixture') }
export function currentDisplayNameRevision() { throw new Error('Display-name revisions are outside this private screenshot fixture') }
