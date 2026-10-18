import { expect, it } from 'vitest'
import { capturedToolEdit } from '../src/conversation.js'
import { claudeToolEdit } from '../src/providers/claude-tool-edit.js'
import { recordedToolEdit } from './fixtures/recorded-tool-edits.js'

it('reads requested edits from the exact Provider-normalized original input', () => {
  const item = recordedToolEdit('original-session')
  expect(capturedToolEdit({ ...item, title: 'A display heading' })).toEqual({ filePath: 'src/answer.ts', edits: [{ before: 'original answer\nkept line', after: 'revised answer\nkept line' }] })
  const provenance = item.conversation!.invocations![0]!
  expect(capturedToolEdit({ ...item, conversation: {} })).toBeNull()
  expect(capturedToolEdit({ ...item, conversation: { invocations: [provenance, provenance] } })).toBeNull()
  expect(capturedToolEdit({ ...item, conversation: { invocations: [{ ...provenance, invocation: { ...provenance.invocation, source: { ...provenance.invocation.source, providerId: 'another-provider' } } }] } })).toBeNull()
  expect(capturedToolEdit({ ...item, conversation: { invocations: [{ ...provenance, selector: { kind: 'captured-field', field: 'toolOutput' } }] } })).toBeNull()
})
it('keeps the whole ordered Provider edit or declines an incomplete description', () => {
  expect(claudeToolEdit('MultiEdit', JSON.stringify({ edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'b', new_string: 'B' }] }))).toEqual({ edits: [{ before: 'a', after: 'A' }, { before: 'b', after: 'B' }] })
  expect(claudeToolEdit('Write', JSON.stringify({ content: '' }))).toEqual({ edits: [{ after: '' }] })
  for (const raw of ['{}', 'null', '[]', '{bad', '{"old_string":"a"}', '{"old_string":1,"new_string":"b"}']) expect(claudeToolEdit('Edit', raw)).toBeNull()
  expect(claudeToolEdit('MultiEdit', JSON.stringify({ edits: [{ old_string: 'a', new_string: 'A' }, { old_string: 'b' }] }))).toBeNull()
  expect(claudeToolEdit('MultiEdit', '{"edits":[]}')).toBeNull()
  expect(claudeToolEdit('edit', '{"old_string":"a","new_string":"b"}')).toBeNull()
})
