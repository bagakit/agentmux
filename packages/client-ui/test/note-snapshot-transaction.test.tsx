import { expect, it } from 'vitest'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { history, undo, redo } from '@tiptap/pm/history'
import { noteContentSchema } from '../src/note/note-content-schema.js'
import { noteInlineLinkContent } from '../src/note/note-wikilinks.js'
import { noteSnapshotTransaction } from '../src/note/note-snapshot-transaction.js'

const paragraph = (text: string, blockId: string | null = 'middle') => ({ type: 'paragraph', attrs: { blockId }, content: text ? [{ type: 'text', text }] : [] })
const doc = (...content: any[]) => noteContentSchema.nodeFromJSON({ type: 'doc', content })
function apply(state: EditorState, target: ReturnType<typeof doc>) {
  const result = noteSnapshotTransaction(state, target)
  expect(result.status, result.status === 'failed' ? result.message : undefined).toBe('ready')
  if (result.status !== 'ready') throw Error('expected mapped transaction')
  expect(result.transaction.doc.eq(target)).toBe(true)
  return { state: state.apply(result.transaction), transaction: result.transaction }
}
function command(state: EditorState, action: typeof undo) { expect(action(state, tr => { state = state.apply(tr) })).toBe(true); return state }

it('maps two remote changes around local input without losing selection or undo/redo history', () => {
  let state = EditorState.create({ doc: doc(paragraph('left', 'a'), paragraph('human', 'b'), paragraph('right', 'c')), plugins: [history()] })
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 12)).insertText(' local'))
  const caret = state.selection.from
  const mapped = apply(state, doc(paragraph('remote left', 'a'), paragraph('human local', 'b'), paragraph('remote right', 'c')))
  expect(mapped.transaction.getMeta('addToHistory')).toBe(false)
  expect(mapped.state.selection.from).toBe(caret + 7)
  state = command(mapped.state, undo)
  expect(state.doc.textContent).toBe('remote lefthumanremote right')
  expect(mapped.transaction.steps.length).toBeGreaterThanOrEqual(2)
  state = command(state, redo)
  expect(state.doc.textContent).toBe('remote lefthuman localremote right')
})

it('uses separate inline hunks within one paragraph and preserves middle local undo', () => {
  let state = EditorState.create({ doc: doc(paragraph('left | human | right')), plugins: [history()] })
  state = state.apply(state.tr.insertText(' local', 13))
  const mapped = apply(state, doc(paragraph('REMOTE left | human local | right REMOTE')))
  expect(mapped.transaction.steps.filter(step => step.toJSON().stepType === 'replace').length).toBe(2)
  state = command(mapped.state, undo)
  expect(state.doc.textContent).toBe('REMOTE left | human | right REMOTE')
  expect(command(state, redo).doc.textContent).toBe('REMOTE left | human local | right REMOTE')
})

it('keeps UTF16 positions and mark-only edits separate from text replacement', () => {
  const initial = doc(paragraph('🧠 alpha 中文 end'))
  let state = EditorState.create({ doc: initial, plugins: [history()], selection: TextSelection.create(initial, 11) })
  state = state.apply(state.tr.insertText('local '))
  const target = doc({ ...paragraph(''), content: [{ type: 'text', text: '🚀 🧠 alpha ', marks: [{ type: 'bold' }] }, { type: 'text', text: 'local 中文 end!' }] })
  const result = apply(state, target)
  expect(result.transaction.steps.some(step => step.toJSON().stepType === 'addMark')).toBe(true)
  expect(result.state.selection.$from.parentOffset).toBe(state.selection.$from.parentOffset + 3)
  expect(command(result.state, undo).doc.textContent).toBe('🚀 🧠 alpha 中文 end!')
})

it('maps nested list insertion/deletion using the original stable blocks', () => {
  const item = (id: string, text: string, nested: any[] = []) => ({ type: 'listItem', attrs: { blockId: id }, content: [paragraph(text, id + '-p'), ...nested] })
  const list = (...content: any[]) => ({ type: 'bulletList', content })
  const initial = doc(list(item('a', 'A'), item('b', 'B', [list(item('c', 'C'))]), item('d', 'D')))
  const target = doc(list(item('x', 'X'), item('b', 'B remote', [list(item('c', 'C'), item('e', 'E'))])))
  const state = EditorState.create({ doc: initial, plugins: [history()], selection: TextSelection.create(initial, 13) })
  expect(apply(state, target).state.doc.eq(target)).toBe(true)
})

it('updates wiki attributes and its text through the same recursive mapping without replacing surrounding input', () => {
  const wiki = (query: string, target: string) => noteInlineLinkContent({ referenceId: 'occurrence', text: query, target: { noteId: target } })
  const initial = doc({ ...paragraph(''), content: [{ type: 'text', text: 'before ' }, wiki('Old', 'old'), { type: 'text', text: ' after' }] })
  let state = EditorState.create({ doc: initial, plugins: [history()] })
  state = state.apply(state.tr.insertText('local ', 1))
  const target = doc({ ...paragraph(''), content: [{ type: 'text', text: 'local before ' }, wiki('New heading #here', 'new'), { type: 'text', text: ' after remote' }] })
  const result = apply(state, target)
  expect(result.transaction.steps.some(step => step.toJSON().stepType === 'attr')).toBe(true)
  expect(command(result.state, undo).doc.textContent).toBe('before [[New heading #here]] after remote')
})

it('applies canonical identity metadata without inventing a human history entry', () => {
  let state = EditorState.create({ doc: doc(paragraph('draft', null)), plugins: [history()] })
  state = state.apply(state.tr.insertText(' local', 6))
  const result = apply(state, doc(paragraph('draft local', 'allocated')))
  expect(result.transaction.steps.every(step => step.toJSON().stepType === 'attr')).toBe(true)
  const undone = command(result.state, undo)
  expect(undone.doc.firstChild!.attrs.blockId).toBe('allocated')
  expect(undone.doc.textContent).toBe('draft')
})

it('returns an explicit failure for an incompatible schema while retaining the complete original state', () => {
  const state = EditorState.create({ doc: doc(paragraph('input')), plugins: [history()] })
  const other = noteContentSchema.nodes.paragraph!.create(null, noteContentSchema.text('invalid root'))
  const result = noteSnapshotTransaction(state, other)
  expect(result.status).toBe('failed')
  if (result.status === 'failed') expect(result.message).toContain('your current input is kept')
  expect(state.doc.textContent).toBe('input')
})

it('maps a long document through only the two changed ranges', () => {
  const content = Array.from({ length: 1000 }, (_, index) => paragraph('Paragraph ' + index + ' ' + 'same text '.repeat(12), 'block-' + index))
  const state = EditorState.create({ doc: doc(...content) })
  const next = [...content]; next[0] = paragraph('Beginning remote ' + 'same text '.repeat(12), 'block-0'); next[999] = paragraph('Ending remote ' + 'same text '.repeat(12), 'block-999')
  const started = performance.now(), result = apply(state, doc(...next))
  expect(result.transaction.steps.length).toBeLessThan(12)
  console.info('note snapshot 1000 blocks ms', Math.round(performance.now() - started))
})


it('uses one mark step for a long formatted range', () => {
  const text = 'long paragraph '.repeat(10000)
  const state = EditorState.create({ doc: doc(paragraph(text)) })
  const target = doc({ ...paragraph(''), content: [{ type: 'text', text, marks: [{ type: 'bold' }] }] })
  const started = performance.now(), result = apply(state, target)
  expect(result.transaction.steps).toHaveLength(1)
  console.info('note snapshot 150k text mark ms', Math.round(performance.now() - started))
})

it('measures a fully replaced paragraph without imposing an arbitrary edit limit', () => {
  const state = EditorState.create({ doc: doc(paragraph('a'.repeat(4000))) })
  const started = performance.now(), result = apply(state, doc(paragraph('b'.repeat(4000))))
  expect(result.transaction.steps).toHaveLength(1)
  console.info('note snapshot 4k entire replacement ms', Math.round(performance.now() - started))
})

it('measures a large paragraph replacement with a retained internal anchor', () => {
  const state = EditorState.create({ doc: doc(paragraph('a'.repeat(2000) + ' shared ' + 'b'.repeat(2000))) })
  const started = performance.now(), result = apply(state, doc(paragraph('c'.repeat(2000) + ' shared ' + 'd'.repeat(2000))))
  expect(result.transaction.steps).toHaveLength(2)
  console.info('note snapshot 4k anchored replacement ms', Math.round(performance.now() - started))
})

it('retains local selection and undo when an unanchored paragraph before it is deleted remotely', () => {
  const initial = doc(paragraph('remove me', null), paragraph('human', null), paragraph('keep last', null))
  let state = EditorState.create({ doc: initial, plugins: [history()] })
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 17)).insertText(' local'))
  const mapped = apply(state, doc(paragraph('human local', null), paragraph('keep last', null)))
  expect(mapped.state.selection.$from.parent.textContent).toBe('human local')
  expect(command(mapped.state, undo).doc.textContent).toBe('humankeep last')
})

it('keeps input and history when an anonymous paragraph changes text beside an ambiguous deletion', () => {
  const initial = doc(paragraph('remove me', null), paragraph('human knowledge', null), paragraph('keep last', null))
  let state = EditorState.create({ doc: initial, plugins: [history()] })
  state = state.apply(state.tr.insertText(' local', 27))
  const before = state.doc.toJSON()
  const result = noteSnapshotTransaction(state, doc(paragraph('remote human knowledge local end', null), paragraph('keep last', null)))
  expect(result.status).toBe('failed')
  expect(state.doc.toJSON()).toEqual(before)
  expect(command(state, undo).doc.textContent).toBe('remove mehuman knowledgekeep last')
})

it('keeps repeated unanchored paragraphs and their original history when a deletion has no unique identity', () => {
  const initial = doc(paragraph('repeat', null), paragraph('human', null), paragraph('repeat', null))
  let state = EditorState.create({ doc: initial, plugins: [history()] })
  state = state.apply(state.tr.insertText(' local', 14))
  const before = state.doc.toJSON()
  const result = noteSnapshotTransaction(state, doc(paragraph('human local', null), paragraph('repeat', null)))
  expect(result.status).toBe('failed')
  if (result.status === 'failed') expect(result.message).toContain('Repeated unanchored blocks')
  expect(state.doc.toJSON()).toEqual(before)
  expect(command(state, undo).doc.textContent).toBe('repeathumanrepeat')
})

it('accepts ordered identity allocation for repeated anonymous paragraphs without treating it as deletion', () => {
  const initial = doc(paragraph('repeat', null), paragraph('repeat', null))
  const state = EditorState.create({ doc: initial, selection: TextSelection.create(initial, 11) })
  const result = apply(state, doc(paragraph('repeat', 'first'), paragraph('repeat', 'second')))
  expect(result.state.selection.from).toBe(11)
  expect(result.state.selection.$from.parent.attrs.blockId).toBe('second')
  expect(result.transaction.steps.every(step => step.toJSON().stepType === 'attr')).toBe(true)
})

it('does not infer anonymous paragraph identity from a word retained by a different original neighbour', () => {
  const initial = doc(paragraph('project', null), paragraph('human', null), paragraph('keep', null))
  let state = EditorState.create({ doc: initial, plugins: [history()] })
  state = state.apply(state.tr.insertText('++', 15))
  const before = state.doc.toJSON(), selection = state.selection.toJSON()
  const result = noteSnapshotTransaction(state, doc(paragraph('project++', null), paragraph('keep', null)))
  expect(result.status).toBe('failed')
  expect(state.doc.toJSON()).toEqual(before)
  expect(state.selection.toJSON()).toEqual(selection)
  expect(command(state, undo).doc.textContent).toBe('projecthumankeep')
})

it('still refines an anonymous paragraph in place when its sibling structure is unchanged', () => {
  const initial = doc(paragraph('left human right', null))
  let state = EditorState.create({ doc: initial, plugins: [history()] })
  state = state.apply(state.tr.insertText(' local', 11))
  const mapped = apply(state, doc(paragraph('remote left human local right remote', null)))
  expect(command(mapped.state, undo).doc.textContent).toBe('remote left human right remote')
})

it.each([null, 'human-block'])('keeps the original caret and undo instead of deleting and reinserting a moved block (%s)', blockId => {
  const initial = doc(paragraph('human', blockId), paragraph('keep', blockId ? 'keep-block' : null))
  let state = EditorState.create({ doc: initial, plugins: [history()] })
  state = state.apply(state.tr.insertText('++', 6))
  const before = state.doc.toJSON(), selection = state.selection.toJSON()
  const result = noteSnapshotTransaction(state, doc(paragraph('keep', blockId ? 'keep-block' : null), paragraph('human++', blockId)))
  expect(result.status).toBe('failed')
  if (result.status === 'failed') expect(result.message).toContain('Blocks moved or changed containers')
  expect(state.doc.toJSON()).toEqual(before)
  expect(state.selection.toJSON()).toEqual(selection)
  expect(command(state, undo).doc.textContent).toBe('humankeep')
})
