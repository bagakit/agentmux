import { fixtureEpoch as _liveTailFixtureEpoch, fixturePath } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { noteDrafts } from '../src/navigation/note-drafts'
import { NoteReader, type NoteEditState } from '@agentmux/client-ui/components/NoteReader'
import { newNoteDocument, serializeNoteDocument, readNoteDocument } from '@agentmux/client-ui/note/note-document'
import { attributeNoteBlocks } from '@agentmux/client-ui/note/note-provenance'
import { fileUploadRevision, type FileReadResult, type FileWriteReceipt } from '@agentmux/core/files'
import { acknowledgeNoteWrite, acknowledgeNoteCanonicalRead, noteWriteCanonicalContent } from '@agentmux/client-ui/note/note-edit-state'
import { NoteSnapshotTestWorker } from '../../desktop/test/note-snapshot-test-worker'
import { computeNoteLiveMerge } from '@agentmux/client-ui/note/note-live-merge.worker'
import type { Editor } from '@tiptap/core'

const revision = 'sha256:' + 'a'.repeat(64), nextRevision = 'sha256:' + 'b'.repeat(64)
const source = newNoteDocument('Original text', 'original-note', 'original-block'), content = serializeNoteDocument(source)
type EditingElement = HTMLElement & { editor: { commands: { insertContentAt(position: number, text: string): boolean } } }
const canonical = serializeNoteDocument(attributeNoteBlocks(null, source, { kind: 'agent', id: 'confirmed-agent' }, _liveTailFixtureEpoch(0, 0, 100)))
let root: Root | undefined, host: HTMLDivElement | undefined
class SharedNoteTestWorker extends NoteSnapshotTestWorker {
  override postMessage(request: Parameters<NoteSnapshotTestWorker['postMessage']>[0]) {
    if ('base' in request) { const input = request as unknown as { base: string; current: string; proposed: string }; queueMicrotask(() => this.onmessage?.({ data: computeNoteLiveMerge(input) } as unknown as Parameters<NonNullable<this['onmessage']>>[0])); return }
    super.postMessage(request)
  }
}
beforeEach(() => { vi.stubGlobal('Worker', SharedNoteTestWorker) })
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
  await act(async () => root!.render(<NoteReader content={content} path="original.note.md" workspaceId="workspace" revision={revision}
    editing={{ onDraft, save, readCurrent: vi.fn() }} />))
  const click = async (text: string) => { const button = [...host!.querySelectorAll('button')].find(node => node.textContent === text)!; await act(async () => button.click()) }
  await click('编辑原笔记'); await click('保存原笔记')
  if (later) await act(async () => (host!.querySelector('.mobile-note-body') as EditingElement).editor.commands.insertContentAt(1, 'Later '))
  await act(async () => finish({ status: 'written', revision: nextRevision, content: canonical }))
  const retained = onDraft.mock.lastCall![0] as NoteEditState
  expect(readNoteDocument(retained.draft).status).toBe('valid')
  expect(retained.expectedRevision).toBe(nextRevision); expect(retained.attempt).toBeUndefined()
  if (later) expect(retained.draft).toContain('Later ')
  else { expect(retained.draft).toBe(canonical); expect(canonical).not.toContain('confirmed-agent'); expect(host!.querySelector('[data-note-agent-author]')).toBeNull() }
})

it.each([false, true])('mobile durable send acknowledges canonical bytes without overwriting a later device draft (%s)', async later => {
  const entries = new Map<string, string>(), storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value) }
  vi.stubGlobal('localStorage', storage)
  const identity = ['runtime', 'host', 'workspace', String(later)], drafts = noteDrafts(identity)
  const original: NoteEditState = { noteId: source.noteId, draft: content, expectedRevision: revision, attempt: { content, expectedRevision: revision, phase: 'sending' } }
  drafts.save(original)
  let finish!: (receipt: FileWriteReceipt) => void
  const pending = drafts.send(content, revision, () => new Promise(resolve => { finish = resolve }))
  if (later) drafts.save({ ...original, draft: serializeNoteDocument(newNoteDocument('Later draft', source.noteId, 'original-block')) })
  finish({ status: 'written', revision: nextRevision, content: canonical }); await pending
  const restored = noteDrafts(identity).initial!
  expect(restored.expectedRevision).toBe(nextRevision); expect(restored.attempt).toBeUndefined()
  expect(restored.draft).toBe(later ? serializeNoteDocument(newNoteDocument('Later draft', source.noteId, 'original-block')) : canonical)
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

const bodyRevision = (content: string) => fileUploadRevision(new TextEncoder().encode(content))
const readerResource = { hostId: 'local', workspaceId: 'workspace', workspacePath: fixturePath('original'), zoneId: 'original-zone', zonePath: fixturePath('original'), path: 'original.note.md' }
const known = (body: string): Extract<FileWriteReceipt, { status: 'written' }> => ({ status: 'written', revision: bodyRevision(body),
  contentUnavailable: 'The body was saved; canonical content cannot fit this reply.', noteHistory: { status: 'committed', eventId: 'original-operation', batchId: 'original-batch' } })

it.each([false, true])('keeps a known-written original intent until its exact canonical revision is read (%s)', later => {
  const saved = serializeNoteDocument(newNoteDocument('Saved canonical body', source.noteId, 'original-block'))
  const initial: NoteEditState = { noteId: source.noteId, draft: later ? content.replace('Original text', 'Later draft') : content, expectedRevision: bodyRevision(content),
    attempt: { content, expectedRevision: bodyRevision(content), phase: 'sending' } }
  const pending = acknowledgeNoteWrite(initial, content, bodyRevision(content), known(saved))
  expect(pending).toMatchObject({ draft: initial.draft, expectedRevision: bodyRevision(saved), receipt: { noteHistory: { eventId: 'original-operation' } }, attempt: { phase: 'written', content, expectedRevision: bodyRevision(content), written: { status: 'written', revision: bodyRevision(saved) } } })
  expect(acknowledgeNoteCanonicalRead(pending, { content: saved, revision: bodyRevision(content) })).toBe(pending)
  expect(acknowledgeNoteCanonicalRead(pending, { content, revision: bodyRevision(saved) })).toBe(pending)
  const unrelated = saved.replace('Saved canonical body', 'Later canonical body')
  expect(acknowledgeNoteCanonicalRead(pending, { content: unrelated, revision: bodyRevision(unrelated) })).toBe(pending)
  const accepted = acknowledgeNoteCanonicalRead(pending, { content: saved, revision: bodyRevision(saved) })
  if (later) expect(accepted.attempt).toMatchObject({ phase: 'written', content, canonicalContent: saved })
  else expect(accepted.attempt).toBeUndefined()
  expect(accepted.receipt).toEqual(pending.receipt); expect(accepted.draft).toBe(later ? initial.draft : saved)
})

it('uses an exact ordinary-CAS digest instead of guessing omitted canonical bytes and never settles an unknown write from equal bytes', () => {
  const ordinary = { status: 'written' as const, revision: bodyRevision(content) }
  expect(noteWriteCanonicalContent(content, ordinary)).toBe(content)
  expect(noteWriteCanonicalContent(content, { ...ordinary, revision: nextRevision })).toBeUndefined()
  expect(noteWriteCanonicalContent(content, known(content))).toBeUndefined()
  const unknown: NoteEditState = { noteId: source.noteId, draft: content, expectedRevision: bodyRevision(content),
    attempt: { content, expectedRevision: bodyRevision(content), phase: 'unknown', noteHistory: { status: 'unconfirmed', eventId: 'original-unknown', reason: 'Original reply lost' } } }
  expect(acknowledgeNoteCanonicalRead(unknown, { content, revision: bodyRevision(content) })).toBe(unknown)
})

it('reopens a mobile canonical-pending write as known-written with its original intent and history, and preserves it in live memory on quota failure', async () => {
  const entries = new Map<string, string>(), setItem = vi.fn((key: string, value: string) => { entries.set(key, value) })
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null, setItem })
  const drafts = noteDrafts(['known-written-device']), later = content.replace('Original text', 'Later device draft')
  drafts.save({ noteId: source.noteId, draft: later, expectedRevision: bodyRevision(content), attempt: { content, expectedRevision: bodyRevision(content), phase: 'sending' } })
  await drafts.send(content, bodyRevision(content), async () => known(canonical))
  expect(noteDrafts(['known-written-device']).initial).toMatchObject({ draft: later, expectedRevision: bodyRevision(canonical), attempt: { phase: 'written', content, written: { noteHistory: { eventId: 'original-operation' } } } })
  const quota = noteDrafts(['known-written-quota']), observe = vi.fn(), stop = quota.subscribe(observe)
  quota.save({ noteId: source.noteId, draft: content, expectedRevision: bodyRevision(content), attempt: { content, expectedRevision: bodyRevision(content), phase: 'sending' } })
  setItem.mockImplementationOnce(() => { throw Error('quota') })
  await quota.send(content, bodyRevision(content), async () => known(canonical))
  expect(observe.mock.lastCall![0]).toMatchObject({ attempt: { phase: 'written', written: { status: 'written', noteHistory: { eventId: 'original-operation' } } } })
  expect(noteDrafts(['known-written-quota']).initial).toMatchObject({ attempt: { phase: 'unknown' } })
  stop()
})

it.each([false, true])('shared NoteReader reads an unavailable canonical reply without fabricating it or replacing later input (%s)', async later => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const saved = serializeNoteDocument(newNoteDocument('Saved canonical body', source.noteId, 'original-block'))
  let finish!: (result: FileReadResult) => void
  const onDraft = vi.fn(), save = vi.fn(async () => known(saved)), readCurrent = vi.fn(() => new Promise<FileReadResult>(resolve => { finish = resolve }))
  await act(async () => root!.render(<NoteReader content={content} path="original.note.md" workspaceId="workspace" revision={bodyRevision(content)} editing={{ onDraft, save, readCurrent }} />))
  const click = async (text: string) => act(async () => [...host!.querySelectorAll('button')].find(button => button.textContent === text)!.click())
  await click('编辑原笔记'); await click('保存原笔记')
  expect(readCurrent).toHaveBeenCalledOnce()
  expect(onDraft.mock.lastCall![0]).toMatchObject({ draft: content, attempt: { phase: 'written', content }, receipt: { noteHistory: { eventId: 'original-operation' } } })
  expect(host.textContent).toContain('原文件已保存，正文待核对')
  if (later) await act(async () => (host!.querySelector('.mobile-note-body') as EditingElement).editor.commands.insertContentAt(1, 'LATER '))
  const draft = (onDraft.mock.lastCall![0] as NoteEditState).draft
  await act(async () => finish({ resource: readerResource, result: { status: 'read', document: { path: 'original.note.md', content: saved, revision: bodyRevision(saved) } } }))
  const retained = onDraft.mock.lastCall![0] as NoteEditState
  expect(retained.attempt).toBeUndefined(); expect(retained.receipt?.noteHistory?.eventId).toBe('original-operation')
  expect(retained.draft).toBe(saved)
  if (later) { expect(retained.input).toMatchObject({ baseContent: content, observedContent: saved, proposedContent: draft }); expect(host.textContent).toContain('LATER ') }
  else expect(retained.input).toBeUndefined()
})

it('does not infer that an unknown original operation committed when the current file contains identical bytes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const onDraft = vi.fn(), save = vi.fn(async (): Promise<FileWriteReceipt> => ({ status: 'unknown', code: 'LOST_REPLY', message: 'Original reply lost', noteHistory: { status: 'unconfirmed', eventId: 'unknown-operation', reason: 'Keep original identity' } }))
  const readCurrent = vi.fn(async (): Promise<FileReadResult> => ({ resource: readerResource, result: { status: 'read', document: { path: 'original.note.md', content, revision: bodyRevision(content) } } }))
  await act(async () => root!.render(<NoteReader content={content} path="original.note.md" workspaceId="workspace" revision={bodyRevision(content)} editing={{ onDraft, save, readCurrent }} />))
  const click = async (text: string) => act(async () => [...host!.querySelectorAll('button')].find(button => button.textContent === text)!.click())
  await click('编辑原笔记'); await click('保存原笔记'); await click('核对当前原文')
  expect(onDraft.mock.lastCall![0]).toMatchObject({ attempt: { phase: 'unknown', noteHistory: { eventId: 'unknown-operation' } } })
  expect(host.textContent).toContain('即使字节相同，原回执仍未知')
  expect([...host.querySelectorAll('button')].find(button => button.textContent === '保存原笔记')!.disabled).toBe(true)
  expect(save).toHaveBeenCalledOnce()
})

it('waits for the final IME draft before acknowledging a canonical read that arrived during composition', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const saved = serializeNoteDocument(newNoteDocument('Saved canonical body', source.noteId, 'original-block'))
  let finish!: (result: FileReadResult) => void
  const onDraft = vi.fn(), readCurrent = vi.fn(() => new Promise<FileReadResult>(resolve => { finish = resolve }))
  await act(async () => root!.render(<NoteReader content={content} path="original.note.md" workspaceId="workspace" revision={bodyRevision(content)} editing={{ onDraft, save: async () => known(saved), readCurrent }} />))
  const click = async (text: string) => act(async () => [...host!.querySelectorAll('button')].find(button => button.textContent === text)!.click())
  await click('编辑原笔记'); await click('保存原笔记')
  const editor = (host.querySelector('.mobile-note-body') as HTMLElement & { editor: Editor }).editor
  await act(async () => { editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); editor.commands.insertContentAt(1, '共同知识') })
  await act(async () => finish({ resource: readerResource, result: { status: 'read', document: { path: 'original.note.md', content: saved, revision: bodyRevision(saved) } } }))
  expect(onDraft.mock.lastCall![0]).toMatchObject({ attempt: { phase: 'written' } })
  expect(editor.getText()).toContain('共同知识')
  await act(async () => editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '共同知识' })))
  await vi.waitFor(() => { const retained = onDraft.mock.lastCall![0] as NoteEditState; expect(retained.attempt).toBeUndefined(); expect(retained.draft).toBe(saved); expect(retained.input?.proposedContent).toContain('共同知识'); expect(retained.input?.issue).toBeTruthy() })
  expect(editor.getText()).toContain('共同知识'); expect((onDraft.mock.lastCall![0] as NoteEditState).expectedRevision).toBe(bodyRevision(saved))
})

it('keeps a title projection failure visible as saved body metadata in the shared reader', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const onDraft = vi.fn()
  const save = vi.fn(async (): Promise<FileWriteReceipt> => ({ status: 'written', revision: bodyRevision(content), content,
    noteTitleProjection: { status: 'unconfirmed', noteId: source.noteId, resource: { hostId: readerResource.hostId, workspaceId: readerResource.workspaceId, workspacePath: readerResource.workspacePath, path: readerResource.path }, code: 'catalog-unavailable', message: 'Original catalog is unavailable' } }))
  await act(async () => root!.render(<NoteReader content={content} path="original.note.md" workspaceId="workspace" revision={bodyRevision(content)} editing={{ onDraft, save, readCurrent: vi.fn() }} />))
  const click = async (text: string) => act(async () => [...host!.querySelectorAll('button')].find(button => button.textContent === text)!.click())
  await click('编辑原笔记'); await click('保存原笔记')
  expect(onDraft.mock.lastCall![0]).toMatchObject({ receipt: { status: 'written', noteTitleProjection: { status: 'unconfirmed' } } })
  expect(host.textContent).toContain('原文件保存已确认'); expect(host.textContent).toContain('目录标题投影未确认')
})


it.each(['written', 'unknown', 'conflict'] as const)('does not let a late %s receipt replace another workface original intent or canonical display', async status => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  let finish!: (result: FileWriteReceipt) => void, publish!: (state: NoteEditState) => void
  const onDraft = vi.fn(), other = serializeNoteDocument(newNoteDocument('Another workface draft', source.noteId, 'original-block'))
  await act(async () => root!.render(<NoteReader content={content} path="original.note.md" workspaceId="workspace" revision={revision}
    editing={{ onDraft, subscribe: listener => { publish = listener; return () => {} }, save: () => new Promise(resolve => { finish = resolve }), readCurrent: vi.fn() }} />))
  const click = async (text: string) => { const button = [...host!.querySelectorAll('button')].find(node => node.textContent === text)!; await act(async () => button.click()) }
  await click('编辑原笔记'); await click('保存原笔记')
  const otherState: NoteEditState = { noteId: source.noteId, draft: other, expectedRevision: nextRevision, attempt: { phase: 'unknown', content: other, expectedRevision: nextRevision, noteHistory: { status: 'unconfirmed', eventId: 'other-operation', reason: 'Other reply lost' } } }
  await act(async () => publish(otherState))
  const count = onDraft.mock.calls.length
  await act(async () => finish(status === 'written' ? { status, revision: bodyRevision(canonical), content: canonical } : status === 'unknown' ? { status, code: 'REPLY_LOST', message: 'Old reply lost' } : { status, observedRevision: bodyRevision(content) }))
  expect(onDraft).toHaveBeenCalledTimes(count)
  expect(host!.querySelector('.mobile-note-body')!.textContent).toContain('Another workface draft')
  expect(host!.textContent).not.toContain('原文件保存已确认。')
})

it.each([false, true])('maps local input before a canonical worker echo without deleting independent acknowledged content (overlap %s)', async overlap => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const initial = newNoteDocument('Original text', source.noteId, 'original-block')
  initial.content.content!.push({ type: 'paragraph', attrs: { blockId: 'independent-block' }, content: [{ type: 'text', text: 'Independent original' }] })
  const base = serializeNoteDocument(initial), remote = base.replace(overlap ? 'Original text' : 'Independent original', overlap ? 'Remote overlap' : 'Remote acknowledged')
  let publish!: (state: NoteEditState) => void, last!: NoteEditState
  const onDraft = (state: NoteEditState) => { last = state }
  await act(async () => root!.render(<NoteReader content={base} path="original.note.md" workspaceId="workspace" revision={bodyRevision(base)}
    editing={{ onDraft, subscribe: listener => { publish = listener; return () => {} }, save: vi.fn(), readCurrent: vi.fn() }} />))
  const click = async (text: string) => { const button = [...host!.querySelectorAll('button')].find(node => node.textContent === text)!; await act(async () => button.click()) }
  await click('编辑原笔记')
  const editor = (host!.querySelector('.mobile-note-body') as HTMLElement & { editor: Editor }).editor
  // The authoritative draft moves before React can deliver its pending PM snapshot.
  await act(async () => { publish({ noteId: source.noteId, draft: remote, expectedRevision: bodyRevision(remote) }); editor.commands.insertContentAt(1, 'Local one '); editor.commands.insertContentAt(1, 'Local two ') })
  if (overlap) {
    expect(last.draft).toBe(remote)
    expect(last.input).toMatchObject({ baseContent: base, observedContent: remote, proposedContent: expect.stringContaining('Local two Local one ') })
    expect(last.input!.issue).toBeTruthy(); expect(host!.textContent).toContain('输入与当前稿尚未对齐')
    await click('保留两份，采用这次输入')
    expect(last.input).toBeUndefined(); expect(last.draft).toContain('Local two Local one '); expect(last.alternates!.some(item => item.draft === remote)).toBe(true)
  } else {
    expect(last.input).toBeUndefined(); expect(last.draft).toContain('Remote acknowledged'); expect(last.draft).toContain('Local two Local one ')
    expect(editor.getText()).toContain('Remote acknowledged'); expect(editor.getText()).toContain('Local two Local one ')
  }
})


it('drains the actual composition delta after its final publish while retaining an independent acknowledged revision', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const original = newNoteDocument('Original text', source.noteId, 'original-block')
  original.content.content!.push({ type: 'paragraph', attrs: { blockId: 'independent-block' }, content: [{ type: 'text', text: 'Independent original' }] })
  const base = serializeNoteDocument(original), remote = base.replace('Independent original', 'Remote acknowledged')
  let publish!: (state: NoteEditState) => void, last!: NoteEditState
  await act(async () => root!.render(<NoteReader content={base} path="original.note.md" workspaceId="workspace" revision={bodyRevision(base)}
    editing={{ onDraft: state => { last = state }, subscribe: listener => { publish = listener; return () => {} }, save: vi.fn(), readCurrent: vi.fn() }} />))
  await act(async () => [...host!.querySelectorAll('button')].find(node => node.textContent === '编辑原笔记')!.click())
  const editor = (host!.querySelector('.mobile-note-body') as HTMLElement & { editor: Editor }).editor
  await act(async () => { editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); editor.commands.insertContentAt(1, '共同知识'); publish({ noteId: source.noteId, draft: remote, expectedRevision: bodyRevision(remote) }) })
  expect(editor.getText()).toContain('共同知识'); expect(last.draft).toBe(base)
  await act(async () => editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '共同知识' })))
  await vi.waitFor(() => { expect(last.input).toBeUndefined(); expect(last.draft).toContain('共同知识'); expect(last.draft).toContain('Remote acknowledged') })
  expect(editor.getText()).toContain('共同知识'); expect(editor.getText()).toContain('Remote acknowledged')
})

it('retains a complete pending editor delta through mobile durable recovery', () => {
  const entries = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value) })
  const drafts = noteDrafts(['pending-input-recovery']), input = { baseContent: content, observedContent: canonical, proposedContent: content.replace('Original text', 'Local unsynchronized edit'), issue: 'Original merge worker stopped' }
  drafts.save({ noteId: source.noteId, draft: canonical, expectedRevision: bodyRevision(canonical), input })
  expect(noteDrafts(['pending-input-recovery']).initial).toMatchObject({ draft: canonical, input })
})


it('validates rich identity even for equal merge inputs inside the actual shared worker computation', () => {
  expect(computeNoteLiveMerge({ base: 'Unsupported original bytes', current: 'Unsupported original bytes', proposed: 'Unsupported original bytes' })).toEqual({ status: 'conflict' })
  const base = serializeNoteDocument(newNoteDocument('Original text', source.noteId, 'original-block'))
  expect(computeNoteLiveMerge({ base, current: base, proposed: base })).toEqual({ status: 'merged', content: base })
  const other = serializeNoteDocument(newNoteDocument('Original text', 'foreign-note', 'original-block'))
  expect(computeNoteLiveMerge({ base, current: other, proposed: base })).toEqual({ status: 'conflict' })
})

it('keeps stable block identity and rejects a structurally invalid merged result inside the actual shared worker', () => {
  const first = newNoteDocument('Keep original block', source.noteId, 'first-block')
  first.content.content!.push({ type: 'paragraph', attrs: { blockId: 'second-block' }, content: [{ type: 'text', text: 'Original second' }] })
  const base = serializeNoteDocument(first)
  const replacedNote = structuredClone(first); replacedNote.content.content![0]!.attrs!.blockId = 'replacement-block'
  const replaced = serializeNoteDocument(replacedNote)
  expect(computeNoteLiveMerge({ base, current: replaced, proposed: base.replace('Keep original block', 'Edited original block') })).toEqual({ status: 'conflict' })
  const withoutSecond = newNoteDocument('Keep original block', source.noteId, 'first-block')
  const inverse = serializeNoteDocument(withoutSecond)
  const later = newNoteDocument('Keep original block', source.noteId, 'first-block')
  later.content.content!.push({ type: 'paragraph', attrs: { blockId: 'third-block' }, content: [{ type: 'text', text: 'Independent separator' }] }, { type: 'paragraph', attrs: { blockId: 'second-block' }, content: [{ type: 'text', text: 'New independent second' }] })
  // All three rich documents are valid separately; applying the inverse would duplicate a stable ID.
  expect(computeNoteLiveMerge({ base: inverse, current: serializeNoteDocument(later), proposed: base })).toEqual({ status: 'conflict' })
})


it.each(['written', 'read'] as const)('maps sent-to-later edits onto the actual canonical body before the next ordinary CAS (%s)', async mode => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const original = newNoteDocument('Submitted first paragraph', source.noteId, 'original-block')
  original.content.content!.push({ type: 'paragraph', attrs: { blockId: 'independent-block' }, content: [{ type: 'text', text: 'Independent submitted paragraph' }] })
  const submitted = serializeNoteDocument(original), saved = submitted.replace('Independent submitted paragraph', 'Agent canonical paragraph')
  let finish!: (value: FileWriteReceipt) => void, last!: NoteEditState
  const save = vi.fn((text: string) => save.mock.calls.length === 1 ? new Promise<FileWriteReceipt>(resolve => { finish = resolve }) : Promise.resolve<FileWriteReceipt>({ status: 'written', revision: bodyRevision(text), content: text }))
  await act(async () => root!.render(<NoteReader content={submitted} path="original.note.md" workspaceId="workspace" revision={bodyRevision(submitted)}
    editing={{ onDraft: value => { last = value }, save, readCurrent: async () => ({ resource: readerResource, result: { status: 'read', document: { path: 'original.note.md', content: saved, revision: bodyRevision(saved) } } }) }} />))
  const click = async (text: string) => act(async () => [...host!.querySelectorAll('button')].find(node => node.textContent === text)!.click())
  await click('编辑原笔记'); await click('保存原笔记')
  const editor = (host.querySelector('.mobile-note-body') as HTMLElement & { editor: Editor }).editor
  await act(async () => { editor.commands.insertContentAt(1, 'Local later ') })
  await act(async () => finish(mode === 'written' ? { status: 'written', revision: bodyRevision(saved), content: saved } : known(saved)))
  await vi.waitFor(() => { expect(last.attempt).toBeUndefined(); expect(last.input).toBeUndefined(); expect(last.draft).toContain('Agent canonical paragraph'); expect(last.draft).toContain('Local later ') })
  await click('保存原笔记')
  expect(save).toHaveBeenCalledTimes(2)
  expect(save.mock.calls[1]![0]).toContain('Agent canonical paragraph'); expect(save.mock.calls[1]![0]).toContain('Local later ')
  expect((save.mock.calls as unknown as string[][])[1]![1]).toBe(bodyRevision(saved))
  expect(editor.getText()).toContain('Agent canonical paragraph'); expect(editor.getText()).toContain('Local later ')
})

it.each(['written', 'read'] as const)('keeps exact sent/canonical/later sources and refuses a second CAS when the canonical receipt overlaps later input (%s)', async mode => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const submitted = content, saved = content.replace('Original text', 'Agent overlap')
  let finish!: (value: FileWriteReceipt) => void, last!: NoteEditState
  const save = vi.fn(() => new Promise<FileWriteReceipt>(resolve => { finish = resolve }))
  await act(async () => root!.render(<NoteReader content={submitted} path="original.note.md" workspaceId="workspace" revision={bodyRevision(submitted)}
    editing={{ onDraft: value => { last = value }, save, readCurrent: async () => ({ resource: readerResource, result: { status: 'read', document: { path: 'original.note.md', content: saved, revision: bodyRevision(saved) } } }) }} />))
  const click = async (text: string) => act(async () => [...host!.querySelectorAll('button')].find(node => node.textContent === text)!.click())
  await click('编辑原笔记'); await click('保存原笔记')
  const editor = (host.querySelector('.mobile-note-body') as HTMLElement & { editor: Editor }).editor
  await act(async () => { editor.commands.insertContentAt(1, 'Local later ') })
  await act(async () => finish(mode === 'written' ? { status: 'written', revision: bodyRevision(saved), content: saved } : known(saved)))
  await vi.waitFor(() => { expect(last.input?.issue).toBeTruthy() })
  expect(last.expectedRevision).toBe(bodyRevision(saved)); expect(last.draft).toBe(saved)
  expect(last.input).toMatchObject({ baseContent: submitted, observedContent: saved, proposedContent: submitted.replace('Original text', 'Local later Original text') })
  expect(last.receipt?.status).toBe('written'); expect(editor.getText()).toContain('Local later Original text')
  await click('保存原笔记'); expect(save).toHaveBeenCalledOnce()
})


it('recovers known canonical bytes after an older pending input, without replacing that input original observation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const note = newNoteDocument('First original', source.noteId, 'first-block')
  note.content.content!.push({ type: 'paragraph', attrs: { blockId: 'second-block' }, content: [{ type: 'text', text: 'Second original' }] }, { type: 'paragraph', attrs: { blockId: 'third-block' }, content: [{ type: 'text', text: 'Third original' }] })
  const submitted = serializeNoteDocument(note), observed = submitted.replace('Second original', 'Earlier local observation'), proposed = submitted.replace('First original', 'Pending editor input'), canonical = submitted.replace('Third original', 'Agent canonical third')
  const input = { baseContent: submitted, observedContent: observed, proposedContent: proposed }
  const before: NoteEditState = { noteId: source.noteId, draft: observed, expectedRevision: bodyRevision(submitted), attempt: { phase: 'sending', content: submitted, expectedRevision: bodyRevision(submitted) }, input }
  const acknowledged = acknowledgeNoteWrite(before, submitted, bodyRevision(submitted), { status: 'written', revision: bodyRevision(canonical), content: canonical })
  expect(acknowledged.input).toBe(input); expect(acknowledged.attempt).toMatchObject({ content: submitted, canonicalContent: canonical, phase: 'written' })
  const entries = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value) })
  noteDrafts(['ordered-canonical-recovery']).save(acknowledged)
  const restored = noteDrafts(['ordered-canonical-recovery']).initial!
  expect(restored).toMatchObject({ input, attempt: { phase: 'written', canonicalContent: canonical } })
  let last = restored
  await act(async () => root!.render(<NoteReader content={submitted} path="original.note.md" workspaceId="workspace" revision={bodyRevision(submitted)}
    editing={{ initial: restored, onDraft: value => { last = value }, save: vi.fn(), readCurrent: vi.fn() }} />))
  await vi.waitFor(() => { expect(last.attempt).toBeUndefined(); expect(last.input).toBeUndefined(); expect(last.draft).toContain('Earlier local observation'); expect(last.draft).toContain('Pending editor input'); expect(last.draft).toContain('Agent canonical third') })
})

it('automatically drains a known canonical receipt received from another workface without another read', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const note = newNoteDocument('Submitted first', source.noteId, 'first-block')
  note.content.content!.push({ type: 'paragraph', attrs: { blockId: 'second-block' }, content: [{ type: 'text', text: 'Submitted second' }] })
  const sent = serializeNoteDocument(note), later = sent.replace('Submitted first', 'Later local first'), saved = sent.replace('Submitted second', 'Canonical second')
  let publish!: (value: NoteEditState) => void, last!: NoteEditState
  const readCurrent = vi.fn(), save = vi.fn()
  await act(async () => root!.render(<NoteReader content={sent} path="original.note.md" workspaceId="workspace" revision={bodyRevision(sent)}
    editing={{ onDraft: value => { last = value }, subscribe: listener => { publish = listener; return () => {} }, save, readCurrent }} />))
  const acknowledged = acknowledgeNoteWrite({ noteId: source.noteId, draft: later, expectedRevision: bodyRevision(sent), attempt: { phase: 'sending', content: sent, expectedRevision: bodyRevision(sent) } }, sent, bodyRevision(sent), { status: 'written', revision: bodyRevision(saved), content: saved })
  await act(async () => publish(acknowledged))
  await vi.waitFor(() => { expect(last.attempt).toBeUndefined(); expect(last.input).toBeUndefined(); expect(last.draft).toContain('Later local first'); expect(last.draft).toContain('Canonical second') })
  expect(last.expectedRevision).toBe(bodyRevision(saved)); expect(readCurrent).not.toHaveBeenCalled()
  expect([...host.querySelectorAll('button')].find(button => button.textContent === '保存原笔记')!.disabled).toBe(false)
})

it('does not automatically rebroadcast an already conflicted input received from another workface', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  let publish!: (value: NoteEditState) => void
  const onDraft = vi.fn(), post = vi.spyOn(SharedNoteTestWorker.prototype, 'postMessage')
  await act(async () => root!.render(<NoteReader content={content} path="original.note.md" workspaceId="workspace" revision={bodyRevision(content)}
    editing={{ onDraft, subscribe: listener => { publish = listener; return () => {} }, save: vi.fn(), readCurrent: vi.fn() }} />))
  const proposed = content.replace('Original text', 'Another pending input'), observed = content.replace('Original text', 'Observed overlap')
  const received: NoteEditState = { noteId: source.noteId, draft: observed, expectedRevision: bodyRevision(observed), input: { baseContent: content, observedContent: observed, proposedContent: proposed, issue: 'Already compared overlap' } }
  await act(async () => { publish(received) })
  expect(onDraft).not.toHaveBeenCalled()
  expect(post.mock.calls.filter(([request]) => 'base' in request)).toHaveLength(0)
  expect(host.textContent).toContain('Already compared overlap')
})

it('retains the displayed shared editor draft when incoming blocks cannot be mapped, and keeps the original unknown save on explicit choice', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const note = newNoteDocument('First original', source.noteId, 'first-block')
  note.content.content!.push({ type: 'paragraph', attrs: { blockId: 'second-block' }, content: [{ type: 'text', text: 'Second original' }] }, { type: 'paragraph', attrs: { blockId: 'third-block' }, content: [{ type: 'text', text: 'Third original' }] })
  const base = serializeNoteDocument(note), moved = structuredClone(note)
  moved.content.content = [note.content.content![0]!, note.content.content![2]!, note.content.content![1]!]
  const incoming = serializeNoteDocument(moved), attempt = { phase: 'unknown' as const, content: base, expectedRevision: bodyRevision(base), noteHistory: { status: 'unconfirmed' as const, eventId: 'original-unknown', reason: 'Reply lost' } }
  let publish!: (value: NoteEditState) => void, last!: NoteEditState
  await act(async () => root!.render(<NoteReader content={base} path="original.note.md" workspaceId="workspace" revision={bodyRevision(base)}
    editing={{ initial: { noteId: source.noteId, draft: base, expectedRevision: bodyRevision(base), attempt }, onDraft: value => { last = value }, subscribe: listener => { publish = listener; return () => {} }, save: vi.fn(), readCurrent: vi.fn() }} />))
  const editor = (host.querySelector('.mobile-note-body') as HTMLElement & { editor: Editor }).editor
  await act(async () => publish({ noteId: source.noteId, draft: incoming, expectedRevision: bodyRevision(base), attempt }))
  await vi.waitFor(() => { expect(host!.textContent).toContain('Keep editing displayed draft'); expect(last.alternates?.some(value => value.draft === base)).toBe(true) })
  expect(editor.getText()).toBe('First original\n\nSecond original\n\nThird original')
  const draftCount = last.alternates!.length
  await act(async () => [...host!.querySelectorAll('button')].find(button => button.textContent === 'Retry incoming update')!.click())
  await vi.waitFor(() => expect(host!.textContent).toContain('Keep editing displayed draft'))
  expect(last.alternates!.length).toBe(draftCount)
  await act(async () => [...host!.querySelectorAll('button')].find(button => button.textContent === 'Keep editing displayed draft')!.click())
  expect(last.draft).toBe(base); expect(last.attempt).toEqual(attempt); expect(last.alternates!.some(value => value.draft === incoming)).toBe(true)
  expect([...host.querySelectorAll('button')].find(button => button.textContent === '保存原笔记')!.disabled).toBe(true)
})

it('preserves every original input source as readable alternate drafts before accepting a different editor transaction basis', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const observed = content.replace('Original text', 'Original observed D'), proposed = content.replace('Original text', 'Original proposed L'), recognized = content.replace('Original text', 'New recognized draft R')
  let publish!: (value: NoteEditState) => void, last!: NoteEditState
  await act(async () => root!.render(<NoteReader content={content} path="original.note.md" workspaceId="workspace" revision={bodyRevision(content)}
    editing={{ initial: { noteId: source.noteId, draft: content, expectedRevision: bodyRevision(content) }, onDraft: value => { last = value }, subscribe: listener => { publish = listener; return () => {} }, save: vi.fn(), readCurrent: vi.fn() }} />))
  const editor = (host.querySelector('.mobile-note-body') as HTMLElement & { editor: Editor }).editor
  await act(async () => {
    publish({ noteId: source.noteId, draft: recognized, expectedRevision: bodyRevision(recognized), input: { baseContent: content, observedContent: observed, proposedContent: proposed, issue: 'Original unresolved input' } })
    // This mounted editor still displays Z=content, while another workface owns pending (B,D,L).
    editor.commands.insertContentAt(1, 'Different editor input ')
  })
  await vi.waitFor(() => expect(last.input?.issue).toBeTruthy())
  const readable = [last.draft, last.input!.baseContent, last.input!.observedContent, last.input!.proposedContent, ...last.alternates!.map(item => item.draft)]
  expect(readable).toEqual(expect.arrayContaining([content, observed, proposed, recognized]))
  expect(host.textContent).toContain('Original observed D'); expect(host.textContent).toContain('Original proposed L')
})

it.each([false, true])('preserves all original input sources when explicitly choosing a draft (proposed %s)', async adopt => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const observed = content.replace('Original text', 'Original observed D'), proposed = content.replace('Original text', 'Original proposed L'), recognized = content.replace('Original text', 'New recognized draft R')
  let publish!: (value: NoteEditState) => void, last!: NoteEditState
  const save = vi.fn()
  await act(async () => root!.render(<NoteReader content={content} path="original.note.md" workspaceId="workspace" revision={bodyRevision(content)}
    editing={{ initial: { noteId: source.noteId, draft: content, expectedRevision: bodyRevision(content) }, onDraft: value => { last = value }, subscribe: listener => { publish = listener; return () => {} }, save, readCurrent: vi.fn() }} />))
  await act(async () => publish({ noteId: source.noteId, draft: recognized, expectedRevision: bodyRevision(recognized), input: { baseContent: content, observedContent: observed, proposedContent: proposed, issue: 'Original unresolved input' } }))
  await act(async () => [...host!.querySelectorAll('button')].find(button => button.textContent === (adopt ? '保留两份，采用这次输入' : '保留两份，采用当前草稿'))!.click())
  expect(last.input).toBeUndefined(); expect(last.draft).toBe(adopt ? proposed : recognized)
  expect([last.draft, ...last.alternates?.map(item => item.draft) ?? []]).toEqual(expect.arrayContaining([content, observed, proposed, recognized]))
  expect(last.expectedRevision).toBe(bodyRevision(recognized)); expect(save).not.toHaveBeenCalled()
})

it.each(['unknown', 'written'] as const)('preserves the original %s save and every input source when explicitly adopting a device draft', async phase => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const draft = content.replace('Original text', 'My later local draft'), observed = content.replace('Original text', 'Original observed D'), proposed = content.replace('Original text', 'Original proposed L'), oldAlternate = content.replace('Original text', 'Older alternate A')
  const deviceDraft = content.replace('Original text', 'New device draft'), deviceAttempt = { phase: 'unknown' as const, content: deviceDraft, expectedRevision: bodyRevision(deviceDraft) }
  const device: NoteEditState = { noteId: source.noteId, draft: deviceDraft, expectedRevision: bodyRevision(deviceDraft), attempt: deviceAttempt }
  const written = known(canonical), history = phase === 'written' ? written.noteHistory! : { status: 'unconfirmed' as const, eventId: 'original-unknown-event', reason: 'Reply lost' }
  const attempt: NonNullable<NoteEditState['attempt']> = { phase, content, expectedRevision: bodyRevision(content), noteHistory: history, ...(phase === 'written' ? { written, canonicalContent: canonical } : {}) }
  let publish!: (value: NoteEditState) => void, last!: NoteEditState
  const save = vi.fn(), adopted = vi.fn()
  await act(async () => root!.render(<NoteReader content={content} path="original.note.md" workspaceId="workspace" revision={bodyRevision(content)}
    editing={{ initial: { noteId: source.noteId, draft: content, expectedRevision: bodyRevision(content) }, onDraft: value => { last = value }, subscribe: listener => { publish = listener; return () => {} }, save, readCurrent: vi.fn(), readDeviceDraft: () => device, adoptDeviceDraft: adopted }} />))
  await act(async () => publish({ noteId: source.noteId, draft, expectedRevision: phase === 'written' ? written.revision : bodyRevision(content), attempt,
    input: { baseContent: content, observedContent: observed, proposedContent: proposed, issue: 'Original unresolved input' }, alternates: [{ draft: oldAlternate, expectedRevision: bodyRevision(content) }] }))
  await act(async () => [...host!.querySelectorAll('button')].find(button => button.textContent === '核对本机笔记草稿')!.click())
  await act(async () => [...host!.querySelectorAll('button')].find(button => button.textContent === '保留当前编辑，采用本机草稿')!.click())
  expect(last.draft).toBe(deviceDraft); expect(last.attempt).toEqual(deviceAttempt)
  expect(last.unconfirmed).toEqual(expect.arrayContaining([expect.objectContaining({ content, expectedRevision: attempt.expectedRevision, noteHistory: history, ...(phase === 'written' ? { written } : {}) })]))
  expect([last.draft, ...last.alternates?.map(item => item.draft) ?? []]).toEqual(expect.arrayContaining([draft, content, observed, proposed, oldAlternate, ...phase === 'written' ? [canonical] : []]))
  expect(adopted).toHaveBeenCalledTimes(1); expect(save).not.toHaveBeenCalled()
})

it('retains an unpersisted original unknown save across another device publication without pairing later input with its new revision', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const entries = new Map<string, string>(); let quota = false
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, raw: string) => { if (quota) throw Error('quota'); entries.set(key, raw) } })
  const identity = ['mounted-quota-original-operation'], drafts = noteDrafts(identity)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  let finish!: (value: FileWriteReceipt) => void, last!: NoteEditState
  const save = vi.fn((body: string, expected: string) => drafts.send(body, expected, () => new Promise<FileWriteReceipt>(resolve => { finish = resolve })))
  await act(async () => root!.render(<NoteReader content={content} path="original.note.md" workspaceId="workspace" revision={bodyRevision(content)}
    editing={{ onDraft: value => { last = value; drafts.save(value) }, subscribe: drafts.subscribe, save, readCurrent: vi.fn() }} />))
  const click = async (text: string) => { await act(async () => [...host!.querySelectorAll('button')].find(button => button.textContent === text)!.click()) }
  await click('编辑原笔记'); await click('保存原笔记')
  const other = noteDrafts(identity)
  quota = true
  await act(async () => (host!.querySelector('.mobile-note-body') as HTMLElement & { editor: Editor }).editor.commands.insertContentAt(1, 'Later unpersisted L '))
  await act(async () => finish({ status: 'unknown', code: 'REPLY_LOST', message: 'Original outcome lost', noteHistory: { status: 'unconfirmed', eventId: 'quota-original-unknown', reason: 'Reply lost' } }))
  const local = last.draft
  expect(last.attempt).toMatchObject({ phase: 'unknown', content, noteHistory: { eventId: 'quota-original-unknown' } })
  expect(local).toContain('Later unpersisted L ')
  const remote = content.replace('Original text', 'Remote canonical C')
  quota = false
  await act(async () => other.save({ noteId: source.noteId, draft: remote, expectedRevision: bodyRevision(remote), receipt: known(remote) }))
  expect(last.draft).toBe(local)
  expect(last.expectedRevision).toBe(bodyRevision(content))
  expect(last.attempt).toMatchObject({ phase: 'unknown', content, expectedRevision: bodyRevision(content), noteHistory: { eventId: 'quota-original-unknown' } })
  expect([last.draft, ...last.alternates?.map(item => item.draft) ?? []]).toContain(remote)
  const saveButton = [...host!.querySelectorAll('button')].find(button => button.textContent === '保存原笔记')!
  expect(saveButton.disabled).toBe(true)
  await act(async () => saveButton.click())
  expect(save).toHaveBeenCalledTimes(1)
  expect(noteDrafts(identity).initial).toMatchObject({ draft: local, expectedRevision: bodyRevision(content), attempt: { phase: 'unknown', noteHistory: { eventId: 'quota-original-unknown' } } })
})

it('maps an exact original known-written publication after a quota failure before the next ordinary CAS', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const entries = new Map<string, string>(); let quota = false
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, raw: string) => { if (quota) throw Error('quota'); entries.set(key, raw) } })
  const sourceNote = newNoteDocument('Submitted first', source.noteId, 'first-block')
  sourceNote.content.content!.push({ type: 'paragraph', attrs: { blockId: 'second-block' }, content: [{ type: 'text', text: 'Submitted second' }] })
  const sent = serializeNoteDocument(sourceNote), canonical = sent.replace('Submitted second', 'Canonical second')
  const drafts = noteDrafts(['exact-canonical-quota']), receipt: Extract<FileWriteReceipt, { status: 'written' }> = { status: 'written', content: canonical, revision: bodyRevision(canonical), noteHistory: { status: 'committed', eventId: 'exact-quota-operation', batchId: 'exact-quota-batch' } }
  let finish!: (value: FileWriteReceipt) => void, last!: NoteEditState
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const save = vi.fn((body: string, expected: string) => drafts.send(body, expected, () => save.mock.calls.length === 1 ? new Promise<FileWriteReceipt>(resolve => { finish = resolve }) : Promise.resolve<FileWriteReceipt>({ status: 'written', revision: bodyRevision(body), content: body })))
  await act(async () => root!.render(<NoteReader content={sent} path="original.note.md" workspaceId="workspace" revision={bodyRevision(sent)}
    editing={{ onDraft: value => { last = value; drafts.save(value) }, subscribe: drafts.subscribe, save, readCurrent: vi.fn() }} />))
  const click = async (text: string) => act(async () => [...host!.querySelectorAll('button')].find(button => button.textContent === text)!.click())
  await click('编辑原笔记'); await click('保存原笔记')
  const other = noteDrafts(['exact-canonical-quota'])
  quota = true
  await act(async () => (host!.querySelector('.mobile-note-body') as HTMLElement & { editor: Editor }).editor.commands.insertContentAt(1, 'Later local '))
  await act(async () => finish({ status: 'unknown', code: 'REPLY_LOST', message: 'Original outcome lost', noteHistory: { status: 'unconfirmed', eventId: 'exact-quota-operation', reason: 'Reply lost' } }))
  quota = false
  const { content: _content, ...written } = receipt
  await act(async () => other.save({ noteId: source.noteId, draft: canonical, expectedRevision: receipt.revision, receipt: written,
    attempt: { phase: 'written', content: sent, expectedRevision: bodyRevision(sent), noteHistory: receipt.noteHistory, written, canonicalContent: canonical } }))
  await vi.waitFor(() => { expect(last.attempt).toBeUndefined(); expect(last.input).toBeUndefined(); expect(last.draft).toContain('Later local '); expect(last.draft).toContain('Canonical second') })
  expect(last.expectedRevision).toBe(receipt.revision)
  await click('保存原笔记')
  expect(save).toHaveBeenCalledTimes(2); expect(save.mock.calls[1]![0]).toContain('Later local '); expect(save.mock.calls[1]![0]).toContain('Canonical second'); expect(save.mock.calls[1]![1]).toBe(receipt.revision)
})
