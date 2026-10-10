// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { RetainedDocumentDraftNotice } from '../src/renderer/src/components/RetainedDocumentDraftNotice'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import type { FileDocument } from '../src/shared/contracts'

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!, path = 'original.txt', regionId = 'kept-region', tabId = 'kept-tab'
const key = documentKey(workspace.id, path)
const surface = { kind: 'file' as const, regionId, workspaceId: workspace.id, path }
const resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path }
const selected: FileDocument = { path, content: 'The selected readable draft', revision: 'original-revision', noteEditing: {
  attempt: { operationId: 'original-unknown-operation', noteId: null, content: 'Original submitted input', expectedRevision: 'original-revision', generation: 1, resource, phase: 'unknown' },
  input: { baseContent: 'Exact base B', observedContent: 'Observed D', proposedContent: 'Input L', resource, phase: 'conflict', queued: [{ baseContent: 'Other editor Z', proposedContent: 'Later P' }] }
} }
beforeEach(() => {
  useAppStore.setState({ tabs: { [tabId]: createWorkbenchTab(tabId, surface) }, documents: { [key]: { path, content: 'Newest current draft', revision: 'saved-revision' } }, retainedDocumentDrafts: { [key]: [selected] } })
  vi.spyOn(api.files, 'read').mockRejectedValue(Error('Reviewing kept inputs must not read or write a file'))
  vi.spyOn(api.files, 'write').mockRejectedValue(Error('Selecting a kept draft is not Save'))
})
async function mount(active = true) {
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}><RetainedDocumentDraftNotice tabId={tabId} surface={surface} /></WorkbenchPresentationContext.Provider>)
}
async function expand(selector: string) {
  const details = dom.container.querySelector<HTMLDetailsElement>(selector)!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
}

it('shows retained original inputs only after explicit expansion in an active view', async () => {
  await mount(false); await expand('.note-version-history')
  expect(dom.container.querySelector('pre')).toBeNull()
  await mount()
  expect(dom.container.textContent).toContain('The selected readable draft')
  const nested = dom.container.querySelectorAll<HTMLDetailsElement>('.note-conversion-backup__content details')
  await act(async () => nested.forEach(details => { details.open = true; details.dispatchEvent(new Event('toggle')) }))
  const text = dom.container.textContent!
  for (const raw of ['original-unknown-operation', 'Original submitted input', 'Exact base B', 'Observed D', 'Input L', 'Other editor Z', 'Later P']) expect(text).toContain(raw)
  expect(text).toContain('does not replay or confirm')
  expect(api.files.read).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})

it('selects the exact reviewed draft while retaining newer input and never activating its old unknown operation', async () => {
  await mount(); await expand('.note-version-history')
  await dom.click('.note-version-history .note-text-button')
  const state = useAppStore.getState()
  expect(state.documents[key]!.content).toBe(selected.content)
  expect(state.documents[key]!.noteEditing?.attempt).toBeUndefined()
  expect(state.retainedDocumentDrafts[key]!.some(draft => draft.content === 'Newest current draft')).toBe(true)
  // Removing it from the review list must not discard the original unknown request and queued inputs.
  expect(state.retainedDocumentDrafts[key]!.some(draft => draft.noteEditing?.attempt?.operationId === 'original-unknown-operation')).toBe(true)
  expect(state.dirtyDocuments[key]).toBe(true); expect(api.files.write).not.toHaveBeenCalled()
})
