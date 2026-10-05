// @vitest-environment happy-dom
import { act } from 'react'
import type { Editor } from '@tiptap/core'
import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../src/renderer/src/components/settings/ToolkitScriptEditor', () => ({ default: () => <textarea /> }))
import { SettingsPanel } from '../src/renderer/src/components/SettingsPanel'
import { NoteFileSurfaceView } from '../src/renderer/src/components/NoteFileSurfaceView'
import { GlobalBoardSurface } from '../src/renderer/src/components/GlobalBoardSurface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { EMPTY_AGENT_FOCUS } from '../src/renderer/src/lib/agent-focus'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { NOTE_SCHEMA, type NoteDocument } from '../src/shared/note-document'
import { applyConfigEdit } from '../src/shared/config-edit'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import type { AppConfig } from '../src/shared/contracts'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const goal = (id: string, status: DemandRecord['status'] = 'todo'): DemandRecord => ({ id, title: `Goal ${id}`, description: `Original ${id} description`, priority: 'normal', status,
  projectId: null, projectName: null, sessionIds: [], createdAt: 1, updatedAt: 2, source: 'default-topic' })
const note: NoteDocument = { schema: NOTE_SCHEMA, noteId: 'original-note', content: { type: 'doc', content: [
  { type: 'paragraph', attrs: { blockId: 'original-block' }, content: [{ type: 'text', text: 'Original editable finding' }] }
] } }
const surface = { kind: 'file', regionId: 'original-note-region', workspaceId: 'workspace', path: 'notes/original.note.json' } as const
const noteKey = documentKey(surface.workspaceId, surface.path)
beforeEach(() => useAppStore.setState({ config: { ...structuredClone(composerConfig), goalsCommonActions: { items: [], collapsed: false } }, sessions: [composerSession('healthy')],
  documents: { [noteKey]: { path: surface.path, content: JSON.stringify(note), revision: 'original-file-revision' } }, dirtyDocuments: {}, savingDocuments: {}, documentIssues: {}, documentRevealTargets: {},
  demands: { active: goal('active'), finished: goal('finished', 'done'), cancelled: goal('cancelled', 'cancelled') }, selectedDemandId: null,
  agentFocus: EMPTY_AGENT_FOCUS, mainSurface: 'board', activeWorkspaceId: null, tabs: { 'original-tab': createWorkbenchTab('original-tab', surface) }, layouts: {}, loading: false, error: null, executorDetections: {},
  detectExecutors: async () => {}, checkHost: async () => {} }))
const pane = (id: string) => dom.container.querySelector<HTMLElement>(`[data-settings-pane="${id}"]`)!
async function save(id: string) { await dom.click(`[data-settings-pane="${id}"] [data-settings-save-bar] button`) }
async function input(selector: string, value: string) {
  const node = dom.container.querySelector<HTMLInputElement>(selector)!
  expect(node, selector).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })) })
}
function transaction() {
  return vi.spyOn(api.config, 'save').mockImplementation(async (requested, expected) => {
    const saved = applyConfigEdit(useAppStore.getState().config!, expected!, requested)
    useAppStore.setState({ config: saved }); return saved
  })
}
function visibleGoalIds() { return [...dom.container.querySelectorAll('[data-demand-id]')].map(node => node.getAttribute('data-demand-id')) }

it('first GUI edit persists only the authored optional field, without backfilling unrelated Notes or Goals defaults', async () => {
  const write = transaction()
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="notes" />)
  await input('[aria-label="Notes body text size"]', '18'); await save('notes')
  expect(useAppStore.getState().config?.notes).toEqual({ fontSize: 18 })
  expect(useAppStore.getState().config?.goals).toBeUndefined()
  await dom.click('nav [data-settings-target="goals"]'); await goalsView('Board'); await save('goals')
  expect(useAppStore.getState().config?.goals).toEqual({ defaultView: 'board' })
  expect(useAppStore.getState().config?.notes).toEqual({ fontSize: 18 })
  expect(write).toHaveBeenCalledTimes(2)
})

it('actual Note surface updates reading styles without remounting its rich editor, moving its caret or saving its authored body', async () => {
  await dom.render(<NoteFileSurfaceView tabId="original-tab" surface={surface} />)
  const body = dom.container.querySelector<HTMLElement & { editor: Editor }>('.note-block-content')!
  expect(body).not.toBeNull(); const editor = body.editor
  expect(editor).toBeDefined()
  await act(async () => { editor.commands.setTextSelection(9); editor.commands.insertContent(' authored'); editor.view.focus() })
  const selection = editor.state.selection.toJSON(), content = editor.getJSON(), fileDraft = useAppStore.getState().documents[noteKey], dirty = useAppStore.getState().dirtyDocuments[noteKey]
  expect(dirty).toBe(true)
  const saveFile = vi.spyOn(useAppStore.getState(), 'saveDocument'), saveConfig = vi.spyOn(api.config, 'save')
  await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, notes: { fontSize: 20, contentWidth: 'wide' } } }))
  const outer = dom.container.querySelector<HTMLElement>('.note-surface')!
  expect(outer.style.getPropertyValue('--note-font-size')).toBe('20px')
  expect(outer.style.getPropertyValue('--note-content-width')).toBe('100%')
  expect(dom.container.querySelector('.note-block-content')).toBe(body)
  expect(body.editor).toBe(editor); expect(editor.isDestroyed).toBe(false)
  expect(editor.getJSON()).toEqual(content); expect(editor.state.selection.toJSON()).toEqual(selection)
  expect(document.activeElement).toBe(body)
  expect(useAppStore.getState().documents[noteKey]).toBe(fileDraft); expect(useAppStore.getState().dirtyDocuments[noteKey]).toBe(dirty)
  expect(saveFile).not.toHaveBeenCalled(); expect(saveConfig).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, notes: { fontSize: 10, contentWidth: 'standard' } } }))
  expect(outer.style.getPropertyValue('--note-font-size')).toBe('10px')
  expect(outer.style.getPropertyValue('--note-content-width')).toBe('760px')
  expect(editor.getJSON()).toEqual(content); expect(editor.state.selection.toJSON()).toEqual(selection)
})

it('new Goals instance consumes saved Board/finished defaults while absent preferences preserve the original active List', async () => {
  await dom.render(<GlobalBoardSurface />)
  expect(dom.container.querySelector('.goals-list')).not.toBeNull(); expect(visibleGoalIds()).toEqual(['active'])
  await dom.render(<div />)
  await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, goals: { defaultView: 'board', showFinished: true } } }))
  await dom.render(<GlobalBoardSurface />)
  expect(dom.container.querySelector('.goals-board')).not.toBeNull()
  expect(dom.container.querySelector('[aria-label="Board view"]')?.getAttribute('aria-pressed')).toBe('true')
  expect(visibleGoalIds()).toEqual(['active', 'finished', 'cancelled'])
})

it('changing saved defaults keeps the current Goal view, search, finished choice, selected identity and authored detail draft', async () => {
  const saveConfig = vi.spyOn(api.config, 'save'), originalSessions = useAppStore.getState().sessions
  await dom.render(<GlobalBoardSurface />)
  await dom.click('[aria-label="Board view"]')
  await input('[aria-label="Search goals"]', 'active')
  await dom.click('[data-demand-id="active"]')
  const selected = useAppStore.getState().selectedDemandId
  expect(selected).toBe('active')
  const detail = dom.container.querySelector('.goals-detail')
  const description = dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Goal description"]')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(description, 'Keep this unsaved Goal intention.'); description.dispatchEvent(new Event('input', { bubbles: true })); description.focus() })
  await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, goals: { defaultView: 'list', showFinished: true } } }))
  expect(dom.container.querySelector('.goals-board')).not.toBeNull()
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Search goals"]')!.value).toBe('active')
  expect(dom.container.querySelector('.goals-footer button')?.getAttribute('aria-pressed')).toBe('false')
  expect(useAppStore.getState().selectedDemandId).toBe(selected); expect(dom.container.querySelector('.goals-detail')).toBe(detail)
  expect(dom.container.querySelector('[aria-label="Goal description"]')).toBe(description)
  expect(description.value).toBe('Keep this unsaved Goal intention.')
  expect(useAppStore.getState().demands.active?.description).toBe('Original active description')
  expect(useAppStore.getState().sessions).toBe(originalSessions); expect(saveConfig).not.toHaveBeenCalled()
})

it('explicit Done and Cancelled filters remain readable even when the new default hides finished goals', async () => {
  await dom.render(<GlobalBoardSurface />); await dom.click('[aria-label="Goal filters"]')
  const select = dom.container.querySelector<HTMLSelectElement>('[aria-label="Filter work status"]')!
  for (const [status, id] of [['done', 'finished'], ['cancelled', 'cancelled']] as const) {
    await act(async () => { select.value = status; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(visibleGoalIds()).toEqual([id])
  }
  expect(useAppStore.getState().demands.finished?.status).toBe('done'); expect(useAppStore.getState().demands.cancelled?.status).toBe('cancelled')
})

it('full Notes Settings shell preserves a visited partial font draft and saves only its authored fields', async () => {
  const write = transaction()
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="notes" />)
  await input('[aria-label="Notes body text size"]', '1')
  await dom.click('nav [data-settings-target="goals"]'); await dom.click('nav [data-settings-target="notes"]')
  expect(pane('notes').querySelector<HTMLInputElement>('[aria-label="Notes body text size"]')!.value).toBe('1')
  await save('notes')
  expect(pane('notes').querySelector('[role=alert]')?.textContent).toContain('whole-number font size')
  expect(write).not.toHaveBeenCalled()
  await input('[aria-label="Notes body text size"]', '18')
  await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, notes: { contentWidth: 'wide' }, copyPathsAsAbsolute: true } }))
  await save('notes')
  expect(write).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().config?.notes).toEqual({ fontSize: 18, contentWidth: 'wide' })
  expect(useAppStore.getState().config?.copyPathsAsAbsolute).toBe(true)
})

it('Notes same-field conflicts and failed writes keep the original edited value and actual error', async () => {
  let live: AppConfig = useAppStore.getState().config!
  vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => applyConfigEdit(live, expected!, next))
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="notes" />)
  await input('[aria-label="Notes body text size"]', '18')
  live = { ...live, notes: { fontSize: 16 } }
  await act(async () => useAppStore.setState({ config: live })); await save('notes')
  expect(pane('notes').querySelector<HTMLInputElement>('[aria-label="Notes body text size"]')!.value).toBe('18')
  expect(pane('notes').querySelector('[role=alert]')?.textContent).toContain('changed since')
  expect(live.notes?.fontSize).toBe(16)
  vi.mocked(api.config.save).mockRejectedValue(new Error('Controlled durable write failed')); await save('notes')
  expect(pane('notes').querySelector('[role=alert]')?.textContent).toContain('Controlled durable write failed')
  expect(pane('notes').querySelector<HTMLInputElement>('[aria-label="Notes body text size"]')!.value).toBe('18')
})

it('pending Notes save retains later input and preserves the exact submitted expected value', async () => {
  let finish!: (saved: AppConfig) => void
  const write = vi.spyOn(api.config, 'save').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="notes" />)
  await input('[aria-label="Notes body text size"]', '18'); await save('notes')
  expect(pane('notes').textContent).toContain('Saving changes')
  await input('[aria-label="Notes body text size"]', '20')
  const [submitted, expected] = write.mock.calls[0]!
  expect(submitted.notes?.fontSize).toBe(18); expect(expected?.notes?.fontSize).toBe(13)
  await act(async () => { useAppStore.setState({ config: submitted }); finish(submitted) })
  expect(pane('notes').querySelector<HTMLInputElement>('[aria-label="Notes body text size"]')!.value).toBe('20')
  expect(pane('notes').textContent).toContain('Unsaved changes')
})

async function goalsView(choice: 'List' | 'Board') {
  const label = [...pane('goals').querySelectorAll<HTMLLabelElement>('fieldset label')].find(node => node.textContent?.trim() === choice)
  expect(label, 'Actual native Goals view choice').toBeDefined()
  await act(async () => label!.querySelector<HTMLInputElement>('input')!.click())
}
const finishedChoice = () => pane('goals').querySelector<HTMLInputElement>('[aria-label="Show finished goals by default"]')!

it('Goals Settings saves authored starting view while preserving concurrent finished preference, empty actions and unrelated fields', async () => {
  const write = transaction()
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="goals" />)
  await goalsView('Board')
  await act(async () => useAppStore.setState({ config: { ...useAppStore.getState().config!, goals: { showFinished: true }, goalsCommonActions: { items: [], collapsed: true }, copyPathsAsAbsolute: true } }))
  expect(finishedChoice().checked).toBe(true)
  await save('goals')
  expect(write).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().config?.goals).toEqual({ defaultView: 'board', showFinished: true })
  expect(useAppStore.getState().config?.goalsCommonActions).toEqual({ items: [], collapsed: true })
  expect(useAppStore.getState().config?.copyPathsAsAbsolute).toBe(true)
})

it('Goals failure retains the selected view and finished draft while clean external fields still reload', async () => {
  vi.spyOn(api.config, 'save').mockRejectedValue(new Error('Controlled Goals durability failure'))
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="goals" />)
  await goalsView('Board'); await dom.click('[aria-label="Show finished goals by default"]')
  await save('goals')
  expect(pane('goals').querySelector('[role=alert]')?.textContent).toContain('Controlled Goals durability failure')
  expect(finishedChoice().checked).toBe(true)
  expect([...pane('goals').querySelectorAll<HTMLLabelElement>('fieldset label')].find(label => label.textContent?.trim() === 'Board')!.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
  expect(useAppStore.getState().config?.goals).toBeUndefined()
})

it('pending Goals save retains the later native view choice and exact authored baselines', async () => {
  let finish!: (saved: AppConfig) => void
  const write = vi.spyOn(api.config, 'save').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await dom.render(<SettingsPanel onClose={() => {}} initialSection="goals" />)
  await goalsView('Board'); await dom.click('[aria-label="Show finished goals by default"]'); await save('goals')
  await goalsView('List')
  const [submitted, expected] = write.mock.calls[0]!
  expect(submitted.goals).toEqual({ defaultView: 'board', showFinished: true, requesterAsSupervisor: true })
  expect(expected?.goals).toEqual({ defaultView: 'list', showFinished: false, requesterAsSupervisor: true })
  await act(async () => { useAppStore.setState({ config: submitted }); finish(submitted) })
  expect([...pane('goals').querySelectorAll<HTMLLabelElement>('fieldset label')].find(label => label.textContent?.trim() === 'List')!.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
  expect(pane('goals').textContent).toContain('Unsaved changes')
})
