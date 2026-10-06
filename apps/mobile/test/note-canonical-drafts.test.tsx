import { fixtureEpoch as _liveTailFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { noteDrafts } from '../src/navigation/note-drafts'
import { NoteReader, type NoteEditState } from '@agentmux/client-ui/components/NoteReader'
import { newNoteDocument } from '@agentmux/client-ui/note/note-document'
import { attributeNoteBlocks } from '@agentmux/client-ui/note/note-provenance'
import type { FileWriteReceipt } from '@agentmux/core/files'
import type { Editor } from '@tiptap/core'
import { acknowledgeNoteWrite } from '@agentmux/client-ui/note/note-edit-state'

const revision = 'sha256:' + 'a'.repeat(64), nextRevision = 'sha256:' + 'b'.repeat(64)
const source = newNoteDocument('Original text', 'original-note', 'original-block'), content = JSON.stringify(source)
const canonical = JSON.stringify(attributeNoteBlocks(null, source, { kind: 'agent', id: 'confirmed-agent' }, _liveTailFixtureEpoch(0, 0, 100)))
let root: Root | undefined, host: HTMLDivElement | undefined
afterEach(async () => { if (root) await act(() => root!.unmount()); host?.remove(); root = undefined; vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('does not let an earlier canonical receipt settle another workface original pending attempt', () => {
  const other = 'sha256:' + 'c'.repeat(64)
  const current: NoteEditState = { noteId: source.noteId, draft: canonical, expectedRevision: other, attempt: { content: canonical, expectedRevision: other, phase: 'unknown' } }
  expect(acknowledgeNoteWrite(current, content, revision, { status: 'written', revision: nextRevision, content: canonical })).toBe(current)
})

it.each([false, true])('shared NoteReader accepts canonical saved bytes and preserves later edits (%s)', async later => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  let finish!: (result: FileWriteReceipt) => void
  const onDraft = vi.fn(), save = vi.fn(() => new Promise<FileWriteReceipt>(resolve => { finish = resolve }))
  await act(async () => root!.render(<NoteReader content={content} path="original.note.json" workspaceId="workspace" revision={revision}
    editing={{ onDraft, save, readCurrent: vi.fn() }} />))
  const click = async (text: string) => { const button = [...host!.querySelectorAll('button')].find(node => node.textContent === text)!; await act(async () => button.click()) }
  await click('编辑原笔记'); await click('保存原笔记')
  if (later) await act(async () => (host!.querySelector('.mobile-note-body') as HTMLElement & { editor: Editor }).editor.commands.insertContentAt(1, 'Later '))
  await act(async () => finish({ status: 'written', revision: nextRevision, content: canonical }))
  const retained = onDraft.mock.lastCall![0] as NoteEditState
  expect(retained.expectedRevision).toBe(nextRevision); expect(retained.attempt).toBeUndefined()
  if (later) expect(retained.draft).toContain('Later ')
  else { expect(retained.draft).toBe(canonical); expect(host!.querySelector('[data-note-agent-author]')).not.toBeNull() }
})

it.each([false, true])('mobile durable send acknowledges canonical bytes without overwriting a later device draft (%s)', async later => {
  const entries = new Map<string, string>(), storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value) }
  vi.stubGlobal('localStorage', storage)
  const identity = ['runtime', 'host', 'workspace', String(later)], drafts = noteDrafts(identity)
  const original: NoteEditState = { noteId: source.noteId, draft: content, expectedRevision: revision, attempt: { content, expectedRevision: revision, phase: 'sending' } }
  drafts.save(original)
  let finish!: (receipt: FileWriteReceipt) => void
  const pending = drafts.send(content, revision, () => new Promise(resolve => { finish = resolve }))
  if (later) drafts.save({ ...original, draft: JSON.stringify(newNoteDocument('Later draft', source.noteId, 'original-block')) })
  finish({ status: 'written', revision: nextRevision, content: canonical }); await pending
  const restored = noteDrafts(identity).initial!
  expect(restored.expectedRevision).toBe(nextRevision); expect(restored.attempt).toBeUndefined()
  expect(restored.draft).toBe(later ? JSON.stringify(newNoteDocument('Later draft', source.noteId, 'original-block')) : canonical)
})

it('retains the original durable pending attempt if receipt reconciliation cannot be persisted', async () => {
  const entries = new Map<string, string>(), storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { entries.set(key, value) }) }
  vi.stubGlobal('localStorage', storage)
  const identity = ['quota-runtime'], drafts = noteDrafts(identity)
  drafts.save({ noteId: source.noteId, draft: content, expectedRevision: revision, attempt: { content, expectedRevision: revision, phase: 'sending' } })
  storage.setItem.mockImplementationOnce(() => { throw Error('quota') })
  await drafts.send(content, revision, async () => ({ status: 'written', revision: nextRevision, content: canonical }))
  expect(noteDrafts(identity).initial).toMatchObject({ draft: content, expectedRevision: revision, attempt: { phase: 'unknown', content } })
})
