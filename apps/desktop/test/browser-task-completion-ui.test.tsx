// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { BrowserTaskAssetEditor } from '../src/renderer/src/components/BrowserTaskAssetEditor'
import type { BrowserTaskAsset, BrowserTaskContent } from '../src/shared/browser-task-assets'
import type { BrowserOutcomeEvaluation } from '../src/shared/browser-outcome-criteria'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const draft: BrowserTaskContent = { name: 'Finite task', url: 'https://generic.invalid/form', parameters: [], steps: [
  { id: 'producer', kind: 'click', url: 'https://generic.invalid/form', target: { role: 'button', name: 'Create file', ordinal: 1, count: 1 }, reviewed: true },
  { id: 'confirm', kind: 'checkpoint', url: 'https://generic.invalid/form', label: 'Inspect file', reviewed: true }
] }
const asset: BrowserTaskAsset = { id: 'asset-a', browserId: 'browser-a', sourceRecordingId: 'recording-a', revision: 1,
  draft, versions: [{ ...draft, completion: { criteria: [{ kind: 'human-checkpoint', checkpointId: 'confirm' }] }, version: 1, savedAt: 1 }], createdAt: 1, updatedAt: 1 }
const evaluation: BrowserOutcomeEvaluation = { context: { workspaceId: 'workspace-a', browserId: 'browser-a', operationId: 'producer-a', navigationId: 'nav-a' },
  assetRun: { runId: 'run-a', assetId: 'asset-a', version: 1 }, status: 'not-met',
  conditions: [{ criterion: { kind: 'human-checkpoint', checkpointId: 'confirm' }, status: 'not-met', reason: 'This checkpoint has no recorded trusted Continue event.' }] }
async function mount() {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const onSaveVersion = vi.fn(async (_content: BrowserTaskContent) => {})
  const onVerify = vi.fn(async (_runId: string) => evaluation)
  const onRun = vi.fn(async () => {})
  await act(async () => root.render(createElement(BrowserTaskAssetEditor, { asset, recording: null,
    run: { id: 'run-a', browserId: 'browser-a', assetId: 'asset-a', version: 1, nextStep: 2, status: 'waiting-human', operationIds: ['producer-a'],
      pendingCheckpointId: 'confirm', humanCheckpoints: [], startedAt: 1, updatedAt: 2 },
    onImport: () => {}, onSaveDraft: async () => {}, onSaveVersion, onLocateStep: () => {}, onRun, onStop: () => {}, onVerify })))
  return { container, onSaveVersion, onVerify, onRun, close: async () => { await act(async () => root.unmount()); container.remove() } }
}
describe('finite completion inside the actual asset editor', () => {
  it('saves an explicit checkpoint declaration in the draft without changing the running immutable version or executing it', async () => {
    const f = await mount()
    try {
      expect(f.container.querySelector('[aria-label="Download path for producer"]')).not.toBeNull()
      const checkbox = f.container.querySelector<HTMLInputElement>('[aria-label="Require checkpoint confirm"]')!
      expect(checkbox.checked).toBe(false)
      await act(async () => checkbox.click())
      expect(checkbox.checked).toBe(true)
      await act(async () => Array.from(f.container.querySelectorAll('button')).find(button => button.textContent === 'Save version')!.click())
      expect(f.onSaveVersion.mock.calls[0]?.[0].completion).toEqual({ criteria: [{ kind: 'human-checkpoint', checkpointId: 'confirm' }] })
      expect(asset.versions[0]?.completion).toEqual({ criteria: [{ kind: 'human-checkpoint', checkpointId: 'confirm' }] })
      expect(f.onRun).not.toHaveBeenCalled()
    } finally { await f.close() }
  })
  it('verifies the existing run through its callback and shows the actual three-state result without auto-confirming or executing', async () => {
    const f = await mount()
    try {
      const buttons = Array.from(f.container.querySelectorAll('button'))
      expect(buttons.length).toBeGreaterThan(0)
      await act(async () => buttons.find(button => button.textContent === 'Verify task evidence')!.click())
      expect(f.onVerify).toHaveBeenCalledTimes(1)
      expect(f.onVerify.mock.calls[0]?.[0]).toBe('run-a')
      expect(f.container.querySelector('[data-task-completion]')?.getAttribute('data-task-completion')).toBe('not-met')
      expect(f.container.textContent).toContain('Not satisfied')
      expect(f.container.textContent).toContain(evaluation.conditions[0]!.reason)
      expect(f.onRun).not.toHaveBeenCalled()
      expect(f.container.querySelector('.browser-task-asset__progress')?.getAttribute('data-run-status')).toBe('waiting-human')
    } finally { await f.close() }
  })
})
