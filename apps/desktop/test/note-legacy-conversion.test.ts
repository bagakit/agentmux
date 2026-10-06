import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { NoteResource } from '@agentmux/core/notebook-catalog'
import type { NoteDocument } from '@agentmux/client-ui/note/note-document'
import { readNoteDocument } from '@agentmux/client-ui/note/note-document'
import { fixturePath, fixtureTime } from '../scripts/lib/fixture-values.mjs'
import { prepareLegacyNoteMarkdown } from '../src/main/note-legacy-conversion'

const codecFault = vi.hoisted(() => ({ replaceTarget: false }))
vi.mock('@agentmux/client-ui/note/note-document', async importOriginal => {
  const actual = await importOriginal<typeof import('@agentmux/client-ui/note/note-document')>()
  return { ...actual, serializeNoteDocument: (note: NoteDocument) => {
    const raw = actual.serializeNoteDocument(note)
    return codecFault.replaceTarget ? raw.replaceAll('note:target%2Dnote', 'note:different%2Dnote') : raw
  } }
})
const source: NoteResource = { hostId: 'local', workspaceId: '__notes__', workspacePath: fixturePath('note-conversion'), path: 'nested/original.note.json' }
const author = { actor: { kind: 'agent' as const, id: 'original-exact-session' }, at: fixtureTime(10) }
function original(): NoteDocument {
  return { schema: 'agentmux.note.v1', noteId: 'original 中文/#%--Note', content: { type: 'doc', content: [
    { type: 'paragraph', attrs: { blockId: 'paragraph/#%--中文', provenance: { created: author, lastEdited: null } }, content: [
      { type: 'text', text: 'Original ', marks: [{ type: 'bold' }] },
      { type: 'noteLink', attrs: { referenceId: 'inline--exact', text: 'Same label', target: { noteId: 'target-note', blockId: 'target-block' } } },
      { type: 'hardBreak' }, { type: 'text', text: 'raw [[Same title]] remains raw' },
      { type: 'noteLink', attrs: { referenceId: 'inline--unbound', text: 'Same title', target: null } }
    ] },
    { type: 'orderedList', attrs: { start: 7, type: 'a' }, content: [
      { type: 'listItem', attrs: { blockId: 'item-original' }, content: [{ type: 'paragraph', attrs: { blockId: 'item-paragraph-original' }, content: [{ type: 'text', text: 'Both item and paragraph IDs survive' }] }] }
    ] },
    { type: 'blockReference', attrs: { blockId: 'reference-source', referenceId: 'reference-exact', target: { noteId: 'target-note', blockId: 'target-block' }, mode: 'embed' } }
  ] } }
}
const bytes = (note = original()) => Buffer.from(JSON.stringify(note), 'utf8')
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')

describe('legacy Note preparation for the original storage journal', () => {
  it('keeps exact Note, block, occurrence, target and old authors with separate source/Markdown hashes', () => {
    const legacy = bytes(), before = Buffer.from(legacy)
    const prepared = prepareLegacyNoteMarkdown(source, legacy, original().noteId)
    expect(legacy).toEqual(before)
    expect(prepared.source).toEqual(source)
    expect(prepared.destination).toEqual({ ...source, path: 'nested/original.note.md' })
    expect(prepared.sourceHash).toBe(hash(legacy))
    expect(prepared.targetHash).toBe(hash(prepared.targetBytes))
    expect(prepared.targetHash).not.toBe(prepared.sourceHash)
    const markdown = Buffer.from(prepared.targetBytes).toString('utf8'), read = readNoteDocument(markdown)
    expect(read.status).toBe('valid')
    if (read.status !== 'valid') throw new Error(read.message)
    expect(read.note.noteId).toBe(original().noteId)
    expect(read.unanchoredBlockCount).toBe(0)
    expect(read.note.content.content?.[0]?.content?.[1]?.attrs).toEqual({ referenceId: 'inline--exact', text: 'Same label', target: { noteId: 'target-note', blockId: 'target-block' } })
    expect(read.note.content.content?.[0]?.content?.at(-1)?.attrs).toEqual({ referenceId: 'inline--unbound', text: 'Same title', target: null })
    expect(markdown).toContain('[[Same title]]')
    expect(markdown).not.toContain('original-exact-session')
    expect(Object.keys(prepared.provenance.blocks)).toEqual(['paragraph/#%--中文', 'item-original', 'item-paragraph-original', 'reference-source'])
    expect(prepared.provenance).toMatchObject({ noteId: original().noteId, resource: prepared.destination, revision: 'sha256:' + prepared.targetHash,
      blocks: { 'paragraph/#%--中文': { created: author, lastEdited: null }, 'item-original': { created: null, lastEdited: null } } })
    expect(prepareLegacyNoteMarkdown(source, legacy, original().noteId)).toEqual(prepared)
  })

  it('rejects a different registered identity, unsupported legacy data and invalid UTF-8 without touching source bytes', () => {
    const legacy = bytes(), before = Buffer.from(legacy)
    expect(() => prepareLegacyNoteMarkdown(source, legacy, 'different-note')).toThrow('identity')
    const unsupported = original(); unsupported.content.content![0]!.attrs!.futureUnsupported = 'keep raw'
    expect(() => prepareLegacyNoteMarkdown(source, bytes(unsupported))).toThrow('unsupported')
    expect(() => prepareLegacyNoteMarkdown(source, Uint8Array.from([0xff, 0xfe]))).toThrow('UTF-8')
    expect(legacy).toEqual(before)
    expect(() => prepareLegacyNoteMarkdown({ ...source, hostId: 'remote' }, legacy)).toThrow('local legacy')
    expect(() => prepareLegacyNoteMarkdown({ ...source, path: '../outside.note.json' }, legacy)).toThrow('local legacy')
  })

  it('refuses a valid Markdown result whose exact target was lost instead of silently importing it', () => {
    codecFault.replaceTarget = true
    try { expect(() => prepareLegacyNoteMarkdown(source, bytes())).toThrow('preserve the complete original') }
    finally { codecFault.replaceTarget = false }
  })
})
