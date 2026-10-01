// @vitest-environment happy-dom
import { act, createElement, type MouseEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import type { BrowserOutcomeEvaluation } from '../src/shared/browser-outcome-criteria'
import type { BrowserOperation } from '../src/shared/browser-operation'
import { getBrowserTaskReliability } from '../src/shared/browser-task-reliability'

const host = vi.hoisted(() => ({ executeControl: vi.fn(), verifyOutcome: vi.fn(), operations: [] as BrowserOperation[],
  onVerify: undefined as undefined | ((runId: string, event: MouseEvent<HTMLButtonElement>) => Promise<BrowserOutcomeEvaluation>) }))
vi.mock('../src/renderer/src/lib/api', () => ({ api: { browser: {
  getDemonstration: async () => ({ draft: null }), getTaskAssets: async () => ({ assets: [], runs: [] }),
  listOperationHistory: async () => host.operations, verifyOutcome: host.verifyOutcome,
  onPresentationEvent: () => () => {},
  cancelElementSelection: async () => {}, setAnnotationMarkers: async () => {}, setBounds: async () => {}
}, ui: { getZoomFactor: () => 1 } } }))
vi.mock('../src/renderer/src/store', () => ({ useAppStore: Object.assign((select: (value: unknown) => unknown) => select({
  applyBrowserEvent: () => {}, executeControl: host.executeControl, reportError: () => {}, setWorkspaceTool: () => {},
  saveBrowserBookmark: async () => {}, openFile: async () => {}, toolsOpen: false, config: { browser: { toolbar: { more: true } } },
  browserAnnotationsByBrowserId: {}, addBrowserAnnotation: () => {}
  , noticeReadReceipts: {}, markNoticeRead: () => {}, markNoticeUnread: () => {}
}), { setState: () => {}, getState: () => ({ tabs: {}, layouts: {} }) }) }))
vi.mock('../src/renderer/src/components/BrowserTaskAssetEditor', async importOriginal => {
  const original = await importOriginal<typeof import('../src/renderer/src/components/BrowserTaskAssetEditor')>()
  return { ...original, BrowserTaskAssetEditor: (props: Parameters<typeof original.BrowserTaskAssetEditor>[0]) => {
    host.onVerify = props.onVerify
    return createElement(original.BrowserTaskAssetEditor, props)
  } }
})
import { BrowserPane } from '../src/renderer/src/components/BrowserPane'
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })

it('the real Pane Verify refreshes the selected older run read while current activity stays on another operation', async () => {
  const content = { name: 'Saved task', url: 'https://example.test/', parameters: [], steps: [{ id: 'produce', kind: 'click' as const,
    reviewed: true, url: 'https://example.test/', target: { role: 'button', name: 'Create result', count: 1, ordinal: 1 } }],
    completion: { criteria: [{ kind: 'download-readable' as const, stepId: 'produce', path: 'result.txt' }] } }
  const state = { assets: [{ id: 'asset', browserId: 'browser', sourceRecordingId: 'fixture-recording', revision: 1, createdAt: 1, updatedAt: 2, draft: content,
    versions: [{ ...content, version: 1, savedAt: 1 }] }], selectedRunId: 'older', runs: [{ id: 'older', browserId: 'browser', assetId: 'asset', version: 1,
      status: 'completed' as const, nextStep: 1, operationIds: ['older-operation'], humanCheckpoints: [], startedAt: 1, updatedAt: 2 }] }
  const context = { workspaceId: 'workspace', browserId: 'browser', operationId: 'older-operation', navigationId: 'nav' }, assetRun = { assetId: 'asset', runId: 'older', version: 1 }
  const criterion = { kind: 'download-readable' as const, path: 'result.txt' }
  const older: BrowserOperation = { id: context.operationId, browserId: 'browser', phase: 'completed', startedAt: 1, finishedAt: 2,
    operator: { id: 'person', name: 'Person' }, summary: 'Original action', url: content.url,
    steps: [{ sequence: 1, method: 'click', label: 'Create result', status: 'completed', startedAt: 1, finishedAt: 2 }],
    outcome: { registration: { context, assetRun, criteria: [{ ...criterion, producer: { operationId: context.operationId, navigationId: 'nav' } }] },
      evaluation: { context, assetRun, status: 'not-met', conditions: [{ criterion, status: 'not-met', reason: 'Original retained evidence' }] } } }
  host.operations = [older]
  host.executeControl.mockImplementation(async input => input.operation === 'browser.task.reliability'
    ? { operation: input.operation, reliability: getBrowserTaskReliability({ ...input, state, operations: host.operations }) }
    : { operation: 'browser.history', operations: host.operations })
  host.verifyOutcome.mockImplementation(async () => {
    const result: BrowserOutcomeEvaluation = { context, assetRun, status: 'passed', conditions: [{ criterion, status: 'passed', reason: 'Updated original producer evidence' }] }
    older.outcome!.evaluation = result
    return result
  })
  const { outcome: _currentOutcome, ...current } = older
  const tab: BrowserWorkbenchSurface = { kind: 'browser', regionId: 'region', workspaceId: 'workspace', browserId: 'browser', id: 'browser',
    navigationId: 'nav', profileId: 'profile', url: content.url, title: 'Preferences', loading: false, canGoBack: false, canGoForward: false,
    viewport: 'responsive', error: null, driving: false, appLinkPrompt: null, taskAssets: state,
    activity: { operation: { ...current, id: 'newer-current-operation' }, control: 'human' } }
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(BrowserPane, { tab, visible: false })))
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="More browser tools"]')!
    await act(async () => trigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
    const open = document.querySelector<HTMLElement>('[aria-label="Open human demonstration draft"]')!
    await act(async () => { open.focus(); open.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(container.textContent).toContain('0/1 outcomes passed')
    expect(host.onVerify).toBeTypeOf('function')
    await act(async () => { await host.onVerify!('older', { nativeEvent: { isTrusted: true } } as MouseEvent<HTMLButtonElement>) })
    expect(host.verifyOutcome).toHaveBeenCalledExactlyOnceWith('browser', 'older-operation')
    const reads = host.executeControl.mock.calls.map(([request]) => request).filter(request => request.operation === 'browser.task.reliability')
    expect(reads).toHaveLength(2); expect(reads[1]).toMatchObject({ browserId: 'browser', assetId: 'asset', version: 1 })
    expect(container.textContent).toContain('1/1 outcomes passed')
    expect(tab.activity!.operation!.id).toBe('newer-current-operation')
  } finally { await act(async () => root.unmount()); container.remove() }
})
