// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { BrowserTaskAssets, type BrowserTaskAssetStore } from '../src/main/browser-task-assets'
import { BrowserTaskAssetEditor } from '../src/renderer/src/components/BrowserTaskAssetEditor'
import type { BrowserTaskAsset, BrowserTaskAssetDocument, BrowserTaskContent, BrowserTaskStep } from '../src/shared/browser-task-assets'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const url = 'https://generic.invalid/form', browserId = 'editor-browser'
const target = (name: string) => ({ role: 'button', name, ordinal: 1, count: 1 })
class MemoryStore implements BrowserTaskAssetStore {
  document: BrowserTaskAssetDocument | null = null
  async load() { return structuredClone(this.document) }
  async save(value: BrowserTaskAssetDocument) { this.document = structuredClone(value) }
}
const steps: BrowserTaskStep[] = [
  { id: 'wait', kind: 'wait', url, reviewed: false, wait: { kind: 'element-present', target: { role: 'status', name: 'Ready' } }, timeoutMs: 2_000 },
  { id: 'assert', kind: 'assert', url, reviewed: false, assert: { kind: 'text-present', text: 'Saved' } },
  { id: 'press', kind: 'press', url, reviewed: true, target: target('Search'), key: 'Enter' },
  { id: 'hover', kind: 'hover', url, reviewed: true, target: target('Menu') },
  { id: 'scroll', kind: 'scroll', url, label: 'Reach the footer', reviewed: true, target: target('Footer') }
]
async function render() {
  let sequence = 0, now = 20
  const owner = new BrowserTaskAssets(new MemoryStore(), { id: () => `editor-${++sequence}`, now: () => now++ })
  const imported = await owner.importRecording({ id: 'real-recording', browserId, navigationId: 'nav', url, revision: 1, status: 'stopped', startedAt: 1, updatedAt: 2, steps: [] })
  const asset: BrowserTaskAsset = await owner.edit(imported.id, imported.revision, { ...imported.draft, steps })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const saved: BrowserTaskContent[] = []
  await act(async () => { root.render(createElement(BrowserTaskAssetEditor, { asset, recording: null, onImport: vi.fn(), onSaveDraft: async draft => { saved.push(draft) },
    onSaveVersion: vi.fn(), onLocateStep: vi.fn(), onRun: vi.fn(), onStop: vi.fn() })) })
  const select = (label: string) => container.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!
  const choose = async (label: string, value: string) => { await act(async () => { select(label).value = value; select(label).dispatchEvent(new Event('change', { bubbles: true })) }) }
  const save = async () => { await act(async () => { [...container.querySelectorAll('button')].find(button => button.textContent === 'Save draft')!.click() }) }
  const review = (index: number) => container.querySelector<HTMLInputElement>(`[aria-label="Review task step ${index}"]`)!
  return { owner, asset, container, select, choose, save, saved, review, unmount: () => { act(() => root.unmount()); container.remove() } }
}

describe('testing steps in the task editor', () => {
  it('names every new step with its key parameter', async () => {
    const view = await render()
    try {
      const titles = [...view.container.querySelectorAll('[data-task-step-id] strong')].map(node => node.textContent)
      expect(titles).toEqual(['Wait until present · status "Ready" · 2 s', 'Assert text present · "Saved"', 'Press Enter · Search', 'Hover · Menu', 'Reach the footer'])
      expect(view.container.querySelector('[data-task-step-id="scroll"] [data-task-step-summary]')?.textContent).toBe('Scroll to · Footer')
      // Wait and assert read page facts; they have no element target to locate before review.
      expect(view.review(1).disabled).toBe(false); expect(view.review(2).disabled).toBe(false)
    } finally { view.unmount() }
  })

  it('saves a compact retry and failure choice that the owner accepts and keeps', async () => {
    const view = await render()
    try {
      expect([...view.select('Task step 2 on failure').options].map(option => option.textContent)).toEqual(['Stop the run', 'Continue, record failure', 'Go to 3 · Search', 'Go to 4 · Menu', 'Go to 5 · Reach the footer'])
      expect([...view.select('Task step 2 retries').options].map(option => option.value)).toEqual(['0', '1', '2', '3'])
      await view.choose('Task step 2 retries', '2')
      await view.choose('Task step 2 on failure', 'goto:scroll')
      await view.choose('Task step 3 on failure', 'continue')
      await view.save()
      const draft = view.saved.at(-1)!
      expect(draft.steps.find(step => step.id === 'assert')).toMatchObject({ retry: 2, onFail: { goto: 'scroll' } })
      expect(draft.steps.find(step => step.id === 'press')).toMatchObject({ onFail: 'continue' })
      expect(draft.steps.find(step => step.id === 'hover')).not.toHaveProperty('onFail')
      expect(draft.steps.find(step => step.id === 'hover')).not.toHaveProperty('retry')
      const edited = await view.owner.edit(view.asset.id, view.asset.revision, draft)
      expect(edited.draft.steps.find(step => step.id === 'assert')).toMatchObject({ retry: 2, onFail: { goto: 'scroll' } })
      // Back to the defaults removes the fields instead of saving stop / 0.
      await view.choose('Task step 2 retries', '0')
      await view.choose('Task step 2 on failure', 'stop')
      await view.save()
      expect(view.saved.at(-1)!.steps.find(step => step.id === 'assert')).not.toHaveProperty('onFail')
      expect(view.saved.at(-1)!.steps.find(step => step.id === 'assert')).not.toHaveProperty('retry')
    } finally { view.unmount() }
  })
})
