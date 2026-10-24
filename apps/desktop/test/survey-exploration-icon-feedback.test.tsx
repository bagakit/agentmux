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
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { NOTES_WORKSPACE_ID } from '@agentmux/host/notes-library'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const dom = composerDOM(), notes = { ...composerConfig.workspaces[0]!, id: NOTES_WORKSPACE_ID, name: 'Recall' }
const target: CaptureTarget = { draftId: 'original-survey-capture', source: { sourceId: 'original-page', url: 'https://source.test/finding', title: 'Original source', recordedAt: _historyFixtureEpoch(0, 0, 1) } }
let catalog: NotebookState
const body = new Map<string, { content: string; revision: string }>()
const cue = () => document.querySelector('.survey-recall-capture [data-icon-animation="feedback"]')
const icon = () => document.querySelector('.survey-recall-capture [data-semantic-icon="object.survey"]')
async function view(value: CaptureTarget | null = target, active = true) {
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}><SurveyRecallCapture target={value} onClose={() => {}} /></WorkbenchPresentationContext.Provider>)
}
async function save() { await act(async () => document.querySelector<HTMLButtonElement>('.survey-recall-capture .primary-button')!.click()) }
beforeEach(() => {
  body.clear(); catalog = emptyNotebookState(); useNotebookLibrary.setState({ state: catalog, issue: null }); useLauncherState.setState({ drafts: {}, persistenceIssue: null })
  useAppStore.setState({ config: { ...composerConfig, workspaces: [...composerConfig.workspaces, notes] }, mainSurface: 'survey', layouts: {}, recallNotebookId: null, recallNoteId: null })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, bottom: 16, right: 16, width: 16, height: 16, toJSON() {} })
  vi.spyOn(api.notebooks, 'read').mockImplementation(async () => structuredClone(catalog))
  vi.spyOn(api.notebooks, 'apply').mockImplementation(async input => { catalog = applyNotebookChange(catalog, input, { kind: 'user', id: 'original-capture-user' }, Date.now()); return structuredClone(catalog) })
  vi.spyOn(api.files, 'createPublic').mockImplementation(async input => { body.set(input.path, { content: input.content, revision: 'written-original' }); return { resource: input.expectedResource, result: { status: 'written', revision: 'written-original' } } })
  vi.spyOn(api.files, 'readPublic').mockImplementation(async input => ({ resource: { ...input.expectedResource, zoneId: input.zoneId, zonePath: notes.path, path: input.path }, result: body.has(input.path) ? { status: 'read', document: { path: input.path, ...body.get(input.path)! } } : { status: 'deleted' } }))
  vi.spyOn(api.files, 'read').mockImplementation(async (_id, path) => body.has(path) ? { status: 'read', document: { path, ...body.get(path)! } } : { status: 'deleted' })
  vi.spyOn(useAppStore.getState(), 'createWorkbenchZone').mockImplementation(async input => ({ zone: { zoneId: 'original-notes-zone', kind: 'temporary', workspaceId: input.workspaceId, hostId: notes.hostId, directoryPath: notes.path, name: 'Notes' }, save: { state: 'saved', durable: true }, issues: [] } as never))
})
it('mounted capture waits for original write and Notebook registration before one exploration feedback', async () => {
  let release!: () => void
  vi.mocked(api.files.createPublic).mockImplementationOnce(async input => { await new Promise<void>(resolve => { release = resolve }); body.set(input.path, { content: input.content, revision: 'written-original' }); return { resource: input.expectedResource, result: { status: 'written', revision: 'written-original' } } })
  const navigation = useAppStore.getState().surveyZoneSelection, originalControl = useAppStore.getState().sessions[0]!.control
  await view(); await save(); await vi.waitFor(() => expect(release).toBeTypeOf('function')); expect(cue()).toBeNull(); expect(icon()).toBeNull()
  await act(async () => { release() })
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); expect(icon()).not.toBeNull() })
  expect(cue()).not.toBeNull(); expect(document.querySelectorAll('.survey-recall-capture [data-semantic-icon="object.survey"]')).toHaveLength(1)
  const receipt = useLauncherState.getState().drafts[target.draftId]!.noteCreation!
  expect(receipt.status).toBe('written'); expect(receipt.notebookRegistered).toBe(true); expect(catalog.pages[receipt.noteId]!.sources).toEqual([target.source])
  expect(api.files.createPublic).toHaveBeenCalledOnce(); expect(useAppStore.getState().surveyZoneSelection).toBe(navigation); expect(useAppStore.getState().sessions[0]!.control).toBe(originalControl)
  await act(async () => icon()!.dispatchEvent(new Event('animationend', { bubbles: true }))); expect(cue()).toBeNull()
  await view(null); await view(); expect(icon()).not.toBeNull(); expect(cue()).toBeNull()
})
it('written without confirmed registration stays still, and a later read of that saved intent does not replay it', async () => {
  const apply = vi.mocked(api.notebooks.apply), original = apply.getMockImplementation()!
  let fail = true
  apply.mockImplementation(async input => { if (input.change.kind === 'register' && fail) throw new Error('Original registration reply unconfirmed'); return original(input) })
  await view(); await save()
  const receipt = useLauncherState.getState().drafts[target.draftId]!.noteCreation!
  expect(receipt.status).toBe('written'); expect(receipt.notebookRegistered).not.toBe(true); expect(cue()).toBeNull(); expect(document.body.textContent).toContain('unconfirmed')
  fail = false
  await act(async () => { await saveSurveyToRecall(target, 'quick-notes', receipt.draft) })
  expect(useLauncherState.getState().drafts[target.draftId]!.noteCreation!.notebookRegistered).toBe(true)
  expect(icon()).not.toBeNull(); expect(cue()).toBeNull(); expect(api.files.createPublic).toHaveBeenCalledOnce()
})
it('loading old saved findings and receiving unknown writes never implies a new saved event', async () => {
  await saveSurveyToRecall(target, 'quick-notes', 'Previously saved finding'); await view(); expect(icon()).not.toBeNull(); expect(cue()).toBeNull()
  await view(null); const unknown = { ...target, draftId: 'unknown-capture' }
  vi.mocked(api.files.createPublic).mockResolvedValueOnce({ resource: null, result: { status: 'unknown', code: 'UNCONFIRMED', message: 'Original write unknown' } })
  await view(unknown); await save(); expect(cue()).toBeNull(); expect(icon()).toBeNull(); expect(useLauncherState.getState().drafts[unknown.draftId]!.noteCreation!.status).toBe('unknown')
})
it('a delayed saved finding stays on its captured intent instead of animating a different capture', async () => {
  let release!: () => void
  vi.mocked(api.files.createPublic).mockImplementationOnce(async input => { await new Promise<void>(resolve => { release = resolve }); body.set(input.path, { content: input.content, revision: 'written-original' }); return { resource: input.expectedResource, result: { status: 'written', revision: 'written-original' } } })
  await view(); await save(); await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const other = { ...target, draftId: 'different-capture' }; await view(other)
  await act(async () => { release() }); await vi.waitFor(() => expect(useLauncherState.getState().drafts[target.draftId]!.noteCreation!.notebookRegistered).toBe(true))
  expect(cue()).toBeNull(); expect(icon()).toBeNull(); expect(useLauncherState.getState().drafts[other.draftId]!.noteCreation).toBeUndefined()
})
it('a parked original capture can finish saving without queued feedback on return', async () => {
  await view(target, false); await save(); expect(useLauncherState.getState().drafts[target.draftId]!.noteCreation!.notebookRegistered).toBe(true)
  expect(icon()).not.toBeNull(); expect(cue()).toBeNull(); await view(); expect(cue()).toBeNull()
})
