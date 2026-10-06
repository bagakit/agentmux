import { useSyncExternalStore } from 'react'

const listeners = new Set<() => void>()
let revision = 0
export const errors: string[] = [], applied: unknown[] = []
const notify = () => { revision++; for (const listener of listeners) listener() }
export const state: any = {
  config: {
    version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private native fixture' }],
    executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
  },
  tab: null, released: false, toolsOpen: false, browserAnnotationsByBrowserId: {}, noticeReadReceipts: {},
  applyBrowserEvent(event: any) {
    if (event.type !== 'updated' || event.browser.id !== state.tab?.browserId) return
    state.tab = { ...state.tab, ...event.browser }; applied.push(event); notify()
  },
  reportError(error: unknown) { errors.push(String(error)); notify() },
  executeControl: async () => ({ operation: 'browser.history', operations: [] }),
  addBrowserAnnotation() {}, clearRegionCaretFocus() {}
}
export function initialize(snapshot: any) {
  state.tab = { ...snapshot, browserId: snapshot.id, kind: 'browser', regionId: 'private-viewport-region', workspaceId: 'private-viewport-workspace' }
  notify()
}
export const useAppStore = Object.assign((selector: (value: any) => unknown) => {
  useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => revision)
  return selector(state)
}, {
  getState: () => state,
  setState(patch: unknown) { Object.assign(state, patch); notify() },
  subscribe(listener: (current: any, previous: any) => void) {
    let previous = { ...state }
    const receive = () => { const before = previous; previous = { ...state }; listener(state, before) }
    listeners.add(receive); return () => listeners.delete(receive)
  }
})
export function agentSteerCanEdit() { throw new Error('Agent steering is outside this viewport fixture') }
export function agentSteerExecution() { throw new Error('Agent execution is outside this viewport fixture') }
export function fileNavigationSelection() { throw new Error('File navigation is outside this viewport fixture') }
