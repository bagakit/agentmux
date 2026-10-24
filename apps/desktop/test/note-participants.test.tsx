// @vitest-environment happy-dom
import { act, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxNotebookStore } from '@agentmux/core/notebook-store'
import { LocalExecutionHost } from '@agentmux/core'
import type { NotebookActor, NoteResource } from '@agentmux/core/notebook-catalog'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '../src/shared/note-document'
import type { FileDocument, WorkspaceRecord } from '../src/shared/contracts'
import { NoteFileWriter } from '@agentmux/host/note-file-writer'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { NoteFileView } from '../src/renderer/src/components/NoteFileView'
import { noteSavedEditors } from '../src/renderer/src/components/NoteParticipants'
import { noteKnowledge } from '../src/renderer/src/lib/note-knowledge'
import { observeNotebookLibrary, useNotebookLibrary } from '../src/renderer/src/lib/notebook-library'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { NoteSnapshotTestWorker } from './note-snapshot-test-worker'

const dom = composerDOM(), self = { kind: 'user', id: 'confirmed-self' } as const
const agent = { kind: 'agent', id: 'saved-agent-session' } as const
const other = { kind: 'user', id: 'another-person' } as const
const sameIdDevice = { kind: 'device', id: self.id } as const
const image = 'data:image/png;base64,iVBORw0KGgo='
let directory: string, owner: AgentMuxNotebookStore, files: WorkspaceFiles, savedDocument: FileDocument, resource: NoteResource, stop: (() => void) | undefined
function Original({ original = savedDocument, dirty = false }: { original?: FileDocument; dirty?: boolean }) {
  const [draft, setDraft] = useState(original), [changed, setChanged] = useState(dirty)
  return <NoteFileView resource={resource} document={draft} dirty={changed} knowledge={noteKnowledge([])} onChange={raw => { setDraft(value => ({ ...value, content: raw })); setChanged(true) }} onSave={() => {}} onOpen={() => {}} />
}
function editor() { return (dom.container.querySelector('.note-block-content') as HTMLElement & { editor: Editor }).editor }
async function dismiss(label: string) {
  const panel = dom.container.querySelector<HTMLElement>(`[aria-label="Note ${label.toLowerCase()}"]`)!
  expect(window.document.activeElement).toBe(panel)
  await act(async () => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(dom.container.querySelector(`[aria-label="Note ${label.toLowerCase()}"]`)).toBeNull()
  expect(window.document.activeElement).toBe(dom.container.querySelector(`[aria-label="Page ${label.toLowerCase()}"]`))
}
beforeEach(async () => {
  stop = undefined
  vi.stubGlobal('Worker', NoteSnapshotTestWorker)
  directory = await realpath(await mkdtemp(join(tmpdir(), 'amx-note-participants-')))
  const workspace: WorkspaceRecord = { id: 'workspace', hostId: 'local', path: directory, name: 'Notes', kind: 'folder' }
  resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path, path: 'original.note.md' }
  owner = new AgentMuxNotebookStore(join(directory, 'notebooks.sqlite'))
  files = new WorkspaceFiles(() => new LocalExecutionHost())
  const writer = new NoteFileWriter(files, undefined, owner)
  const note = newNoteDocument('First saved paragraph', 'original', 'first', 'Saved title')
  note.content.content!.push({ type: 'paragraph', attrs: { blockId: 'second' }, content: [{ type: 'text', text: 'Second saved paragraph' }] })
  const created = await writer.write(workspace, { path: resource.path, content: serializeNoteDocument(note), expectedRevision: null }, { actor: self })
  expect(created.status).toBe('written'); if (created.status !== 'written') throw Error('Real original creation must be written')
  const initial = await writer.read(workspace, resource.path); if (initial.status !== 'read') throw Error('Actual created body must read')
  const read = readNoteDocument(initial.document.content); if (read.status !== 'valid') throw Error('Original canonical note must parse')
  read.note.content.content![1]!.content = [{ type: 'text', text: 'Agent edited second paragraph' }]
  const written = await writer.write(workspace, { path: resource.path, content: serializeNoteDocument(read.note), expectedRevision: created.revision }, { actor: agent })
  expect(written.status).toBe('written')
  const observed = await writer.read(workspace, resource.path)
  if (observed.status !== 'read' || observed.document.noteProvenance?.status !== 'recorded') throw Error('Actual original file and SQLite authors must read')
  savedDocument = observed.document
  await owner.apply({ operationId: 'register-page', expectedRevision: 0, change: { kind: 'register', noteId: 'original', title: 'Saved title', resource } }, self)
  await owner.apply({ operationId: 'agent-follow', expectedRevision: 1, change: { kind: 'follow', noteId: 'original' } }, agent)
  useAppStore.setState({ config: { ...composerConfig, profile: { displayName: 'Local profile', about: '', avatar: image, shareWithAgents: false }, workspaces: [workspace] }, sessions: [composerSession(agent.id)], agentNames: { [agent.id]: 'Research assistant with a long display name' } })
  vi.spyOn(api.notebooks, 'actor').mockResolvedValue(self)
  vi.spyOn(api.notebooks, 'read').mockImplementation(() => owner.read())
  vi.spyOn(api.notebooks, 'apply').mockImplementation(input => owner.apply(input, self))
  vi.spyOn(api.notebooks, 'onChange').mockImplementation(listener => owner.subscribe(listener))
  vi.spyOn(api.files, 'historyPublic').mockRejectedValue(new Error('Header participants never read history'))
  vi.spyOn(api.files, 'write').mockRejectedValue(new Error('Header participants never write the file'))
  useNotebookLibrary.setState({ state: await owner.read(), issue: null }); stop = observeNotebookLibrary()
})
afterEach(async () => { stop?.(); await dom.render(null); await files.dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); useNotebookLibrary.setState({ state: null, issue: null }); vi.unstubAllGlobals() })

it('places two participant groups below the title, reads the actual saved block authors, and preserves the original dirty editor through both full lists', async () => {
  await dom.render(<Original />)
  const originalEditor = editor(), heading = dom.container.querySelector('[aria-label="Page details"]')!, row = heading.querySelector('[aria-label="Note participants"]')!
  expect(heading.querySelector('.notebook-page-topline [aria-label="Page followers"]')).toBeNull()
  expect(row.previousElementSibling?.getAttribute('aria-label')).toBe('Page title')
  expect(row.querySelectorAll('.note-participants__trigger')).toHaveLength(2)
  expect(row.querySelector('[aria-label="Page editors"]')?.getAttribute('aria-description')).toBe('2 editors')
  expect(row.querySelector('.note-participants__count')).toBeNull()
  expect(row.querySelector('[aria-label="Page followers"]')?.textContent).toBe('Followers')
  expect(row.querySelector('.note-participants__overflow')).toBeNull()
  await act(async () => { originalEditor.view.focus(); originalEditor.commands.insertContentAt(1, 'Unsaved human input ') })
  await dom.click('[aria-label="Page editors"]')
  const roster = heading.querySelector('[aria-label="Note editors"]')!
  expect(roster.textContent).toContain('Creators and most recent editors of the saved blocks.')
  expect(roster.textContent).toContain('This draft is not saved yet.')
  expect(roster.querySelectorAll('li')).toHaveLength(2)
  expect(roster.textContent).toContain(`agent · ${agent.id}`)
  expect(roster.textContent).toContain(`user · ${self.id}`)
  expect(roster.textContent).toContain('Research assistant with a long display name')
  expect(roster.textContent).toContain('Created 2 · Last edited 1')
  await dismiss('Editors'); await dom.click('[aria-label="Page followers"]'); await dismiss('Followers')
  expect(editor()).toBe(originalEditor); expect(editor().state.doc.textContent).toContain('Unsaved human input First saved paragraph')
  expect(api.files.historyPublic).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})

it.each(['hostId', 'workspaceId', 'workspacePath', 'path', 'noteId', 'revision', 'documentPath'] as const)('keeps %s mismatches unknown in the real Note header instead of displaying unrelated saved authors', async field => {
  const saved = structuredClone(savedDocument.noteProvenance!)
  if (field === 'noteId' || field === 'revision') saved[field] += '-unrelated'
  else if (field !== 'documentPath') saved.resource[field] += '-unrelated'
  const original = { ...savedDocument, ...(field === 'documentPath' ? { path: 'another.note.md' } : {}), noteProvenance: saved }
  await dom.render(<Original original={original} />)
  const trigger = dom.container.querySelector('[aria-label="Page editors"]')!
  expect(trigger.textContent).toBe('Editors'); expect(trigger.getAttribute('aria-description')).toContain('not confirmed'); expect(trigger.querySelector('[data-semantic-icon="status.unknown"]')).not.toBeNull(); expect(trigger.querySelectorAll('[data-speaker-id]')).toHaveLength(0)
  await dom.click('[aria-label="Page editors"]')
  const panel = dom.container.querySelector('[aria-label="Note editors"]')!
  expect(panel.textContent).toContain('not confirmed for this file and revision')
  expect(panel.querySelectorAll('li')).toHaveLength(0)
  expect(panel.textContent).not.toContain(agent.id)
  expect(editor().isEditable).toBe(true); expect(api.files.historyPublic).not.toHaveBeenCalled()
})

it('keeps unconfirmed and missing saved records explicit and ignores authored claims in Markdown', async () => {
  const note = readNoteDocument(savedDocument.content); if (note.status !== 'valid') throw Error('Valid saved source required')
  note.note.content.content![0]!.content = [{ type: 'text', text: 'Author: Agent body-claim-is-not-evidence' }]
  const original = { ...savedDocument, content: serializeNoteDocument(note.note), noteProvenance: { ...savedDocument.noteProvenance!, status: 'unconfirmed' as const, reason: 'Metadata observation unavailable' } }
  expect(original.content).toContain('body-claim-is-not-evidence')
  await dom.render(<Original original={original} dirty />); await dom.click('[aria-label="Page editors"]')
  const panel = dom.container.querySelector('[aria-label="Note editors"]')!
  expect(panel.textContent).toContain('Metadata observation unavailable'); expect(panel.querySelectorAll('li')).toHaveLength(0)
  expect(panel.textContent).not.toContain('body-claim-is-not-evidence')
  const missing = noteSavedEditors({ ...savedDocument, noteProvenance: { ...savedDocument.noteProvenance!, blocks: { first: { created: null, lastEdited: null } } } }, 'original', resource)
  expect(missing).toEqual({ editors: [], unknown: 'Some saved blocks have no confirmed author record.' })
})

it('bounds the header avatars but exposes every exact follower identity, and uses the local profile image only for the confirmed same-kind self', async () => {
  const actors: NotebookActor[] = [self, other, sameIdDevice, agent, { kind: 'agent', id: 'not-in-session-list' }, { kind: 'user', id: 'third-person' }]
  let current = await owner.read()
  for (const [index, actor] of actors.entries()) if (actor.id !== agent.id) current = await owner.apply({ operationId: `follower-${index}`, expectedRevision: current.revision, change: { kind: 'follow', noteId: 'original' } }, actor)
  await act(async () => useNotebookLibrary.setState({ state: current }))
  await dom.render(<Original />)
  const trigger = dom.container.querySelector('[aria-label="Page followers"]')!
  expect(trigger.querySelectorAll('.note-participants__avatar')).toHaveLength(3)
  expect(trigger.querySelector('.note-participants__overflow')?.textContent).toBe('+3')
  expect(trigger.getAttribute('aria-description')).toBe('6 followers')
  expect(trigger.querySelector('.note-participants__count')).toBeNull()
  await dom.click('[aria-label="Page followers"]')
  const list = dom.container.querySelector('[aria-label="Note followers"]')!
  expect(list.querySelectorAll('li')).toHaveLength(6)
  for (const actor of actors) {
    const item = list.querySelector(`[data-participant-kind="${actor.kind}"][data-participant-id="${actor.id}"]`)!
    expect(item.textContent).toContain(`${actor.kind} · ${actor.id}`)
    expect(item.querySelector('img')?.getAttribute('src')).toBe(actor.kind === self.kind && actor.id === self.id ? image : undefined)
  }
  expect(list.querySelector('[data-participant-id="not-in-session-list"]')?.textContent).toContain('Agent · not-in-session-list')
  expect(list.querySelectorAll('[data-state="running"], .status-dot')).toHaveLength(0)
  await dismiss('Followers')
})

it('does not use a local profile for an unconfirmed self and keeps the original follow recovery available', async () => {
  vi.mocked(api.notebooks.actor).mockRejectedValue(new Error('Identity observation unavailable'))
  let current = await owner.read()
  current = await owner.apply({ operationId: 'other-follow', expectedRevision: current.revision, change: { kind: 'follow', noteId: 'original' } }, other)
  await act(async () => useNotebookLibrary.setState({ state: current }))
  await dom.render(<Original />); await dom.click('[aria-label="Page followers"]')
  const panel = dom.container.querySelector('[aria-label="Note followers"]')!
  expect(panel.textContent).toContain('Your follow state is unknown.')
  expect(panel.querySelectorAll('img')).toHaveLength(0)
  expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="Follow page"]')!.disabled).toBe(false)
  await dom.click('[aria-label="Follow page"]')
  await vi.waitFor(async () => expect((await owner.read()).pages.original!.followers?.some(f => f.actor.id === self.id)).toBe(true))
  await act(async () => { await vi.waitFor(() => expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="Follow page"]')!.disabled).toBe(false)) })
  expect(panel.textContent).toContain('Refresh identity'); expect(panel.textContent).toContain('Unfollow myself')
})


it('keeps the exact original follower and unfollow action available when a valid saved timestamp is outside the Date display range', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(8_700_000_000_000_000)
  try {
    const original = await owner.read()
    await owner.apply({ operationId: 'legal-future-follow', expectedRevision: original.revision, change: { kind: 'follow', noteId: 'original' } }, self)
  } finally { clock.mockRestore() }
  const saved = await owner.read()
  expect(saved.pages.original!.followers!.find(f => f.actor.id === self.id)?.followedAt).toBe(8_700_000_000_000_000)
  await act(async () => useNotebookLibrary.setState({ state: saved }))
  await dom.render(<Original />); const originalEditor = editor()
  await dom.click('[aria-label="Page followers"]')
  const panel = dom.container.querySelector('[aria-label="Note followers"]')!
  const person = panel.querySelector(`[data-participant-kind="user"][data-participant-id="${self.id}"]`)!
  expect(person.textContent).toContain(`user · ${self.id}`)
  expect(person.textContent).toContain('Time unavailable')
  expect(person.querySelector('time')).toBeNull()
  expect(panel.querySelectorAll('li')).toHaveLength(2)
  expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="Unfollow page"]')!.disabled).toBe(false)
  await dom.click('[aria-label="Unfollow page"]')
  await vi.waitFor(async () => expect((await owner.read()).pages.original!.followers!.some(f => f.actor.id === self.id)).toBe(false))
  await act(async () => { await vi.waitFor(() => expect(dom.container.querySelector<HTMLButtonElement>('[aria-label="Follow page"]')!.disabled).toBe(false)) })
  expect(editor()).toBe(originalEditor)
  expect(api.files.historyPublic).not.toHaveBeenCalled(); expect(api.files.write).not.toHaveBeenCalled()
})
