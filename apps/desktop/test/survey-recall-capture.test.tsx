import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { applyNotebookChange, emptyNotebookState, type NotebookState } from '@agentmux/core/notebook-catalog'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { saveSurveyToRecall, type SurveyRecallCapture as CaptureTarget } from '../src/renderer/src/lib/survey-recall-capture'
import { SurveyRecallCapture } from '../src/renderer/src/components/SurveyRecallCapture'
import { NOTES_WORKSPACE_ID } from '../src/shared/notes-library'
import { newNoteDocument } from '../src/shared/note-document'

const dom = composerDOM()
const notes = { id: NOTES_WORKSPACE_ID, name: 'Recall', hostId: 'local', path: _hygiene_fixturePath("home/notes"), kind: 'folder' as const }
const target: CaptureTarget = { draftId: 'capture:first-page', source: { sourceId: 'original-source', url: 'https://source.test/finding', title: 'Original source', recordedAt: 123,
  position: { zoneId: 'browser-zone', tabId: 'browser-tab', regionId: 'browser-region' } } }
let catalog: NotebookState
const body = new Map<string, { content: string; revision: string }>()
beforeEach(() => {
  body.clear(); catalog = emptyNotebookState()
  useNotebookLibrary.setState({ state: catalog, issue: null })
  useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [...composerConfig.workspaces, notes] }, mainSurface: 'survey',
    surveyZoneSelection: { zoneId: 'browser-zone', selection: [{ tabId: 'browser-tab', regionId: 'browser-region' }], active: { tabId: 'browser-tab', regionId: 'browser-region' } },
    recallNotebookId: null, recallNoteId: null, recallZoneSelection: null, layouts: {} })
  vi.spyOn(api.notebooks, 'read').mockImplementation(async () => structuredClone(catalog))
  vi.spyOn(api.notebooks, 'apply').mockImplementation(async input => { catalog = applyNotebookChange(catalog, input, { kind: 'user', id: 'capture-user' }, Date.now()); return structuredClone(catalog) })
  vi.spyOn(api.files, 'createPublic').mockImplementation(async (input) => { body.set(input.path, { content: input.content, revision: 'original-written-revision' }); return { resource: input.expectedResource, result: { status: 'written', revision: 'original-written-revision' } } })
  vi.spyOn(api.files, 'readPublic').mockImplementation(async input => ({ resource: { ...input.expectedResource, zoneId: input.zoneId, zonePath: notes.path, path: input.path }, result: body.has(input.path) ? { status: 'read', document: { path: input.path, ...body.get(input.path)! } } : { status: 'deleted' } }))
  vi.spyOn(api.files, 'read').mockImplementation(async (_workspaceId, path) => body.has(path) ? { status: 'read', document: { path, ...body.get(path)! } } : { status: 'deleted' })
  vi.spyOn(useAppStore.getState(), 'createWorkbenchZone').mockImplementation(async input => ({ zone: { zoneId: 'notes-zone', kind: 'temporary', workspaceId: input.workspaceId, hostId: 'local', directoryPath: notes.path, name: 'Notes' }, save: { state: 'saved', durable: true }, issues: [] } as never))
})

it('cancels without creating a Note, keeps its input, and reopens the same draft', async () => {
  const close = vi.fn()
  await dom.render(<SurveyRecallCapture target={target} onClose={close} />)
  await act(async () => useLauncherState.getState().setDraft(target.draftId, 'note', 'A finding to keep'))
  await act(async () => (document.querySelector('.survey-recall-capture footer button') as HTMLButtonElement).click())
  expect(close).toHaveBeenCalledOnce()
  expect(api.files.createPublic).not.toHaveBeenCalled(); expect(api.notebooks.apply).not.toHaveBeenCalled()
  expect(useAppStore.getState().createWorkbenchZone).not.toHaveBeenCalled()
  await dom.render(<SurveyRecallCapture target={null} onClose={close} />)
  await dom.render(<SurveyRecallCapture target={target} onClose={close} />)
  expect((document.querySelector('[aria-label="Recall finding"]') as HTMLTextAreaElement).value).toBe('A finding to keep')
})

it('saves a finding to the exact Notebook and preserves its original URL without moving browser navigation', async () => {
  catalog = applyNotebookChange(catalog, { expectedRevision: catalog.revision, operationId: 'new-book', change: { kind: 'create', notebookId: 'chosen-notebook', name: 'Chosen notebook' } }, { kind: 'user', id: 'capture-user' }, 1)
  const before = useAppStore.getState().surveyZoneSelection
  expect(useAppStore.getState().layouts[notes.id]).toBeUndefined()
  const saved = await saveSurveyToRecall(target, 'chosen-notebook', 'Remember this finding')
  expect(saved.status).toBe('written'); expect(saved.notebookRegistered).toBe(true)
  expect(useAppStore.getState().layouts[notes.id]).toBeDefined()
  expect(useAppStore.getState().layouts[notes.id]?.activeGroupId).toBe(saved.target.groupId)
  expect(api.files.createPublic).toHaveBeenCalledExactlyOnceWith({ zoneId: 'notes-zone', expectedResource: { hostId: 'local', workspaceId: notes.id, workspacePath: notes.path, zoneId: 'notes-zone', zonePath: notes.path, path: saved.path }, path: saved.path, content: JSON.stringify(newNoteDocument(saved.draft, saved.noteId, saved.blockIds[0]!), null, 2), expectedRevision: null })
  expect(catalog.pages[saved.noteId]!.notebookId).toBe('chosen-notebook')
  expect(catalog.pages[saved.noteId]!.sources).toEqual([target.source])
  expect(catalog.pages[saved.noteId]!.resource.workspacePath).toBe(notes.path)
  expect(useAppStore.getState().mainSurface).toBe('survey'); expect(useAppStore.getState().surveyZoneSelection).toBe(before)
})

it('the mounted Save finding action saves through production owners and offers an explicit Recall open action', async () => {
  const close = vi.fn(), navigation = useAppStore.getState().surveyZoneSelection
  await dom.render(<SurveyRecallCapture target={target} onClose={close} />)
  await act(async () => useLauncherState.getState().setDraft(target.draftId, 'note', 'A mounted finding'))
  await act(async () => (document.querySelector('.survey-recall-capture .primary-button') as HTMLButtonElement).click())
  expect(api.files.createPublic).toHaveBeenCalledOnce()
  expect(JSON.parse([...body.values()][0]!.content).content.content[0].content[0].text).toBe('A mounted finding')
  expect(Object.values(catalog.pages)[0]!.sources).toEqual([target.source])
  expect(document.body.textContent).toContain('Saved to 随手记.')
  expect(document.body.textContent).toContain('Open in Recall')
  expect(useAppStore.getState().mainSurface).toBe('survey'); expect(useAppStore.getState().surveyZoneSelection).toBe(navigation)
  expect(close).not.toHaveBeenCalled()
})

it('checks a lost file reply against the same Note identity and never repeats that write or retargets its source', async () => {
  vi.mocked(api.files.createPublic).mockImplementationOnce(async (input) => { body.set(input.path, { content: input.content, revision: 'confirmed-original' }); return { resource: input.expectedResource, result: { status: 'unknown', code: 'REPLY_LOST', message: 'Original reply was lost' } } })
  const first = await saveSurveyToRecall(target, 'quick-notes', 'Original input')
  expect(first.status).toBe('unknown'); expect(api.notebooks.apply).toHaveBeenCalledTimes(1) // Only the workface bind.
  const confirmed = await saveSurveyToRecall({ ...target, source: { ...target.source, url: 'https://later.test/', sourceId: 'later-source' } }, 'other-book', 'Later input')
  expect(confirmed.status).toBe('written'); expect(confirmed.noteId).toBe(first.noteId); expect(confirmed.path).toBe(first.path)
  expect(api.files.createPublic).toHaveBeenCalledOnce(); expect(catalog.pages[first.noteId]!.sources).toEqual([target.source])
  expect(catalog.pages[first.noteId]!.notebookId).toBe('quick-notes')
})

it('keeps unknown missing or conflicting target bytes without replacing them', async () => {
  vi.mocked(api.files.createPublic).mockResolvedValueOnce({ resource: null, result: { status: 'unknown', code: 'REPLY_LOST', message: 'Unknown write' } })
  const first = await saveSurveyToRecall(target, 'quick-notes', 'Original input')
  const missing = await saveSurveyToRecall(target, 'quick-notes', 'Newer input')
  expect(missing.status).toBe('unknown'); expect(missing.noteId).toBe(first.noteId)
  body.set(first.path, { content: JSON.stringify(newNoteDocument('Other data', 'another-note', 'another-block')), revision: 'foreign' })
  const conflicting = await saveSurveyToRecall(target, 'quick-notes', 'Newer input')
  expect(conflicting.status).toBe('unknown'); expect(api.files.createPublic).toHaveBeenCalledOnce()
  expect(Object.keys(catalog.pages)).toHaveLength(0)
})

it('recovers a lost Notebook reply with the original operation and leaves one original page and trail event', async () => {
  let loseRegister = true
  vi.mocked(api.notebooks.apply).mockImplementation(async input => {
    catalog = applyNotebookChange(catalog, input, { kind: 'user', id: 'capture-user' }, Date.now())
    if (input.change.kind === 'register' && loseRegister) { loseRegister = false; throw new Error('Notebook reply lost') }
    return structuredClone(catalog)
  })
  const first = await saveSurveyToRecall(target, 'quick-notes', 'Original input')
  expect(first.notebookRegistered).toBeUndefined(); expect(first.notebookIssue).toMatch(/unconfirmed/)
  const recovered = await saveSurveyToRecall(target, 'quick-notes', 'Later input')
  expect(recovered.notebookRegistered).toBe(true); expect(api.files.createPublic).toHaveBeenCalledOnce()
  expect(Object.keys(catalog.pages)).toEqual([first.noteId]); expect(catalog.trail.filter(event => event.action === 'created')).toHaveLength(1)
  const registers = vi.mocked(api.notebooks.apply).mock.calls.filter(([input]) => input.change.kind === 'register')
  expect(registers[0]![0].operationId).toBe(registers[1]![0].operationId)
})

it('keeps later input and navigation after a slow save and deduplicates concurrent submissions of this same intent', async () => {
  let release!: () => void
  vi.mocked(api.files.createPublic).mockImplementationOnce(async (input) => { await new Promise<void>(resolve => { release = resolve }); body.set(input.path, { content: input.content, revision: 'saved' }); return { resource: input.expectedResource, result: { status: 'written', revision: 'saved' } } })
  await dom.render(<SurveyRecallCapture target={target} onClose={vi.fn()} />)
  await act(async () => useLauncherState.getState().setDraft(target.draftId, 'note', 'Original finding'))
  let saving!: Promise<Awaited<ReturnType<typeof saveSurveyToRecall>>>
  await act(async () => { saving = saveSurveyToRecall(target, 'quick-notes', 'Original finding'); await vi.waitFor(() => expect(release).toBeTypeOf('function')) })
  const joined = saveSurveyToRecall(target, 'quick-notes', 'A different input')
  expect(joined).toBe(saving)
  const later = { zoneId: 'later-zone', selection: [], active: null }
  await act(async () => { useLauncherState.getState().setDraft(target.draftId, 'note', 'Newer unsaved finding'); useAppStore.setState({ surveyZoneSelection: later }); release(); await saving })
  expect(useLauncherState.getState().drafts[target.draftId]!.note).toBe('Newer unsaved finding')
  expect(useAppStore.getState().surveyZoneSelection).toBe(later); expect(useAppStore.getState().mainSurface).toBe('survey')
  expect(api.files.createPublic).toHaveBeenCalledOnce()
  expect(document.body.textContent).toContain('Your newer input is still kept as a draft.')
})

it('new captures use the managed Notes resource even when the Notebook retains an older project workface', async () => {
  catalog.notebooks['quick-notes'] = { ...catalog.notebooks['quick-notes']!, workface: { zoneId: 'original-project-zone', workspaceId: 'workspace' } }
  const saved = await saveSurveyToRecall(target, 'quick-notes', 'Finding')
  expect(catalog.notebooks['quick-notes']!.workface).toEqual({ zoneId: 'original-project-zone', workspaceId: 'workspace' })
  expect(catalog.pages[saved.noteId]!.resource.workspaceId).toBe(notes.id)
  expect(catalog.pages[saved.noteId]!.workface?.zoneId).toBe('notes-zone')
})
