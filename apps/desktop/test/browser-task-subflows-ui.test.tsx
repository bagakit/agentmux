// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { BrowserTaskAssetEditor } from '../src/renderer/src/components/BrowserTaskAssetEditor'
import type { BrowserTaskAsset, BrowserTaskAssetRun, BrowserTaskContent, BrowserTaskVersion } from '../src/shared/browser-task-assets'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
type Props = ComponentProps<typeof BrowserTaskAssetEditor>
const url = 'https://generic.invalid/form', browserId = 'subflow-browser'
const childVersion: BrowserTaskVersion = { version: 1, savedAt: 1, name: 'Submit item', url,
  parameters: [{ key: 'label', label: 'Item label', secret: false }, { key: 'token', label: 'Access token', secret: true }],
  steps: [{ id: 'fill-label', kind: 'fill', parameterKey: 'label', url, reviewed: true, target: { role: 'text input', name: 'Label', ordinal: 1, count: 1 } }] }
const rootVersion: BrowserTaskVersion = { version: 1, savedAt: 1, name: 'Submit collection', url, parameters: [],
  steps: [{ id: 'collection', kind: 'subflow', label: 'Collection', url, reviewed: true, subflow: { target: { kind: 'local', assetId: 'child-asset', version: 1 }, iteration: 'each' } }] }
const asset = (id: string, version: BrowserTaskVersion, versions = [version]): BrowserTaskAsset => ({ id, browserId, revision: 1, createdAt: 1, updatedAt: 1, draft: version, versions })
const child = asset('child-asset', childVersion, [childVersion, { ...childVersion, name: 'Later revision', version: 2 }]), rootAsset = asset('root-asset', rootVersion)
const run = (id: string, assetId: string, status: BrowserTaskAssetRun['status']): BrowserTaskAssetRun => ({ id, assetId, browserId, version: 1, status, nextStep: status === 'completed' ? 1 : 0, operationIds: [], startedAt: 1, updatedAt: 2 })
function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label)
  expect(found, `Actual ${label} button`).toBeDefined(); return found!
}
async function value(field: HTMLInputElement, text: string) {
  expect(field).toBeInstanceOf(HTMLInputElement)
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, text); field.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function mount(overrides: Partial<Props> = {}) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const onRun = vi.fn<Props['onRun']>(async () => {}), onSaveDraft = vi.fn<Props['onSaveDraft']>(async () => {}), onStop = vi.fn<Props['onStop']>()
  const props: Props = { asset: rootAsset, assets: [rootAsset, child], recording: null, onImport: vi.fn(), onSaveDraft, onSaveVersion: vi.fn(async () => {}), onLocateStep: vi.fn(), onRun, onStop, ...overrides }
  const render = async (next: Partial<Props> = {}) => { Object.assign(props, next); await act(async () => root.render(createElement(BrowserTaskAssetEditor, props))) }
  await render()
  return { host, props, onRun, onStop, onSaveDraft, render, close: async () => { await act(async () => root.unmount()); host.remove() } }
}

describe('the original task editor consumes finite fixed-version subflows', () => {
  it('edits the exact retained callee version and iteration, resets review and excludes page-only controls', async () => {
    const foreign = { ...child, id: 'foreign-asset', browserId: 'other-browser' }, m = await mount({ assets: [rootAsset, child, foreign] })
    try {
      const picker = m.host.querySelector<HTMLSelectElement>('[aria-label="Subflow 1 task version"]')!
      expect([...picker.options].map(option => option.value)).not.toContain(JSON.stringify([foreign.id, 1]))
      expect(picker.value).toBe(JSON.stringify([child.id, 1]))
      await act(async () => { picker.value = JSON.stringify([child.id, 2]); picker.dispatchEvent(new Event('change', { bubbles: true })) })
      const repeat = m.host.querySelector<HTMLSelectElement>('[aria-label="Subflow 1 iteration"]')!
      await act(async () => { repeat.value = 'once'; repeat.dispatchEvent(new Event('change', { bubbles: true })) })
      expect(m.host.querySelector('[aria-label="Locate task step 1"]')).toBeNull()
      expect(m.host.querySelector('[aria-label="Task step 1 on failure"]')).toBeNull()
      expect(m.host.querySelector<HTMLInputElement>('[aria-label="Review task step 1"]')!.checked).toBe(false)
      await act(async () => button(m.host, 'Save draft').click())
      expect(m.onSaveDraft.mock.calls[0]?.[0].steps[0]).toMatchObject({ reviewed: false, subflow: { target: { kind: 'local', assetId: child.id, version: 2 }, iteration: 'once' } })
      expect(rootAsset.versions[0]!.steps[0]!.subflow!.target).toEqual({ kind: 'local', assetId: child.id, version: 1 })
      await act(async () => { picker.value = JSON.stringify([child.id, 1]); picker.dispatchEvent(new Event('change', { bubbles: true })) })
      await act(async () => button(m.host, 'Save draft').click())
      expect(m.onSaveDraft.mock.calls[1]?.[0].steps[0]?.subflow?.target).toEqual({ kind: 'local', assetId: child.id, version: 1 })
    } finally { await m.close() }
  })
  it('sends two nonempty fresh items to fixed v1 and clears callee values after an unknown reply', async () => {
    const m = await mount(); m.onRun.mockRejectedValueOnce(new Error('Original reply unavailable'))
    try {
      await value(m.host.querySelector<HTMLInputElement>('[aria-label="Collection item 1 Item label"]')!, 'first-value')
      await act(async () => button(m.host, 'Add Collection item').click())
      await value(m.host.querySelector<HTMLInputElement>('[aria-label="Collection item 2 Item label"]')!, 'second-value')
      await value(m.host.querySelector<HTMLInputElement>('[aria-label="Collection fresh Access token"]')!, 'private-once-only')
      await act(async () => button(m.host, 'Run version').click())
      expect(m.onRun.mock.calls[0]?.[0]).toMatchObject({ version: 1, calls: { collection: { parameters: { token: 'private-once-only' }, items: [
        { id: expect.any(String), parameters: { label: 'first-value' } }, { id: expect.any(String), parameters: { label: 'second-value' } }
      ] } } })
      expect(m.host.querySelector<HTMLInputElement>('[aria-label="Collection fresh Access token"]')!.value).toBe('')
      expect(m.host.querySelector<HTMLInputElement>('[aria-label="Collection item 2 Item label"]')!.value).toBe('')
      expect(m.host.textContent).toContain('Original reply unavailable'); expect(m.onRun).toHaveBeenCalledOnce()
      expect(JSON.stringify(rootAsset)).not.toContain('private-once-only')
    } finally { await m.close() }
  })
  it('continues the original root and its unchanged items, reads child states and stops the root', async () => {
    const original = { ...run('original-root', rootAsset.id, 'waiting-human'), calls: [{ stepId: 'collection', assetId: child.id, version: 1, nextItem: 1, items: [{ id: 'first', runId: 'completed-child' }, { id: 'second', runId: 'waiting-child' }] }] }
    const runs = [original, { ...run('completed-child', child.id, 'completed'), operationIds: ['retained-operation'] }, { ...run('waiting-child', child.id, 'waiting-human'), pendingCheckpointId: 'child-checkpoint' }]
    const m = await mount({ run: original, batchRuns: runs })
    try {
      expect(m.host.querySelector('[aria-label="Collection item 1 Item label"]')).toBeNull()
      expect(m.host.querySelector('[data-task-subflow-item="first"]')!.getAttribute('data-run-status')).toBe('completed')
      expect(m.host.querySelector('[data-task-subflow-item="second"]')!.getAttribute('data-run-id')).toBe('waiting-child')
      expect([...m.host.querySelectorAll('button')].some(item => item.textContent === 'Add Collection item')).toBe(false)
      await value(m.host.querySelector<HTMLInputElement>('[aria-label="Collection item 2 Item label"]')!, 'fresh-second')
      await value(m.host.querySelector<HTMLInputElement>('[aria-label="Collection fresh Access token"]')!, 'fresh-token')
      await act(async () => button(m.host, 'Return control and continue').click())
      expect(m.onRun.mock.calls[0]?.[0]).toMatchObject({ runId: original.id, calls: { collection: { items: [{ id: 'first', parameters: {} }, { id: 'second', parameters: { label: 'fresh-second' } }] } } })
      await act(async () => button(m.host, 'Stop task').click()); expect(m.onStop.mock.calls[0]?.[0]).toBe(original.id)
      expect(original.calls[0]!.items[0]!.runId).toBe('completed-child')
    } finally { await m.close() }
  })
  it('keeps an imported reference visibly unbound until a local immutable version is selected', async () => {
    const draft: BrowserTaskContent = { ...rootVersion, steps: [{ ...rootVersion.steps[0]!, reviewed: false, subflow: { iteration: 'once', target: { kind: 'imported', source: { assetId: child.id, version: 1 } } } }] }
    const m = await mount({ asset: { ...rootAsset, draft, versions: [] } })
    try {
      expect(m.host.textContent).toContain('Imported reference')
      expect(m.host.querySelector<HTMLInputElement>('[aria-label="Review task step 1"]')!.disabled).toBe(true)
      const picker = m.host.querySelector<HTMLSelectElement>('[aria-label="Subflow 1 task version"]')!
      await act(async () => { picker.value = JSON.stringify([child.id, 1]); picker.dispatchEvent(new Event('change', { bubbles: true })) })
      expect(m.host.querySelector<HTMLInputElement>('[aria-label="Review task step 1"]')!.disabled).toBe(false)
      await act(async () => button(m.host, 'Save draft').click())
      expect(m.onSaveDraft.mock.calls[0]?.[0].steps[0]?.subflow?.target).toEqual({ kind: 'local', assetId: child.id, version: 1 })
    } finally { await m.close() }
  })
  it('keeps repeated local step IDs separate inside nested fresh call items', async () => {
    const leaf = asset('leaf-asset', { ...childVersion, name: 'Leaf entry', parameters: [{ key: 'leaf', label: 'Leaf value', secret: false }] })
    const nested = asset(child.id, { ...childVersion, steps: [{ ...rootVersion.steps[0]!, subflow: { iteration: 'once', target: { kind: 'local', assetId: leaf.id, version: 1 } } }] })
    const m = await mount({ assets: [rootAsset, nested, leaf] })
    try {
      await value(m.host.querySelector<HTMLInputElement>('[aria-label="Collection / Collection item 1 Leaf value"]')!, 'nested-value')
      await act(async () => button(m.host, 'Run version').click())
      expect(m.onRun.mock.calls[0]?.[0].calls?.collection?.items[0]?.calls?.collection?.items[0]?.parameters).toEqual({ leaf: 'nested-value' })
      expect(m.onRun.mock.calls[0]?.[0].calls?.collection?.items[0]?.parameters).toEqual({})
    } finally { await m.close() }
  })
  it('adopts the original manifest arriving after root preparation without minting replacement item IDs', async () => {
    const prepared = run('streamed-root', rootAsset.id, 'ready'), m = await mount({ run: prepared, batchRuns: [prepared] })
    try {
      const original = { ...prepared, calls: [{ stepId: 'collection', assetId: child.id, version: 1, nextItem: 0, items: [{ id: 'retained-first' }, { id: 'retained-second' }] }] }
      await m.render({ run: original, batchRuns: [original] })
      await act(async () => button(m.host, 'Return control and continue').click())
      expect(m.onRun.mock.calls[0]?.[0].calls?.collection?.items.map(item => item.id)).toEqual(['retained-first', 'retained-second'])
    } finally { await m.close() }
  })
})
