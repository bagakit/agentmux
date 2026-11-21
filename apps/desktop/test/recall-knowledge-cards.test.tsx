// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryItem } from '@agentmux/core'
import { applyNotebookChange, DEFAULT_NOTEBOOK_ID, emptyNotebookState, type NoteResource } from '@agentmux/core/notebook-catalog'
import { parseNotebookGraph, readRecallCard, recallCardBlocks, recallCardHref, type RecallCard } from '@agentmux/core/notebook-observation'
import { fileUploadRevision } from '@agentmux/core/files'
import { NOTES_WORKSPACE_ID } from '@agentmux/host/notes-library'
import { createWorkspaceLayout } from '@agentmux/layout'
import { newNoteDocument, readNoteDocument, recallCardNoteBlock, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import { noteKnowledge } from '@agentmux/client-ui/note/note-knowledge'
import { NotebookObservationOwner } from '../../host/src/notebook-observation-owner'
import { fixture as conversationFixture, session as conversationSession } from '../../mobile/test/conversation-fixture'
import { installConversationReading } from '../../mobile/test/conversation-reading-fixture'
import { FileResourceOwner } from '../../host/src/file-resource'
import { api } from '../src/renderer/src/lib/api'
import { checkRecallCard, saveRecallCard } from '../src/renderer/src/lib/recall-card-capture'
import { createRecallDaily, recallDailyAddress } from '../src/renderer/src/lib/recall-daily'
import { recallBacklinks } from '../src/renderer/src/lib/recall-card-navigation'
import { restoreRecallCardIntents } from '../src/renderer/src/lib/recall-card-intent'
import { ConversationRecallCard } from '../src/renderer/src/components/ConversationRecallCard'
import { GlobalRecallSurface } from '../src/renderer/src/components/GlobalRecallSurface'
import { NoteFileView } from '../src/renderer/src/components/NoteFileView'
import { useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import * as workbench from '../src/renderer/src/store'

const workspace = { ...composerConfig.workspaces[0]!, id: NOTES_WORKSPACE_ID }
const workface = { zoneId: 'original-note-zone', workspaceId: workspace.id }
const spaceId = directoryIdentity(workspace.hostId, workspace.path)
const actor = { kind: 'user', id: 'reader' } as const
const date = new Date(2032, 0, 7, 2)
const path = 'original.note.md'
const resource = (path: string): NoteResource => ({ path, hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path })
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
const originalFiles = new FileResourceOwner({
  catalog: async () => spatialCatalog(workbench.useAppStore.getState(), []),
  workspace: id => id === workspace.id ? workspace : undefined,
  files: {
    read: async (_, requested) => read(requested),
    listFiles: async () => { throw new Error('Unexpected directory listing') },
    async write(_, input) {
      const actual = files.get(input.path)
      const observedRevision = actual === undefined ? null : revision(actual)
      if (input.expectedRevision !== observedRevision) return { status: 'conflict', observedRevision }
      if (input.baseContent !== undefined) expect(input.baseContent).toBe(actual)
      files.set(input.path, input.content)
      return { status: 'written', revision: revision(input.content) }
    }
  }
})
const settle = async () => { await act(async () => { await Promise.resolve() }) }
async function openSavedContent(open = true) {
  const disclosure = container!.querySelector<HTMLDetailsElement>('.recall-knowledge-card details')!
  await act(async () => {
    disclosure.open = open
    disclosure.dispatchEvent(new Event('toggle'))
  })
}
function originalConversation(parts: AgentSessionHistoryItem['contentParts']) {
  const conversation = conversationFixture()
  const reference = card.reference
  if (reference.source.kind !== 'native') throw new Error('The fixture uses an original native message.')
  conversation.sessions.set(reference.agentSessionId, { ...conversationSession(), hostId: reference.hostId })
  conversation.setPage({ agentSessionId: reference.agentSessionId, sourceHostId: reference.hostId,
    source: { providerId: reference.source.providerId, nativeSessionId: reference.source.nativeSessionId }, nextCursor: null,
    items: [
      { id: 'adjacent-record', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Unselected neighbour.' }] },
      { id: reference.source.recordId, kind: 'user-message', contentParts: parts }
    ] })
  installConversationReading(conversation)
  return conversation
}
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
  changeBook({ kind: 'register', noteId: 'selected-note', title: 'Research note', resource: resource(path) }, 'selected-note-register')
  workbench.useAppStore.setState({
    config: { ...composerConfig, workspaces: [workspace] }, recallCardIntents: {}, tabs: {}, sessions: [],
    spaceZoneBindings: { [workface.zoneId]: { spaceId, workspaceId: workspace.id, directoryPath: workspace.path, relations: { [spaceId]: false } } }
  })
  useNotebookLibrary.setState({ state: catalog })
  vi.spyOn(workbench, 'persistRecallCardIntent').mockImplementation(async (intent, settled) => {
    const key = JSON.stringify([intent.card.routeHostId, intent.card.reference.agentSessionId, intent.card.id])
    const intents = { ...workbench.useAppStore.getState().recallCardIntents }
    if (settled) delete intents[key]; else intents[key] = intent
    workbench.useAppStore.setState({ recallCardIntents: restoreRecallCardIntents(intents) })
  })
  vi.spyOn(api.notebooks, 'read').mockImplementation(async () => catalog)
  vi.spyOn(api.notebooks, 'apply').mockImplementation(async input => { changeBook(input.change, input.operationId); return catalog })
  vi.spyOn(api.files, 'readPublic').mockImplementation(input => originalFiles.read(input))
  vi.spyOn(api.files, 'createPublic').mockImplementation(input => originalFiles.create(input))
  vi.spyOn(api.files, 'writePublic').mockImplementation(input => originalFiles.write(input))
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
  const backlinks = recallBacklinks({ catalog, graph }, { hostId: card.routeHostId, agentSessionId: card.reference.agentSessionId })
  await display(<ConversationRecallCard card={card} backlinks={backlinks} />)
  expect(container!.querySelector('.recall-knowledge-card')?.textContent).toContain('Open Research note')
  const beforeNoteOpen = workbench.useAppStore.getState()
  const openFile = vi.fn(async () => true)
  const originalRead = vi.spyOn(api.files, 'read').mockImplementation(async (_, requested) => read(requested))
  try {
    workbench.useAppStore.setState({
      openFile, layouts: {},
      prepareWorkbenchLayout: () => createWorkspaceLayout('notes-group', []),
      setMainSurface: mainSurface => workbench.useAppStore.setState({ mainSurface }),
      setRecallNotebook: (recallNotebookId, recallNoteId) => workbench.useAppStore.setState({ recallNotebookId, recallNoteId: recallNoteId ?? null }),
      setRecallZoneSelection: recallZoneSelection => workbench.useAppStore.setState({ recallZoneSelection })
    })
    const link = [...container!.querySelectorAll('button')].find(button => button.textContent === 'Open Research note')!
    await act(async () => link.click())
    expect(originalRead).toHaveBeenCalledWith(workspace.id, path)
    expect(openFile).toHaveBeenCalledWith(path, 'notes-group', {
      line: 1, noteBlock: { noteId: saved.page.noteId, blockId: saved.blockId }
    }, workspace.id, true, expect.objectContaining({
      space: expect.objectContaining({ zoneId: workspaceZoneId(spaceId, workspace.id) })
    }), undefined)
  } finally {
    workbench.useAppStore.setState(beforeNoteOpen)
  }
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

it('saves the exact message text inside the card in one original write and displays it with its link', async () => {
  const reference = card.reference
  const exactText = 'The decision preserves the original file.\n\nA later edit can still refer to it.'
  const conversation = originalConversation([{ kind: 'text', text: exactText }])
  const readOriginal = vi.spyOn(api.conversation, 'readAgentConversation').mockImplementation(conversation.client.readAgentConversation)
  const release = vi.spyOn(api.conversation, 'releaseConversationView').mockImplementation(conversation.client.releaseConversationView)

  const saved = await saveRecallCard(card, catalog.pages['selected-note']!, date)
  expect(saved.text).toBe('saved')
  expect(readOriginal).toHaveBeenCalledWith(expect.objectContaining({ hostId: card.routeHostId, record: reference }))
  expect(release).toHaveBeenCalledTimes(1)
  expect(api.files.writePublic).toHaveBeenCalledTimes(1)
  const document = read(path)
  if (document.status !== 'read') throw new Error('Saved Note is unavailable.')
  expect(document.document.content.startsWith(body)).toBe(true)
  expect(document.document.content).not.toContain('Unselected neighbour.')
  const persisted = readNoteDocument(document.document.content)
  const occurrence = persisted.status === 'valid' && recallCardBlocks(persisted.note.content)[0]
  expect(occurrence).toMatchObject({ blockId: saved.blockId, card, body: [{ content: [{ type: 'text', text: exactText }] }] })

  await display(<NoteFileView document={document.document} resource={resource(path)} knowledge={{ scope: 'complete', sources: [], invalid: [], references: [] }}
    onChange={() => {}} onSave={() => {}} onOpen={() => {}} />)
  expect(container!.querySelector('.recall-knowledge-card .note-embedded-content')).toBeNull()
  await openSavedContent()
  await vi.waitFor(() => expect(container!.querySelector('.recall-knowledge-card .note-embedded-content')?.textContent).toContain('A later edit'))
  expect(container!.querySelector('.recall-knowledge-card__actions button')?.textContent).toBe('Open original message')
})

it('opens a reference in a saved card body using the original Note citation scope', async () => {
  const note = newNoteDocument('Original file.', 'selected-note', 'source-block', 'Research note')
  const target = { noteId: 'supporting-note', blockId: 'evidence-block' }
  note.content.content!.push(recallCardNoteBlock(card, 'reading-anchor', { containerId: 'card-container',
    blocks: [{ type: 'blockReference', attrs: { blockId: 'quoted-evidence', referenceId: 'quoted-evidence-link', mode: 'reference', target } }] }))
  const content = serializeNoteDocument(note)
  const original = { path, content, revision: revision(content) }
  const supportingPath = 'supporting.note.md'
  const supporting = serializeNoteDocument(newNoteDocument('Keep the original evidence.', target.noteId, target.blockId, 'Evidence'))
  const knowledge = noteKnowledge([
    { location: { workspaceId: workspace.id, path }, document: original },
    { location: { workspaceId: workspace.id, path: supportingPath }, document: { path: supportingPath, content: supporting, revision: revision(supporting) } }
  ], 'complete')
  const open = vi.fn()
  await display(<NoteFileView document={original} resource={resource(path)} knowledge={knowledge}
    onChange={() => {}} onSave={() => {}} onOpen={open} />)
  await openSavedContent()
  const preview = container!.querySelector('.recall-knowledge-card .note-reference')
  expect(preview?.querySelector('.note-reference__excerpt')?.textContent).toBe('Keep the original evidence.')
  await act(async () => preview!.querySelector('button')!.click())
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ location: { workspaceId: workspace.id, path: supportingPath } }), target.blockId)
})

it('reads the exact original card body inline when expanded from Conversation', async () => {
  const note = newNoteDocument('Outside the card.', 'selected-note', 'source-block', 'Research note')
  note.content.content!.push(recallCardNoteBlock(card, 'saved-card', { containerId: 'saved-container',
    blocks: [
      { type: 'heading', attrs: { blockId: 'finding', level: 2 }, content: [{ type: 'text', text: 'Saved finding' }] },
      { type: 'codeBlock', attrs: { blockId: 'example' }, content: [{ type: 'text', text: 'const example = true' }] },
      { type: 'paragraph', attrs: { blockId: 'last-line' }, content: [{ type: 'text', text: 'The complete last paragraph.' }] }
    ] }))
  files.set(path, serializeNoteDocument(note))
  const graph = await originalObservation.graph(catalog, {})
  const content = vi.spyOn(api.notebooks, 'content').mockImplementation(noteId => originalObservation.content(catalog, noteId))
  const backlinks = recallBacklinks({ catalog, graph }, { hostId: card.routeHostId, agentSessionId: card.reference.agentSessionId })
  await display(<ConversationRecallCard card={{ ...card, title: 'Renamed reading point' }} backlinks={backlinks} inNamedRow />)
  expect(container!.querySelector('.recall-knowledge-card strong')?.textContent).toBe(card.title)
  expect(content).not.toHaveBeenCalled()
  await openSavedContent()
  const preview = container!.querySelector('.recall-knowledge-card .note-embedded-content')!
  expect(preview.querySelector('h2')?.textContent).toBe('Saved finding')
  expect(preview.querySelector('pre')?.textContent).toBe('const example = true')
  expect(preview.textContent).toContain('The complete last paragraph.')
  expect(preview.textContent).not.toContain('Outside the card.')
  expect(content).toHaveBeenCalledExactlyOnceWith('selected-note', { signal: expect.any(AbortSignal) })
  await openSavedContent(false)
  expect(content.mock.calls[0]![1]!.signal?.aborted).toBe(true)
  expect(container!.querySelector('.recall-knowledge-card .note-embedded-content')).toBeNull()
  expect(api.files.writePublic).not.toHaveBeenCalled()
})

it('shows a confirmed link-only card and keeps the Note action when its saved body cannot be checked', async () => {
  const saved = await saveRecallCard(card, catalog.pages['selected-note']!, date)
  const graph = await originalObservation.graph(catalog, {})
  const content = vi.spyOn(api.notebooks, 'content').mockImplementation(noteId => originalObservation.content(catalog, noteId))
    .mockRejectedValueOnce(new Error('Original read unavailable'))
  const backlinks = recallBacklinks({ catalog, graph }, { hostId: card.routeHostId, agentSessionId: card.reference.agentSessionId })
  await display(<ConversationRecallCard card={card} backlinks={backlinks} />)
  await openSavedContent()
  expect(container!.querySelector('[role="status"]')?.textContent).toContain('Original read unavailable')
  expect(container!.querySelector('.recall-knowledge-card__actions button')?.textContent).toBe('Open Research note')
  const retry = [...container!.querySelectorAll('button')].find(button => button.textContent === 'Retry saved content')!
  await act(async () => retry.click())
  expect(container!.textContent).toContain('Only the source link was saved.')
  files.set(path, body)
  await display(null)
  await display(<ConversationRecallCard card={card} backlinks={backlinks} />)
  await openSavedContent()
  expect(container!.textContent).toContain('This card could not be confirmed in its original Note.')
  expect(container!.textContent).not.toContain('Only the source link was saved.')
  expect(content).toHaveBeenCalledTimes(3)
  expect(saved.page.noteId).toBe('selected-note')
})

it('keeps the directory usable until the user creates today’s Daily, then captures into the same file', async () => {
  const original = workbench.useAppStore.getState()
  const openFile = vi.fn(async () => true)
  vi.spyOn(api.files, 'read').mockImplementation(async (_, requested) => read(requested))
  workbench.useAppStore.setState({
    loading: false, mainSurface: 'recall', recallNotebookId: null, recallNoteId: null, recallZoneSelection: null,
    notebookRecoveries: [], openFile, layouts: {},
    prepareWorkbenchLayout: () => createWorkspaceLayout('notes-group', [])
  })
  try {
    await display(<GlobalRecallSurface catalog={null} projection={null} selection={null} />)
    const create = [...container!.querySelectorAll('button')].find(button => button.textContent === 'Create today’s Daily')!
    expect(create).toBeDefined()
    expect(api.files.createPublic).not.toHaveBeenCalled()
    await act(async () => create.click())
    await vi.waitFor(() => expect(openFile).toHaveBeenCalled())
    const current = catalog.pages[workbench.useAppStore.getState().recallNoteId!]!
    expect(current.notebookId).toBe(DEFAULT_NOTEBOOK_ID)
    const captured = await saveRecallCard(card, null)
    expect(captured.page.resource).toEqual(current.resource)
    expect(await createRecallDaily()).toEqual(current)
    expect(api.files.createPublic).toHaveBeenCalledTimes(1)
    expect(api.files.writePublic).toHaveBeenCalledTimes(1)
  } finally {
    await display(null)
    workbench.useAppStore.setState(original)
  }
})

it('checks the same Daily after midnight without replaying its unconfirmed creation', async () => {
  const original = workbench.useAppStore.getState()
  const tomorrow = new Date(date); tomorrow.setDate(date.getDate() + 1)
  const button = (label: string) => [...container!.querySelectorAll('button')].find(candidate => candidate.textContent === label)!
  workbench.useAppStore.setState({
    loading: false, mainSurface: 'recall', recallNotebookId: null, recallNoteId: null, recallZoneSelection: null, notebookRecoveries: []
  })
  vi.mocked(api.files.createPublic).mockResolvedValueOnce({
    resource: null, result: { status: 'unknown', code: 'ACK_UNKNOWN', message: 'Original reply unavailable' }
  })
  vi.setSystemTime(date)
  try {
    await display(<GlobalRecallSurface catalog={null} projection={null} selection={null} />)
    await act(async () => button('Create today’s Daily').click())
    expect(button('Check this Daily')).toBeDefined()
    vi.setSystemTime(tomorrow)
    await act(async () => button('Check this Daily').click())
    expect(api.files.readPublic).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.files.readPublic).mock.calls.map(([input]) => input.path))
      .toEqual([recallDailyAddress(date).path, recallDailyAddress(date).path])
    expect(api.files.createPublic).toHaveBeenCalledTimes(1)
    expect(button('Create today’s Daily')).toBeDefined()
  } finally {
    vi.useRealTimers()
    await display(null)
    workbench.useAppStore.setState(original)
  }
})

it('keeps the exact pending destination after a lost write reply and checks the same file without a duplicate write', async () => {
  const conversation = originalConversation([
    { kind: 'text', text: 'The visible text.' },
    { kind: 'resource', resourceType: 'image', reference: 'opaque:image' }
  ])
  vi.spyOn(api.conversation, 'readAgentConversation').mockImplementation(conversation.client.readAgentConversation)
  vi.spyOn(api.conversation, 'releaseConversationView').mockImplementation(conversation.client.releaseConversationView)
  vi.mocked(api.files.writePublic).mockImplementationOnce(async input => {
    await originalFiles.write(input)
    throw new Error('Reply lost for the original file')
  })
  await expect(saveRecallCard(card, catalog.pages['selected-note']!, date)).rejects.toThrow('Reply lost')
  const originalIntent = Object.values(workbench.useAppStore.getState().recallCardIntents)[0]!
  expect(originalIntent.phase).toBe('checking')
  const history = vi.spyOn(api.files, 'historyPublic').mockImplementation(async input => {
    expect(input.eventId).toBe(originalIntent.writeAttempt)
    expect(input.path).toBe(path)
    return { resource: input.expectedResource, result: { status: 'read', noteId: 'selected-note', resource: resource(path),
      batches: [], hasMore: false, entries: [{ eventId: input.eventId, status: 'committed' }] } } as Awaited<ReturnType<typeof api.files.historyPublic>>
  })
  await expect(saveRecallCard(card, null, date)).rejects.toThrow('Check the original Recall save')
  await display(<ConversationRecallCard card={card} />)
  const check = [...container!.querySelectorAll('button')].find(button => button.textContent === 'Check original save')!
  await act(async () => check.click())
  expect(container!.textContent).toContain('Open Research note')
  expect(container!.textContent).toContain('Saved the available text.')
  expect(history).toHaveBeenCalledTimes(1)
  expect(api.files.writePublic).toHaveBeenCalledTimes(1)
  expect(api.files.createPublic).not.toHaveBeenCalled()
  expect(workbench.useAppStore.getState().recallCardIntents).toEqual({})
})

it('keeps overlapping requests for two destinations distinct', async () => {
  let release = () => {}
  const confirmFirst = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.files.writePublic).mockImplementationOnce(async input => {
    await confirmFirst
    return originalFiles.write(input)
  })
  const selected = catalog.pages['selected-note']!
  const first = saveRecallCard(card, selected, date)
  await vi.waitFor(() => expect(api.files.writePublic).toHaveBeenCalledTimes(1))
  expect(saveRecallCard(card, selected, date)).toBe(first)
  const originalIntent = Object.values(workbench.useAppStore.getState().recallCardIntents)[0]!
  expect(checkRecallCard(card, originalIntent.operationId)).toBe(first)
  const second = saveRecallCard(card, null, date)
  const secondResult = expect(second).rejects.toThrow('another Note is already in progress')
  release()
  await expect(first).resolves.toMatchObject({ page: { noteId: selected.noteId } })
  await secondResult
  expect(api.files.createPublic).not.toHaveBeenCalled()
  await expect(saveRecallCard(card, null, date)).resolves.toMatchObject({ page: { noteId: recallDailyAddress(date).noteId } })
})

it('writes an explicitly selected nested Note using the original Zone-relative address', async () => {
  const nested = { ...workface, zoneId: 'journal-zone' }
  const nestedPath = 'journal/decisions.note.md'
  workbench.useAppStore.setState(state => ({ spaceZoneBindings: { ...state.spaceZoneBindings, [nested.zoneId]: {
    spaceId, workspaceId: workspace.id, directoryPath: workspace.path + '/journal', relations: { [spaceId]: false }
  } } }))
  files.set(nestedPath, serializeNoteDocument(newNoteDocument('Decisions', 'decisions', 'existing-block', 'Decisions')))
  await api.notebooks.apply({ expectedRevision: catalog.revision, operationId: 'register-decisions',
    change: { kind: 'register', noteId: 'decisions', title: 'Decisions', resource: resource(nestedPath), workface: nested } })

  const saved = await saveRecallCard(card, catalog.pages.decisions!, date)
  expect(saved.page.resource.path).toBe(nestedPath)
  expect(api.files.readPublic).toHaveBeenCalledWith(expect.objectContaining({ zoneId: nested.zoneId, path: 'decisions.note.md' }))
  const nestedNote = readNoteDocument(files.get(nestedPath)!)
  expect(nestedNote.status === 'valid' && recallCardBlocks(nestedNote.note.content)).toEqual([{ blockId: saved.blockId, card }])
  expect(files.get(path)).toBe(body)
  expect(files.has('journal/' + nestedPath)).toBe(false)
})

it('continues the same Daily after the original file and catalog entry move', async () => {
  const first = await saveRecallCard(card, null, date)
  const from = first.page.resource, to = resource('journal/renamed.note.md')
  files.set(to.path, files.get(from.path)!)
  files.delete(from.path)
  await api.notebooks.apply({ expectedRevision: catalog.revision, operationId: 'move-daily',
    change: { kind: 'relocate', noteId: first.page.noteId, from, resource: to } })
  const second = await saveRecallCard({ ...card, id: 'another-reading-point' }, null, date)
  expect(second.page.noteId).toBe(first.page.noteId)
  expect(second.page.resource).toEqual(to)
  expect(api.files.createPublic).toHaveBeenCalledTimes(1)
  expect(files.has(from.path)).toBe(false)
  const moved = readNoteDocument(files.get(to.path)!)
  expect(moved.status === 'valid' && recallCardBlocks(moved.note.content)).toHaveLength(2)
})

it('permits choosing another destination after the first Note cannot be read', async () => {
  files.delete(path)
  await expect(saveRecallCard(card, catalog.pages['selected-note']!, date)).rejects.toThrow('cannot be read')
  expect(workbench.persistRecallCardIntent).not.toHaveBeenCalled()
  expect(api.files.writePublic).not.toHaveBeenCalled()
  const saved = await saveRecallCard(card, null, date)
  expect(saved.page.resource.path).not.toBe(path)
  expect(files.has(path)).toBe(false)
})

it('permits choosing another destination after a confirmed revision conflict', async () => {
  const edited = body + '\nIndependent edit\n'
  vi.mocked(api.files.writePublic).mockImplementationOnce(input => {
    files.set(path, edited)
    return originalFiles.write(input)
  })
  await expect(saveRecallCard(card, catalog.pages['selected-note']!, date)).rejects.toThrow('destination changed')
  expect(workbench.useAppStore.getState().recallCardIntents).toEqual({})
  const saved = await saveRecallCard(card, null, date)
  expect(saved.page.resource.path).not.toBe(path)
  expect(files.get(path)).toBe(edited)
})
