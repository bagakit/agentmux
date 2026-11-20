// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyNotebookChange, DEFAULT_NOTEBOOK_ID, emptyNotebookState, type NoteResource } from '@agentmux/core/notebook-catalog'
import { parseNotebookGraph, readRecallCard, recallCardBlocks, recallCardHref, type RecallCard } from '@agentmux/core/notebook-observation'
import { fileUploadRevision } from '@agentmux/core/files'
import { NOTES_WORKSPACE_ID } from '@agentmux/host/notes-library'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { NotebookObservationOwner } from '../../host/src/notebook-observation-owner'
import { api } from '../src/renderer/src/lib/api'
import { saveRecallCard } from '../src/renderer/src/lib/recall-card-capture'
import { restoreRecallCardIntents } from '../src/renderer/src/lib/recall-card-intent'
import { ConversationRecallCard } from '../src/renderer/src/components/ConversationRecallCard'
import { NoteFileView } from '../src/renderer/src/components/NoteFileView'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import * as workbench from '../src/renderer/src/store'

const workspace = { ...composerConfig.workspaces[0]!, id: NOTES_WORKSPACE_ID }
const workface = { zoneId: 'original-note-zone', workspaceId: workspace.id }
const actor = { kind: 'user', id: 'reader' } as const
const date = new Date(2032, 0, 7, 2)
const path = 'original.note.md'
const resource = (path: string): NoteResource => ({ path, hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path })
const mapping = (path: string) => ({ ...resource(path), zoneId: workface.zoneId, zonePath: workspace.path })
const card: RecallCard = { id: 'reading-point', title: 'Where we decided [why]', routeHostId: 'reader-route',
  reference: { hostId: 'native-source', agentSessionId: 'original-agent', source: { kind: 'native', providerId: 'provider', nativeSessionId: 'source', recordId: 'original-record' } } }
const body = serializeNoteDocument(newNoteDocument('Keep existing bytes.', 'selected-note', 'source-block', 'Research note'))
const revision = (content: string) => fileUploadRevision(new TextEncoder().encode(content))
const files = new Map<string, string>()
let catalog: ReturnType<typeof emptyNotebookState>
let root: ReturnType<typeof createClientUiRoot> | undefined
let container: HTMLDivElement | undefined

const read = (requested: string) => {
  const content = files.get(requested)
  return content === undefined ? { status: 'deleted' as const } : { status: 'read' as const, document: { path: requested, content, revision: revision(content) } }
}
const originalObservation = new NotebookObservationOwner({ workspace: id => id === workspace.id ? workspace : undefined,
  files: { read: async (_, requested) => read(requested) } })
const settle = async () => { await act(async () => { await Promise.resolve() }) }
async function display(node: ReactNode) {
  if (!root) {
    container = document.createElement('div')
    document.body.append(container)
    root = createClientUiRoot(container)
  }
  await act(async () => root!.render(node))
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  files.clear()
  files.set(path, body)
  catalog = emptyNotebookState()
  const changeBook = (change: Parameters<typeof applyNotebookChange>[1]['change'], operationId: string) => {
    catalog = applyNotebookChange(catalog, { expectedRevision: catalog.revision, operationId, change }, actor, date.getTime())
  }
  changeBook({ kind: 'bind', notebookId: DEFAULT_NOTEBOOK_ID, workface }, 'bind-notes')
  changeBook({ kind: 'register', noteId: 'selected-note', title: 'Research note', resource: resource(path), workface }, 'selected-note-register')
  workbench.useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace] }, recallCardIntents: {} })
  useNotebookLibrary.setState({ state: catalog })
  vi.spyOn(workbench, 'persistRecallCardIntent').mockImplementation(async (intent, settled) => {
    const key = JSON.stringify([intent.card.routeHostId, intent.card.reference.agentSessionId, intent.card.id])
    const intents = { ...workbench.useAppStore.getState().recallCardIntents }
    if (settled) delete intents[key]; else intents[key] = intent
    workbench.useAppStore.setState({ recallCardIntents: restoreRecallCardIntents(intents) })
  })
  vi.spyOn(api.notebooks, 'read').mockImplementation(async () => catalog)
  vi.spyOn(api.notebooks, 'apply').mockImplementation(async input => { changeBook(input.change, input.operationId); return catalog })
  vi.spyOn(api.files, 'readPublic').mockImplementation(async input => ({ resource: mapping(input.path), result: read(input.path) }))
  vi.spyOn(api.files, 'createPublic').mockImplementation(async input => {
    expect(input.expectedResource).toEqual(mapping(input.path))
    if (files.has(input.path)) return { resource: mapping(input.path), result: { status: 'conflict', observedRevision: revision(files.get(input.path)!) } }
    files.set(input.path, input.content)
    return { resource: mapping(input.path), result: { status: 'written', revision: revision(input.content) } }
  })
  vi.spyOn(api.files, 'writePublic').mockImplementation(async input => {
    expect(input.expectedResource).toEqual(mapping(input.path))
    expect(input.baseContent).toBe(files.get(input.path))
    expect(input.expectedRevision).toBe(revision(input.baseContent!))
    files.set(input.path, input.content)
    return { resource: mapping(input.path), result: { status: 'written', revision: revision(input.content) } }
  })
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove(); root = undefined; container = undefined
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('writes the chosen original file and projects one exact card from the Notebook graph into both consumers', async () => {
  const saved = await saveRecallCard(card, catalog.pages['selected-note']!, date)
  expect(saved.page.resource).toEqual(resource(path))
  expect(files.get(path)).toMatch(/^---[\s\S]*Keep existing bytes\./u)
  expect(files.get(path)?.startsWith(body)).toBe(true)
  expect(api.files.createPublic).not.toHaveBeenCalled()
  const graph = parseNotebookGraph(await originalObservation.graph(catalog, {}), {})
  expect(graph.recallCards).toEqual([{ source: { noteId: saved.page.noteId, blockId: saved.blockId }, card }])
  expect(readRecallCard(recallCardHref(card), card.title)).toEqual(card)
  await display(<ConversationRecallCard card={card} observed={{ catalog, graph }} />)
  expect(container!.querySelector('.recall-knowledge-card')?.textContent).toContain('Open Research note')
  const actual = read(path)
  expect(actual.status).toBe('read')
  if (actual.status !== 'read') throw new Error('Fixture note must be readable')
  await display(<NoteFileView document={actual.document} resource={resource(path)} knowledge={{ scope: 'complete', sources: [], invalid: [], references: [] }}
    onChange={() => {}} onSave={() => {}} onOpen={() => {}} />)
  await settle()
  expect(container!.querySelector('.recall-knowledge-card')?.textContent).toContain('Open original message')
  expect(container!.querySelector('.recall-knowledge-card')?.textContent).toContain(card.title)
  const session = composerSession(card.reference.agentSessionId)
  const focus = vi.fn(() => true), reveal = vi.fn(async () => ({ kind: 'located' as const }))
  const navigation = workbench.useAppStore.getState()
  try {
    workbench.useAppStore.setState({ sessions: [{ ...session, control: { ...session.control, hostId: card.routeHostId } }],
      focusExecutionSession: focus, revealConversationItem: reveal, setMainSurface: vi.fn() })
    const source = [...container!.querySelectorAll('button')].find(button => button.textContent === 'Open original message')!
    await act(async () => source.click())
    expect(focus).toHaveBeenCalledWith(card.reference.agentSessionId)
    expect(reveal).toHaveBeenCalledWith(card.reference, card.routeHostId)
  } finally {
    workbench.useAppStore.setState({ sessions: navigation.sessions, focusExecutionSession: navigation.focusExecutionSession,
      revealConversationItem: navigation.revealConversationItem, setMainSurface: navigation.setMainSurface })
  }

})

it('creates one default Daily per local day and appends different cards to its original file', async () => {
  const first = await saveRecallCard(card, null, date)
  const second = await saveRecallCard({ ...card, id: 'another-reading-point' }, null, date)
  expect(first.page.resource).toEqual(second.page.resource)
  expect(first.page.noteId).toBe(second.page.noteId)
  expect(second.page.notebookId).toBe(DEFAULT_NOTEBOOK_ID)
  expect(second.page.resource.path).toMatch(/^Daily-\d{4}-\d{2}-\d{2}\.note\.md$/u)
  expect(api.files.createPublic).toHaveBeenCalledTimes(1)
  expect(api.files.writePublic).toHaveBeenCalledTimes(1)
  const content = readNoteDocument(files.get(second.page.resource.path)!)
  expect(content.status === 'valid' && recallCardBlocks(content.note.content)).toHaveLength(2)
  const tomorrow = new Date(date); tomorrow.setDate(date.getDate() + 1)
  const third = await saveRecallCard(card, null, tomorrow)
  expect(third.page.noteId).not.toBe(first.page.noteId)
})

it('keeps the exact pending destination after a lost write reply and checks the same file without a duplicate write', async () => {
  vi.mocked(api.files.writePublic).mockImplementationOnce(async input => {
    files.set(input.path, input.content)
    throw new Error('Reply lost for the original file')
  })
  await expect(saveRecallCard(card, catalog.pages['selected-note']!, date)).rejects.toThrow('Reply lost')
  const originalIntent = Object.values(workbench.useAppStore.getState().recallCardIntents)[0]!
  expect(originalIntent.phase).toBe('checking')
  const history = vi.spyOn(api.files, 'historyPublic').mockImplementation(async input => {
    expect(input.eventId).toBe(originalIntent.writeAttempt)
    return { resource: mapping(path), result: { status: 'read', noteId: 'selected-note', resource: resource(path),
      batches: [], hasMore: false, entries: [{ eventId: input.eventId, status: 'committed' }] } } as Awaited<ReturnType<typeof api.files.historyPublic>>
  })
  const same = await saveRecallCard(card, null, new Date())
  expect(same.page.resource.path).toBe(path)
  expect(history).toHaveBeenCalledTimes(1)
  expect(api.files.writePublic).toHaveBeenCalledTimes(1)
  expect(api.files.createPublic).not.toHaveBeenCalled()
  expect(workbench.useAppStore.getState().recallCardIntents).toEqual({})
})
