// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { NoteFileContext } from '@agentmux/client-ui/components/NoteFileContext'
import { noteKnowledge } from '@agentmux/client-ui/note/note-knowledge'
import { newNoteDocument } from '@agentmux/client-ui/note/note-document'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { spatialCatalog, type SpatialWorkbench } from '../src/renderer/src/lib/space-agent-control'
import { noteResourceReadParams } from '../src/renderer/src/lib/note-history-target'
import { NoteBlockEditor } from '../src/renderer/src/components/NoteBlockEditor'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

function fixture(worktree = false) {
  const root = fixturePath('note-resource-target'), workspace = { id: '__notes__', hostId: 'local', path: root + (worktree ? '/worktree' : ''), name: 'Notebook', kind: worktree ? 'worktree' as const : 'folder' as const, ...(worktree ? { repoPath: root } : {}) }
  const spaceId = directoryIdentity(workspace.hostId, workspace.repoPath ?? workspace.path), defaultZoneId = workspaceZoneId(spaceId, workspace.id), pageZoneId = 'page-workface-zone'
  const tab = { ...createWorkbenchTab('original-page', { kind: 'file', regionId: 'original-region', workspaceId: workspace.id, path: 'original.note.md' }), space: { spaceId, zoneId: pageZoneId } }
  const state: SpatialWorkbench = { config: { ...composerConfig, workspaces: [workspace] }, sessions: [], tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('notebook-group', [tab.id]) },
    spaceZoneBindings: { [pageZoneId]: { spaceId, workspaceId: workspace.id, directoryPath: workspace.path, relations: { [spaceId]: false } } }, spatialRequests: {} }
  const resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: 'original.note.md' }
  return { state, workspace, resource, defaultZoneId, pageZoneId, spaceId }
}
function unavailableDefault(f: ReturnType<typeof fixture>) {
  f.state.spaceZoneBindings[f.defaultZoneId] = { spaceId: f.spaceId, workspaceId: f.workspace.id, directoryPath: f.workspace.path,
    resource: { kind: 'unknown', hostId: null, directoryPath: null, branch: null, issue: 'Original directory observation unavailable' } }
}

const dom = composerDOM(), originalWorker = globalThis.Worker
afterEach(async () => { await dom.render(null); vi.stubGlobal('Worker', originalWorker) })

it('selects the existing stable default directory from the actual Notebook duplicate resource mapping', () => {
  const f = fixture(), before = structuredClone(f.state)
  const zones = spatialCatalog(f.state, []).zones.filter(zone => zone.workspaceId === f.workspace.id && zone.directoryPath === f.workspace.path)
  expect(zones.map(zone => zone.zoneId)).toEqual([f.defaultZoneId, f.pageZoneId])
  expect(spatialCatalog(f.state, []).bindings.some(binding => binding.zoneId === f.pageZoneId)).toBe(false)
  expect(noteResourceReadParams(f.state, [], f.resource)).toEqual({ zoneId: f.defaultZoneId, path: f.resource.path,
    expectedResource: { hostId: f.resource.hostId, workspaceId: f.resource.workspaceId, workspacePath: f.resource.workspacePath } })
  expect(f.state).toEqual(before)
})
it('uses the original worktree factory identity while retaining its exact physical workspace path', () => {
  const f = fixture(true), params = noteResourceReadParams(f.state, [], f.resource)
  expect(params.zoneId).toBe(f.defaultZoneId)
  expect(params.expectedResource!.workspacePath).toBe(f.workspace.path)
  expect(params.zoneId).not.toBe(workspaceZoneId(directoryIdentity(f.workspace.hostId, f.workspace.path), f.workspace.id))
})
it('keeps multiple nondefault mappings unknown when the default directory is not an eligible candidate', () => {
  const f = fixture(); unavailableDefault(f)
  f.state.spaceZoneBindings['another-page-zone'] = { ...f.state.spaceZoneBindings[f.pageZoneId]! }
  expect(() => noteResourceReadParams(f.state, [], f.resource)).toThrow('directory mapping is unconfirmed')
  f.state.spaceZoneBindings[f.defaultZoneId] = { ...f.state.spaceZoneBindings[f.defaultZoneId]!, resource: { kind: 'directory', hostId: 'foreign', directoryPath: f.workspace.path, branch: null } }
  expect(() => noteResourceReadParams(f.state, [], f.resource)).toThrow('directory mapping is unconfirmed')
  f.state.spaceZoneBindings[f.defaultZoneId] = { ...f.state.spaceZoneBindings[f.defaultZoneId]!, resource: { kind: 'directory', hostId: f.workspace.hostId, directoryPath: f.workspace.path + '/other', branch: null } }
  expect(() => noteResourceReadParams(f.state, [], f.resource)).toThrow('directory mapping is unconfirmed')
})
it('retains the existing exact single nondefault directory mapping without inventing a default', () => {
  const f = fixture(); unavailableDefault(f)
  expect(noteResourceReadParams(f.state, [], f.resource).zoneId).toBe(f.pageZoneId)
})
it('never grants a changed Host, Workspace root or outside path the stable default identity', () => {
  const f = fixture()
  for (const resource of [{ ...f.resource, hostId: 'foreign' }, { ...f.resource, workspacePath: f.workspace.path + '/changed' }, { ...f.resource, workspaceId: 'other-workspace' }]) expect(() => noteResourceReadParams(f.state, [], resource)).toThrow('Workspace changed')
  for (const path of ['../outside.png', 'nested/../../outside.png', new URL("outside.png", new URL('/', import.meta.url)).pathname]) expect(() => noteResourceReadParams(f.state, [], { ...f.resource, path })).toThrow('directory mapping is unconfirmed')
})
it('the original Notebook chooser reads and imports through the default directory before inserting the image draft', async () => {
  const f = fixture(), save = vi.fn()
  useAppStore.setState({ ...f.state })
  installNoteCanvasGeometry(); vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  const reads = vi.spyOn(api.files, 'readPublic').mockImplementation(async params => ({ resource: { ...params.expectedResource, zoneId: params.zoneId, zonePath: f.workspace.path, path: params.path }, result: { status: 'deleted' } }))
  const imports = vi.spyOn(api.files, 'importPublic').mockImplementation(async params => ({ operationId: params.operationId, resource: params.expectedResource, result: { status: 'written', revision: params.revision, byteLength: params.byteLength } }))
  vi.spyOn(api.files, 'readPreview').mockResolvedValue({ status: 'deleted', message: 'Source retained' })
  await dom.render(<NoteFileContext.Provider value={f.resource}><NoteBlockEditor note={newNoteDocument('Original draft', 'original-note', 'body')} knowledge={noteKnowledge([])} onChange={() => {}} onSave={save} onIssue={() => {}} onOpen={() => {}} /></NoteFileContext.Provider>)
  const input = dom.container.querySelector<HTMLInputElement>('input[type="file"]')!
  expect(input).not.toBeNull()
  Object.defineProperty(input, 'files', { configurable: true, value: [new File([new Uint8Array([0, 1, 2])], 'original.png', { type: 'image/png' })] })
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
  await vi.waitFor(() => expect(imports).toHaveBeenCalledTimes(1))
  expect(reads.mock.calls[0]![0]).toMatchObject({ zoneId: f.defaultZoneId, path: expect.stringMatching(/^attachment-.*-original\.png$/), expectedResource: { hostId: f.workspace.hostId, workspaceId: f.workspace.id, workspacePath: f.workspace.path } })
  expect(imports.mock.calls[0]![0]).toMatchObject({ zoneId: f.defaultZoneId, expectedRevision: null, expectedResource: { zoneId: f.defaultZoneId, zonePath: f.workspace.path } })
  const editor = (dom.container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor
  await vi.waitFor(() => expect(editor.getJSON().content![0]!.content!.some(node => node.type === 'image')).toBe(true))
  expect(editor.getText()).toContain('Original draft'); expect(save).not.toHaveBeenCalled()
})
