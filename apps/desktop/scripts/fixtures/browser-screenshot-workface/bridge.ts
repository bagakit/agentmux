// Private IO adapter for the mounted production Pane. It never connects to user state or clipboard.
const bridge = (window as any).screenshotNative
const noop = () => () => {}
export const api = {
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
    writeClipboardImage: (image: unknown) => bridge.call('privateClipboard', image),
    writeClipboardText: (text: string) => bridge.call('privateClipboardText', text), openExternal: async () => {}
  }
}
const listeners = new Set<(state: any, previous: any) => void>()
export const state: any = {
  config: {
    version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private native fixture' }],
    executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
  },
  toolsOpen: false, browserAnnotationsByBrowserId: {}, noticeReadReceipts: {},
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
