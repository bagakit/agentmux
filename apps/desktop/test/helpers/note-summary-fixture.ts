import type { JSONContent } from '@tiptap/core'
const paragraph = (id: string, text: string): JSONContent => ({ type: 'paragraph', attrs: { blockId: id }, ...(text ? { content: [{ type: 'text', text }] } : {}) })
const table: JSONContent = { type: 'table', attrs: { blockId: 'summary-table' }, content: [
  { type: 'tableRow', content: ['Evidence', 'Result'].map((text, index) => ({ type: 'tableHeader', content: [paragraph('header-' + index, text)] })) },
  { type: 'tableRow', content: ['Original source', 'Retained'].map((text, index) => ({ type: 'tableCell', content: [paragraph('cell-' + index, text)] })) },
] }
const tasks: JSONContent = { type: 'taskList', content: [{ type: 'taskItem', attrs: { blockId: 'summary-task', checked: true }, content: [
  paragraph('parent-words', 'Task parent'), { type: 'taskList', content: [{ type: 'taskItem', attrs: { blockId: 'child-task', checked: false }, content: [paragraph('child-words', 'Task child')] }] },
] }] }
export const noteSummaryCases: { name: string; content: JSONContent; title?: string; expected: string; indexedBlock: string; indexedText: string }[] = [
  { name: 'explicit title', content: table, title: 'User named evidence', expected: 'User named evidence', indexedBlock: 'summary-table', indexedText: 'EvidenceResultOriginal sourceRetained' },
  { name: 'table cells', content: table, expected: 'Evidence · Result · Original source · Retained', indexedBlock: 'summary-table', indexedText: 'EvidenceResultOriginal sourceRetained' },
  { name: 'nested tasks', content: tasks, expected: 'Task parent · Task child', indexedBlock: 'summary-task', indexedText: 'Task parentTask child' },
  { name: 'first readable paragraph', content: { type: 'doc', content: [paragraph('empty-summary', ''), paragraph('first-summary', 'First readable paragraph'), paragraph('later-summary', 'Later independent paragraph')] }, expected: 'First readable paragraph', indexedBlock: 'first-summary', indexedText: 'First readable paragraph' },
]
export function noteSummaryContent(example: typeof noteSummaryCases[number]): JSONContent {
  return structuredClone(example.content.type === 'doc' ? example.content : { type: 'doc', content: [example.content] })
}
