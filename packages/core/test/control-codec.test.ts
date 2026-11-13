import { expect, it } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../src/control.js'
import { parseAgentMuxControlReceipt } from '../src/control-codec.js'

// settings.get may name keys that could not be read this time beside the entries that were read.
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'partial-read' } as const

it('carries issues across the control codec, and rejects a malformed or duplicate issue', () => {
  const entries = [{ key: 'notes.fontSize', kind: 'number', value: 15, default: 15 }]
  const response = (result: unknown) => ({ ...envelope, ok: true, operation: 'settings.get', result })
  const issue = { key: 'notes.directory', code: 'NOTES_LOCATION_UNREADABLE', message: 'unreadable' }
  expect(parseAgentMuxControlReceipt(response({ entries, partial: true, issues: [issue] })))
    .toMatchObject({ ok: true, result: { entries, partial: true, issues: [issue] } })
  expect(parseAgentMuxControlReceipt(response({ entries, partial: true }))).not.toHaveProperty('result.issues')
  for (const bad of [[], [{ key: 'notes.directory', message: 'missing code' }], [{ ...issue, extra: true }], [{ ...issue, key: 'notes.fontSize' }]])
    expect(() => parseAgentMuxControlReceipt(response({ entries, partial: true, issues: bad }))).toThrow()
})
