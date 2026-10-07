import { expect, it } from 'vitest'
import { mergeNoteText } from '../dist/note-merge.js'
import { mergeNoteTextInWorker } from '../dist/note-merge-node.js'

it('keeps exact separators and upstream overlap semantics through the Myers adapter', () => {
  const base = 'First\r\n\r\n^first\r\n\r\nMiddle\r\n\r\n^middle\r\n\r\nLast\r\n\r\n^last'
  expect(mergeNoteText(base, base.replace('First', 'Human first'), base.replace('Last', 'Agent last'))).toEqual({ status: 'merged', content: base.replace('First', 'Human first').replace('Last', 'Agent last') })
  expect(mergeNoteText(base, base.replace('Middle', 'Human middle'), base.replace('Middle', 'Agent middle'))).toEqual({ status: 'conflict' })
  expect(mergeNoteText(base, base.replace('Middle', 'Same edit'), base.replace('Middle', 'Same edit'))).toEqual({ status: 'merged', content: base.replace('Middle', 'Same edit') })
})
it('merges repeated blank lines on the actual worker while the Host event loop continues', async () => {
  const base = Array.from({ length: 4000 }, (_, index) => `Paragraph ${index} text\n\n^block-${index}\n`).join('\n')
  const current = base.replace('Paragraph 0 text', 'Human first'), proposed = base.replace('Paragraph 3999 text', 'Agent last')
  let settled = false
  const result = mergeNoteTextInWorker(base, current, proposed).finally(() => { settled = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(settled, 'The Host must get an event-loop turn while CPU work runs in its worker').toBe(false)
  expect(await result).toEqual({ status: 'merged', content: current.replace('Paragraph 3999 text', 'Agent last') })
}, 15000)

it('merges a legal large line buffer without spreading it onto the V8 call stack', async () => {
  const base = Array.from({ length: 150000 }, (_, index) => `Paragraph ${index}\n`).join('')
  const current = base.replace('Paragraph 0', 'First'), proposed = base.replace('Paragraph 149999', 'Last')
  expect(await mergeNoteTextInWorker(base, current, proposed)).toEqual({ status: 'merged', content: current.replace('Paragraph 149999', 'Last') })
}, 15000)
