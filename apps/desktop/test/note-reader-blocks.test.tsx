// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { NoteReader } from '@agentmux/client-ui/components/NoteReader'
import { noteKnowledge, projectNoteBlocks } from '@agentmux/client-ui/note/note-knowledge'
import { composerDOM } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM()
const paragraph = (blockId: string, text: string) => ({ type: 'paragraph', attrs: { blockId }, content: [{ type: 'text', text }] })
const reference = (blockId: string, target: string) => ({ type: 'blockReference', attrs: { blockId, referenceId: 'ref-' + blockId, mode: 'reference', target: { noteId: 'original', blockId: target } } })
const file = (content: unknown[]) => JSON.stringify({ schema: 'agentmux.note.v1', noteId: 'original', content: { type: 'doc', content } })
const input = (content: string) => [{ location: { workspaceId: 'notes', path: 'original.note.json' }, document: { path: 'original.note.json', revision: 'r1', content } }]

it('projects exact ordered items and paragraph sources with original numbering, nested lists and no duplicated original IDs', async () => {
  installNoteCanvasGeometry()
  const content = file([{ type: 'orderedList', attrs: { start: 4 }, content: [
    { type: 'listItem', attrs: { blockId: 'item-four' }, content: [paragraph('para-four', 'Fourth item')] },
    { type: 'listItem', attrs: { blockId: 'item-five' }, content: [paragraph('para-five', 'Fifth item'), { type: 'bulletList', content: [{ type: 'listItem', attrs: { blockId: 'nested' }, content: [paragraph('nested-para', 'Nested original')] }] }] },
    { type: 'listItem', attrs: { blockId: 'item-six' }, content: [paragraph('para-six', 'Sixth item')] },
  ] }])
  const source = noteKnowledge(input(content)).sources[0]!
  const projected = projectNoteBlocks(source, ['item-five', 'para-five', 'nested', 'para-six'])
  expect(projected.rootBlockIds).toEqual(['item-five', 'para-six'])
  expect(projected.shownBlockIds).toEqual(expect.arrayContaining(['item-five', 'para-five', 'nested', 'para-six']))
  await dom.render(<NoteReader {...input(content)[0]!.location} content={content} revision="r1" blockIds={['item-five', 'para-five', 'nested', 'para-six']} />)
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Nested original'))
  expect(dom.container.querySelectorAll('[data-block-id="para-five"]')).toHaveLength(1)
  expect(dom.container.querySelectorAll('[data-block-id="nested"]')).toHaveLength(1)
  expect(dom.container.querySelector('[data-block-id="para-five"]')!.closest('ol')!.getAttribute('start')).toBe('5')
  const context = dom.container.querySelector('[data-block-id="para-six"]')!.closest('ol')
  expect(context).not.toBeNull()
  expect(context!.getAttribute('start')).toBe('6')
  // The context item is structural; it cannot impersonate the complete original item-six subtree.
  expect(dom.container.querySelector('[data-block-id="item-six"]')).toBeNull()
  expect(dom.container.textContent).not.toContain('Fourth item')
})

it('keeps complete original knowledge behind a clipped projection and resolves same-file atom chains and cycles honestly', async () => {
  installNoteCanvasGeometry()
  const content = file([paragraph('outside-excerpt', 'Exact original outside the excerpt'), reference('first', 'second'), reference('second', 'outside-excerpt'), reference('cycle', 'cycle')])
  await dom.render(<NoteReader path="original.note.json" workspaceId="notes" content={content} revision="r1" blockIds={['first', 'cycle']} />)
  await vi.waitFor(() => expect(dom.container.textContent).toContain('Exact original outside the excerpt'))
  expect(dom.container.querySelector('.mobile-note-body')!.querySelectorAll(':scope > [data-block-id="outside-excerpt"]')).toHaveLength(0)
  expect(dom.container.textContent).toContain('循环引用')
  expect(dom.container.textContent).not.toContain('引用正文尚未读取')
  expect(dom.container.querySelector('[contenteditable]')?.getAttribute('contenteditable')).toBe('false')
})

it('bounds a long original excerpt independently and offers explicit continuation without changing any source content', async () => {
  installNoteCanvasGeometry()
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.textContent?.includes('Long original') ? 2000 : 30 })
  const content = file([{ type: 'codeBlock', attrs: { blockId: 'long-code' }, content: [{ type: 'text', text: 'Long original\n'.repeat(150) }] }, paragraph('next-related', 'The next related block remains reachable')])
  await dom.render(<NoteReader path="original.note.json" workspaceId="notes" content={content} revision="r1" blockIds={['long-code', 'next-related']} />)
  await vi.waitFor(() => expect(dom.container.querySelector('.note-reader-excerpt-continue')).not.toBeNull())
  const clip = dom.container.querySelector<HTMLElement>('.note-reader-excerpt-clip')!
  expect(clip.style.maxHeight).toBe('112px')
  expect(dom.container.textContent).toContain('The next related block remains reachable')
  await dom.click('.note-reader-excerpt-continue')
  expect(clip.style.maxHeight).toBe('')
  expect(dom.container.querySelector('.note-reader-excerpt-continue')?.textContent).toBe('Show shorter block')
  await act(async () => dom.container.querySelector<HTMLButtonElement>('.note-reader-excerpt-continue')!.click())
  expect(clip.style.maxHeight).toBe('112px')
})
