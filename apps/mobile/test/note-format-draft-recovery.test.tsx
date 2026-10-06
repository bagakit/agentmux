// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { newNoteDocument, readNoteDocument, serializeNoteDocument } from '@agentmux/client-ui/note/note-document'
import type { NoteEditState } from '@agentmux/client-ui/note/note-edit-state'
import type { FileReadResource } from '@agentmux/core/files'
import type { NotesResourceChange } from '@agentmux/core/notebook-store'
import { noteDrafts, noteDraftResourceIdentity } from '../src/navigation/note-drafts'
import { MobileNoteFile } from '../src/navigation/MobileNoteFile'
import { MobileRegionContent } from '../src/navigation/MobileRegionContent'
import { fixturePath } from '../../desktop/scripts/lib/fixture-values.mjs'
const oldRevision = 'sha256:' + 'a'.repeat(64), targetRevision = 'sha256:' + 'b'.repeat(64)
const note = newNoteDocument('Original old Note', 'same-note', 'same-block'), raw = JSON.stringify(note), markdown = serializeNoteDocument(note)
const resource: FileReadResource = { hostId: 'local', workspaceId: '__notes__', workspacePath: fixturePath('note-format-fixture'), zoneId: 'original-zone', zonePath: fixturePath('note-format-fixture'), path: 'one.note.md' }
const from = { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath, path: 'one.note.json' }
const change: NotesResourceChange = { noteId: note.noteId, from, to: { ...from, path: resource.path }, conversion: { sourceRevision: oldRevision, targetRevision } }
const address = (value: FileReadResource) => [JSON.stringify(noteDraftResourceIdentity(value)), note.noteId]
const key = (value: FileReadResource) => 'agentmux-mobile-note-draft:' + JSON.stringify(address(value))
const oldResource = { ...resource, path: from.path }
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
function seed(attempt = true) {
  const state: NoteEditState = { noteId: note.noteId, draft: raw, expectedRevision: oldRevision,
    ...(attempt ? { attempt: { content: raw + ' ', expectedRevision: oldRevision, phase: 'unknown' as const } } : {}) }
  localStorage.setItem(key(oldResource), JSON.stringify(state)); return state
}
it('restores an exact original device draft as Markdown but keeps the original unknown attempt and bytes/revision', () => {
  const original = seed(), drafts = noteDrafts(address(resource))
  expect(drafts.restoreRelocated(resource, note.noteId, [change], targetRevision)).toBe(true)
  const restored = noteDrafts(address(resource)).initial!
  expect(readNoteDocument(restored.draft).status).toBe('valid')
  expect(restored.expectedRevision).toBe(oldRevision)
  expect(restored.attempt).toEqual(original.attempt)
  expect(restored.alternates).toContainEqual({ draft: raw, expectedRevision: oldRevision })
  expect(JSON.parse(localStorage.getItem(key(oldResource))!)).toEqual(original)
})
it('advances a known exact baseline only from the conversion receipt, preserving later input already at the destination', () => {
  seed(false)
  const drafts = noteDrafts(address(resource))
  drafts.restoreRelocated(resource, note.noteId, [change], targetRevision)
  expect(noteDrafts(address(resource)).initial?.expectedRevision).toBe(targetRevision)
  const later = serializeNoteDocument(newNoteDocument('LATER MOBILE INPUT', note.noteId, 'same-block'))
  drafts.save({ noteId: note.noteId, draft: later, expectedRevision: targetRevision })
  drafts.restoreRelocated(resource, note.noteId, [change], targetRevision)
  expect(noteDrafts(address(resource)).initial?.draft).toBe(later)
  expect(noteDrafts(address(resource)).initial?.alternates).toContainEqual({ draft: markdown, expectedRevision: targetRevision })
})
it('does not discover a draft from a similarly named path, another Zone or another Note', () => {
  seed()
  const drafts = noteDrafts(address(resource))
  expect(drafts.restoreRelocated(resource, note.noteId, [], targetRevision)).toBe(false)
  expect(drafts.restoreRelocated({ ...resource, zoneId: 'different-zone' }, note.noteId, [change], targetRevision)).toBe(false)
  expect(drafts.restoreRelocated(resource, note.noteId, [{ ...change, noteId: 'different-note' }], targetRevision)).toBe(false)
  expect(localStorage.getItem(key(resource))).toBeNull()
  expect(localStorage.getItem(key(oldResource))).not.toBeNull()
})
it('actual MobileNoteFile consumes the public mapping and exposes the preserved unknown save without replaying it', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  seed()
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const rpc = vi.fn(async (method: string) => {
    if (method === 'notebook.inspect') return { resourceChanges: [change] }
    throw new Error('Unexpected write or observation: ' + method)
  })
  try {
    await act(async () => root.render(<MobileNoteFile rpc={rpc as any} params={{ zoneId: resource.zoneId, path: resource.path, expectedResource: { hostId: resource.hostId, workspaceId: resource.workspaceId, workspacePath: resource.workspacePath } }}
      read={{ resource, result: { status: 'read', document: { path: resource.path, content: markdown, revision: targetRevision } } }} />))
    expect(host.textContent).toContain('原保存回执未确认')
    expect([...host.querySelectorAll('button')].find(button => button.textContent === '保存原笔记')?.disabled).toBe(true)
    expect(rpc.mock.calls.map(call => call[0])).toEqual(['notebook.inspect'])
    expect(noteDrafts(address(resource)).initial?.attempt?.content).toBe(raw + ' ')
  } finally { await act(async () => root.unmount()); host.remove() }
})
it('keeps an unavailable remote legacy Note readable with only its exact conversion issue and an explicit refresh', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const remote = { ...oldResource, hostId: 'remote-original' }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const rpc = vi.fn(async (method: string) => {
    if (method === 'app.snapshot') return { workspaces: [{ workspaceId: remote.workspaceId, hostId: remote.hostId, path: remote.workspacePath }] }
    if (method === 'file.read') return { resource: remote, result: { status: 'read', document: { path: remote.path, content: raw, revision: oldRevision } } }
    if (method === 'notebook.inspect') return { conversionIssues: [
      { noteId: note.noteId, resource: from, code: 'OTHER_NOTE', message: 'Unrelated local conversion' },
      { noteId: note.noteId, resource: { ...from, hostId: remote.hostId }, code: 'NOTE_CONVERSION_REMOTE', message: 'Original remote Note conversion remains unconfirmed' }
    ] }
    throw new Error('Unexpected write: ' + method)
  })
  try {
    const client = { forwardRpc: rpc } as any
    await act(async () => root.render(<MobileRegionContent client={client} tabId="same-tab" regionId="same-region" zoneId={remote.zoneId} kind="file"
      file={{ workspaceId: remote.workspaceId, path: remote.path, zoneRelativePath: remote.path }} />))
    expect(host.querySelector('pre')?.textContent).toBe(raw)
    expect(host.textContent).toContain('Original remote Note conversion remains unconfirmed')
    expect(host.textContent).not.toContain('Unrelated local conversion')
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === '刷新原转换状态')!.click())
    expect(rpc.mock.calls.map(call => call[0])).toEqual(['app.snapshot', 'file.read', 'notebook.inspect', 'notebook.inspect'])
  } finally { await act(async () => root.unmount()); host.remove() }
})
