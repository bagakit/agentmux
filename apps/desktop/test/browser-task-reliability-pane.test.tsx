// @vitest-environment happy-dom
import { act, createElement, type MouseEvent } from 'react'
import { expect, it, vi } from 'vitest'
import type { BrowserWorkbenchSurface } from '../src/renderer/src/lib/workbench-tabs'
import type { BrowserOutcomeEvaluation } from '@agentmux/browser/model/browser-outcome-criteria'
import type { BrowserOperation } from '@agentmux/browser/model/browser-operation'
import { getBrowserTaskReliability } from '../src/shared/browser-task-reliability'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createClientUiRoot } from './helpers/client-ui-render'

const host = vi.hoisted(() => ({
  onVerify: undefined as undefined | ((runId: string, event: MouseEvent<HTMLButtonElement>) => Promise<BrowserOutcomeEvaluation>) }))
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
  const { outcome: _currentOutcome, ...currentFacts } = older
  const current = { ...currentFacts, id: 'newer-current-operation' }
  const listOperationHistory = vi.spyOn(api.browser, 'listOperationHistory').mockResolvedValue([current])
  const getOperation = vi.spyOn(api.browser, 'getOperation').mockImplementation(async id => id === older.id ? older : null)
  const executeControl = vi.fn<ReturnType<typeof useAppStore.getState>['executeControl']>(async input => {
    if (input.operation === 'browser.task.reliability') return { operation: input.operation, reliability: getBrowserTaskReliability({ ...input, state, operations: [older] }) }
    if (input.operation === 'browser.history') return { operation: input.operation, operations: [current] }
    throw new Error('Unexpected control request')
  })
  const verifyOutcome = vi.spyOn(api.browser, 'verifyOutcome').mockImplementation(async () => {
    const result: BrowserOutcomeEvaluation = { context, assetRun, status: 'passed', conditions: [{ criterion, status: 'passed', reason: 'Updated original producer evidence' }] }
    older.outcome!.evaluation = result
    return result
  })
  const tab: BrowserWorkbenchSurface = { kind: 'browser', regionId: 'region', workspaceId: 'workspace', browserId: 'browser', id: 'browser',
    navigationId: 'nav', profileId: 'profile', url: content.url, title: 'Preferences', loading: false, canGoBack: false, canGoForward: false,
    viewport: 'responsive', error: null, driving: false, appLinkPrompt: null, taskAssets: state,
    activity: { operation: current, control: 'human' } }
  const originalState = useAppStore.getState()
  useAppStore.setState({ executeControl, toolsOpen: false })
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(BrowserPane, { tab, visible: true })))
    const trigger = container.querySelector('.browser-operation-status__trigger')!
    expect(trigger).not.toBeNull()
    await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    const open = document.querySelector('[role="menu"] [aria-label="Open browser activity timeline"]')!
    expect(open).not.toBeNull()
    await act(async () => open.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(document.body.textContent).toContain('0/1 outcomes passed')
    expect(host.onVerify).toBeTypeOf('function')
    await act(async () => { await host.onVerify!('older', { nativeEvent: { isTrusted: true } } as MouseEvent<HTMLButtonElement>) })
    expect(getOperation).toHaveBeenCalledExactlyOnceWith('older-operation')
    expect(listOperationHistory).not.toHaveBeenCalled()
    expect(verifyOutcome).toHaveBeenCalledExactlyOnceWith('browser', 'older-operation')
    const reads = executeControl.mock.calls.map(([request]) => request).filter(request => request.operation === 'browser.task.reliability')
    expect(reads).toHaveLength(2); expect(reads[1]).toMatchObject({ browserId: 'browser', assetId: 'asset', version: 1 })
    expect(document.body.textContent).toContain('1/1 outcomes passed')
    expect(tab.activity!.operation!.id).toBe('newer-current-operation')
    const trusted = { nativeEvent: { isTrusted: true } } as MouseEvent<HTMLButtonElement>
    getOperation.mockClear()
    await act(async () => {
      await expect(host.onVerify!('another-run', trusted)).rejects.toThrow('The declared producer is unavailable.')
      await expect(host.onVerify!('older', { nativeEvent: { isTrusted: false } } as MouseEvent<HTMLButtonElement>))
        .rejects.toThrow('Verification requires the actual person')
      expect(getOperation).not.toHaveBeenCalled()
    })

    const renderBoundRun = (operationIds: string[]) => act(async () => root.render(createElement(BrowserPane, { visible: true,
      tab: { ...tab, taskAssets: { ...state, runs: [{ ...state.runs[0]!, operationIds }] } } })))
    await renderBoundRun(['older-operation', 'older-operation', 'missing-operation'])
    await act(async () => { await expect(host.onVerify!('older', trusted)).rejects.toThrow('The declared producer is unavailable.') })
    expect(getOperation.mock.calls).toEqual([['older-operation'], ['missing-operation']])

    getOperation.mockClear()
    const secondId = 'second-matching-operation'
    const second: BrowserOperation = { ...older, id: secondId, outcome: { registration: { assetRun,
      context: { ...context, operationId: secondId }, criteria: [{ ...criterion, producer: { operationId: secondId, navigationId: 'nav' } }] } } }
    getOperation.mockImplementation(async id => id === older.id ? older : id === second.id ? second : null)
    await renderBoundRun([older.id, second.id])
    await act(async () => { await expect(host.onVerify!('older', trusted)).rejects.toThrow('The declared producer is unavailable.') })
    expect(getOperation.mock.calls).toEqual([[older.id], [second.id]])
    expect(verifyOutcome).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount()); container.remove()
    useAppStore.setState(originalState, true); vi.restoreAllMocks()
  }
})
