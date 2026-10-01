// @vitest-environment happy-dom
// Actual saved-version component consumers; no native clipboard, input, Browser, or restart claim.
import { act, createElement, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { BrowserTaskBatchEditor } from '../src/renderer/src/components/BrowserTaskBatchEditor'
import { BrowserTaskAssetEditor } from '../src/renderer/src/components/BrowserTaskAssetEditor'
import type { BrowserTaskAsset, BrowserTaskAssetRun, BrowserTaskBatchRun, BrowserTaskVersion } from '../src/shared/browser-task-assets'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
type BatchProps = ComponentProps<typeof BrowserTaskBatchEditor>
const version: BrowserTaskVersion = { version: 1, savedAt: 1, name: 'Original saved items', url: 'https://fixture.invalid/form',
  parameters: [{ key: 'item', label: 'Item value', secret: false }, { key: 'secret', label: 'Fresh token', secret: true }],
  steps: [{ id: 'item-step', kind: 'fill', url: 'https://fixture.invalid/form', reviewed: true, parameterKey: 'item', target: { role: 'text input', name: 'Item', ordinal: 1, count: 1 } },
    { id: 'secret-step', kind: 'fill', url: 'https://fixture.invalid/form', reviewed: true, parameterKey: 'secret', target: { role: 'text input', name: 'Token', ordinal: 1, count: 1 } }] }
const batch: BrowserTaskBatchRun = { id: 'original-batch', browserId: 'original-browser', assetId: 'original-asset', version: 1,
  items: [{ id: 'first', runId: 'first-run' }, { id: 'second', runId: 'second-run' }], nextItem: 1, status: 'waiting-human', operationCount: 1, executedMillis: 1, startedAt: 1, updatedAt: 2, warning: 'Review the person checkpoint.' }
const runs: BrowserTaskAssetRun[] = [{ id: 'first-run', browserId: batch.browserId, assetId: batch.assetId, version: 1, nextStep: 2, status: 'completed', operationIds: ['first-operation'], startedAt: 1, updatedAt: 2 },
  { id: 'second-run', browserId: batch.browserId, assetId: batch.assetId, version: 1, nextStep: 0, status: 'waiting-human', operationIds: [], startedAt: 2, updatedAt: 2 }]
function button(host: HTMLElement, label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)
  expect(result, `Actual ${label} button`).toBeDefined(); return result!
}
async function value(field: HTMLInputElement, text: string) {
  expect(field).toBeInstanceOf(HTMLInputElement)
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function mount(original: BrowserTaskBatchRun | null = null) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const onRun = vi.fn<BatchProps['onRun']>(async () => {}), onStop = vi.fn<BatchProps['onStop']>()
  const render = async (selectedVersion = version, selected = original) => {
    await act(async () => root.render(createElement(BrowserTaskBatchEditor, { version: selectedVersion, batch: selected, runs, busy: false, onRun, onStop })))
  }
  await render()
  return { host, onRun, onStop, render, close: async () => { await act(async () => root.unmount()); host.remove() } }
}
describe('saved-version batch input remains bounded and transient', () => {
  it('invokes the saved version with two actual item inputs and clears the fresh secret afterwards', async () => {
    const m = await mount()
    try {
      await value(m.host.querySelector<HTMLInputElement>('[aria-label="Batch item 1 Item value"]')!, 'first-value')
      await act(async () => button(m.host, 'Add item').click())
      await value(m.host.querySelector<HTMLInputElement>('[aria-label="Batch item 2 Item value"]')!, 'second-value')
      await value(m.host.querySelector<HTMLInputElement>('[aria-label="Batch fresh Fresh token"]')!, 'once-only')
      await act(async () => button(m.host, 'Run batch').click())
      expect(m.onRun).toHaveBeenCalledOnce()
      expect(m.onRun.mock.calls[0]?.[0]).toMatchObject({ version: 1, items: [{ id: expect.any(String), parameters: { item: 'first-value' } }, { id: expect.any(String), parameters: { item: 'second-value' } }], parameters: { secret: 'once-only' } })
      expect(m.host.querySelector<HTMLInputElement>('[aria-label="Batch fresh Fresh token"]')!.value).toBe('')
      expect(m.host.textContent).toContain('2 items'); expect(m.host.querySelectorAll('[data-task-batch-item]')).toHaveLength(2)
    } finally { await m.close() }
  })
  it('retains original completed item IDs while the current checkpoint asks for fresh values and Stop names only this group', async () => {
    const m = await mount(batch)
    try {
      expect(m.host.textContent).toContain('1/2 · waiting-human'); expect(m.host.textContent).toContain('Review the person checkpoint.')
      expect(m.host.querySelectorAll('[data-task-batch-item]')).toHaveLength(2)
      expect(m.host.querySelector('[aria-label="Batch item 1 Item value"]')).toBeNull()
      await value(m.host.querySelector<HTMLInputElement>('[aria-label="Batch item 2 Item value"]')!, 'fresh-second')
      await value(m.host.querySelector<HTMLInputElement>('[aria-label="Batch fresh Fresh token"]')!, 'new-token')
      await act(async () => button(m.host, 'Return control and continue batch').click())
      expect(m.onRun.mock.calls[0]?.[0]).toMatchObject({ batchId: batch.id, items: [{ id: 'first', parameters: {} }, { id: 'second', parameters: { item: 'fresh-second' } }], parameters: { secret: 'new-token' } })
      await act(async () => button(m.host, 'Stop batch').click()); expect(m.onStop.mock.calls[0]?.[0]).toBe(batch.id)
      expect(batch.items).toEqual([{ id: 'first', runId: 'first-run' }, { id: 'second', runId: 'second-run' }])
    } finally { await m.close() }
  })
  it('will not expand past 16 items and resets values on a different immutable version', async () => {
    const m = await mount()
    try {
      for (let index = 1; index < 16; index++) await act(async () => button(m.host, 'Add item').click())
      expect(m.host.querySelectorAll('[data-task-batch-item]')).toHaveLength(16); expect(button(m.host, 'Add item').disabled).toBe(true)
      await value(m.host.querySelector<HTMLInputElement>('[aria-label="Batch item 1 Item value"]')!, 'old-version-value')
      await value(m.host.querySelector<HTMLInputElement>('[aria-label="Batch fresh Fresh token"]')!, 'old-version-secret')
      await m.render({ ...version, version: 2 })
      expect(m.host.querySelectorAll('[data-task-batch-item]')).toHaveLength(1)
      expect(m.host.querySelector<HTMLInputElement>('[aria-label="Batch item 1 Item value"]')!.value).toBe('')
      expect(m.host.querySelector<HTMLInputElement>('[aria-label="Batch fresh Fresh token"]')!.value).toBe('')
      expect(m.onRun).not.toHaveBeenCalled()
    } finally { await m.close() }
  })
  it('a terminal group requires an explicit New batch with different IDs instead of replaying it', async () => {
    const m = await mount({ ...batch, status: 'interrupted' })
    try {
      expect(button(m.host, 'Return control and continue batch').disabled).toBe(true)
      await act(async () => button(m.host, 'New batch').click())
      expect(m.host.querySelectorAll('[data-task-batch-item]')).toHaveLength(1)
      expect(m.host.querySelector('[data-task-batch-item]')!.getAttribute('data-task-batch-item')).not.toBe('first')
      await act(async () => button(m.host, 'Run batch').click())
      expect(m.onRun.mock.calls[0]?.[0]).not.toHaveProperty('batchId')
    } finally { await m.close() }
  })
  it('the real AssetEditor mounts batch input only at the selected saved version', async () => {
    const asset: BrowserTaskAsset = { id: batch.assetId, browserId: batch.browserId, sourceRecordingId: 'recording', revision: 1, createdAt: 1, updatedAt: 2, draft: version, versions: [version] }
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host), onRunBatch = vi.fn<BatchProps['onRun']>(async () => {})
    try {
      await act(async () => root.render(createElement(BrowserTaskAssetEditor, { asset, recording: null, batch, batchRuns: runs, onRunBatch, onStopBatch: vi.fn(),
        onImport: vi.fn(), onSaveDraft: vi.fn(async () => {}), onSaveVersion: vi.fn(async () => {}), onLocateStep: vi.fn(), onRun: vi.fn(async () => {}), onStop: vi.fn() })))
      expect(host.querySelector('[aria-label="Task asset version"]')).not.toBeNull()
      expect(host.querySelectorAll('[data-task-batch-item]')).toHaveLength(2)
      const labels = [...host.querySelectorAll('button')].map(button => button.textContent)
      expect(labels).toContain('Return control and continue batch')
      expect(labels).not.toContain('Run version'); expect(labels).not.toContain('Run next step')
      await act(async () => button(host, 'Return control and continue batch').click())
      expect(onRunBatch).toHaveBeenCalledOnce(); expect(onRunBatch.mock.calls[0]?.[0]).toMatchObject({ version: 1, batchId: batch.id })
    } finally { await act(async () => root.unmount()); host.remove() }
  })
})
