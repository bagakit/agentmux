import { fixtureEpoch as _tailRefreshFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, useLayoutEffect } from 'react'
import { ReactFlowProvider, useStoreApi } from '@xyflow/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocalExecutionHost } from '@agentmux/core'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import type { NotebookGraphSnapshot } from '../src/shared/notebook-observation'
import { createNotebookObservationServices } from '../src/main/notebook-observation-requests'
import { createPreloadNotebookObservation } from '../src/preload/notebook-observation'
import { createRendererNotebookObservation } from '../src/renderer/src/lib/notebook-observation-api'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteCanvas } from '../src/renderer/src/components/NoteCanvas'
import { NoteLinksPanel } from '../src/renderer/src/components/NoteLinksPanel'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { noteCanvasScopeKey } from '../src/renderer/src/lib/note-canvas-state'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'
import { installNoteCanvasBlockRows } from './helpers/note-canvas-block-dom'

const dom = composerDOM(), scope = { kind: 'note', noteId: 'target' } as const
let directory: string, store: AgentMuxNotebookStore
const body = (id: string, text: string, references = false) => JSON.stringify({ schema: 'agentmux.note.v1', noteId: id, content: { type: 'doc', content: [
  { type: 'paragraph', attrs: { blockId: id + '-block', provenance: { created: { actor: { kind: 'agent', id: 'ExactResearchSession' }, at: _tailRefreshFixtureEpoch(0, 1) }, lastEdited: { actor: { kind: 'agent', id: 'ExactResearchSession' }, at: _tailRefreshFixtureEpoch(0, 1) } } }, content: [{ type: 'text', text }] },
  ...references ? [
    ...[0, 1, 2].map(index => ({ type: 'blockReference', attrs: { blockId: 'source-reference-' + index, referenceId: 'original-reference-' + index, mode: index === 2 ? 'embed' : 'reference', target: { noteId: 'target', blockId: 'target-block' } } })),
    { type: 'paragraph', attrs: { blockId: 'source-inline' }, content: [
      { type: 'text', text: 'Original closed source links to ' },
      { type: 'noteLink', attrs: { referenceId: 'page-link', text: 'Original target', target: { noteId: 'target' } } },
      { type: 'text', text: ' and ' },
      { type: 'noteLink', attrs: { referenceId: 'heading-link', text: 'Original target #Heading', target: { noteId: 'target', blockId: 'target-block' } } },
      { type: 'text', text: ' plus [[Unconfirmed page]]' },
    ] },
  ] : []
] } })
beforeEach(async () => {
  installNoteCanvasGeometry()
  directory = await realpath(await mkdtemp(join(tmpdir(), 'amx-canvas-ui-')))
  const workspace = { id: 'notes', hostId: 'local', path: directory, name: 'Notes', kind: 'folder' as const }
  store = new AgentMuxNotebookStore(join(directory, 'notebooks.json'))
  for (const id of ['target', 'closed-source']) {
    await writeFile(join(directory, id + '.note.json'), body(id, 'Saved ' + id, id !== 'target'))
    await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'register-' + id, change: { kind: 'register', noteId: id, title: 'Original ' + id, resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: id + '.note.json' } } }, { kind: 'user', id: 'ui-test' })
  }
  const services = createNotebookObservationServices(store, { files: new WorkspaceFiles(() => new LocalExecutionHost()), workspace: () => workspace })
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
  const observation = createRendererNotebookObservation(createPreloadNotebookObservation(async (channel, input) => {
    if (channel === 'notebook:graph') return structuredClone(await services.requests.graph(sender, input))
    if (channel === 'notebook:content') return structuredClone(await services.requests.content(sender, input))
    if (channel === 'notebook:resolve') return structuredClone(await services.requests.resolve(sender, input))
    if (channel === 'notebook:cancelObservation') return services.requests.cancel(sender, input)
    throw new Error('Unexpected channel')
  }))
  vi.spyOn(api.notebooks, 'graph').mockImplementation(observation.graph)
  vi.spyOn(api.notebooks, 'content').mockImplementation(observation.content)
  vi.spyOn(api.notebooks, 'resolve').mockImplementation(observation.resolve)
  vi.spyOn(api.notebooks, 'onChange').mockImplementation(listener => store.subscribe(listener))
  useAppStore.setState({ noteCanvasLayouts: {}, noteCanvasSaveIssues: {}, documents: {}, dirtyDocuments: {} })
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
async function ready() { await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-title[data-note-id]')).toHaveLength(2)) }
type FlowPublicationProbe = { waiting: boolean; published: string[]; sourceCount(): number }
function CaptureFlowErrors({ errors, publication }: { errors: string[]; publication?: FlowPublicationProbe }) {
  const store = useStoreApi()
  useLayoutEffect(() => {
    const original = store.getState().onError
    store.setState({ onError: (id, message) => { errors.push(id); original?.(id, message) } })
    if (publication) publication.sourceCount = () => store.getState().edges.filter(edge => edge.source === 'closed-source').length
    const unsubscribe = store.subscribe(state => {
      if (!publication?.waiting) return
      for (const edge of state.edges) {
        const relationship = edge.data?.relationship as { sourceBlockId?: string } | undefined
        if (edge.source === 'closed-source' && relationship?.sourceBlockId) publication.published.push(relationship.sourceBlockId)
      }
    })
    return () => { unsubscribe(); store.setState({ onError: original }) }
  }, [store, errors, publication])
  return null
}

it('renders incoming closed-file relationships through the original Main/preload/Renderer owner and opens exact bundled blocks', async () => {
  const open = vi.fn(), talk = vi.fn()
  await dom.render(<NoteCanvas scope={scope} onOpen={open} onTalk={talk} />); await ready()
  expect(dom.container.querySelector('.note-canvas-caption')!.textContent).toContain('2/2 originals read')
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1); expect(api.notebooks.content).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Inspect 2 references: Block → block"]')).not.toBeNull())
  await dom.click('[aria-label="Inspect 2 references: Block → block"]')
  const occurrences = dom.container.querySelectorAll('.note-canvas-inspector li')
  expect(occurrences).toHaveLength(2); expect(occurrences[1]!.textContent).toContain('Block reference'); expect(dom.container.querySelector('[aria-label="Inspect 1 embed: Block → block"]')).not.toBeNull()
  await act(async () => occurrences[1]!.querySelector<HTMLButtonElement>('.note-canvas-inspector-actions button')!.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages['closed-source'], 'source-reference-1')
  await act(async () => occurrences[0]!.querySelectorAll<HTMLButtonElement>('.note-canvas-inspector-actions button')[1]!.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages.target, 'target-block')
  const target = dom.container.querySelector<HTMLButtonElement>('[data-note-id="target"]')!
  await act(async () => { target.focus(); target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })) })
  await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')?.textContent).toContain('Talk with Agent'))
  await act(async () => document.querySelector<HTMLElement>('[role="menuitem"]')!.click())
  await vi.waitFor(() => expect(talk).toHaveBeenCalledWith((expect.objectContaining({ noteId: 'target' })), target))
})

it('reads original blocks and authors only on explicit expansion, and opens a selected original block', async () => {
  const open = vi.fn()
  await dom.render(<NoteCanvas scope={scope} onOpen={open} />); await ready()
  await dom.click('[aria-label="Read saved body: Original target"]')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-reader')?.textContent).toContain('Saved target'))
  const block = dom.container.querySelector<HTMLElement>('.note-canvas-reader [data-block-id="target-block"]')!
  expect(block.getAttribute('data-note-agent-author')).toBe('Agent ExactResearchSession')
  expect(block.title).toContain('Created: Agent ExactResearchSession')
  expect(dom.container.querySelector('.note-canvas-reader [contenteditable]')?.getAttribute('contenteditable')).toBe('false')
  await act(async () => block.click()); await dom.click('.note-canvas-open-block')
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages.target, 'target-block')
  expect(api.notebooks.content).toHaveBeenCalledTimes(1); expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  await dom.click('[aria-label="Collapse saved body: Original target"]')
  expect(dom.container.querySelector('.note-canvas-reader')).toBeNull()
  expect(dom.container.querySelector('.note-canvas-row-endpoint')).toBeNull()
  expect((await store.read()).trail).toHaveLength(2)
})

it('keeps newer bytes out of an older card and refreshes explicitly without replacing graph truth with drafts', async () => {
  installNoteCanvasBlockRows()
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  await writeFile(join(directory, 'target.note.json'), body('target', 'Later saved bytes'))
  await dom.click('[aria-label="Read saved body: Original target"]')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Saved snapshot changed.'))
  expect(dom.container.querySelector('.note-canvas-reader')).toBeNull()
  expect(dom.container.querySelector('.note-canvas-row-endpoint')).toBeNull()
  await dom.click('.note-canvas-body-state button')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-reader')?.textContent).toContain('Later saved bytes'))
  expect(api.notebooks.graph).toHaveBeenCalledTimes(2)
  const readCount = vi.mocked(api.notebooks.content).mock.calls.length
  await act(async () => useAppStore.setState({ documents: { 'notes\0target.note.json': { path: 'target.note.json', content: body('target', 'Unsaved draft is kept'), revision: 'draft' } }, dirtyDocuments: { 'notes\0target.note.json': true }, sessions: [...useAppStore.getState().sessions] }))
  expect(api.notebooks.graph).toHaveBeenCalledTimes(2); expect(api.notebooks.content).toHaveBeenCalledTimes(readCount)
  expect(dom.container.querySelector('.note-canvas-reader')?.textContent).toContain('Later saved bytes')
})

it('retains the last usable graph on failed refresh and aborts a hidden pending original observation', async () => {
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  vi.mocked(api.notebooks.graph).mockRejectedValueOnce(new Error('Original reader unavailable'))
  await dom.click('[aria-label="Refresh saved graph"]')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original reader unavailable'))
  expect(dom.container.querySelectorAll('.note-canvas-title[data-note-id]')).toHaveLength(2)
  let pendingSignal: AbortSignal | undefined
  vi.mocked(api.notebooks.graph).mockImplementationOnce((_params, options) => new Promise<NotebookGraphSnapshot>((_resolve, reject) => { pendingSignal = options!.signal; pendingSignal!.addEventListener('abort', () => reject(pendingSignal!.reason), { once: true }) }))
  await dom.click('[aria-label="Refresh saved graph"]')
  expect(pendingSignal?.aborted).toBe(false)
  await dom.render(<NoteCanvas scope={scope} active={false} onOpen={() => {}} />)
  expect(pendingSignal?.aborted).toBe(true)
  expect(dom.container.querySelectorAll('.note-canvas-title[data-note-id]')).toHaveLength(2)
})

it('persists completed keyboard moves through the same presentation owner and restores the original coordinates on remount', async () => {
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  const node = dom.container.querySelector<HTMLElement>('.react-flow__node[data-id="target"]')!
  await act(async () => { node.focus(); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  await act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
  const position = useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(scope)]?.positions.target
  expect(position).toBeDefined(); expect(position!.x).toBeGreaterThan(0)
  const transform = node.style.transform
  await dom.render(null); await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  expect(dom.container.querySelector<HTMLElement>('.react-flow__node[data-id="target"]')!.style.transform).toBe(transform)
  expect(useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(scope)]!.positions.target).toEqual(position)
})

it('keeps a missing target explicit and inspects its registered original without guessing an exact block', async () => {
  await writeFile(join(directory, 'target.note.json'), body('target', 'Original target').replaceAll('target-block', 'another-original-block'))
  const open = vi.fn()
  await dom.render(<NoteCanvas scope={scope} onOpen={open} />); await ready()
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Inspect 2 references: Block → block"]')).not.toBeNull())
  await dom.click('[aria-label="Inspect 2 references: Block → block"]')
  expect(dom.container.querySelector('.note-canvas-inspector')?.textContent).toContain('Target missing.')
  expect(dom.container.querySelector('.note-canvas-inspector')?.textContent).not.toContain('Open target block')
  const original = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-canvas-inspector-actions button')].find(button => button.textContent === 'Inspect registered original')!
  await act(async () => original.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages.target, undefined)
})

it('exposes exact page/block links and raw queries from the original saved graph without fabricating target nodes', async () => {
  const open = vi.fn()
  await dom.render(<NoteCanvas scope={scope} onOpen={open} />); await ready()
  await vi.waitFor(() => expect(dom.container.querySelector('[aria-label="Inspect 1 link: Block → page"]')).not.toBeNull())
  await dom.click('[aria-label="Inspect 1 link: Block → page"]')
  expect(dom.container.querySelectorAll('.note-canvas-edge-link')).toHaveLength(2)
  expect(dom.container.querySelectorAll('.note-canvas-inspector li')).toHaveLength(1)
  expect(dom.container.querySelector('.note-canvas-inspector')?.textContent).not.toContain('Open target block')
  expect(dom.container.querySelector('.note-canvas-inspector')?.textContent).toContain('Page link')
  const targetPage = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-canvas-inspector-actions button')].find(button => button.textContent === 'Open target page')!
  await act(async () => targetPage.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages.target, undefined)
  await dom.click('[aria-label="Inspect 1 link: Block → block"]')
  expect(dom.container.querySelectorAll('.note-canvas-inspector li')).toHaveLength(1)
  expect(dom.container.querySelector('.note-canvas-inspector')?.textContent).not.toContain('Open target page')
  const targetBlock = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-canvas-inspector-actions button')].find(button => button.textContent === 'Open target block')!
  await act(async () => targetBlock.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages.target, 'target-block')
  await dom.click('[aria-label="Inspect 1 unbound links in Original closed-source"]')
  expect(dom.container.querySelector('.note-canvas-inspector')?.textContent).toContain('[[Unconfirmed page]]')
  expect(dom.container.querySelectorAll('.note-canvas-title[data-note-id]')).toHaveLength(2)
  expect(dom.container.querySelector('.note-canvas-caption')?.textContent).toContain('1 visible unbound links')
  expect(api.notebooks.content).not.toHaveBeenCalled()
})

it('connects page targets and hierarchy to card headers while keeping block endpoints explicitly grouped', async () => {
  const catalog = await store.read()
  await store.apply({ expectedRevision: catalog.revision, operationId: 'original-parent', change: { kind: 'move', noteId: 'closed-source', notebookId: catalog.pages.target!.notebookId, parentNoteId: 'target' } }, { kind: 'user', id: 'ui-test' })
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-edge-label')).toHaveLength(5))
  const label = (name: string) => dom.container.querySelector<HTMLElement>(`[aria-label="${name}"]`)!
  const handle = (edge: HTMLElement, end: 'source' | 'target') => dom.container.querySelector<HTMLElement>(`.react-flow__node[data-id="${edge.dataset[end + 'Note']}"] [data-handleid="${edge.dataset[end + 'Handle']}"]`)!
  const page = label('Inspect 1 link: Block → page'), block = label('Inspect 1 link: Block → block'), hierarchy = label('Inspect parent and subpage relationship: Page → page')
  expect(page.textContent).toContain('Block → page')
  expect(page.dataset.sourceHandle).toMatch(/^block-out-/)
  expect(page.dataset.targetHandle).toMatch(/^page-in-/)
  expect(handle(page, 'source').closest('.note-canvas-block-summary')?.textContent).toContain('Grouped endpoints')
  expect(handle(page, 'target').closest('header')?.textContent).toContain('Original target')
  expect(block.textContent).toContain('Block → block')
  expect(block.dataset.targetHandle).toMatch(/^block-in-/)
  expect(handle(block, 'target').closest('.note-canvas-block-summary')).not.toBeNull()
  expect(hierarchy.textContent).toContain('Page → page')
  expect(handle(hierarchy, 'source').closest('header')?.textContent).toContain('Original target')
  expect(handle(hierarchy, 'target').closest('header')?.textContent).toContain('Original closed-source')
  expect(dom.container.querySelector('[data-note-id="target"]')!.closest('article')!.querySelector('.note-canvas-degrees')?.textContent).toContain('5 incoming')
  expect(dom.container.querySelector('[data-note-id="closed-source"]')!.closest('article')!.querySelector('.note-canvas-degrees')?.textContent).toContain('6 outgoing')
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  expect(api.notebooks.content).not.toHaveBeenCalled()
})

it('attaches the real Reader original blocks, regroups scrolled-out endpoints, and keeps inspected occurrence/navigation precise', async () => {
  const geometry = installNoteCanvasBlockRows(), open = vi.fn()
  await dom.render(<NoteCanvas scope={scope} onOpen={open} />); await ready()
  await dom.click('[aria-label="Read saved body: Original target"]')
  await dom.click('[aria-label="Read saved body: Original closed-source"]')
  const endpoint = (noteId: string, blockId: string) => [...dom.container.querySelectorAll<HTMLElement>(`.react-flow__node[data-id="${noteId}"] [data-port-block-id]`)].find(element => element.dataset.portBlockId === blockId)
  const labels = () => [...dom.container.querySelectorAll<HTMLElement>('.note-canvas-edge-label')]
  await vi.waitFor(() => expect(endpoint('target', 'target-block')).toBeDefined())
  await vi.waitFor(() => expect(labels().filter(label => label.dataset.relationshipKind === 'reference').map(label => label.dataset.sourceBlock)).toEqual(['source-reference-0', 'source-reference-1']))
  expect(dom.container.querySelector('.note-canvas-reader .mobile-note-reference[data-block-id="source-reference-0"]')).not.toBeNull()
  expect(labels().filter(label => label.dataset.targetKind === 'block').every(label => label.dataset.targetBlock === 'target-block')).toBe(true)
  const page = labels().find(label => label.dataset.targetKind === 'page')!
  expect(page.dataset.sourceBlock).toBe('source-inline'); expect(page.dataset.targetAttachment).toBe('page')
  expect(page.dataset.targetHandle).toMatch(/^page-in-/)
  const second = labels().find(label => label.dataset.sourceBlock === 'source-reference-1')!
  await act(async () => second.click())
  expect(dom.container.querySelectorAll('.note-canvas-inspector li')).toHaveLength(1)
  expect(dom.container.querySelector('.note-canvas-inspector')?.textContent).toContain('source-reference-1')
  const layout = structuredClone(useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(scope)])
  geometry.rows['source-reference-1'] = -100
  const sourceBody = dom.container.querySelector<HTMLElement>('.react-flow__node[data-id="closed-source"] .note-canvas-body')!
  const enumerateOriginal = vi.spyOn(sourceBody.querySelector('.mobile-note-body')!, 'querySelectorAll')
  await act(async () => sourceBody.dispatchEvent(new Event('scroll')))
  await vi.waitFor(() => expect(endpoint('closed-source', 'source-reference-1')).toBeUndefined())
  await vi.waitFor(() => expect(labels().some(label => label.dataset.relationshipKind === 'reference' && label.dataset.sourceAttachment === 'summary')).toBe(true))
  expect(dom.container.querySelectorAll('.note-canvas-inspector li')).toHaveLength(1)
  await dom.click('.note-canvas-inspector-actions button')
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages['closed-source'], 'source-reference-1')
  geometry.scale = 2; geometry.rows['target-block'] = 180
  const targetBody = dom.container.querySelector<HTMLElement>('.react-flow__node[data-id="target"] .note-canvas-body')!
  await act(async () => targetBody.dispatchEvent(new Event('scroll')))
  await vi.waitFor(() => expect(endpoint('target', 'target-block')?.style.top).toBe('195px'))
  geometry.rows['target-block'] = 500
  await act(async () => targetBody.dispatchEvent(new Event('scroll')))
  await vi.waitFor(() => expect(endpoint('target', 'target-block')).toBeUndefined())
  await vi.waitFor(() => expect(labels().filter(label => label.dataset.targetKind === 'block').every(label => label.dataset.targetAttachment === 'summary')).toBe(true))
  expect(useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(scope)]).toEqual(layout)
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1); expect(api.notebooks.content).toHaveBeenCalledTimes(2)
  expect(enumerateOriginal).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[data-note-id="target"]')!.closest('article')!.querySelector('.note-canvas-degrees')?.textContent).toContain('5 incoming')
})

it('stops original-block geometry and clears exact ports while hidden, without consuming scroll events or altering drafts', async () => {
  const geometry = installNoteCanvasBlockRows()
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  await dom.click('[aria-label="Read saved body: Original target"]')
  await vi.waitFor(() => expect(dom.container.querySelector('[data-port-block-id="target-block"]')).not.toBeNull())
  const body = dom.container.querySelector<HTMLElement>('.note-canvas-body')!
  const draft = structuredClone(useAppStore.getState().agentComposerDrafts)
  await dom.render(<NoteCanvas scope={scope} active={false} onOpen={() => {}} />)
  await vi.waitFor(() => expect(dom.container.querySelector('.note-canvas-row-endpoint')).toBeNull())
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))) })
  const reads = geometry.reads, contentReads = vi.mocked(api.notebooks.content).mock.calls.length
  await act(async () => { body.dispatchEvent(new Event('scroll')); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))) })
  expect(geometry.reads).toBe(reads)
  expect(api.notebooks.content).toHaveBeenCalledTimes(contentReads)
  expect(useAppStore.getState().agentComposerDrafts).toEqual(draft)
})

it('uses each exact target block rather than a nearby visible row, and withdraws only a duplicated DOM target', async () => {
  const geometry = installNoteCanvasBlockRows(); geometry.rows['target-other'] = 230
  const target = JSON.parse(body('target', 'First original block'))
  target.content.content.push({ type: 'heading', attrs: { level: 2, blockId: 'target-other' }, content: [{ type: 'text', text: 'Second original block' }] })
  const source = JSON.parse(body('closed-source', 'Original source', true))
  source.content.content.find((block: any) => block.attrs.blockId === 'source-inline').content.find((inline: any) => inline.attrs?.referenceId === 'heading-link').attrs.target.blockId = 'target-other'
  await writeFile(join(directory, 'target.note.json'), JSON.stringify(target))
  await writeFile(join(directory, 'closed-source.note.json'), JSON.stringify(source))
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  await dom.click('[aria-label="Read saved body: Original target"]')
  await vi.waitFor(() => expect(dom.container.querySelectorAll('[data-port-block-id]')).toHaveLength(2))
  const linked = () => dom.container.querySelector<HTMLElement>('.note-canvas-edge-label[data-relationship-kind="link"][data-target-kind="block"]')!
  await vi.waitFor(() => expect(linked().dataset.targetBlock).toBe('target-other'))
  expect([...dom.container.querySelectorAll<HTMLElement>('.note-canvas-edge-label[data-relationship-kind="reference"]')].every(label => label.dataset.targetBlock === 'target-block')).toBe(true)
  const original = dom.container.querySelector('.note-canvas-reader .mobile-note-body')!, row = original.querySelector<HTMLElement>('[data-block-id="target-other"]')!
  await act(async () => original.append(row.cloneNode(true)))
  await vi.waitFor(() => expect(dom.container.querySelector('[data-port-block-id="target-other"]')).toBeNull())
  await vi.waitFor(() => expect(linked().dataset.targetAttachment).toBe('summary'))
  expect(dom.container.querySelector('[data-port-block-id="target-block"]')).not.toBeNull()
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1); expect(api.notebooks.content).toHaveBeenCalledTimes(1)
})

it('keeps an expired raw occurrence explicit after a real saved-file revision refresh until the relationship is selected again', async () => {
  await writeFile(join(directory, 'target.note.json'), body('target', 'See [[Original closed-source]]'))
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  const link = () => dom.container.querySelector<HTMLButtonElement>('.note-canvas-edge-label[data-source-note="target"][data-target-kind="page"]')!
  await vi.waitFor(() => expect(link()).not.toBeNull())
  await act(async () => link().click())
  expect(dom.container.querySelectorAll('.note-canvas-inspector li')).toHaveLength(1)
  await writeFile(join(directory, 'target.note.json'), body('target', 'See [[Original closed-source]] with newer saved context'))
  await dom.click('[aria-label="Refresh saved graph"]')
  await vi.waitFor(() => {
    const status = dom.container.querySelector('.note-canvas-inspector [role="status"]')
    expect(status).not.toBeNull()
    expect(status!.textContent).toContain('selected original occurrence is no longer in this saved graph')
  })
  expect(link()).not.toBeNull()
  expect(dom.container.querySelector('.note-canvas-inspector strong')?.textContent).toBe('Selection changed')
  expect(dom.container.querySelector('.note-canvas-inspector ol')).toBeNull()
  await act(async () => link().click())
  expect(dom.container.querySelectorAll('.note-canvas-inspector li')).toHaveLength(1)
  expect(dom.container.querySelector('.note-canvas-inspector')?.textContent).toContain('[[Original closed-source]]')
  expect(api.notebooks.graph).toHaveBeenCalledTimes(2); expect(api.notebooks.content).not.toHaveBeenCalled()
})

it('publishes dynamic handles after real registration and retires them after actual edge release without missing-handle errors', async () => {
  const geometry = installNoteCanvasBlockRows(), errors: string[] = []
  const publication: FlowPublicationProbe = { waiting: false, published: [], sourceCount: () => 0 }
  await dom.render(<ReactFlowProvider><CaptureFlowErrors errors={errors} publication={publication} /><NoteCanvas scope={scope} onOpen={() => {}} /></ReactFlowProvider>); await ready()
  await dom.click('[aria-label="Read saved body: Original target"]')
  await dom.click('[aria-label="Read saved body: Original closed-source"]')
  const exact = () => dom.container.querySelector('.note-canvas-edge-label[data-source-block="source-reference-1"][data-target-block="target-block"]')
  await vi.waitFor(() => expect(exact()).not.toBeNull())
  const targetBody = dom.container.querySelector<HTMLElement>('.react-flow__node[data-id="target"] .note-canvas-body')!
  geometry.rows['target-block'] = 800
  await act(async () => targetBody.dispatchEvent(new Event('scroll')))
  await vi.waitFor(() => expect(dom.container.querySelector('[data-port-block-id="target-block"]')).toBeNull())
  geometry.rows['target-block'] = 140
  await act(async () => targetBody.dispatchEvent(new Event('scroll')))
  await vi.waitFor(() => expect(exact()).not.toBeNull())
  await dom.click('[aria-label="Collapse saved body: Original closed-source"]')
  await vi.waitFor(() => expect(dom.container.querySelector('.react-flow__node[data-id="closed-source"] [data-port-block-id]')).toBeNull())
  await dom.click('[aria-label="Read saved body: Original closed-source"]')
  await vi.waitFor(() => expect(exact()).not.toBeNull())
  await dom.click('[aria-label="Collapse relationships: Original target"]')
  await vi.waitFor(() => expect(dom.container.querySelector('.react-flow__node[data-id="closed-source"]')).toBeNull())
  await vi.waitFor(() => expect(publication.sourceCount()).toBe(0))
  const readOriginal = vi.mocked(api.notebooks.content).getMockImplementation()!
  let releaseOriginal: (() => void) | undefined
  vi.mocked(api.notebooks.content).mockImplementationOnce((noteId, options) => new Promise(resolve => { releaseOriginal = () => { void readOriginal(noteId, options).then(resolve) } }))
  publication.waiting = true
  await dom.click('[aria-label="Expand relationships: Original target"]'); await ready()
  await vi.waitFor(() => expect(releaseOriginal).toBeDefined())
  const pendingEdges = [...dom.container.querySelectorAll<HTMLElement>('.note-canvas-edge-label[data-source-note="closed-source"]')]
  expect(pendingEdges).toHaveLength(4)
  expect(pendingEdges.every(label => label.dataset.sourceAttachment === 'summary')).toBe(true)
  expect(publication.published).toEqual([])
  publication.waiting = false
  await act(async () => releaseOriginal!())
  await vi.waitFor(() => expect(exact()).not.toBeNull())
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))) })
  expect(errors.filter(id => id === '008')).toEqual([])
})

it('lazily discovers closed original backlinks and reads actual source text only after explicit source expansion', async () => {
  const open = vi.fn()
  await dom.render(<NoteLinksPanel noteId="target" selectedBlockId="target-block" onOpen={open} />)
  expect(api.notebooks.graph).not.toHaveBeenCalled(); expect(api.notebooks.content).not.toHaveBeenCalled()
  await dom.click('.note-links-toggle')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-links-source-toggle')?.textContent).toContain('Original closed-source'))
  expect(dom.container.textContent).toContain('5 incoming · 0 outgoing')
  expect(dom.container.textContent).toContain('1 written link query elsewhere has no confirmed destination')
  expect(api.notebooks.content).not.toHaveBeenCalled()
  await dom.click('.note-links-source-toggle')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original closed source links to'))
  expect(dom.container.querySelectorAll('.note-links-occurrence')).toHaveLength(5)
  expect(dom.container.querySelectorAll('.note-links-block')).toHaveLength(4)
  expect([...dom.container.querySelectorAll('.note-links-excerpt')].filter(item => item.textContent?.includes('Original closed source links to'))).toHaveLength(1)
  const toPage = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-links-actions button')].find(button => button.textContent === 'Open target page')!
  await act(async () => toPage.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages.target, undefined)
  const exactSource = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-links-actions button')].filter(button => button.textContent === 'Open source block').at(-1)!
  await act(async () => exactSource.click())
  expect(open).toHaveBeenLastCalledWith((await store.read()).pages['closed-source'], 'source-inline')
  const only = [...dom.container.querySelectorAll<HTMLButtonElement>('.note-links-controls button')].find(button => button.textContent === 'Selected block only')!
  await act(async () => only.click())
  expect(dom.container.querySelectorAll('.note-links-occurrence')).toHaveLength(4)
  expect(dom.container.textContent).not.toContain('Page link')
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  expect(api.notebooks.content).toHaveBeenCalledTimes(1)
})

it('retains source occurrence evidence on a newer original and on failed refresh, then cancels hidden source reads', async () => {
  await dom.render(<NoteLinksPanel noteId="target" onOpen={() => {}} />)
  await dom.click('.note-links-toggle')
  await vi.waitFor(() => expect(dom.container.querySelector('.note-links-source-toggle')).not.toBeNull())
  await writeFile(join(directory, 'closed-source.note.json'), body('closed-source', 'New unrelated revision'))
  await dom.click('.note-links-source-toggle')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('The saved source changed after this graph'))
  expect(dom.container.querySelectorAll('.note-links-occurrence')).toHaveLength(5)
  expect(dom.container.querySelector('.note-links-excerpt')).toBeNull()
  vi.mocked(api.notebooks.graph).mockRejectedValueOnce(new Error('Original catalog reader unavailable'))
  await dom.click('[aria-label="Refresh saved links"]')
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Original catalog reader unavailable'))
  expect(dom.container.querySelectorAll('.note-links-occurrence')).toHaveLength(5)
  let pending: AbortSignal | undefined
  vi.mocked(api.notebooks.content).mockImplementationOnce((_id, options) => new Promise((_resolve, reject) => { pending = options!.signal; pending!.addEventListener('abort', () => reject(pending!.reason), { once: true }) }))
  await dom.click('.note-links-source-toggle'); await dom.click('.note-links-source-toggle')
  expect(pending?.aborted).toBe(false)
  await dom.render(<NoteLinksPanel noteId="target" active={false} onOpen={() => {}} />)
  expect(pending?.aborted).toBe(true)
  expect(dom.container.querySelectorAll('.note-links-occurrence')).toHaveLength(5)
})

it('does not revive a cancelled Arrange when a later original graph adds another related Note', async () => {
  const workers: DelayedWorker[] = []
  class DelayedWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    request: { id: string } | undefined
    constructor() { workers.push(this) }
    postMessage(request: { id: string }) { this.request = request }
    terminate() {}
  }
  vi.stubGlobal('Worker', DelayedWorker)
  const key = noteCanvasScopeKey(scope)
  useAppStore.setState({ noteCanvasLayouts: { [key]: { positions: { target: { x: 120, y: 80 }, 'closed-source': { x: 500, y: 80 } }, viewport: { x: 0, y: 0, zoom: 1 }, expandedNoteIds: ['target'], previewNoteIds: [] } } })
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  const node = dom.container.querySelector<HTMLElement>('.react-flow__node[data-id="target"]')!
  await act(async () => { node.focus(); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
  await dom.click('[aria-label="Arrange notes"]')
  expect(workers).toHaveLength(1)
  await act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })))
  const manual = useAppStore.getState().noteCanvasLayouts[key]!.positions.target
  await writeFile(join(directory, 'new-child.note.json'), body('new-child', 'New saved related Note'))
  await act(async () => { await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'later-child', change: { kind: 'register', noteId: 'new-child', parentNoteId: 'target', title: 'Later related child', resource: { hostId: 'local', workspaceId: 'notes', workspacePath: directory, path: 'new-child.note.json' } } }, { kind: 'user', id: 'ui-test' }) })
  await dom.click('[aria-label="Refresh saved graph"]')
  await vi.waitFor(() => expect(workers).toHaveLength(2))
  const later = workers[1]!
  await act(async () => later.onmessage?.({ data: { id: later.request!.id, positions: { target: { x: -900, y: -900 }, 'closed-source': { x: -500, y: -500 }, 'new-child': { x: 900, y: 900 } } } } as MessageEvent))
  expect(useAppStore.getState().noteCanvasLayouts[key]!.positions.target).toEqual(manual)
  expect(useAppStore.getState().noteCanvasLayouts[key]!.positions['closed-source']).toEqual({ x: 500, y: 80 })
  expect(useAppStore.getState().noteCanvasLayouts[key]!.positions['new-child']).toBeDefined()
})


it('draws both directions and every relation kind on distinct lanes from original files, with incoming/outgoing counts', async () => {
  await writeFile(join(directory, 'target.note.json'), body('target', 'See [[Original closed-source]]'))
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-edge-label')).toHaveLength(5))
  const labels = [...dom.container.querySelectorAll<HTMLElement>('.note-canvas-edge-label')]
  expect(new Set(labels.map(label => label.dataset.lane)).size).toBe(5)
  expect(new Set(labels.map(label => label.style.transform)).size).toBe(5)
  const labelRows = labels.map(label => Number(/,(-?[\d.]+)px\)$/.exec(label.style.transform)![1])).sort((a, b) => a - b)
  for (let index = 1; index < labelRows.length; index++) expect(labelRows[index]! - labelRows[index - 1]!).toBeGreaterThanOrEqual(50)
  expect(labels.map(label => `${label.dataset.sourceNote}→${label.dataset.targetNote}`)).toContain('target→closed-source')
  const target = dom.container.querySelector('[data-note-id="target"]')!.closest('article')!
  expect(target.querySelector('.note-canvas-degrees')?.textContent).toContain('5 incoming')
  expect(target.querySelector('.note-canvas-degrees')?.textContent).toContain('1 outgoing')
  await act(async () => labels.find(label => label.dataset.sourceNote === 'target')!.click())
  expect(dom.container.querySelector('.note-canvas-inspector')?.textContent).toContain('[[Original closed-source]]')
  expect(dom.container.querySelector('.note-canvas-inspector')?.textContent).toContain('confirm a permanent target')
  expect(api.notebooks.graph).toHaveBeenCalledTimes(1)
  expect(api.notebooks.content).not.toHaveBeenCalled()
})

it('shows cross-Notebook incoming neighbors on first entry, while preserving a saved collapse until Show related', async () => {
  const actor = { kind: 'user', id: 'ui-test' } as const
  const apply = async (change: any) => store.apply({ expectedRevision: (await store.read()).revision, operationId: crypto.randomUUID(), change }, actor)
  await apply({ kind: 'create', notebookId: 'external', name: 'Outside Notebook' })
  await apply({ kind: 'move', noteId: 'closed-source', notebookId: 'external', parentNoteId: null })
  const notebookScope = { kind: 'notebook', notebookId: (await store.read()).pages.target!.notebookId } as const
  await dom.render(<NoteCanvas scope={notebookScope} seedNoteIds={['target']} onOpen={() => {}} />); await ready()
  expect(dom.container.querySelector('[data-note-id="closed-source"]')!.closest('article')?.dataset.context).toBe('true')
  const rootNode = dom.container.querySelector<HTMLElement>('.react-flow__node[data-id="target"]')!
  await act(async () => { rootNode.click(); rootNode.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
  await vi.waitFor(() => expect(useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(notebookScope)]?.positions.target).toBeDefined())
  expect(useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(notebookScope)]!.expandedNoteIds).toEqual(['target'])
  await ready()
  await act(async () => useAppStore.setState({ noteCanvasLayouts: { [noteCanvasScopeKey(notebookScope)]: { positions: { target: { x: 77, y: 99 } }, expandedNoteIds: [], previewNoteIds: [], viewport: { x: 14, y: 25, zoom: .8 } } } }))
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-title[data-note-id]')).toHaveLength(1))
  expect(dom.container.querySelector('.note-canvas-degrees')?.textContent).toContain('5 incoming')
  const reads = vi.mocked(api.notebooks.graph).mock.calls.length
  await dom.click('[aria-label="Show related notes"]'); await ready()
  expect(api.notebooks.graph).toHaveBeenCalledTimes(reads)
  expect(useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(notebookScope)]!.positions.target).toEqual({ x: 77, y: 99 })
  expect(useAppStore.getState().noteCanvasLayouts[noteCanvasScopeKey(notebookScope)]!.viewport).toEqual({ x: 14, y: 25, zoom: .8 })
})


it('keeps an explicit filter even when it matches every Notebook page, until Show related is chosen', async () => {
  const actor = { kind: 'user', id: 'ui-test' } as const
  await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'book-filter', change: { kind: 'create', notebookId: 'external', name: 'Outside Notebook' } }, actor)
  await store.apply({ expectedRevision: (await store.read()).revision, operationId: 'move-filter', change: { kind: 'move', noteId: 'closed-source', notebookId: 'external', parentNoteId: null } }, actor)
  await dom.render(<NoteCanvas scope={{ kind: 'notebook', notebookId: (await store.read()).pages.target!.notebookId }} seedNoteIds={['target']} expandOnFirstView={false} onOpen={() => {}} />)
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-title[data-note-id]')).toHaveLength(1))
  expect(dom.container.querySelector('[data-note-id="target"]')).not.toBeNull()
  await dom.click('[aria-label="Show related notes"]'); await ready()
})


it('keeps different self-reference and embed loops separately visible and selectable', async () => {
  const note = JSON.parse(body('target', 'A Note can cite itself'))
  for (const mode of ['reference', 'embed']) note.content.content.push({ type: 'blockReference', attrs: { blockId: 'self-' + mode, referenceId: 'occurrence-' + mode, mode, target: { noteId: 'target', blockId: 'target-block' } } })
  await writeFile(join(directory, 'target.note.json'), JSON.stringify(note))
  await dom.render(<NoteCanvas scope={scope} onOpen={() => {}} />); await ready()
  await vi.waitFor(() => expect(dom.container.querySelectorAll('.note-canvas-edge-label[data-source-note="target"][data-target-note="target"]')).toHaveLength(2))
  const loops = [...dom.container.querySelectorAll<HTMLElement>('.note-canvas-edge-label[data-source-note="target"][data-target-note="target"]')]
  expect(new Set(loops.map(label => label.style.transform)).size).toBe(2)
  for (const loop of loops) {
    await act(async () => loop.click())
    expect(dom.container.querySelectorAll('.note-canvas-inspector li')).toHaveLength(1)
    expect(dom.container.querySelector('.note-canvas-inspector')?.textContent).toContain('self-' + loop.dataset.relationshipKind)
  }
})
