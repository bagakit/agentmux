// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyNotebookChange, emptyNotebookState, type NotebookChange, type NotebookState } from '@agentmux/core/notebook-catalog'
import { NotebookPageDetails } from '../src/renderer/src/components/NotebookPageDetails'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import * as pageTree from '../src/renderer/src/lib/notebook-page-tree'
import * as addresses from '../src/shared/space-addresses'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(), actor = { kind: 'user', id: 'original-person' } as const
const workspace = composerConfig.workspaces[0]!
const scratch = { ...workspace, id: SCRATCH_WORKSPACE_ID, name: 'Topics' }
const topic = { id: 'research-topic', title: 'Original research topic', summary: '', directoryPath: 'research-topic', topicPath: 'research-topic/topic.md', collaborators: [] }
const config = { ...composerConfig, workspaces: [workspace, scratch] }
let catalog: NotebookState
let descendants: ReturnType<typeof vi.spyOn>, rows: ReturnType<typeof vi.spyOn>, topics: ReturnType<typeof vi.spyOn>
const activityScans = vi.fn()

function change(change: NotebookChange) {
  catalog = applyNotebookChange(catalog, { expectedRevision: catalog.revision, operationId: `change-${catalog.revision}`, change }, actor, catalog.revision + 1)
}
function register(noteId: string, notebookId = 'quick-notes', parentNoteId: string | null = null) {
  change({ kind: 'register', noteId, notebookId, parentNoteId, title: `Page ${noteId}`, resource: {
    hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: `${noteId}.note.md`
  } })
}
function Page({ active = true }: { active?: boolean }) {
  const page = useNotebookLibrary(state => state.state!.pages.original!)
  return <WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}><NotebookPageDetails page={page} /></WorkbenchPresentationContext.Provider>
}
function resetCosts() { descendants.mockClear(); rows.mockClear(); topics.mockClear(); activityScans.mockClear() }
function expectQuiet() {
  expect(descendants).not.toHaveBeenCalled(); expect(rows).not.toHaveBeenCalled()
  expect(topics).not.toHaveBeenCalled(); expect(activityScans).not.toHaveBeenCalled()
}
async function publish() { await act(async () => useNotebookLibrary.setState({ state: catalog, issue: null })) }
async function choose(label: string) {
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Page options"]')!
  await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  let item: HTMLElement | undefined
  await vi.waitFor(() => {
    item = [...document.querySelectorAll<HTMLElement>('[role="menu"][data-state="open"] [role="menuitem"]')].find(node => node.getAttribute('aria-label') === label)
    expect(item, label).toBeDefined()
  })
  await act(async () => item!.click())
}
function parents() { return [...dom.container.querySelectorAll<HTMLOptionElement>('[aria-label="Parent page"] option')].map(option => option.value) }
async function selectDestination(value: string) {
  const input = dom.container.querySelector<HTMLSelectElement>('[aria-label="Destination notebook"]')!
  await act(async () => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })) })
}
async function renameTopic(title: string) {
  await act(async () => useAppStore.setState({ scratchTopicSnapshots: {
    [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 2, topics: [{ ...topic, title }], error: null, reading: false }
  } }))
}

beforeEach(() => {
  catalog = emptyNotebookState()
  change({ kind: 'create', notebookId: 'research', name: 'Research' })
  register('original'); register('child', 'quick-notes', 'original'); register('grandchild', 'quick-notes', 'child')
  register('sibling'); register('destination', 'research'); register('nested-destination', 'research', 'destination')
  for (let index = 0; index < 24; index++) register(`unrelated-${index}`, 'research')
  const space = addresses.spatialSources(config, [topic]).spaces.find(space => space.topicId === topic.id)!
  change({ kind: 'organize', noteId: 'original', topic: { spaceId: space.spaceId, topicId: topic.id } })
  change({ kind: 'rename-page', noteId: 'original', title: 'Current original title' })
  useNotebookLibrary.setState({ state: catalog, issue: null })
  useAppStore.setState({ config, scratchTopicSnapshots: {
    [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 1, topics: [topic], error: null, reading: false }
  } })
  vi.spyOn(api.notebooks, 'actor').mockResolvedValue(actor)
  vi.spyOn(api.notebooks, 'apply').mockRejectedValue(new Error('These detail disclosures must not write Notebook metadata'))
  descendants = vi.spyOn(pageTree, 'notebookDescendants')
  rows = vi.spyOn(pageTree, 'notebookPageRows')
  topics = vi.spyOn(addresses, 'spatialSources')
  const filter = Array.prototype.filter
  vi.spyOn(Array.prototype, 'filter').mockImplementation(function (this: unknown[], predicate, thisArg) {
    if (this === useNotebookLibrary.getState().state?.trail) activityScans()
    return Reflect.apply(filter, this, [predicate, thisArg])
  })
  resetCosts()
})
afterEach(async () => { await dom.render(null); useNotebookLibrary.setState({ state: null, issue: null }) })

it('keeps closed detail work at zero while the actual title is typed and catalogs change', async () => {
  await dom.render(<Page />)
  expectQuiet()
  const title = dom.container.querySelector<HTMLInputElement>('[aria-label="Page title"]')!
  await act(async () => {
    title.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Unsaved title')
    title.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(title.value).toBe('Unsaved title'); expectQuiet()
  change({ kind: 'rename-page', noteId: 'sibling', title: 'Updated elsewhere' }); await publish()
  await renameTopic('Updated hidden topic')
  expectQuiet(); expect(title.value).toBe('Unsaved title')
  expect(api.notebooks.apply).not.toHaveBeenCalled()
  await act(async () => title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(title.value).toBe('Current original title'); expectQuiet()
})

it('derives only the opened Move choices and keeps destination, hierarchy and live updates correct', async () => {
  await dom.render(<Page />); await choose('Move page')
  expect(descendants).toHaveBeenCalledTimes(1); expect(rows).toHaveBeenCalledTimes(1)
  expect(activityScans).not.toHaveBeenCalled(); expect(topics).not.toHaveBeenCalled()
  expect(parents()).toEqual(['', 'sibling'])
  await selectDestination('research')
  expect(parents()).toContain('destination'); expect(parents()).toContain('nested-destination')
  expect(parents()).not.toContain('original'); expect(parents()).not.toContain('child'); expect(parents()).not.toContain('grandchild')
  const nested = dom.container.querySelector<HTMLOptionElement>('[aria-label="Parent page"] option[value="nested-destination"]')!
  expect(nested.textContent).toBe('　Page nested-destination')
  register('new-destination', 'research'); await publish()
  expect(parents()).toContain('new-destination')
  await dom.click('[aria-label="Close move page"]'); resetCosts()
  register('closed-destination', 'research'); await publish(); expectQuiet()
  await choose('Move page'); expect(parents()).toEqual(['', 'sibling'])
  await selectDestination('research'); expect(parents()).toContain('closed-destination')
  expect(activityScans).not.toHaveBeenCalled(); expect(topics).not.toHaveBeenCalled()
  expect(api.notebooks.apply).not.toHaveBeenCalled()
})

it('derives Page activity only when requested and preserves exact page ordering and Topic names', async () => {
  await dom.render(<Page />); await choose('Page activity')
  const panel = dom.container.querySelector('[aria-label="Page activity"]')!
  expect([...panel.querySelectorAll('strong')].map(node => node.textContent)).toEqual(['Renamed', 'Added to Topic', 'Created'])
  expect(panel.textContent).toContain('Page original → Current original title')
  expect(panel.textContent).toContain('Original research topic'); expect(panel.textContent).toContain(`user · ${actor.id}`)
  expect(activityScans).toHaveBeenCalledTimes(1); expect(topics).toHaveBeenCalledTimes(1)
  expect(descendants).not.toHaveBeenCalled(); expect(rows).not.toHaveBeenCalled()
  resetCosts(); await renameTopic('Renamed research topic')
  expect(panel.textContent).toContain('Renamed research topic'); expect(panel.textContent).not.toContain('Original research topic')
  expect(activityScans).not.toHaveBeenCalled(); expect(topics).toHaveBeenCalledTimes(1)
  change({ kind: 'follow', noteId: 'original' }); await publish()
  expect([...panel.querySelectorAll('strong')].map(node => node.textContent)).toEqual(['Followed', 'Renamed', 'Added to Topic', 'Created'])
  await dom.click('[aria-label="Close page activity"]'); resetCosts()
  change({ kind: 'unfollow', noteId: 'original' }); await publish(); await renameTopic('Later hidden topic'); expectQuiet()
  await choose('Page activity')
  expect(dom.container.querySelector('[aria-label="Page activity"]')?.textContent).toContain('Later hidden topic')
  expect(dom.container.querySelector('[aria-label="Page activity"] strong')?.textContent).toBe('Unfollowed')
  expect(api.notebooks.apply).not.toHaveBeenCalled()
})

it.each(['Move page', 'Page activity'])('pauses %s derivation in a retained hidden workface and resumes current facts on return', async label => {
  await dom.render(<Page />); await choose(label); resetCosts()
  await dom.render(<Page active={false} />)
  register('hidden-destination', 'research'); change({ kind: 'follow', noteId: 'original' }); await publish()
  await renameTopic('Topic changed while hidden'); expectQuiet()
  await dom.render(<Page />)
  if (label === 'Move page') {
    expect(descendants).toHaveBeenCalledTimes(1); expect(rows).toHaveBeenCalledTimes(1)
    expect(activityScans).not.toHaveBeenCalled(); expect(topics).not.toHaveBeenCalled()
    await selectDestination('research'); expect(parents()).toContain('hidden-destination')
  } else {
    expect(descendants).not.toHaveBeenCalled(); expect(rows).not.toHaveBeenCalled()
    expect(activityScans).toHaveBeenCalledTimes(1); expect(topics).toHaveBeenCalledTimes(1)
    expect(dom.container.querySelector('[aria-label="Page activity"] strong')?.textContent).toBe('Followed')
    expect(dom.container.querySelector('[aria-label="Page activity"]')?.textContent).toContain('Topic changed while hidden')
  }
  expect(api.notebooks.apply).not.toHaveBeenCalled()
})
